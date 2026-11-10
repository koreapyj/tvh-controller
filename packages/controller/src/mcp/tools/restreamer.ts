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

import type { RestreamChannelWithStatus } from '@tvhc/shared';
import { z } from 'zod';
import { p } from '../inject.js';
import {
  DESTRUCTIVE,
  READ,
  READ_REMOTE,
  WRITE,
  WRITE_IDEMPOTENT,
  channelIdentity,
  instanceId,
  nodeId,
  page,
  pageShape,
  passthroughObject,
  sameChannel,
  tool,
  type ToolDef,
} from './common.js';

const node = { instanceId, nodeId };
const sessionName = z.string().min(1).describe('session name on the node (see list_restreamer_nodes sessions)');
const lines = z.number().int().min(1).optional().describe('number of trailing log lines');
const channelId = z.string().min(1).describe('restream channel id (see list_restream_channels)');
const profileId = z.string().min(1).describe('restream profile id (see list_restream_profiles)');
const placementId = z.string().min(1).describe('placement id (from a channel\'s placements)');
const playlistId = z.string().min(1).describe('playlist id (see list_restream_playlists)');
const force = z.boolean().optional().describe('bypass availability / mid-procedure guards');

const channelNumber = z
  .string()
  .nullable()
  .describe(
    'channel NUMBER paired with channelName, a STRING exactly as tvheadend reports it (e.g. "9.1"); null = the LOWEST-numbered channel with that name on each instance',
  );

const channelPatch = {
  channelName: z.string().min(1).optional(),
  channelNumber: channelNumber.optional(),
  profileId: profileId.optional(),
  slug: z.string().min(1).optional().describe('output dir on every node + public URL segment'),
  enabled: z.boolean().optional(),
  comment: z.string().nullable().optional(),
  playlistIds: z.array(z.string()).optional(),
  force,
};

const placementMode = z.enum(['hot', 'cold']);
const placementInput = z.object({
  instanceId,
  nodeId,
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
  mode: placementMode.optional().describe('hot = always encoding; cold = started on failover'),
  profileId: z.string().nullable().optional().describe('per-placement profile override; null = channel profile'),
  programNumber: z.number().nullable().optional(),
  force,
});

const probeThresholds = z.object({
  timeoutSeconds: z.number(),
  periodSeconds: z.number(),
  successThreshold: z.number().int(),
  failureThreshold: z.number().int(),
});

const tsErrorThresholds = z.object({
  maxErrors: z.number().int().min(0),
  periodSeconds: z.number(),
  successThreshold: z.number().int(),
  failureThreshold: z.number().int(),
});

export const restreamerTools: ToolDef[] = [
  // ---------- nodes ----------
  tool({
    name: 'list_restreamer_nodes',
    description:
      'Status of every restreamer node (reachability, version, sessions, probes, pending pushes) and every connected HLS switcher replica.',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/restreamer/nodes' }),
  }),
  tool({
    name: 'push_restreamer_node',
    description: 'Force-push the desired session document to one restreamer node.',
    input: node,
    annotations: WRITE_IDEMPOTENT,
    run: (a, api) =>
      api({ method: 'POST', url: `/api/restreamer/nodes/${p(a.instanceId)}/${p(a.nodeId)}/push` }),
  }),
  tool({
    name: 'restart_restreamer_session',
    description: 'Restart one encoding session on a node (interrupts that live output).',
    input: { ...node, name: sessionName },
    annotations: DESTRUCTIVE,
    run: (a, api) =>
      api({
        method: 'POST',
        url: `/api/restreamer/nodes/${p(a.instanceId)}/${p(a.nodeId)}/sessions/${p(a.name)}/restart`,
      }),
  }),
  tool({
    name: 'reset_restreamer_session_restarts',
    description: 'Reset the restart counter / backoff of one session on a node.',
    input: { ...node, name: sessionName },
    annotations: WRITE_IDEMPOTENT,
    run: (a, api) =>
      api({
        method: 'POST',
        url: `/api/restreamer/nodes/${p(a.instanceId)}/${p(a.nodeId)}/sessions/${p(a.name)}/restarts/reset`,
      }),
  }),
  tool({
    name: 'get_restreamer_session_log',
    description: 'Recent log lines of one session (ffmpeg/supervisor output), fetched live from the node.',
    input: { ...node, name: sessionName, lines },
    annotations: READ_REMOTE,
    run: (a, api) =>
      api({
        method: 'GET',
        url: `/api/restreamer/nodes/${p(a.instanceId)}/${p(a.nodeId)}/sessions/${p(a.name)}/log`,
        query: { lines: a.lines },
      }),
  }),
  tool({
    name: 'get_restreamer_node_log',
    description: 'Recent daemon log lines of one restreamer node, fetched live from the node.',
    input: { ...node, lines },
    annotations: READ_REMOTE,
    run: (a, api) =>
      api({
        method: 'GET',
        url: `/api/restreamer/nodes/${p(a.instanceId)}/${p(a.nodeId)}/log`,
        query: { lines: a.lines },
      }),
  }),
  tool({
    name: 'get_node_probe_settings',
    description: 'Liveness / underspeed / lag / tsError probe thresholds of one node.',
    input: node,
    annotations: READ,
    run: (a, api) =>
      api({ method: 'GET', url: `/api/restreamer/nodes/${p(a.instanceId)}/${p(a.nodeId)}/probes` }),
  }),
  tool({
    name: 'set_node_probe_settings',
    description:
      'Replace the probe thresholds of one node (liveness, underspeed, lag required; tsError optional — omitted = defaults: maxErrors 0, period 60s, success 3, failure 0 = measure-only). tsError.maxErrors = allowed ffmpeg "Packet corrupt" count per period.',
    input: {
      ...node,
      liveness: probeThresholds,
      underspeed: probeThresholds,
      lag: probeThresholds,
      tsError: tsErrorThresholds.optional(),
    },
    annotations: WRITE_IDEMPOTENT,
    run: ({ instanceId: i, nodeId: n, ...body }, api) =>
      api({ method: 'PUT', url: `/api/restreamer/nodes/${p(i)}/${p(n)}/probes`, body }),
  }),
  tool({
    name: 'get_node_settings',
    description: 'Admission settings of one node: maxSessions and on-demand initialDelaySec.',
    input: node,
    annotations: READ,
    run: (a, api) =>
      api({ method: 'GET', url: `/api/restreamer/nodes/${p(a.instanceId)}/${p(a.nodeId)}/settings` }),
  }),
  tool({
    name: 'set_node_settings',
    description: 'Replace the admission settings of one node.',
    input: {
      ...node,
      maxSessions: z.number().int().min(0).nullable().describe('null = uncapped; 0 = admit no new sessions'),
      initialDelaySec: z.number().int().min(1).nullable().describe('on-demand start grace; null = default'),
    },
    annotations: WRITE_IDEMPOTENT,
    run: ({ instanceId: i, nodeId: n, ...body }, api) =>
      api({ method: 'PUT', url: `/api/restreamer/nodes/${p(i)}/${p(n)}/settings`, body }),
  }),

  // ---------- profiles ----------
  tool({
    name: 'list_restream_profiles',
    description: 'Encoding profiles used by restream channels.',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/restreamer/profiles' }),
  }),
  tool({
    name: 'create_restream_profile',
    description: 'Create an encoding profile.',
    input: { name: z.string().min(1), payload: passthroughObject('RestreamProfile payload (encoder settings)') },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: '/api/restreamer/profiles', body: a }),
  }),
  tool({
    name: 'update_restream_profile',
    description:
      'Rename and/or change the payload of a profile. A payload change re-pushes every node and switcher using it (live sessions cut over).',
    input: {
      id: profileId,
      name: z.string().min(1).optional(),
      payload: passthroughObject('RestreamProfile payload').optional(),
    },
    annotations: DESTRUCTIVE,
    run: ({ id, ...body }, api) => api({ method: 'PUT', url: `/api/restreamer/profiles/${p(id)}`, body }),
  }),
  tool({
    name: 'delete_restream_profile',
    description: 'Delete an encoding profile.',
    input: { id: profileId },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'DELETE', url: `/api/restreamer/profiles/${p(a.id)}` }),
  }),
  tool({
    name: 'clone_restream_profile',
    description: 'Copy an encoding profile under a new name.',
    input: { id: profileId, name: z.string().min(1) },
    annotations: WRITE,
    run: ({ id, ...body }, api) =>
      api({ method: 'POST', url: `/api/restreamer/profiles/${p(id)}/clone`, body }),
  }),

  // ---------- channels ----------
  tool({
    name: 'list_restream_channels',
    description:
      'Restream channels with their placements (node, mode, priority, blockedReason), playlists and live failover status.',
    input: { channel: channelIdentity.optional().describe('only the channel with this exact name + number'), ...pageShape },
    annotations: READ,
    run: async (a, api) => {
      const all = await api<RestreamChannelWithStatus[]>({ method: 'GET', url: '/api/restreamer/channels' });
      const list = a.channel ? all.filter((c) => sameChannel(a.channel!, c.channelName, c.channelNumber)) : all;
      return page(list, a.offset, a.limit);
    },
  }),
  tool({
    name: 'get_restream_channel',
    description: 'One restream channel with placements and status.',
    input: { id: channelId },
    annotations: READ,
    run: (a, api) => api({ method: 'GET', url: `/api/restreamer/channels/${p(a.id)}` }),
  }),
  tool({
    name: 'create_restream_channel',
    description:
      'Create a restream channel (optionally with placements) and push affected nodes. A 409 result lists per-node `unavailable` reasons; retry with force=true to override.',
    input: {
      channelName: z.string().min(1),
      channelNumber: channelNumber.optional(),
      profileId,
      slug: channelPatch.slug,
      enabled: channelPatch.enabled,
      comment: channelPatch.comment,
      playlistIds: channelPatch.playlistIds,
      placements: z.array(placementInput).optional(),
      force,
    },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: '/api/restreamer/channels', body: a }),
  }),
  tool({
    name: 'update_restream_channel',
    description: 'Patch a restream channel\'s fields and push affected nodes.',
    input: { id: channelId, ...channelPatch },
    annotations: WRITE,
    run: ({ id, ...body }, api) => api({ method: 'PUT', url: `/api/restreamer/channels/${p(id)}`, body }),
  }),
  tool({
    name: 'apply_restream_channel',
    description:
      'Transactional save: optional channel patch + the FULL desired placement set (array order = priority; existing placements whose id is missing are DELETED).',
    input: {
      id: channelId,
      channel: z.object(channelPatch).optional(),
      placements: z
        .array(
          z.object({
            id: z.string().optional().describe('existing placement id; omit to create'),
            instanceId,
            nodeId,
            mode: placementMode.optional().describe('default hot'),
            profileId: z.string().nullable().optional(),
            programNumber: z.number().nullable().optional(),
            enabled: z.boolean().optional().describe('default true'),
          }),
        )
        .optional(),
      force,
    },
    annotations: DESTRUCTIVE,
    run: ({ id, ...body }, api) => api({ method: 'POST', url: `/api/restreamer/channels/${p(id)}/apply`, body }),
  }),
  tool({
    name: 'delete_restream_channel',
    description: 'Delete a restream channel and stop its sessions on every node.',
    input: { id: channelId },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'DELETE', url: `/api/restreamer/channels/${p(a.id)}` }),
  }),
  tool({
    name: 'set_restream_channel_playlists',
    description: 'Replace the playlist membership of a channel.',
    input: { id: channelId, playlistIds: z.array(z.string()) },
    annotations: WRITE_IDEMPOTENT,
    run: ({ id, ...body }, api) =>
      api({ method: 'POST', url: `/api/restreamer/channels/${p(id)}/playlists`, body }),
  }),
  tool({
    name: 'batch_restream_channels',
    description:
      'One action over several channels: edit (patch), delete, enable, disable, add-playlist / remove-playlist (playlistId).',
    input: {
      action: z.enum(['edit', 'delete', 'enable', 'disable', 'add-playlist', 'remove-playlist']),
      ids: z.array(z.string()).min(1),
      patch: z.object(channelPatch).optional().describe('edit only'),
      playlistId: playlistId.optional().describe('add-playlist / remove-playlist only'),
    },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'POST', url: '/api/restreamer/channels/batch', body: a }),
  }),

  // ---------- placements ----------
  tool({
    name: 'add_restream_placement',
    description: 'Add a placement (channel on a node) and push the node.',
    input: { channelId, placement: placementInput },
    annotations: WRITE,
    run: (a, api) =>
      api({ method: 'POST', url: `/api/restreamer/channels/${p(a.channelId)}/placements`, body: a.placement }),
  }),
  tool({
    name: 'update_restream_placement',
    description: 'Patch a placement (node, priority, mode, profile override, program number, enabled).',
    input: {
      id: placementId,
      instanceId: instanceId.optional(),
      nodeId: nodeId.optional(),
      priority: z.number().optional(),
      enabled: z.boolean().optional(),
      mode: placementMode.optional(),
      profileId: z.string().nullable().optional(),
      programNumber: z.number().nullable().optional(),
      force,
    },
    annotations: WRITE,
    run: ({ id, ...body }, api) => api({ method: 'PUT', url: `/api/restreamer/placements/${p(id)}`, body }),
  }),
  tool({
    name: 'delete_restream_placement',
    description: 'Delete a placement (stops that session). force=true bypasses the mid-failover-procedure guard.',
    input: { id: placementId, force },
    annotations: DESTRUCTIVE,
    run: (a, api) =>
      api({
        method: 'DELETE',
        url: `/api/restreamer/placements/${p(a.id)}`,
        ...(a.force !== undefined ? { body: { force: a.force } } : {}),
      }),
  }),
  tool({
    name: 'reorder_restream_placements',
    description: 'Set placement priority order of a channel (first = highest priority).',
    input: { channelId, orderedPlacementIds: z.array(z.string()).min(1) },
    annotations: WRITE_IDEMPOTENT,
    run: (a, api) =>
      api({
        method: 'POST',
        url: `/api/restreamer/channels/${p(a.channelId)}/placements/reorder`,
        body: { orderedPlacementIds: a.orderedPlacementIds },
      }),
  }),

  // ---------- playlists ----------
  tool({
    name: 'list_restream_playlists',
    description: 'Viewer playlists (M3U/XMLTV slugs) grouping restream channels.',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/restreamer/playlists' }),
  }),
  tool({
    name: 'create_restream_playlist',
    description: 'Create a viewer playlist.',
    input: { slug: z.string().min(1), title: z.string().min(1) },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: '/api/restreamer/playlists', body: a }),
  }),
  tool({
    name: 'update_restream_playlist',
    description: 'Change a playlist\'s slug (changes its public URL) and/or title.',
    input: { id: playlistId, slug: z.string().min(1).optional(), title: z.string().min(1).optional() },
    annotations: WRITE,
    run: ({ id, ...body }, api) => api({ method: 'PUT', url: `/api/restreamer/playlists/${p(id)}`, body }),
  }),
  tool({
    name: 'delete_restream_playlist',
    description: 'Delete a viewer playlist (its public M3U/XMLTV URLs stop working).',
    input: { id: playlistId },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'DELETE', url: `/api/restreamer/playlists/${p(a.id)}` }),
  }),

  // ---------- failover ----------
  tool({
    name: 'switch_restream_channel',
    description:
      'Manual live failover: switch the channel\'s active output to the given placement. Only queues the serialized failover procedure; poll get_restream_channel for progress.',
    input: { id: channelId, placementId },
    annotations: DESTRUCTIVE,
    run: (a, api) =>
      api({ method: 'POST', url: `/api/restreamer/channels/${p(a.id)}/switch`, body: { placementId: a.placementId } }),
  }),
  tool({
    name: 'reset_restream_channel',
    description:
      'Fail the channel back in natural placement order. A 409 with triggerStillFailing=true means the original trigger is still failing — retry with force=true only if intended.',
    input: { id: channelId, force: z.boolean().optional() },
    annotations: DESTRUCTIVE,
    run: (a, api) =>
      api({
        method: 'POST',
        url: `/api/restreamer/channels/${p(a.id)}/switch`,
        body: { reset: true, ...(a.force !== undefined ? { force: a.force } : {}) },
      }),
  }),
  tool({
    name: 'clear_restream_failover_blocked',
    description: 'Dismiss the "failover blocked" badge of a channel (UI flag only; does not trigger failover).',
    input: { id: channelId },
    annotations: WRITE_IDEMPOTENT,
    run: (a, api) => api({ method: 'POST', url: `/api/restreamer/channels/${p(a.id)}/failover/clear-blocked` }),
  }),
];
