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
import {
  chanKey,
  compareRecordings,
  type ConflictWindow,
  type EpgChannel,
  type EpgRecordRequest,
  type TvhDvrConfig,
  type TvhEpgEvent,
  type UnifiedEpgEvent,
} from '@tvhc/shared';
import { httpError, type AppContext } from './context.js';

export interface EpgMergeInput {
  instanceId: string;
  reachable: boolean;
  conflicts: ConflictWindow[];
  epg: TvhEpgEvent[];
}

/** dedup-candidate bucketing granularity (see mergeEpg) */
const SLOT_SECONDS = 1800;

/** tvheadend channel numbers are like "5.1" or "700" - parse for sorting */
function parseChannelNo(s?: string | null): number | null {
  if (!s) return null;
  const n = Number.parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** prefer a reachable instance not already over-capacity during the broadcast */
function pickRecommended(inputs: EpgMergeInput[], item: UnifiedEpgEvent): string | null {
  const byId = new Map(inputs.map((i) => [i.instanceId, i]));
  const reachable = item.copies.filter((c) => byId.get(c.instanceId)?.reachable);
  if (!reachable.length) return null;
  const free = reachable.find(
    (c) =>
      !(byId.get(c.instanceId)?.conflicts ?? []).some(
        (w) => w.level === 'conflict' && w.start < item.stop && w.stop > item.start,
      ),
  );
  return (free ?? reachable[0]!).instanceId;
}

/**
 * Merge each instance's EPG into one list: the same broadcast on a shared
 * channel (channel + time overlap, robust to EIT title revisions) becomes a
 * single `UnifiedEpgEvent` carrying its per-instance copies. Channels are keyed
 * by name + number so subchannels stay separate even when they share a name.
 */
export function mergeEpg(
  inputs: EpgMergeInput[],
  threshold: number,
  now: number = Date.now() / 1000,
): UnifiedEpgEvent[] {
  const items: UnifiedEpgEvent[] = [];
  // index by channel identity + coarse start-time slot so dedup only compares
  // against a handful of candidates. A broadcast's start differs by at most an
  // EIT revision (seconds/minutes) across instances, so a slot +/- 1 covers it.
  const index = new Map<string, UnifiedEpgEvent[]>();
  const bucketKey = (name: string, number: string | null, slot: number) =>
    `${chanKey(name, number)} ${slot}`;
  for (const inp of inputs) {
    if (!inp.reachable) continue;
    for (const e of inp.epg) {
      const number = e.channelNumber ?? null;
      const slot = Math.floor(e.start / SLOT_SECONDS);
      let item: UnifiedEpgEvent | undefined;
      for (let s = slot - 1; s <= slot + 1 && !item; s++) {
        item = index.get(bucketKey(e.channelName, number, s))?.find(
          (it) =>
            compareRecordings(
              { channelname: it.channelName, start: it.start, stop: it.stop, title: it.title },
              { channelname: e.channelName, start: e.start, stop: e.stop, title: e.title },
              threshold,
            ).isDuplicate,
        );
      }
      if (!item) {
        item = {
          channelName: e.channelName,
          channelNumber: number,
          title: e.title ?? '',
          subtitle: e.subtitle,
          start: e.start,
          stop: e.stop,
          details: e,
          copies: [],
          recommendedInstanceId: null,
        };
        items.push(item);
        const key = bucketKey(item.channelName, number, slot);
        const bucket = index.get(key);
        if (bucket) bucket.push(item);
        else index.set(key, [item]);
      }
      item.copies.push({
        instanceId: inp.instanceId,
        eventId: e.eventId,
        dvrUuid: e.dvrUuid,
        dvrState: e.dvrState,
      });
      if (!item.details.description && e.description) item.details = e;
    }
  }
  for (const item of items) item.recommendedInstanceId = pickRecommended(inputs, item);
  // currently-airing programmes first, ordered by channel number (a "what's on
  // now" view); upcoming programmes after, ordered by start time
  const chno = (e: UnifiedEpgEvent) => parseChannelNo(e.channelNumber) ?? Number.POSITIVE_INFINITY;
  const running = (e: UnifiedEpgEvent) => e.start <= now && e.stop > now;
  items.sort((a, b) => {
    const ra = running(a) ? 0 : 1;
    const rb = running(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (ra === 0) return chno(a) - chno(b) || a.start - b.start;
    return a.start - b.start || chno(a) - chno(b);
  });
  return items;
}

function requireInstance(ctx: AppContext, id: string): void {
  if (!ctx.cache.has(id)) {
    throw httpError(404, `unknown instance "${id}"`);
  }
}

/** tvheadend's default DVR profile has an empty name; '' lets tvh pick the default */
function defaultDvrConfigUuid(configs: TvhDvrConfig[]): string {
  const def = configs.find((c) => !c.name) ?? configs[0];
  return def?.uuid ?? '';
}

/**
 * Unified EPG across instances. The same broadcast on a shared channel appears
 * once with its per-instance copies, mirroring the unified recordings view.
 * Served from the per-instance cache (`snap.epg`), which the poller keeps fresh
 * via the comet `epg` WebSocket push.
 */
export function registerEpgRoutes(app: FastifyInstance, ctx: AppContext): void {
  // The full cross-instance merge is expensive (tens of thousands of events).
  // Compute it once and reuse it across the many small page requests the
  // frontend's infinite scroll makes; invalidate only when the underlying data
  // changes (EPG refresh, conflict recompute, or reachability flip).
  let cached: UnifiedEpgEvent[] | null = null;
  ctx.bus.subscribe((e) => {
    if (e.type === 'epg' || e.type === 'conflicts' || e.type === 'instance-status') cached = null;
  });

  function mergedAll(): UnifiedEpgEvent[] {
    if (cached) return cached;
    const inputs: EpgMergeInput[] = ctx.cache.all().map((s) => ({
      instanceId: s.summary.id,
      reachable: s.summary.reachable,
      conflicts: s.conflicts,
      epg: s.epg,
    }));
    cached = mergeEpg(inputs, ctx.config.overlapThreshold);
    return cached;
  }

  // distinct channels present in the EPG (name + number), for the filter UI
  app.get('/api/epg/channels', async (): Promise<EpgChannel[]> => {
    const seen = new Map<string, EpgChannel>();
    for (const snap of ctx.cache.all()) {
      if (!snap.summary.reachable) continue;
      for (const e of snap.epg) {
        const number = e.channelNumber ?? null;
        const key = chanKey(e.channelName, number);
        if (!seen.has(key)) seen.set(key, { name: e.channelName, number });
      }
    }
    return [...seen.values()].sort(
      (a, b) =>
        (parseChannelNo(a.number) ?? Infinity) - (parseChannelNo(b.number) ?? Infinity) ||
        a.name.localeCompare(b.name),
    );
  });

  // apply the same channel + title filters the EPG page uses, so /api/epg and
  // /api/epg/index agree on the list a jump is computed against
  function filteredList(channelsRaw?: string, q?: string): UnifiedEpgEvent[] {
    // `channels` is a JSON array of chanKey() strings (name + number)
    let keys: Set<string> | null = null;
    if (channelsRaw) {
      try {
        const parsed = JSON.parse(channelsRaw) as unknown;
        if (Array.isArray(parsed) && parsed.length) keys = new Set(parsed.map(String));
      } catch {
        /* ignore malformed filter */
      }
    }
    const ql = q?.toLowerCase();
    let list = mergedAll();
    if (keys) list = list.filter((e) => keys!.has(chanKey(e.channelName, e.channelNumber)));
    if (ql) list = list.filter((e) => `${e.title} ${e.subtitle ?? ''}`.toLowerCase().includes(ql));
    return list;
  }

  app.get<{ Querystring: { channels?: string; q?: string; offset?: string; limit?: string } }>(
    '/api/epg',
    async (req) => {
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const list = filteredList(req.query.channels, req.query.q);
      // paginated for the frontend's infinite scroll
      return { items: list.slice(offset, offset + limit), total: list.length };
    },
  );

  // Row index of the first programme starting at/after `at` (unix seconds), for
  // the EPG "jump to time" control. The list is server-paginated, so the client
  // can't compute this itself. Upcoming events are start-sorted, so this lands
  // on the boundary; if nothing starts that late, returns total (end of list).
  app.get<{ Querystring: { channels?: string; q?: string; at?: string } }>(
    '/api/epg/index',
    async (req) => {
      const list = filteredList(req.query.channels, req.query.q);
      const at = Number(req.query.at);
      if (!Number.isFinite(at)) return { index: 0, total: list.length };
      const idx = list.findIndex((e) => e.start >= at);
      return { index: idx === -1 ? list.length : idx, total: list.length };
    },
  );

  app.get<{ Params: { instanceId: string; eventId: string } }>(
    '/api/epg/event/:instanceId/:eventId',
    async (req) => {
      requireInstance(ctx, req.params.instanceId);
      const poller = ctx.pollers.get(req.params.instanceId);
      const event = await poller?.client.epgEventLoad(Number(req.params.eventId));
      if (!event) {
        throw httpError(404, 'event not found');
      }
      return event;
    },
  );

  app.post<{ Body: EpgRecordRequest }>('/api/epg/record', async (req) => {
    const { instanceId, eventId } = req.body ?? ({} as EpgRecordRequest);
    requireInstance(ctx, instanceId);
    const poller = ctx.pollers.get(instanceId);
    if (!poller) {
      throw httpError(404, `unknown instance "${instanceId}"`);
    }
    const cfgUuid = defaultDvrConfigUuid(ctx.cache.get(instanceId).topology?.dvrConfigs ?? []);
    const uuid = await poller.client.dvrEntryCreateByEvent(Number(eventId), cfgUuid);
    return { uuid };
  });
}
