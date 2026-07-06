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
  DesiredState,
  LogLine,
  SourcesResponse,
  StatusResponse,
  SwitcherDesiredState,
  SwitcherStatus,
} from '@tvhc/shared';
import type { RestreamerNodeConfig, SwitcherConfig } from '../config.js';

export class RestreamerError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`restreamer ${path} -> HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'RestreamerError';
  }
}

/**
 * A failure is transient (worth retrying / not operator-actionable) when the
 * node was unreachable or returned a server error: any non-HTTP throw is a
 * network/connection/timeout failure, and a `RestreamerError` is transient
 * only for status 0 / 5xx. A 4xx (bad doc, unknown session) is permanent.
 * Mirrors `isTransientRcError` in uploads/dispatcher.ts.
 */
export function isTransientRestreamerError(err: unknown): boolean {
  if (err instanceof RestreamerError) return err.status === 0 || err.status >= 500;
  return true;
}

/**
 * Shared HTTP helper for the daemon and switcher clients: JSON in/out,
 * per-request AbortSignal timeout, non-2xx -> RestreamerError. The APIs are
 * unauthenticated by contract (LAN-isolated, same trust model as
 * `rclone rcd --rc-no-auth`).
 */
async function request<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  opts: { method: 'GET' | 'POST' | 'PUT'; body?: unknown; timeoutMs: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      method: opts.method,
      headers: opts.body === undefined ? {} : { 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`restreamer ${path} timed out after ${opts.timeoutMs}ms`);
    }
    throw err;
  }
  const text = await res.text();
  if (!res.ok) throw new RestreamerError(res.status, path, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/**
 * Client for one restreamer daemon node's HTTP API (wire contract v1,
 * vendored in @tvhc/shared). `status()` returns the response as-is even when
 * the node speaks an unknown `apiVersion` — the poller flags unsupported
 * versions instead of the client throwing.
 */
export class RestreamerClient {
  private readonly baseUrl: string;

  constructor(
    cfg: RestreamerNodeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    /** per-request cap; these are small control-plane calls */
    private readonly timeoutMs = 10_000,
  ) {
    this.baseUrl = cfg.url.replace(/\/+$/, '');
  }

  private req<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    return request<T>(this.fetchImpl, this.baseUrl, path, { method, body, timeoutMs: this.timeoutMs });
  }

  status(): Promise<StatusResponse> {
    return this.req<StatusResponse>('GET', '/v1/status');
  }

  /**
   * The node's local sources.m3u catalog. An old daemon without the sources
   * API 404s — mapped to the same shape a no-catalog daemon reports
   * (catalogHash null, no entries) so callers never special-case it.
   */
  async sources(): Promise<SourcesResponse> {
    try {
      return await this.req<SourcesResponse>('GET', '/v1/sources');
    } catch (err) {
      if (err instanceof RestreamerError && err.status === 404) {
        return { apiVersion: 1, catalogHash: null, updatedAt: null, entries: [] };
      }
      throw err;
    }
  }

  /** persisted desired-doc read-back; null when never pushed (daemon 404s) */
  async getDesired(): Promise<DesiredState | null> {
    try {
      return await this.req<DesiredState>('GET', '/v1/desired');
    } catch (err) {
      if (err instanceof RestreamerError && err.status === 404) return null;
      throw err;
    }
  }

  /** full replacement; the daemon validates all-or-nothing (400 on any bad session) */
  async putDesired(doc: DesiredState): Promise<void> {
    await this.req<unknown>('PUT', '/v1/desired', doc);
  }

  /** kill + respawn one session, resetting its backoff */
  async restartSession(name: string): Promise<void> {
    await this.req<unknown>('POST', `/v1/sessions/${encodeURIComponent(name)}/restart`);
  }

  /** stderr ring-buffer tail for one session */
  sessionLog(name: string, lines?: number): Promise<LogLine[]> {
    const qs = lines === undefined ? '' : `?lines=${lines}`;
    return this.req<LogLine[]>('GET', `/v1/sessions/${encodeURIComponent(name)}/log${qs}`);
  }
}

/**
 * Client for one standalone switcher service's HTTP API (same contract file,
 * switcher section). Same conventions as RestreamerClient.
 */
export class SwitcherClient {
  private readonly baseUrl: string;

  constructor(
    cfg: SwitcherConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    this.baseUrl = cfg.url.replace(/\/+$/, '');
  }

  private req<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    return request<T>(this.fetchImpl, this.baseUrl, path, { method, body, timeoutMs: this.timeoutMs });
  }

  status(): Promise<SwitcherStatus> {
    return this.req<SwitcherStatus>('GET', '/v1/status');
  }

  /** persisted desired-doc read-back; null when never pushed (e.g. after PVC loss) */
  async getDesired(): Promise<SwitcherDesiredState | null> {
    try {
      return await this.req<SwitcherDesiredState>('GET', '/v1/desired');
    } catch (err) {
      if (err instanceof RestreamerError && err.status === 404) return null;
      throw err;
    }
  }

  /** full replacement, atomic persist, all-or-nothing validation */
  async putDesired(doc: SwitcherDesiredState): Promise<void> {
    await this.req<unknown>('PUT', '/v1/desired', doc);
  }

  /** manual/rebalance switch of a redundant channel's active upstream */
  async switchChannel(slug: string, upstreamId: string): Promise<void> {
    await this.req<unknown>('POST', `/v1/channels/${encodeURIComponent(slug)}/switch`, {
      upstreamId,
    });
  }
}
