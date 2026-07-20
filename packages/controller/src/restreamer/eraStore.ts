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
 * Persisted era history for the switcher's deterministic multi-replica
 * numbering scheme (restream_switcher_eras). One row per (channel,
 * era_index): the controller mints an anchor at every selection change
 * (failover switch, admin placement change, first activation) and switcher
 * replicas derive per-variant segment numbering from it — fire-and-forget
 * stamping, no controller→node fetches involved. `ensureEra` is idempotent
 * (repeat calls targeting the same placement are no-ops); `recordOffsets`
 * folds in replica-reported chain constants, first-write-wins per variant
 * key, never overwriting a disagreeing later report (logged instead).
 */

import { randomUUID } from 'node:crypto';
import type { EraAnchor } from '@tvhc/shared';
import type { Db } from '../db/db.js';
import type { EventLog } from '../state/eventLog.js';

/** rows kept per channel; oldest pruned past this on insert */
const MAX_ERAS_PER_CHANNEL = 20;

interface EraRow {
  channel_id: string;
  era_index: number;
  placement_id: string;
  splice_pdt_ms: number | null;
  offsets: string;
}

function toAnchor(row: EraRow): EraAnchor {
  return {
    eraIndex: row.era_index,
    upstreamId: row.placement_id,
    splicePdtMs: row.splice_pdt_ms,
    offsets: JSON.parse(row.offsets) as Record<string, number>,
  };
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export type EraStoreLike = Pick<EraStore, 'ensureEra' | 'recordOffsets' | 'recentEras'>;

/**
 * Serializes ensureEra/recordOffsets through an in-process promise chain —
 * the controller runs a single replica (see uploads/ledger.ts), so this is
 * sufficient to make the unique(channel_id, era_index) key and the offsets
 * first-write-wins merge race-safe against interleaved async calls
 * (concurrent replica status reports, or a doc compute racing a switch).
 */
export class EraStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly events: Pick<EventLog, 'log'> = { log: () => {} },
  ) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async latest(channelId: string): Promise<EraRow | null> {
    const row = await this.db
      .selectFrom('restream_switcher_eras')
      .select(['channel_id', 'era_index', 'placement_id', 'splice_pdt_ms', 'offsets'])
      .where('channel_id', '=', channelId)
      .orderBy('era_index', 'desc')
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * Idempotent: if the latest era for this channel already targets
   * `placementId`, it is returned unchanged — the passed `splicePdtMs` is
   * ignored, so repeat stamps of an unchanged selection (e.g. a re-issued
   * unconfirmed switch, or successive computeDoc passes) never perturb the
   * anchor or churn the switcher doc hash. Otherwise a new era is inserted
   * at latest.eraIndex + 1 (or 0 for the channel's first era). Era 0's
   * `splicePdtMs` is always forced null regardless of what the caller
   * passes — the wire contract reserves null exclusively for era 0.
   */
  async ensureEra(channelId: string, placementId: string, splicePdtMs: number | null): Promise<EraAnchor> {
    return this.serialize(async () => {
      const latest = await this.latest(channelId);
      if (latest && latest.placement_id === placementId) {
        return toAnchor(latest);
      }
      const eraIndex = latest ? latest.era_index + 1 : 0;
      const effectiveSplice = eraIndex === 0 ? null : splicePdtMs;
      await this.db
        .insertInto('restream_switcher_eras')
        .values({
          id: randomUUID(),
          channel_id: channelId,
          era_index: eraIndex,
          placement_id: placementId,
          splice_pdt_ms: effectiveSplice,
          offsets: '{}',
          created_at: now(),
        })
        .execute();
      await this.prune(channelId);
      return { eraIndex, upstreamId: placementId, splicePdtMs: effectiveSplice, offsets: {} };
    });
  }

  /** keep only the newest MAX_ERAS_PER_CHANNEL rows for a channel */
  private async prune(channelId: string): Promise<void> {
    const rows = await this.db
      .selectFrom('restream_switcher_eras')
      .select('era_index')
      .where('channel_id', '=', channelId)
      .orderBy('era_index', 'desc')
      .execute();
    if (rows.length <= MAX_ERAS_PER_CHANNEL) return;
    const cutoff = rows[MAX_ERAS_PER_CHANNEL - 1]!.era_index;
    await this.db
      .deleteFrom('restream_switcher_eras')
      .where('channel_id', '=', channelId)
      .where('era_index', '<', cutoff)
      .execute();
  }

  /**
   * Recent eras within the switcher's retained-window drain horizon, newest
   * last, capped at `cap`. An era stays included either as the current
   * (newest) one, or while the era that superseded it began less than
   * `drainGraceMs` ago — mirroring how long the switcher's virtual playlist
   * can still hold segments belonging to it (see failoverPolicy.ts's
   * drainHorizonMs, the shared formula both failoverSync and this call
   * site derive `drainGraceMs` from).
   */
  async recentEras(channelId: string, drainGraceMs: number, cap: number, nowMs: number): Promise<EraAnchor[]> {
    const rows = await this.db
      .selectFrom('restream_switcher_eras')
      .select(['channel_id', 'era_index', 'placement_id', 'splice_pdt_ms', 'offsets'])
      .where('channel_id', '=', channelId)
      .orderBy('era_index', 'asc')
      .execute();
    const anchors = rows.map(toAnchor);
    const kept: EraAnchor[] = [];
    for (let i = 0; i < anchors.length; i++) {
      const isNewest = i === anchors.length - 1;
      if (isNewest) {
        kept.push(anchors[i]!);
        continue;
      }
      const endedAtMs = anchors[i + 1]!.splicePdtMs;
      if (endedAtMs !== null && nowMs - endedAtMs < drainGraceMs) kept.push(anchors[i]!);
    }
    return kept.slice(-cap);
  }

  /**
   * Fold replica-reported chain constants into the era's persisted offsets,
   * first-write-wins per variant key:
   * - unknown variant key: sanity-checked against the PRECEDING era's
   *   persisted value for the same variant (when known) — the chained
   *   numbering design means labels are globally consecutive across eras, so
   *   a lower value than the preceding era's would mean numbering went
   *   backwards; rejected and logged rather than persisted.
   * - already-persisted key, identical value: no-op.
   * - already-persisted key, different value: a later disagreeing replica
   *   report — the persisted value is authoritative and is never
   *   overwritten; logs a warning (system-detected anomaly).
   * Unknown era (pruned, or a stale report for a not-yet-visible era): the
   * whole call is a silent no-op, nothing to record against.
   */
  async recordOffsets(channelId: string, eraIndex: number, offsets: Record<string, number>): Promise<void> {
    if (Object.keys(offsets).length === 0) return;
    return this.serialize(async () => {
      const row = await this.db
        .selectFrom('restream_switcher_eras')
        .select('offsets')
        .where('channel_id', '=', channelId)
        .where('era_index', '=', eraIndex)
        .executeTakeFirst();
      if (!row) return;

      let prevOffsets: Record<string, number> | null = null;
      if (eraIndex > 0) {
        const prevRow = await this.db
          .selectFrom('restream_switcher_eras')
          .select('offsets')
          .where('channel_id', '=', channelId)
          .where('era_index', '=', eraIndex - 1)
          .executeTakeFirst();
        if (prevRow) prevOffsets = JSON.parse(prevRow.offsets) as Record<string, number>;
      }

      const persisted = JSON.parse(row.offsets) as Record<string, number>;
      let changed = false;
      const conflicts: string[] = [];
      for (const [variant, value] of Object.entries(offsets)) {
        const existing = persisted[variant];
        if (existing === undefined) {
          const prevValue = prevOffsets?.[variant];
          if (prevValue !== undefined && value < prevValue) {
            this.events.log({
              type: 'warning',
              service: 'restreamer',
              source: 'switcher',
              message: `era offsets regression rejected: channel ${channelId} era ${eraIndex} variant "${variant}" reported ${value} < previous era's ${prevValue}`,
            });
            continue;
          }
          persisted[variant] = value;
          changed = true;
        } else if (existing !== value) {
          conflicts.push(`${variant}: persisted ${existing}, reported ${value}`);
        }
      }
      if (changed) {
        await this.db
          .updateTable('restream_switcher_eras')
          .set({ offsets: JSON.stringify(persisted) })
          .where('channel_id', '=', channelId)
          .where('era_index', '=', eraIndex)
          .execute();
      }
      if (conflicts.length > 0) {
        this.events.log({
          type: 'warning',
          service: 'restreamer',
          source: 'switcher',
          message: `era offsets conflict: channel ${channelId} era ${eraIndex}: ${conflicts.join('; ')} — keeping persisted value`,
        });
      }
    });
  }
}
