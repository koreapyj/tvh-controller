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
  compareRecordings,
  type DvrState,
  type InstanceOverview,
  type RecordingGroup,
  type RecordingItem,
  type TvhDvrEntry,
} from '@tvhc/shared';
import { httpError, type AppContext } from './context.js';

function requireInstance(ctx: AppContext, id: string): void {
  if (!ctx.cache.has(id)) {
    throw httpError(404, `unknown instance "${id}"`);
  }
}

export function registerInstanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/instances', async () => ctx.cache.all().map((s) => s.summary));

  /** channels across all instances merged by name (for rule editor autocomplete) */
  app.get('/api/channels', async () => {
    const byName = new Map<
      string,
      { name: string; number: number | null; instances: string[]; eitOffsetMinutes: number | null }
    >();
    for (const snap of ctx.cache.all()) {
      const topo = snap.topology;
      if (!topo) continue;
      const serviceMux = new Map(topo.services.map((s) => [s.uuid, s.multiplex_uuid ?? s.multiplex]));
      const muxNetwork = new Map(topo.muxes.map((m) => [m.uuid, m.network_uuid ?? m.network]));
      const networkLocaltime = new Map(topo.networks.map((n) => [n.uuid, n.localtime]));

      // network "EIT time offset": 0 = UTC, 1 = server-local, else minutes
      const eitOffsetOf = (ch: { services?: string[] }): number | null => {
        for (const svc of ch.services ?? []) {
          const mux = serviceMux.get(svc);
          const net = mux ? muxNetwork.get(mux) : undefined;
          const localtime = net ? networkLocaltime.get(net) : undefined;
          if (localtime === undefined) continue;
          if (localtime === 0) return 0;
          if (localtime === 1) return snap.summary.serverOffsetMinutes;
          return localtime;
        }
        return null;
      };

      for (const ch of topo.channels) {
        if (!ch.name) continue;
        let entry = byName.get(ch.name);
        if (!entry) {
          entry = { name: ch.name, number: ch.number ?? null, instances: [], eitOffsetMinutes: null };
          byName.set(ch.name, entry);
        }
        if (entry.number === null && ch.number !== undefined) entry.number = ch.number;
        if (entry.eitOffsetMinutes === null) entry.eitOffsetMinutes = eitOffsetOf(ch);
        if (!entry.instances.includes(snap.summary.id)) entry.instances.push(snap.summary.id);
      }
    }
    return [...byName.values()].sort(
      (a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.name.localeCompare(b.name),
    );
  });

  app.get<{ Params: { id: string } }>('/api/instances/:id/overview', async (req) => {
    requireInstance(ctx, req.params.id);
    const snap = ctx.cache.get(req.params.id);
    const overview: InstanceOverview = {
      instance: snap.summary,
      counts: {
        upcoming: snap.upcoming.length,
        finished: snap.finished.length,
        failed: snap.failed.length,
      },
      inputs: snap.inputs,
      subscriptions: snap.subscriptions,
      nextRecordings: [...snap.upcoming]
        .sort((a, b) => (a.start_real ?? a.start) - (b.start_real ?? b.start))
        .slice(0, 5),
      conflicts: snap.conflicts,
    };
    return overview;
  });

  app.get<{ Params: { id: string }; Querystring: { state?: DvrState } }>(
    '/api/instances/:id/recordings',
    async (req) => {
      requireInstance(ctx, req.params.id);
      const snap = ctx.cache.get(req.params.id);
      const state: DvrState = req.query.state ?? 'upcoming';
      const entries =
        state === 'upcoming' ? snap.upcoming : state === 'finished' ? snap.finished : snap.failed;

      const uploads = ctx.ledger ? await ctx.ledger.allRecent() : [];
      const conflictByEntry = new Map<string, 'conflict' | 'low-margin'>();
      for (const w of snap.conflicts) {
        for (const uuid of w.entryUuids) {
          if (w.level === 'conflict' || !conflictByEntry.has(uuid)) {
            conflictByEntry.set(uuid, w.level);
          }
        }
      }

      const bindings = ctx.db
        ? await ctx.db
            .selectFrom('rule_bindings')
            .select(['master_rule_id', 'tvh_uuid'])
            .where('instance_id', '=', req.params.id)
            .execute()
        : [];
      const masterByTvhUuid = new Map(bindings.map((b) => [b.tvh_uuid, b.master_rule_id]));

      const decorate = (e: TvhDvrEntry): RecordingItem => {
        const item: RecordingItem = { ...e, state };
        const upload = uploads.find(
          (u) =>
            (u.instanceId === req.params.id && u.dvrUuid === e.uuid) ||
            compareRecordings(
              { channelname: e.channelname ?? '', start: e.start, stop: e.stop, title: e.disp_title },
              { channelname: u.channelname, start: u.start, stop: u.stop, title: u.title ?? undefined },
              ctx.config.overlapThreshold,
            ).isDuplicate,
        );
        if (upload && upload.status !== 'failed' && upload.status !== 'cancelled') {
          item.upload = {
            uploadId: upload.id,
            status: upload.status,
            byInstanceId: upload.instanceId,
            possibleDuplicate: false,
          };
        }
        const level = conflictByEntry.get(e.uuid);
        if (level) item.conflictLevel = level;
        return item;
      };

      const groups = new Map<string, RecordingGroup>();
      for (const e of entries) {
        const key = e.autorec || 'manual';
        let group = groups.get(key);
        if (!group) {
          group = {
            masterRuleId: e.autorec ? (masterByTvhUuid.get(e.autorec) ?? null) : null,
            label: e.autorec ? e.autorec_caption || 'Unnamed rule' : 'Manual / other',
            entries: [],
          };
          groups.set(key, group);
        }
        group.entries.push(decorate(e));
      }
      for (const g of groups.values()) {
        g.entries.sort((a, b) => (b.start_real ?? b.start) - (a.start_real ?? a.start));
        if (state === 'upcoming') g.entries.reverse();
      }
      return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    },
  );

  app.get<{ Params: { id: string } }>('/api/instances/:id/conflicts', async (req) => {
    requireInstance(ctx, req.params.id);
    return ctx.cache.get(req.params.id).conflicts;
  });
}
