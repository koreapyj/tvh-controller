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

import {
  compareRecordings,
  type RecordingIdentity,
  type TvhDvrEntry,
  type UploadStatus,
} from '@tvhc/shared';
import type { AppConfig } from '../config.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache, InstanceSnapshot } from '../state/instanceCache.js';
import type { UploadDispatcher } from './dispatcher.js';
import type { UploadLedger } from './ledger.js';

// ---------------------------------------------------------------------------
// pure decision helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface CandidateCopy {
  instanceId: string;
  entry: TvhDvrEntry;
}

export function identityOf(e: TvhDvrEntry): RecordingIdentity {
  return { channelname: e.channelname ?? '', start: e.start, stop: e.stop, title: e.disp_title };
}

/**
 * True while any instance still has a matching entry in its upcoming grid
 * (scheduled or actively recording) — the broadcast is not settled yet and
 * the upload must wait so best-copy selection sees every candidate.
 */
export function isStillPending(
  identity: RecordingIdentity,
  upcomingByInstance: Map<string, TvhDvrEntry[]>,
  threshold: number,
): boolean {
  for (const entries of upcomingByInstance.values()) {
    for (const e of entries) {
      if (compareRecordings(identity, identityOf(e), threshold).isDuplicate) return true;
    }
  }
  return false;
}

/** finished copies of the broadcast across instances (failed copies are simply absent here) */
export function siblingCopies(
  identity: RecordingIdentity,
  finishedByInstance: Map<string, TvhDvrEntry[]>,
  threshold: number,
): CandidateCopy[] {
  const copies: CandidateCopy[] = [];
  for (const [instanceId, entries] of finishedByInstance) {
    for (const entry of entries) {
      if (!entry.filename) continue;
      if (compareRecordings(identity, identityOf(entry), threshold).isDuplicate) {
        copies.push({ instanceId, entry });
      }
    }
  }
  return copies;
}

/** fewest stream errors → fewest data errors → largest file (mirrors the UI's best-copy button) */
export function copyRank(e: TvhDvrEntry): [number, number, number] {
  return [e.errors ?? 0, e.data_errors ?? 0, -(e.filesize ?? 0)];
}

export function strictlyBetter(a: TvhDvrEntry, b: TvhDvrEntry): boolean {
  const ra = copyRank(a);
  const rb = copyRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i]! < rb[i]!) return true;
    if (ra[i]! > rb[i]!) return false;
  }
  return false;
}

export function pickBestCopy(
  copies: CandidateCopy[],
  instanceOrder: string[],
): CandidateCopy | null {
  if (!copies.length) return null;
  return [...copies].sort((a, b) => {
    const ra = copyRank(a.entry);
    const rb = copyRank(b.entry);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i]! !== rb[i]!) return ra[i]! - rb[i]!;
    }
    return instanceOrder.indexOf(a.instanceId) - instanceOrder.indexOf(b.instanceId);
  })[0]!;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 3_000;
const STARTUP_DELAY_MS = 30_000;

/** an existing upload in one of these states already covers the broadcast */
const COVERED_STATUSES: UploadStatus[] = [
  'queued',
  'dispatched',
  'uploading',
  'verifying',
  'done',
];

/**
 * Automatically archives the best copy of every finished recording.
 * Evaluation is STATELESS — recomputed from the instance cache and the
 * upload ledger on every trigger — so restarts need no recovery logic:
 * - waits while any instance still has the broadcast in its upcoming grid;
 * - ignores failed copies entirely;
 * - a *transient* upload failure auto-retries the same copy (dispatcher sweep);
 *   a *permanent* failure advances to the next-best untried copy, and only when
 *   every copy is exhausted (or a manual upload exists) does it stop;
 * - manual uploads are never second-guessed;
 * - when an instance is unreachable, picks among the known copies but marks
 *   the upload `incomplete_pick`; once every instance is reachable again the
 *   pick is re-evaluated and a strictly better copy supersedes the upload
 *   (the old remote object is deleted only after the new one verifies).
 *
 * Evaluation is triggered by recordings/instance-status events; a recording
 * deferred by the grace window arms a one-shot re-check timer for when the
 * window elapses, since no further event may fire once the grids settle.
 */
export class AutoUploader {
  private unsubscribe: (() => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly cache: InstanceCache,
    private readonly ledger: UploadLedger,
    private readonly dispatcher: UploadDispatcher,
    bus: EventBus,
  ) {
    this.unsubscribe = bus.subscribe((event) => {
      if (event.type === 'recordings' || event.type === 'instance-status') this.schedule();
    });
  }

  start(): void {
    this.startupTimer = setTimeout(() => this.schedule(), STARTUP_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
  }

  /**
   * Re-run evaluation once at `atEpoch` (seconds) — the moment a grace-deferred
   * recording becomes eligible. The grids may settle and fire no more events,
   * so without this the upload would stall until unrelated activity nudged it.
   */
  private armRecheck(atEpoch: number): void {
    if (this.stopped) return;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    const delayMs = Math.max(1_000, (atEpoch - Date.now() / 1000) * 1000 + 500);
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      this.schedule();
    }, delayMs);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runOnce();
    }, DEBOUNCE_MS);
  }

  /** single-flight: a trigger during an evaluation queues exactly one rerun */
  private async runOnce(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      await this.evaluate();
    } catch (err) {
      console.error('auto-upload evaluation failed:', err);
    } finally {
      this.running = false;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.schedule();
      }
    }
  }

  private storageRoots(snap: InstanceSnapshot): string[] {
    return (snap.topology?.dvrConfigs ?? [])
      .map((c) => c.storage)
      .filter((s): s is string => !!s);
  }

  /**
   * Channel number at claim time, resolved via the DVR entry's instance-local
   * channel uuid against that same instance's channel list — NEVER by
   * matching the channel name.
   */
  private channelNumber(snap: InstanceSnapshot, entry: TvhDvrEntry): string | null {
    return snap.topology?.channels?.find((c) => c.uuid === entry.channel)?.number ?? null;
  }

  private async evaluate(): Promise<void> {
    const threshold = this.cfg.overlapThreshold;
    const snaps = this.cache.all();
    const reachable = snaps.filter((s) => s.summary.reachable);
    if (!reachable.length) return;
    const anyUnreachable = reachable.length < snaps.length;
    const instanceOrder = snaps.map((s) => s.summary.id);
    const upcomingByInstance = new Map(reachable.map((s) => [s.summary.id, s.upcoming]));
    const finishedByInstance = new Map(reachable.map((s) => [s.summary.id, s.finished]));
    const nowEpoch = Date.now() / 1000;

    // pass 1: enqueue settled broadcasts that the ledger has never seen
    const seen: RecordingIdentity[] = [];
    let earliestEligible = Infinity;
    for (const snap of reachable) {
      for (const entry of snap.finished) {
        if (!entry.filename) continue;
        const identity = identityOf(entry);
        if (seen.some((s) => compareRecordings(s, identity, threshold).isDuplicate)) continue;
        seen.push(identity);

        // grace: let tvheadend finish post-processing before judging copies
        const copies = siblingCopies(identity, finishedByInstance, threshold);
        const graceSeconds = this.cfg.autoUpload.graceSeconds;
        if (copies.some((c) => nowEpoch - (c.entry.stop_real ?? c.entry.stop) < graceSeconds)) {
          // eligible once the youngest copy clears the grace window; remember
          // the soonest such instant so we can re-check without a fresh event
          const youngest = Math.max(...copies.map((c) => c.entry.stop_real ?? c.entry.stop));
          earliestEligible = Math.min(earliestEligible, youngest + graceSeconds);
          continue;
        }
        if (isStillPending(identity, upcomingByInstance, threshold)) continue;

        // per-copy bookkeeping: a permanent failure for one copy must not block
        // trying the next-best copy of the same broadcast
        const rows = await this.ledger.findAllByIdentity(identity);
        if (rows.some((r) => r.origin === 'manual')) continue; // never second-guess the user
        if (rows.some((r) => COVERED_STATUSES.includes(r.status))) continue; // covered or in-flight
        if (rows.some((r) => r.status === 'failed' && r.failureKind === 'transient')) continue; // sweep retries it

        const tried = new Set(rows.map((r) => `${r.instanceId}:${r.dvrUuid}`));
        const best = pickBestCopy(
          copies.filter((c) => !tried.has(`${c.instanceId}:${c.entry.uuid}`)),
          instanceOrder,
        );
        if (!best) continue;
        try {
          const bestSnap = this.cache.get(best.instanceId);
          const result = await this.dispatcher.enqueue(
            best.instanceId,
            best.entry,
            this.storageRoots(bestSnap),
            {
              origin: 'auto',
              incompletePick: anyUnreachable,
              channelNumber: this.channelNumber(bestSnap, best.entry),
            },
          );
          if (result.job) {
            console.log(
              `auto-upload: "${best.entry.disp_title ?? best.entry.uuid}" from ${best.instanceId}` +
                (anyUnreachable ? ' (incomplete pick — some instance unreachable)' : ''),
            );
          }
        } catch (err) {
          console.error('auto-upload enqueue failed:', err);
        }
      }
    }

    // a recording deferred by the grace window won't fire another event once
    // its grids settle — re-check exactly when it becomes eligible
    if (earliestEligible < Infinity) this.armRecheck(earliestEligible);

    // pass 2: with full visibility, re-judge picks made while an instance was down
    if (anyUnreachable) return;
    for (const row of await this.ledger.listIncompletePicks()) {
      const identity: RecordingIdentity = {
        channelname: row.channelname,
        start: row.start,
        stop: row.stop,
        title: row.title ?? undefined,
      };
      if (isStillPending(identity, upcomingByInstance, threshold)) continue;
      const copies = siblingCopies(identity, finishedByInstance, threshold);
      const uploaded = copies.find(
        (c) => c.instanceId === row.instanceId && c.entry.uuid === row.dvrUuid,
      );
      const best = pickBestCopy(copies, instanceOrder);
      if (
        uploaded &&
        best &&
        best.entry.uuid !== uploaded.entry.uuid &&
        strictlyBetter(best.entry, uploaded.entry)
      ) {
        await this.ledger.supersede(row.id);
        try {
          const bestSnap = this.cache.get(best.instanceId);
          await this.dispatcher.enqueue(best.instanceId, best.entry, this.storageRoots(bestSnap), {
            origin: 'auto',
            supersedesPath: row.remotePath,
            channelNumber: this.channelNumber(bestSnap, best.entry),
          });
          console.log(
            `auto-upload: superseding "${row.title ?? row.id}" with the better copy from ${best.instanceId}`,
          );
        } catch (err) {
          console.error('auto-upload supersede enqueue failed:', err);
        }
      } else {
        // pick confirmed (or the uploaded entry is gone — the archive stands)
        await this.ledger.clearIncompletePick(row.id);
      }
    }
  }
}
