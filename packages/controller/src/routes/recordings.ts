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

import type { FastifyInstance } from 'fastify';
import type { RecordingBatchResult, RecordingEditOp, RecordingTarget, TvhDvrEntry } from '@tvhc/shared';
import { httpError, type AppContext } from './context.js';

/** writable DVR-entry fields a batch edit is allowed to touch (others are EPG-derived/read-only) */
const ALLOWED_FIELDS = new Set([
  'enabled',
  'comment',
  'pri',
  'start_extra',
  'stop_extra',
  'removal',
  'retention',
]);

/** all dvr uuids currently known on an instance (any state) */
function knownUuids(ctx: AppContext, instanceId: string): Set<string> {
  const snap = ctx.cache.get(instanceId);
  return new Set([...snap.upcoming, ...snap.finished, ...snap.failed].map((e) => e.uuid));
}

function entriesByUuid(ctx: AppContext, instanceId: string): Map<string, TvhDvrEntry> {
  const snap = ctx.cache.get(instanceId);
  return new Map(
    [...snap.upcoming, ...snap.finished, ...snap.failed].map((e) => [e.uuid, e]),
  );
}

/**
 * Returns a human description of the first field that did NOT take effect, or
 * null when the entry matches what we asked for. tvheadend may normalize values,
 * so an unverifiable (absent) field is skipped rather than treated as a failure.
 */
function fieldMismatch(entry: TvhDvrEntry, fields: Record<string, unknown>): string | null {
  for (const [k, want] of Object.entries(fields)) {
    if (k === 'enabled') {
      const actual = entry.enabled !== false;
      if (actual !== !!want) return `enabled=${actual}`;
      continue;
    }
    const cur = (entry as unknown as Record<string, unknown>)[k];
    if (cur === undefined || cur === null) continue; // can't verify
    if (typeof want === 'number') {
      if (Number(cur) !== Number(want)) return `${k}=${String(cur)}`;
    } else if (String(cur) !== String(want)) {
      return `${k}=${String(cur)}`;
    }
  }
  return null;
}

export function registerRecordingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Edit one or more recordings. Direct tvheadend writes, grouped per instance,
  // then read-back verified so a silently-failed write surfaces as an error
  // instead of leaving the UI out of sync with the instance.
  app.post<{ Body: { ops?: RecordingEditOp[] } }>('/api/recordings/edit', async (req) => {
    const ops = req.body?.ops;
    if (!Array.isArray(ops) || ops.length === 0) throw httpError(400, 'ops[] is required');

    const results: RecordingBatchResult[] = [];
    for (const op of ops) {
      const poller = ctx.pollers.get(op.instanceId);
      const uuids = Array.isArray(op.uuids) ? op.uuids : [];
      if (!poller) {
        for (const u of uuids) {
          results.push({ instanceId: op.instanceId, uuid: u, ok: false, error: 'unknown instance' });
        }
        continue;
      }

      // allowlist the fields (reject anything else outright — never pass arbitrary
      // idnode fields through to tvheadend)
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.fields ?? {})) {
        if (!ALLOWED_FIELDS.has(k)) throw httpError(400, `field "${k}" is not editable`);
        fields[k] = v;
      }
      if (Object.keys(fields).length === 0) continue; // nothing to write

      const known = knownUuids(ctx, op.instanceId);
      const valid: string[] = [];
      for (const u of uuids) {
        if (known.has(u)) valid.push(u);
        else results.push({ instanceId: op.instanceId, uuid: u, ok: false, error: 'unknown recording on this instance' });
      }
      if (valid.length === 0) continue;

      let writeErr: string | null = null;
      try {
        await poller.client.idnodeSave({ uuid: valid, ...fields });
      } catch (err) {
        writeErr = err instanceof Error ? err.message : String(err);
      }

      // refresh the cache from the instance, then verify each target
      await poller.pollDvrAndStatus().catch(() => {});
      const after = entriesByUuid(ctx, op.instanceId);
      for (const u of valid) {
        if (writeErr) {
          results.push({ instanceId: op.instanceId, uuid: u, ok: false, error: writeErr });
          continue;
        }
        const entry = after.get(u);
        if (!entry) {
          results.push({ instanceId: op.instanceId, uuid: u, ok: false, error: 'entry vanished after edit' });
          continue;
        }
        const bad = fieldMismatch(entry, fields);
        results.push(
          bad
            ? { instanceId: op.instanceId, uuid: u, ok: false, error: `change did not apply (${bad})` }
            : { instanceId: op.instanceId, uuid: u, ok: true },
        );
      }
    }
    return results;
  });

  // Delete recordings (and their files, for finished). Read-back verified: an
  // entry still present afterwards (e.g. an autorec re-created an upcoming one)
  // is reported as a failure rather than a false success.
  app.post<{ Body: { targets?: RecordingTarget[] } }>('/api/recordings/delete', async (req) => {
    const targets = req.body?.targets;
    if (!Array.isArray(targets) || targets.length === 0) throw httpError(400, 'targets[] is required');

    const byInstance = new Map<string, string[]>();
    for (const t of targets) {
      const list = byInstance.get(t.instanceId) ?? [];
      list.push(t.uuid);
      byInstance.set(t.instanceId, list);
    }

    const results: RecordingBatchResult[] = [];
    for (const [instanceId, uuids] of byInstance) {
      const poller = ctx.pollers.get(instanceId);
      if (!poller) {
        for (const u of uuids) results.push({ instanceId, uuid: u, ok: false, error: 'unknown instance' });
        continue;
      }
      const known = knownUuids(ctx, instanceId);
      const valid: string[] = [];
      for (const u of uuids) {
        if (known.has(u)) valid.push(u);
        else results.push({ instanceId, uuid: u, ok: false, error: 'unknown recording on this instance' });
      }
      if (valid.length === 0) continue;

      let writeErr: string | null = null;
      try {
        await poller.client.idnodeDelete(valid);
      } catch (err) {
        writeErr = err instanceof Error ? err.message : String(err);
      }

      await poller.pollDvrAndStatus().catch(() => {});
      const stillThere = knownUuids(ctx, instanceId);
      for (const u of valid) {
        if (writeErr) {
          results.push({ instanceId, uuid: u, ok: false, error: writeErr });
          continue;
        }
        results.push(
          stillThere.has(u)
            ? { instanceId, uuid: u, ok: false, error: 'still present after delete (an autorec rule may have re-created it)' }
            : { instanceId, uuid: u, ok: true },
        );
      }
    }
    return results;
  });

  // Instances (with no copy yet) where a broadcast could be recorded redundantly:
  // a reachable instance whose EPG carries the same channel + time slot. Returns
  // the matching event id so the caller can schedule it. Used by the Recordings
  // edit dialog to let you add an instance to an existing (upcoming) recording.
  app.post<{
    Body: { channelname?: string; start?: number; stop?: number; exclude?: string[] };
  }>('/api/recordings/add-candidates', async (req) => {
    const { channelname, start, stop, exclude } = req.body ?? {};
    if (!channelname || typeof start !== 'number' || typeof stop !== 'number') {
      throw httpError(400, 'channelname, start and stop are required');
    }
    const skip = new Set(exclude ?? []);
    const out: Array<{ instanceId: string; eventId: number }> = [];
    for (const snap of ctx.cache.all()) {
      if (skip.has(snap.summary.id) || !snap.summary.reachable) continue;
      // the broadcast on this channel with the largest temporal overlap (the
      // recording window may be padded, so pick the dominant event, not any that
      // barely grazes the padding)
      let best: { eventId: number; overlap: number } | null = null;
      for (const e of snap.epg) {
        if (e.channelName !== channelname) continue;
        const overlap = Math.min(stop, e.stop) - Math.max(start, e.start);
        if (overlap > 0 && (!best || overlap > best.overlap)) {
          best = { eventId: e.eventId, overlap };
        }
      }
      if (best) out.push({ instanceId: snap.summary.id, eventId: best.eventId });
    }
    return out;
  });
}
