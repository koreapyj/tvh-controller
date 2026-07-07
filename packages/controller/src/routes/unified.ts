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
  type RecordingIdentity,
  type RuleInstances,
  type UnifiedCopy,
  type UnifiedGroup,
  type UnifiedItem,
} from '@tvhc/shared';
import type { AppContext } from './context.js';
import { materializeScope } from '../sync/resolve.js';

interface ItemAcc extends UnifiedItem {
  label: string;
  ruleComment: string;
  /** dvr uuids of all copies, for upload matching */
  uuids: Set<string>;
}

/**
 * Unified recordings across all instances: the same broadcast (matched by
 * channel + time overlap, robust to EIT title revisions) appears once with
 * its per-instance copies side by side — which also makes a copy MISSING on
 * one zone immediately visible.
 */
export function registerUnifiedRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { state?: 'upcoming' | 'finished' | 'failed' } }>(
    '/api/recordings',
    async (req) => {
      const state =
        req.query.state === 'finished' || req.query.state === 'failed'
          ? req.query.state
          : 'upcoming';
      const items: ItemAcc[] = [];

      // controller rule names take precedence over the instance-side names:
      // a bound rule may not have received a rename yet (e.g. right after a
      // split-into-clone), and filters must match the controller's names
      const masterByBinding = new Map<
        string,
        { name: string; comment: string; instances: RuleInstances }
      >();
      if (ctx.db && ctx.sync) {
        const [bindings, resolved] = await Promise.all([
          ctx.db
            .selectFrom('rule_bindings')
            .select(['instance_id', 'tvh_uuid', 'master_rule_id'])
            .execute(),
          ctx.sync.listResolved(),
        ]);
        const byId = new Map(resolved.map((r) => [r.id, r]));
        for (const b of bindings) {
          const master = byId.get(b.master_rule_id);
          if (master) {
            masterByBinding.set(`${b.instance_id}:${b.tvh_uuid}`, {
              name: master.name,
              comment: master.effective?.comment ?? '',
              instances: master.instances,
            });
          }
        }
      }

      for (const snap of ctx.cache.all()) {
        const entries =
          state === 'upcoming' ? snap.upcoming : state === 'finished' ? snap.finished : snap.failed;
        // autorec_caption renders "name (comment)" — resolve the rule itself
        // so name and comment stay separate (filters match by name only)
        const autorecByUuid = new Map(
          snap.autorecs.map((a) => [a.uuid, { name: a.name ?? '', comment: a.comment ?? '' }]),
        );
        // channel number is resolved by instance-local uuid only — never by name
        const channelNumberByUuid = new Map(
          (snap.topology?.channels ?? []).map((c) => [c.uuid, c.number ?? null]),
        );
        const conflictByEntry = new Map<string, 'conflict' | 'low-margin'>();
        for (const w of snap.conflicts) {
          for (const uuid of w.entryUuids) {
            if (w.level === 'conflict' || !conflictByEntry.has(uuid)) {
              conflictByEntry.set(uuid, w.level);
            }
          }
        }

        for (const e of entries) {
          const ident: RecordingIdentity = {
            channelname: e.channelname ?? '',
            start: e.start,
            stop: e.stop,
            title: e.disp_title,
          };
          // failures are per-instance events — merging them across zones
          // would hide which instance failed, so each failure is its own row
          let item =
            state === 'failed'
              ? undefined
              : items.find((it) =>
                  compareRecordings(
                    { channelname: it.channelname, start: it.start, stop: it.stop, title: it.title },
                    ident,
                    ctx.config.overlapThreshold,
                  ).isDuplicate,
                );
          const channelNumber = e.channel ? (channelNumberByUuid.get(e.channel) ?? null) : null;
          if (!item) {
            const master = e.autorec
              ? masterByBinding.get(`${snap.summary.id}:${e.autorec}`)
              : undefined;
            const rule = e.autorec ? autorecByUuid.get(e.autorec) : undefined;
            item = {
              title: e.disp_title ?? '',
              subtitle: e.disp_subtitle,
              channelname: e.channelname ?? '',
              channelNumber,
              start: e.start,
              stop: e.stop,
              copies: [],
              scopeInstanceIds: master
                ? materializeScope(master.instances, ctx.cache.tvhIds())
                : undefined,
              label: e.autorec
                ? master?.name || rule?.name || e.autorec_caption || 'Unnamed rule'
                : 'Manual / other',
              ruleComment: master?.comment ?? rule?.comment ?? '',
              uuids: new Set(),
            };
            items.push(item);
          } else if (item.channelNumber == null && channelNumber != null) {
            // backfill when an earlier-seen instance didn't resolve a number
            // for this same broadcast
            item.channelNumber = channelNumber;
          }
          const copy: UnifiedCopy = {
            instanceId: snap.summary.id,
            uuid: e.uuid,
            enabled: e.enabled !== false,
            fromRule: !!e.autorec,
            schedStatus: e.sched_status,
            status: e.status,
            filesize: e.filesize ?? null,
            filename: e.filename ?? null,
            errors: e.errors ?? 0,
            dataErrors: e.data_errors ?? 0,
            pri: e.pri,
            comment: e.comment,
            startExtra: e.start_extra,
            stopExtra: e.stop_extra,
            removal: e.removal,
            retention: e.retention,
          };
          const level = conflictByEntry.get(e.uuid);
          if (level) copy.conflictLevel = level;
          item.copies.push(copy);
          item.uuids.add(e.uuid);
        }
      }

      // upload state (one per broadcast, whichever instance claimed it)
      const uploads = ctx.ledger ? await ctx.ledger.allRecent() : [];
      for (const item of items) {
        const upload = uploads.find(
          (u) =>
            (u.status !== 'failed' && u.status !== 'cancelled' && u.status !== 'superseded') &&
            (item.uuids.has(u.dvrUuid) ||
              compareRecordings(
                { channelname: item.channelname, start: item.start, stop: item.stop, title: item.title },
                { channelname: u.channelname, start: u.start, stop: u.stop, title: u.title ?? undefined },
                ctx.config.overlapThreshold,
              ).isDuplicate),
        );
        if (upload) {
          item.upload = { uploadId: upload.id, status: upload.status, byInstanceId: upload.instanceId };
        }
      }

      items.sort((a, b) => (state === 'upcoming' ? a.start - b.start : b.start - a.start));

      const groups = new Map<string, UnifiedGroup>();
      for (const item of items) {
        let group = groups.get(item.label);
        if (!group) {
          group = { label: item.label, comment: item.ruleComment, items: [] };
          groups.set(item.label, group);
        }
        if (!group.comment && item.ruleComment) group.comment = item.ruleComment;
        const { label: _label, ruleComment: _comment, uuids: _uuids, ...pub } = item;
        group.items.push(pub);
      }
      return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
    },
  );
}
