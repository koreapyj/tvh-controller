/*
 * tvh-controller - Centralized tvheadend controller
 * Copyright (C) 2026 Yoonji Park
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Admission-control policy for adding an encoding session to a restreamer
 * node (PURE — no I/O, no clock).
 *
 * The restreamer daemons have zero admission control of their own: pushing
 * one more session onto an already-loaded Intel QSV edge can stall every
 * session sharing that node's `/dev/dri`. This gate is consulted by the
 * automatic cold-backup failover loop before it adds a session to a node —
 * it combines a static per-node capacity cap with a dynamic health gate
 * evaluated over a short rolling history of poll snapshots.
 */

import type { RestreamerNodeStatus, SessionStatus } from '@tvhc/shared';

/** rolling health-history depth per session — ~60s at the 15s poll interval */
export const HEALTH_HISTORY_SIZE = 4;

/**
 * ffmpeg `progress.speed` below this is falling behind realtime. Set just
 * under 1.0 to leave ~2% jitter slack for normal encode-speed variance.
 */
export const MIN_HEALTHY_SPEED = 0.98;

/**
 * consecutive most-recent samples below MIN_HEALTHY_SPEED required before a
 * session counts as degraded — absorbs single-sample dips at GOP boundaries
 * without flapping the verdict.
 */
export const SPEED_DEGRADED_STREAK = 2;

/**
 * media-playlist wall-clock lag above this is unhealthy. Deliberately set
 * below the daemon's own ~30s stall-restart threshold, so admission is
 * refused BEFORE a session tips into a crash-restart loop.
 */
export const MAX_HEALTHY_PLAYLIST_LAG_SEC = 12;

/**
 * number of concurrently backed-off, overload-shaped sessions (crash/stall/
 * oom-guard) tolerated before the node itself is called unhealthy. One
 * unrelated crash-looper (e.g. a bad source) is tolerated; two or more
 * backing off at once is node-wide contention, not an isolated fault.
 */
export const MAX_OVERLOAD_BACKOFF_SESSIONS = 1;

/** one session's rolling sample */
export interface AdmissionSample {
  speed: number | null;
  playlistLagSec: number | null;
}

export interface AdmissionHistory {
  /** sessionName -> ring buffer of recent samples, oldest-first, capped at HEALTH_HISTORY_SIZE */
  perSession: Map<string, AdmissionSample[]>;
}

export function emptyHistory(): AdmissionHistory {
  return { perSession: new Map() };
}

/**
 * Pure: returns a NEW AdmissionHistory with this poll's samples appended
 * (FIFO-capped at HEALTH_HISTORY_SIZE) for every session in
 * `status.sessions`, and entries for session names absent from
 * `status.sessions` pruned (the session was removed from the desired doc —
 * its stale history must not haunt a future same-named session).
 */
export function recordSnapshot(
  history: AdmissionHistory,
  status: RestreamerNodeStatus,
): AdmissionHistory {
  const perSession = new Map<string, AdmissionSample[]>();
  for (const session of status.sessions) {
    const prior = history.perSession.get(session.name) ?? [];
    const sample: AdmissionSample = {
      speed: session.progress?.speed ?? null,
      playlistLagSec: session.playlistLagSec ?? null,
    };
    const next = [...prior, sample];
    if (next.length > HEALTH_HISTORY_SIZE) next.splice(0, next.length - HEALTH_HISTORY_SIZE);
    perSession.set(session.name, next);
  }
  return { perSession };
}

function isOverloadExit(session: SessionStatus): boolean {
  const cls = session.lastExit?.class;
  return cls === 'crash' || cls === 'stall' || cls === 'oom-guard';
}

/**
 * A session is degraded iff it is `running` AND either:
 * - its most recent SPEED_DEGRADED_STREAK samples all have a non-null speed
 *   below MIN_HEALTHY_SPEED (a session with no progress yet is never
 *   degraded — absence is not slowness), OR
 * - its latest sample has a non-null playlistLagSec above
 *   MAX_HEALTHY_PLAYLIST_LAG_SEC (no streak required — lag is already an
 *   observed, truthful symptom).
 *
 * `source-http` sessions never count: a dead upstream source is not GPU
 * contention and must not make an otherwise-healthy node look unadmittable.
 */
function degradedReason(session: SessionStatus, samples: AdmissionSample[]): string | null {
  if (session.state !== 'running') return null;
  if (session.lastExit?.class === 'source-http') return null;

  const latest = samples[samples.length - 1];
  if (latest && latest.playlistLagSec != null && latest.playlistLagSec > MAX_HEALTHY_PLAYLIST_LAG_SEC) {
    return `${session.name}: playlist lag ${latest.playlistLagSec.toFixed(1)}s > ${MAX_HEALTHY_PLAYLIST_LAG_SEC}s`;
  }

  if (samples.length >= SPEED_DEGRADED_STREAK) {
    const streak = samples.slice(samples.length - SPEED_DEGRADED_STREAK);
    const allSlow = streak.every((s) => s.speed != null && s.speed < MIN_HEALTHY_SPEED);
    if (allSlow) {
      const worst = Math.min(...(streak.map((s) => s.speed) as number[]));
      return `${session.name}: speed ${worst.toFixed(2)} sustained over ${SPEED_DEGRADED_STREAK} polls`;
    }
  }

  return null;
}

/**
 * Node unhealthy iff: (a) two or more sessions are concurrently degraded, or
 * (b) more than MAX_OVERLOAD_BACKOFF_SESSIONS sessions are in `backoff` with
 * an overload-shaped last exit (crash/stall/oom-guard). `source-http` never
 * counts toward either branch. Genuine GPU contention on the shared
 * `/dev/dri` degrades multiple sessions at once, which is what the ">=2"
 * rule is meant to catch — a single bad session is left to its own backoff
 * policy, not blamed on the node.
 */
export function nodeHealthy(
  history: AdmissionHistory,
  status: RestreamerNodeStatus,
): { healthy: true } | { healthy: false; reason: string } {
  const degradedReasons: string[] = [];
  for (const session of status.sessions) {
    const samples = history.perSession.get(session.name) ?? [];
    const reason = degradedReason(session, samples);
    if (reason) degradedReasons.push(reason);
  }
  if (degradedReasons.length >= 2) {
    return { healthy: false, reason: `${degradedReasons.length} sessions degraded: ${degradedReasons.join('; ')}` };
  }

  const backoffSessions = status.sessions.filter(
    (s) => s.state === 'backoff' && s.lastExit?.class !== 'source-http' && isOverloadExit(s),
  );
  if (backoffSessions.length > MAX_OVERLOAD_BACKOFF_SESSIONS) {
    const names = backoffSessions.map((s) => s.name).join(', ');
    return {
      healthy: false,
      reason: `${backoffSessions.length} sessions in overload-shaped backoff > ${MAX_OVERLOAD_BACKOFF_SESSIONS}: ${names}`,
    };
  }

  return { healthy: true };
}

export type AdmitResult =
  | { ok: true }
  | { ok: false; reason: 'node-unreachable' | 'at-capacity' | 'node-unhealthy'; detail: string };

/**
 * Check order: unreachable node fails first (no health data can be trusted);
 * then the static per-node capacity cap; then the dynamic health gate.
 * `maxSessions === undefined` means uncapped — capacity never refuses.
 */
export function canAdmitSession(params: {
  status: RestreamerNodeStatus;
  history: AdmissionHistory;
  /** prospective desired-doc session count INCLUDING the candidate */
  desiredSessionCount: number;
  /** per-node config cap; undefined = uncapped */
  maxSessions: number | undefined;
}): AdmitResult {
  const { status, history, desiredSessionCount, maxSessions } = params;

  if (!status.reachable) {
    return { ok: false, reason: 'node-unreachable', detail: status.error ?? 'node unreachable' };
  }

  if (maxSessions !== undefined && desiredSessionCount > maxSessions) {
    return {
      ok: false,
      reason: 'at-capacity',
      detail: `${desiredSessionCount} sessions desired > maxSessions ${maxSessions}`,
    };
  }

  const health = nodeHealthy(history, status);
  if (!health.healthy) {
    return { ok: false, reason: 'node-unhealthy', detail: health.reason };
  }

  return { ok: true };
}
