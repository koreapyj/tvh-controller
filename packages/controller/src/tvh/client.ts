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
  TvhAutorecRule,
  TvhChannel,
  TvhChannelTag,
  TvhDvrConfig,
  TvhDvrEntry,
  TvhEpgEvent,
  TvhGridResponse,
  TvhHardwareNode,
  TvhInputStatus,
  TvhMux,
  TvhNetwork,
  TvhServerInfo,
  TvhService,
  TvhSubscription,
} from '@tvhc/shared';
import { DigestSession, parseDigestChallenge } from './digest.js';

export class TvhApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`tvheadend ${path} -> HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'TvhApiError';
  }
}

type Params = Record<string, string | number | boolean | object | undefined>;

/**
 * Typed client for the tvheadend HTTP JSON API. All endpoints take
 * form-encoded POST bodies and return JSON. Auth: none when no credentials
 * are configured (anonymous tvheadend access), otherwise Basic first with a
 * transparent fallback to RFC2617 Digest on 401 (tvheadend default).
 */
export class TvhClient {
  private digest: DigestSession | null = null;
  private readonly basic: string | null;
  private readonly username: string;
  private readonly password: string;

  constructor(
    private readonly baseUrl: string,
    username?: string,
    password?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.username = username ?? '';
    this.password = password ?? '';
    this.basic = username
      ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
      : null;
  }

  private encode(params: Params): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      sp.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return sp.toString();
  }

  async call<T>(path: string, params: Params = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const uri = new URL(url).pathname;
    const body = this.encode(params);
    const doFetch = (auth: string | null) =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(auth ? { authorization: auth } : {}),
        },
        body,
      });

    let res = await doFetch(this.digest ? this.digest.authorize('POST', uri) : this.basic);

    if (res.status === 401 && this.basic) {
      const challengeHeader = res.headers.get('www-authenticate') ?? '';
      const challenge = parseDigestChallenge(challengeHeader);
      if (challenge) {
        if (this.digest) this.digest.updateChallenge(challenge);
        else this.digest = new DigestSession(this.username, this.password, challenge);
        res = await doFetch(this.digest.authorize('POST', uri));
      }
    }

    if (!res.ok) {
      throw new TvhApiError(res.status, path, await res.text().catch(() => ''));
    }
    const text = await res.text();
    return (text === '' ? {} : JSON.parse(text)) as T;
  }

  private async grid<T>(path: string, limit = 5000, extra: Params = {}): Promise<T[]> {
    const res = await this.call<TvhGridResponse<T>>(path, { start: 0, limit, ...extra });
    return res.entries ?? [];
  }

  serverInfo(): Promise<TvhServerInfo> {
    return this.call('/api/serverinfo');
  }

  dvrUpcoming(): Promise<TvhDvrEntry[]> {
    return this.grid('/api/dvr/entry/grid_upcoming', 5000, { duplicates: 0 });
  }

  dvrFinished(): Promise<TvhDvrEntry[]> {
    return this.grid('/api/dvr/entry/grid_finished');
  }

  dvrFailed(): Promise<TvhDvrEntry[]> {
    return this.grid('/api/dvr/entry/grid_failed');
  }

  autorecGrid(): Promise<TvhAutorecRule[]> {
    return this.grid('/api/dvr/autorec/grid');
  }

  async autorecCreate(conf: object): Promise<string> {
    const res = await this.call<{ uuid: string }>('/api/dvr/autorec/create', { conf });
    return res.uuid;
  }

  /** in-place update; preserves scheduled entries spawned by the rule */
  idnodeSave(node: object): Promise<void> {
    return this.call('/api/idnode/save', { node });
  }

  /** WARNING for autorecs: cancels all scheduled entries spawned by the rule */
  idnodeDelete(uuid: string | string[]): Promise<void> {
    return this.call('/api/idnode/delete', { uuid: Array.isArray(uuid) ? uuid : [uuid] });
  }

  statusInputs(): Promise<TvhInputStatus[]> {
    return this.call<{ entries: TvhInputStatus[] }>('/api/status/inputs').then((r) => r.entries ?? []);
  }

  statusSubscriptions(): Promise<TvhSubscription[]> {
    return this.call<{ entries: TvhSubscription[] }>('/api/status/subscriptions').then(
      (r) => r.entries ?? [],
    );
  }

  channelGrid(): Promise<TvhChannel[]> {
    return this.grid('/api/channel/grid', 5000, { all: 1 });
  }

  channelTagGrid(): Promise<TvhChannelTag[]> {
    return this.grid('/api/channeltag/grid', 1000, { all: 1 });
  }

  dvrConfigGrid(): Promise<TvhDvrConfig[]> {
    return this.grid('/api/dvr/config/grid');
  }

  muxGrid(): Promise<TvhMux[]> {
    return this.grid('/api/mpegts/mux/grid');
  }

  serviceGrid(): Promise<TvhService[]> {
    return this.grid('/api/mpegts/service/grid', 20000);
  }

  networkGrid(): Promise<TvhNetwork[]> {
    return this.grid('/api/mpegts/network/grid');
  }

  /** one level of the hardware tree; recurse with each non-leaf node's uuid */
  hardwareTreeLevel(uuid = 'root'): Promise<TvhHardwareNode[]> {
    return this.call<TvhHardwareNode[]>('/api/hardware/tree', { uuid });
  }

  /** networks a given frontend can serve */
  inputNetworkList(frontendUuid: string): Promise<Array<{ key: string; val: string }>> {
    return this.call<{ entries: Array<{ key: string; val: string }> }>(
      '/api/mpegts/input/network_list',
      { uuid: frontendUuid },
    ).then((r) => r.entries ?? []);
  }

  /**
   * Every matching EPG broadcast, sorted by start ascending. tvheadend's grid is
   * paginated (the `limit` arg defaults to just 50), so we page through until a
   * short page signals the end. The only bound is tvheadend's finite EIT horizon
   * — no artificial cap. `extra` can carry `filter`, `channel`, `title`, etc.
   */
  async epgEventsAll(extra: Params = {}): Promise<TvhEpgEvent[]> {
    const PAGE = 20000;
    const out: TvhEpgEvent[] = [];
    for (;;) {
      const res = await this.call<{ entries?: TvhEpgEvent[] }>('/api/epg/events/grid', {
        start: out.length,
        limit: PAGE,
        sort: 'start',
        dir: 'ASC',
        ...extra,
      });
      const entries = res.entries ?? [];
      out.push(...entries);
      if (entries.length < PAGE) break; // a short (or empty) page is the last one
    }
    return out;
  }

  /** full details for one broadcast (description/credits/etc.) */
  epgEventLoad(eventId: number): Promise<TvhEpgEvent | null> {
    return this.call<{ entries?: TvhEpgEvent[] }>('/api/epg/events/load', { eventId }).then(
      (r) => r.entries?.[0] ?? null,
    );
  }

  /** schedule a one-time recording from an EPG event; '' config = instance default */
  async dvrEntryCreateByEvent(eventId: number, configUuid = ''): Promise<string[]> {
    const res = await this.call<{ uuid?: string[] | string }>('/api/dvr/entry/create_by_event', {
      event_id: eventId,
      config_uuid: configUuid,
    });
    return Array.isArray(res.uuid) ? res.uuid : res.uuid ? [res.uuid] : [];
  }
}
