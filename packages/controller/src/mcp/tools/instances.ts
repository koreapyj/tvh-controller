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

import type { ChannelOption, RecordingGroup } from '@tvhc/shared';
import { z } from 'zod';
import { p } from '../inject.js';
import { READ, instanceId, page, pageShape, tool, type ToolDef } from './common.js';

const dvrState = z.enum(['upcoming', 'finished', 'failed']);

export const instanceTools: ToolDef[] = [
  tool({
    name: 'list_instances',
    description:
      'List every configured tvheadend instance (zone) with reachability, version, recording counts and rclone/restreamer availability.',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/instances' }),
  }),
  tool({
    name: 'list_channels',
    description:
      'List channels merged across instances by name + number identity, with the instances carrying each channel and its EIT zone offset.',
    input: { ...pageShape },
    annotations: READ,
    run: async (a, api) =>
      page(await api<ChannelOption[]>({ method: 'GET', url: '/api/channels' }), a.offset, a.limit),
  }),
  tool({
    name: 'get_instance_overview',
    description:
      'Dashboard overview of one instance: recording counts, tuner inputs with signal stats, active subscriptions, next recordings, conflict windows.',
    input: { instanceId },
    annotations: READ,
    run: (a, api) => api({ method: 'GET', url: `/api/instances/${p(a.instanceId)}/overview` }),
  }),
  tool({
    name: 'list_instance_recordings',
    description:
      'DVR entries of ONE instance in a state, flattened from rule groups (each item carries its rule label and masterRuleId). For the cross-instance deduplicated view use search_recordings.',
    input: { instanceId, state: dvrState.optional().describe('default upcoming'), ...pageShape },
    annotations: READ,
    run: async (a, api) => {
      const groups = await api<RecordingGroup[]>({
        method: 'GET',
        url: `/api/instances/${p(a.instanceId)}/recordings`,
        query: { state: a.state },
      });
      const flat = groups.flatMap((g) =>
        g.entries.map((e) => ({ rule: g.label, masterRuleId: g.masterRuleId, ...e })),
      );
      return page(flat, a.offset, a.limit);
    },
  }),
  tool({
    name: 'get_instance_conflicts',
    description: 'Predicted tuner-conflict / low-margin windows for upcoming recordings on one instance.',
    input: { instanceId },
    annotations: READ,
    run: (a, api) => api({ method: 'GET', url: `/api/instances/${p(a.instanceId)}/conflicts` }),
  }),
];
