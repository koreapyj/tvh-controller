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
  DvrState,
  IgnoredOrphan,
  IntegrityIssue,
  InstanceOverview,
  MasterRule,
  InstanceSummary,
  MasterRulePayload,
  ReconcileAction,
  RecordingGroup,
  RuleWithStatus,
  EpgChannel,
  TvhEpgEvent,
  UnifiedEpgEvent,
  UnifiedGroup,
  UploadJob,
  UploadStatus,
} from '@tvhc/shared';

/** create/update body: plain rules carry payload, linked clones parentId+overlay */
export interface RuleInput {
  name: string;
  instances: RuleInstances;
  payload?: MasterRulePayload;
  parentId?: string | null;
  overlay?: Partial<MasterRulePayload> | null;
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
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  instances: () => http<InstanceSummary[]>('GET', '/api/instances'),
  channels: () => http<ChannelOption[]>('GET', '/api/channels'),
  overview: (id: string) => http<InstanceOverview>('GET', `/api/instances/${id}/overview`),
  recordings: (id: string, state: DvrState) =>
    http<RecordingGroup[]>('GET', `/api/instances/${id}/recordings?state=${state}`),
  unifiedRecordings: (state: 'upcoming' | 'finished' | 'failed') =>
    http<UnifiedGroup[]>('GET', `/api/recordings?state=${state}`),
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
  epgEvent: (instanceId: string, eventId: number) =>
    http<TvhEpgEvent>('GET', `/api/epg/event/${instanceId}/${eventId}`),
  recordEvent: (instanceId: string, eventId: number) =>
    http<{ uuid: string[] }>('POST', '/api/epg/record', { instanceId, eventId }),

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
};
