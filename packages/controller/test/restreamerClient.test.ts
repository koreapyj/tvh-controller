/*
 * RestreamerClient tests against a fake fetch — no network. Covers
 * per-endpoint URL/method/body shapes, the 404 -> null desired read-back,
 * non-2xx -> RestreamerError, the AbortSignal timeout mapping, and
 * transient-vs-permanent error classification.
 */

import { describe, expect, it } from 'vitest';
import type { DesiredState, SourcesResponse, StatusResponse } from '@tvhc/shared';
import {
  RestreamerClient,
  RestreamerError,
  isTransientRestreamerError,
} from '../src/restreamer/client.js';

type FetchImpl = typeof fetch;

interface Call {
  url: string;
  method: string;
  body: string | null;
  contentType: string | null;
}

/** fake fetch that records every call and replies from a queue (last reply sticks) */
function fakeFetch(...responses: Response[]): { fetchImpl: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = (async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: (init?.body as string | undefined) ?? null,
      contentType: (init?.headers as Record<string, string> | undefined)?.['content-type'] ?? null,
    });
    // clone the sticky last response so repeated calls each get a fresh body
    return responses.length > 1 ? responses.shift()! : responses[0]!.clone();
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

const NODE = { id: 'n1', url: 'http://node1:5580' };

const STATUS: StatusResponse = {
  apiVersion: 1,
  daemonVersion: '1.0.0',
  startedAt: '2026-07-06T00:00:00Z',
  uptimeSec: 42,
  capabilities: ['qsv'],
  templates: [{ id: 'arib-hls', version: 1 }],
  desiredRevision: 'rev-1',
  sessions: [],
};

const DESIRED: DesiredState = { apiVersion: 1, revision: 'rev-1', sessions: [] };

describe('RestreamerClient endpoints', () => {
  it('status(): GET /v1/status and parses the response', async () => {
    const { fetchImpl, calls } = fakeFetch(json(STATUS));
    const client = new RestreamerClient(NODE, fetchImpl);
    const res = await client.status();
    expect(calls).toEqual([
      { url: 'http://node1:5580/v1/status', method: 'GET', body: null, contentType: null },
    ]);
    expect(res).toEqual(STATUS);
  });

  it('strips a trailing slash from the configured url', async () => {
    const { fetchImpl, calls } = fakeFetch(json(STATUS));
    const client = new RestreamerClient({ id: 'n1', url: 'http://node1:5580/' }, fetchImpl);
    await client.status();
    expect(calls[0]?.url).toBe('http://node1:5580/v1/status');
  });

  it('sources(): GET /v1/sources and parses the catalog', async () => {
    const catalog: SourcesResponse = {
      apiVersion: 1,
      catalogHash: 'h1',
      updatedAt: '2026-07-06T00:00:00Z',
      entries: [{ id: 'louise-1', name: 'Louise', url: 'https://louise.example/stream?id=1', chno: '1' }],
    };
    const { fetchImpl, calls } = fakeFetch(json(catalog));
    const client = new RestreamerClient(NODE, fetchImpl);
    expect(await client.sources()).toEqual(catalog);
    expect(calls).toEqual([
      { url: 'http://node1:5580/v1/sources', method: 'GET', body: null, contentType: null },
    ]);
  });

  it('sources(): 404 (old daemon) -> empty no-catalog response', async () => {
    const { fetchImpl } = fakeFetch(new Response('not found', { status: 404 }));
    const client = new RestreamerClient(NODE, fetchImpl);
    expect(await client.sources()).toEqual({
      apiVersion: 1,
      catalogHash: null,
      updatedAt: null,
      entries: [],
    });
  });

  it('sources(): non-404 errors still throw', async () => {
    const { fetchImpl } = fakeFetch(new Response('boom', { status: 500 }));
    const client = new RestreamerClient(NODE, fetchImpl);
    const err = await client.sources().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestreamerError);
    expect((err as RestreamerError).status).toBe(500);
  });

  it('getDesired(): GET /v1/desired returns the persisted doc', async () => {
    const { fetchImpl, calls } = fakeFetch(json(DESIRED));
    const client = new RestreamerClient(NODE, fetchImpl);
    expect(await client.getDesired()).toEqual(DESIRED);
    expect(calls[0]).toMatchObject({ url: 'http://node1:5580/v1/desired', method: 'GET' });
  });

  it('getDesired(): 404 (never pushed) -> null', async () => {
    const { fetchImpl } = fakeFetch(new Response('not found', { status: 404 }));
    const client = new RestreamerClient(NODE, fetchImpl);
    expect(await client.getDesired()).toBeNull();
  });

  it('putDesired(): PUT /v1/desired with the JSON doc as body', async () => {
    const { fetchImpl, calls } = fakeFetch(new Response(null, { status: 204 }));
    const client = new RestreamerClient(NODE, fetchImpl);
    await client.putDesired(DESIRED);
    expect(calls[0]).toEqual({
      url: 'http://node1:5580/v1/desired',
      method: 'PUT',
      body: JSON.stringify(DESIRED),
      contentType: 'application/json',
    });
  });

  it('restartSession(): POST /v1/sessions/:name/restart with the name URL-encoded', async () => {
    const { fetchImpl, calls } = fakeFetch(new Response(null, { status: 204 }));
    const client = new RestreamerClient(NODE, fetchImpl);
    await client.restartSession('at-x');
    expect(calls[0]).toMatchObject({
      url: 'http://node1:5580/v1/sessions/at-x/restart',
      method: 'POST',
    });
  });

  it('sessionLog(): GET /v1/sessions/:name/log with optional ?lines=N', async () => {
    const lines = [{ ts: '2026-07-06T00:00:00Z', src: 'ffmpeg', line: 'frame=1' }];
    // the daemon wraps the tail in an envelope; the client unwraps it
    const { fetchImpl, calls } = fakeFetch(json({ name: 'at-x', lines }));
    const client = new RestreamerClient(NODE, fetchImpl);
    expect(await client.sessionLog('at-x', 50)).toEqual(lines);
    expect(calls[0]).toMatchObject({
      url: 'http://node1:5580/v1/sessions/at-x/log?lines=50',
      method: 'GET',
    });
    await client.sessionLog('at-x');
    expect(calls[1]?.url).toBe('http://node1:5580/v1/sessions/at-x/log');
  });

  it('non-2xx -> RestreamerError carrying status and path', async () => {
    const { fetchImpl } = fakeFetch(new Response('boom', { status: 500 }));
    const client = new RestreamerClient(NODE, fetchImpl);
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestreamerError);
    expect((err as RestreamerError).status).toBe(500);
    expect((err as RestreamerError).path).toBe('/v1/status');
    expect((err as RestreamerError).message).toMatch(/\/v1\/status -> HTTP 500: boom/);
  });

  it('maps an aborted request to a transient "timed out after" error', async () => {
    const fetchImpl: FetchImpl = (async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          reject(err);
        });
      });
    }) as unknown as FetchImpl;
    const client = new RestreamerClient(NODE, fetchImpl, 5);
    const err = await client.status().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/timed out after 5ms/);
    expect(isTransientRestreamerError(err)).toBe(true);
  });
});

describe('isTransientRestreamerError', () => {
  it('network/connection throws are transient', () => {
    expect(isTransientRestreamerError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientRestreamerError(new TypeError('fetch failed'))).toBe(true);
  });

  it('5xx / status 0 are transient', () => {
    expect(isTransientRestreamerError(new RestreamerError(500, '/x', 'oops'))).toBe(true);
    expect(isTransientRestreamerError(new RestreamerError(503, '/x', 'busy'))).toBe(true);
    expect(isTransientRestreamerError(new RestreamerError(0, '/x', 'no response'))).toBe(true);
  });

  it('4xx is permanent', () => {
    expect(isTransientRestreamerError(new RestreamerError(400, '/x', 'bad doc'))).toBe(false);
    expect(isTransientRestreamerError(new RestreamerError(404, '/x', 'missing'))).toBe(false);
  });
});
