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

import type { UnifiedEpgEvent, UnifiedGroup } from '@tvhc/shared';
import { chanKey } from '@tvhc/shared';
import { z } from 'zod';
import { p } from '../inject.js';
import {
  DESTRUCTIVE,
  READ,
  READ_REMOTE,
  WRITE,
  channelIdentity,
  instanceId,
  page,
  pageShape,
  sameChannel,
  tool,
  type ToolDef,
} from './common.js';

const unixSec = z.number().int().describe('unix seconds');

export const recordingTools: ToolDef[] = [
  tool({
    name: 'search_recordings',
    description:
      'Unified recordings across all instances: one item per broadcast (deduplicated by channel + time overlap) with a per-instance `copies` list (status, size, stream/data error counts). Failures are never merged — each failure is its own item. Filters are exact-match and combine with AND.',
    input: {
      state: z.enum(['upcoming', 'finished', 'failed']).optional().describe('default upcoming'),
      rule: z.string().optional().describe('exact autorec rule name (group label)'),
      channel: channelIdentity.optional(),
      from: unixSec.optional().describe('only broadcasts ending after this (unix seconds)'),
      to: unixSec.optional().describe('only broadcasts starting before this (unix seconds)'),
      title: z.string().optional().describe('case-insensitive substring of the title'),
      ...pageShape,
    },
    annotations: READ,
    run: async (a, api) => {
      const groups = await api<UnifiedGroup[]>({
        method: 'GET',
        url: '/api/recordings',
        query: { state: a.state },
      });
      const title = a.title?.toLowerCase();
      const flat = groups
        .filter((g) => a.rule === undefined || g.label === a.rule)
        .flatMap((g) => g.items.map((i) => ({ rule: g.label, ruleComment: g.comment, ...i })))
        .filter(
          (i) =>
            (a.channel === undefined || sameChannel(a.channel, i.channelname, i.channelNumber)) &&
            (a.from === undefined || i.stop > a.from) &&
            (a.to === undefined || i.start < a.to) &&
            (title === undefined || i.title.toLowerCase().includes(title)),
        );
      return page(flat, a.offset, a.limit);
    },
  }),
  tool({
    name: 'edit_recordings',
    description:
      'Batch-edit DVR entries on tvheadend (read-back verified). Each op targets uuids on one instance. Allowed fields: enabled, comment, pri, start_extra, stop_extra, removal, retention.',
    input: {
      ops: z
        .array(
          z.object({
            instanceId,
            uuids: z.array(z.string()).min(1),
            fields: z.record(z.string(), z.unknown()),
          }),
        )
        .min(1),
    },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: '/api/recordings/edit', body: { ops: a.ops } }),
  }),
  tool({
    name: 'delete_recordings',
    description:
      'Delete DVR entries on tvheadend. For FINISHED recordings this also deletes the recorded files. Irreversible.',
    input: { targets: z.array(z.object({ instanceId, uuid: z.string() })).min(1) },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'POST', url: '/api/recordings/delete', body: { targets: a.targets } }),
  }),
  tool({
    name: 'list_epg_channels',
    description: 'Distinct EPG channels (name + number) available for the EPG filter.',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/epg/channels' }),
  }),
  tool({
    name: 'search_epg',
    description:
      'Unified EPG across instances (deduplicated by channel + time overlap), upcoming events sorted by start. Each event lists per-instance copies (eventId, existing DVR state) and a capacity-aware recommendedInstanceId for recording.',
    input: {
      channels: z.array(channelIdentity).optional().describe('restrict to these channels'),
      q: z.string().optional().describe('case-insensitive substring of title + subtitle'),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional().describe('default 50, max 500'),
    },
    annotations: READ,
    run: (a, api) =>
      api<{ items: UnifiedEpgEvent[]; total: number }>({
        method: 'GET',
        url: '/api/epg',
        query: {
          channels: a.channels ? JSON.stringify(a.channels.map((c) => chanKey(c.name, c.number))) : undefined,
          q: a.q,
          offset: a.offset,
          limit: a.limit ?? 50,
        },
      }),
  }),
  tool({
    name: 'get_epg_event',
    description: 'Full tvheadend EPG event details (fetched live from the instance).',
    input: { instanceId, eventId: z.number().int() },
    annotations: READ_REMOTE,
    run: (a, api) => api({ method: 'GET', url: `/api/epg/event/${p(a.instanceId)}/${p(a.eventId)}` }),
  }),
  tool({
    name: 'record_epg_event',
    description:
      'Schedule a one-off recording of an EPG event on one instance (creates a tvheadend DVR entry). Use the eventId of that instance\'s copy from search_epg.',
    input: { instanceId, eventId: z.number().int() },
    annotations: WRITE,
    run: (a, api) =>
      api({ method: 'POST', url: '/api/epg/record', body: { instanceId: a.instanceId, eventId: a.eventId } }),
  }),
];
