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

import type {
  ChannelOption,
  ConflictWindow,
  RuleInstances,
  DriftItem,
  IgnoredOrphan,
  IntegrityIssue,
  InstanceOverview,
  MasterRule,
  InstanceSummary,
  MasterRulePayload,
  NodeProbeSettings,
  NodeSettings,
  ReconcileAction,
  RecordingBatchResult,
  RecordingEditOp,
  RecordingTarget,
  RuleWithStatus,
  EpgChannel,
  EventLogEntry,
  TvhEpgEvent,
  UnifiedEpgEvent,
  UnifiedGroup,
  UploadJob,
  UploadStatus,
  LogLine,
  AribHlsParams,
  RestreamChannelWithStatus,
  RestreamPlaylist,
  RestreamProfile,
  RestreamerNodeStatus,
  SwitcherNodeStatus,
} from '@tvhc/shared';
import type { StagedPlacementInput } from './placementStaging.js';

/** restream channel create body */
export interface RestreamChannelInput {
  channelName: string;
  /** STRING identity ("9.1" ≠ "9.10"); absent/null = pin the lowest-numbered channel at write time */
  channelNumber?: string | null;
  profileId: string;
  /** derived from channelName when absent */
  slug?: string;
  enabled?: boolean;
  comment?: string | null;
  playlistIds?: string[];
  /** full desired placement set, priority = array order; id absent = create */
  placements?: StagedPlacementInput[];
  /** write even when a target node cannot serve the identity right now (pre-provisioning) */
  force?: boolean;
}

/** restream channel update / batch-edit patch (placements travel through the apply endpoint) */
export type RestreamChannelPatch = Partial<Omit<RestreamChannelInput, 'placements'>>;

/** POST /api/restreamer/channels/:id/apply body — the atomic channel+placements write */
export interface ApplyRestreamChannelBody {
  channel?: RestreamChannelPatch;
  /** full desired placement set (same semantics as RestreamChannelInput.placements) */
  placements?: StagedPlacementInput[];
  force?: boolean;
}

export type RestreamChannelBatchAction =
  | 'edit'
  | 'delete'
  | 'enable'
  | 'disable'
  | 'add-playlist'
  | 'remove-playlist';

export interface RestreamPlaylistInput {
  slug: string;
  title: string;
}

/** create/update body: plain rules carry payload, linked clones parentId+overlay */
export interface RuleInput {
  name: string;
  instances: RuleInstances;
  payload?: MasterRulePayload;
  parentId?: string | null;
  overlay?: Partial<MasterRulePayload> | null;
}

/**
 * Non-2xx API response. `body` keeps the parsed JSON error payload (null when
 * the response wasn't JSON) so callers can read structured detail beyond the
 * message — e.g. the 409 `unavailable` list from write-time availability.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** one node that cannot serve the requested identity (409 `unavailable` payload) */
export interface UnavailableTarget {
  instanceId: string;
  nodeId: string;
  reason: string;
}

/** per-node detail of a write-time availability 409, or null for any other error */
export function unavailableDetail(err: unknown): UnavailableTarget[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const u = (err.body as { unavailable?: unknown } | null)?.unavailable;
  if (!Array.isArray(u) || u.length === 0) return null;
  return u as UnavailableTarget[];
}

/**
 * Classify a `switch {reset:true}` 409: 'rejected-mid-procedure' = a failover
 * procedure is already running and reset must wait; 'requires-confirm' = the
 * trigger condition is still failing, so a reset would immediately fail over
 * again unless the caller retries with `force: true`. null = any other error
 * (caller falls back to a generic error toast).
 */
export function classifyResetError(
  err: unknown,
): { kind: 'rejected-mid-procedure' | 'requires-confirm'; message: string } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { error?: string; message?: string } | null;
  if (body?.error === 'rejected-mid-procedure' || body?.error === 'requires-confirm') {
    return { kind: body.error, message: body.message ?? err.message };
  }
  return null;
}

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `${res.status} ${res.statusText}`;
    let parsedBody: unknown = null;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      parsedBody = parsed;
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new ApiError(message, res.status, parsedBody);
  }
  return (await res.json()) as T;
}

export const api = {
  instances: () => http<InstanceSummary[]>('GET', '/api/instances'),
  channels: () => http<ChannelOption[]>('GET', '/api/channels'),
  overview: (id: string) => http<InstanceOverview>('GET', `/api/instances/${id}/overview`),
  unifiedRecordings: (state: 'upcoming' | 'finished' | 'failed') =>
    http<UnifiedGroup[]>('GET', `/api/recordings?state=${state}`),
  editRecordings: (ops: RecordingEditOp[]) =>
    http<RecordingBatchResult[]>('POST', '/api/recordings/edit', { ops }),
  deleteRecordings: (targets: RecordingTarget[]) =>
    http<RecordingBatchResult[]>('POST', '/api/recordings/delete', { targets }),
  recordingAddCandidates: (channelname: string, start: number, stop: number, exclude: string[]) =>
    http<Array<{ instanceId: string; eventId: number }>>('POST', '/api/recordings/add-candidates', {
      channelname,
      start,
      stop,
      exclude,
    }),
  conflicts: (id: string) => http<ConflictWindow[]>('GET', `/api/instances/${id}/conflicts`),

  epg: (params?: { channels?: string[]; q?: string; offset?: number; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.channels?.length) sp.set('channels', JSON.stringify(params.channels));
    if (params?.q) sp.set('q', params.q);
    if (params?.offset !== undefined) sp.set('offset', String(params.offset));
    if (params?.limit !== undefined) sp.set('limit', String(params.limit));
    const qs = sp.toString();
    return http<{ items: UnifiedEpgEvent[]; total: number }>('GET', `/api/epg${qs ? `?${qs}` : ''}`);
  },
  epgChannels: () => http<EpgChannel[]>('GET', '/api/epg/channels'),
  epgIndex: (params: { channels?: string[]; q?: string; at: number }) => {
    const sp = new URLSearchParams();
    if (params.channels?.length) sp.set('channels', JSON.stringify(params.channels));
    if (params.q) sp.set('q', params.q);
    sp.set('at', String(params.at));
    return http<{ index: number; total: number }>('GET', `/api/epg/index?${sp.toString()}`);
  },
  epgEvent: (instanceId: string, eventId: number) =>
    http<TvhEpgEvent>('GET', `/api/epg/event/${instanceId}/${eventId}`),
  recordEvent: (instanceId: string, eventId: number) =>
    http<{ uuid: string[] }>('POST', '/api/epg/record', { instanceId, eventId }),

  eventLog: (params?: {
    service?: string[];
    source?: string[];
    type?: string;
    sort?: string;
    dir?: string;
    offset?: number;
    limit?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params?.service?.length) sp.set('service', JSON.stringify(params.service));
    if (params?.source?.length) sp.set('source', JSON.stringify(params.source));
    if (params?.type) sp.set('type', params.type);
    if (params?.sort) sp.set('sort', params.sort);
    if (params?.dir) sp.set('dir', params.dir);
    sp.set('offset', String(params?.offset ?? 0));
    sp.set('limit', String(params?.limit ?? 100));
    return http<{ items: EventLogEntry[]; total: number }>('GET', `/api/event-log?${sp.toString()}`);
  },
  eventLogFacets: () => http<{ services: string[]; sources: string[] }>('GET', '/api/event-log/facets'),

  rules: () => http<RuleWithStatus[]>('GET', '/api/rules'),
  createRule: (input: RuleInput) => http<RuleWithStatus>('POST', '/api/rules', input),
  updateRule: (id: string, input: RuleInput) =>
    http<RuleWithStatus>('PUT', `/api/rules/${id}`, input),
  cloneRule: (id: string, linked: boolean, name: string) =>
    http<RuleWithStatus>('POST', `/api/rules/${id}/clone`, { linked, name }),
  deletedRules: () => http<MasterRule[]>('GET', '/api/rules/deleted'),
  restoreRule: (id: string) => http<unknown[]>('POST', `/api/rules/${id}/restore`),
  purgeRule: (id: string) => http<{ ok: boolean }>('DELETE', `/api/rules/${id}/purge`),
  deleteRule: (id: string) => http<{ ok: boolean }>('DELETE', `/api/rules/${id}`),
  pushRule: (id: string) => http<unknown[]>('POST', `/api/rules/${id}/push`),
  batchRules: (
    action: 'edit' | 'delete' | 'push' | 'restore' | 'purge',
    ids: string[],
    patch?: Partial<MasterRulePayload>,
    instances?: Record<string, boolean>,
  ) =>
    http<Array<{ id: string; ok: boolean; error?: string }>>('POST', '/api/rules/batch', {
      action,
      ids,
      ...(patch ? { patch } : {}),
      ...(instances ? { instances } : {}),
    }),
  pushAll: () => http<unknown[]>('POST', '/api/sync/push'),
  drift: () => http<DriftItem[]>('GET', '/api/sync/drift'),
  reconcile: (driftId: string, action: ReconcileAction) =>
    http<{ ok: boolean }>('POST', '/api/sync/reconcile', { driftId, action }),
  importFrom: (instanceId: string) =>
    http<{ imported: number; bound: number }>('POST', `/api/sync/import?instance=${instanceId}`),
  integrityCheck: () => http<IntegrityIssue[]>('POST', '/api/sync/integrity'),
  ignoredOrphans: () => http<IgnoredOrphan[]>('GET', '/api/sync/ignored'),
  unignoreOrphan: (instanceId: string, tvhUuid: string) =>
    http<{ ok: boolean }>('POST', '/api/sync/unignore', { instanceId, tvhUuid }),

  uploads: (status?: UploadStatus) =>
    http<UploadJob[]>('GET', `/api/uploads${status ? `?status=${status}` : ''}`),
  startUploads: (instanceId: string, dvrUuids: string[]) =>
    http<Array<{ dvrUuid: string; jobId?: string; error?: string; duplicateOf?: unknown }>>(
      'POST',
      '/api/uploads',
      { instanceId, dvrUuids },
    ),
  retryUpload: (id: string) => http<{ ok: boolean }>('POST', `/api/uploads/${id}/retry`),
  cancelUpload: (id: string) => http<{ ok: boolean }>('POST', `/api/uploads/${id}/cancel`),

  restreamerNodes: () =>
    http<{ nodes: RestreamerNodeStatus[]; switchers: SwitcherNodeStatus[] }>(
      'GET',
      '/api/restreamer/nodes',
    ),
  pushRestreamerNode: (instanceId: string, nodeId: string) =>
    http<unknown>('POST', `/api/restreamer/nodes/${instanceId}/${nodeId}/push`),
  restreamerNodeProbes: (instanceId: string, nodeId: string) =>
    http<NodeProbeSettings>('GET', `/api/restreamer/nodes/${instanceId}/${nodeId}/probes`),
  updateRestreamerNodeProbes: (instanceId: string, nodeId: string, payload: NodeProbeSettings) =>
    http<NodeProbeSettings>('PUT', `/api/restreamer/nodes/${instanceId}/${nodeId}/probes`, payload),
  getNodeSettings: (instanceId: string, nodeId: string) =>
    http<NodeSettings>('GET', `/api/restreamer/nodes/${instanceId}/${nodeId}/settings`),
  putNodeSettings: (instanceId: string, nodeId: string, settings: NodeSettings) =>
    http<NodeSettings>('PUT', `/api/restreamer/nodes/${instanceId}/${nodeId}/settings`, settings),
  restartRestreamSession: (instanceId: string, nodeId: string, name: string) =>
    http<{ ok: boolean }>(
      'POST',
      `/api/restreamer/nodes/${instanceId}/${nodeId}/sessions/${name}/restart`,
    ),
  resetRestreamSessionRestarts: (instanceId: string, nodeId: string, name: string) =>
    http<{ ok: boolean }>(
      'POST',
      `/api/restreamer/nodes/${instanceId}/${nodeId}/sessions/${name}/restarts/reset`,
    ),
  restreamSessionLog: (instanceId: string, nodeId: string, name: string, lines?: number) =>
    http<LogLine[]>(
      'GET',
      `/api/restreamer/nodes/${instanceId}/${nodeId}/sessions/${name}/log${lines !== undefined ? `?lines=${lines}` : ''}`,
    ),
  /** tail of the daemon's own log ring (not any one session) */
  restreamerNodeLog: (instanceId: string, nodeId: string, lines?: number) =>
    http<LogLine[]>(
      'GET',
      `/api/restreamer/nodes/${instanceId}/${nodeId}/log${lines !== undefined ? `?lines=${lines}` : ''}`,
    ),

  restreamProfiles: () => http<RestreamProfile[]>('GET', '/api/restreamer/profiles'),
  createRestreamProfile: (name: string, payload: AribHlsParams) =>
    http<RestreamProfile>('POST', '/api/restreamer/profiles', { name, payload }),
  updateRestreamProfile: (id: string, patch: { name?: string; payload?: AribHlsParams }) =>
    http<RestreamProfile>('PUT', `/api/restreamer/profiles/${id}`, patch),
  deleteRestreamProfile: (id: string) =>
    http<{ ok: boolean }>('DELETE', `/api/restreamer/profiles/${id}`),
  cloneRestreamProfile: (id: string, name: string) =>
    http<RestreamProfile>('POST', `/api/restreamer/profiles/${id}/clone`, { name }),

  restreamChannels: () => http<RestreamChannelWithStatus[]>('GET', '/api/restreamer/channels'),
  createRestreamChannel: (input: RestreamChannelInput) =>
    http<RestreamChannelWithStatus>('POST', '/api/restreamer/channels', input),
  restreamChannel: (id: string) =>
    http<RestreamChannelWithStatus>('GET', `/api/restreamer/channels/${id}`),
  updateRestreamChannel: (id: string, patch: RestreamChannelPatch) =>
    http<RestreamChannelWithStatus>('PUT', `/api/restreamer/channels/${id}`, patch),
  /** atomic channel-field + full-placement-set write (RestreamChannelModal's Save) */
  applyRestreamChannel: (id: string, body: ApplyRestreamChannelBody) =>
    http<RestreamChannelWithStatus>('POST', `/api/restreamer/channels/${id}/apply`, body),
  deleteRestreamChannel: (id: string) =>
    http<{ ok: boolean }>('DELETE', `/api/restreamer/channels/${id}`),
  batchRestreamChannels: (
    action: RestreamChannelBatchAction,
    ids: string[],
    opts?: { patch?: RestreamChannelPatch; playlistId?: string },
  ) =>
    http<Array<{ id: string; ok: boolean; error?: string }>>('POST', '/api/restreamer/channels/batch', {
      action,
      ids,
      ...(opts?.patch ? { patch: opts.patch } : {}),
      ...(opts?.playlistId ? { playlistId: opts.playlistId } : {}),
    }),
  setRestreamChannelPlaylists: (id: string, playlistIds: string[]) =>
    http<{ ok: boolean }>('POST', `/api/restreamer/channels/${id}/playlists`, { playlistIds }),
  /**
   * {placementId} = explicit switch (enqueues the failover procedure);
   * {reset: true} = back to the highest-priority healthy placement, {force:
   * true} bypasses the "trigger still failing" 409 (see classifyResetError).
   */
  switchRestreamChannel: (id: string, body: { placementId: string } | { reset: true; force?: true }) =>
    http<{ ok: boolean; queued?: boolean; already?: boolean; aborted?: boolean; cleared?: boolean }>(
      'POST',
      `/api/restreamer/channels/${id}/switch`,
      body,
    ),
  /** operator dismiss of the ⚠ blocked badge (does not retry the failover) */
  clearRestreamFailoverBlocked: (id: string) =>
    http<{ ok: boolean; cleared: boolean }>('POST', `/api/restreamer/channels/${id}/failover/clear-blocked`),

  restreamPlaylists: () => http<RestreamPlaylist[]>('GET', '/api/restreamer/playlists'),
  createRestreamPlaylist: (input: RestreamPlaylistInput) =>
    http<RestreamPlaylist>('POST', '/api/restreamer/playlists', input),
  updateRestreamPlaylist: (id: string, patch: Partial<RestreamPlaylistInput>) =>
    http<RestreamPlaylist>('PUT', `/api/restreamer/playlists/${id}`, patch),
  deleteRestreamPlaylist: (id: string) =>
    http<{ ok: boolean }>('DELETE', `/api/restreamer/playlists/${id}`),
};
