/*
 * RestreamerClient / SwitcherClient tests against a fake fetch — no network.
 * Covers per-endpoint URL/method/body shapes, the 404 -> null desired
 * read-back, non-2xx -> RestreamerError, the AbortSignal timeout mapping,
 * and transient-vs-permanent error classification.
 */

import { describe, expect, it } from 'vitest';
import type { DesiredState, StatusResponse, SwitcherDesiredState, SwitcherStatus } from '@tvhc/shared';
import {
  RestreamerClient,
  RestreamerError,
  SwitcherClient,
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
const SWITCHER = { id: 'sw1', url: 'http://switcher:5581', publicUrl: 'https://tv.example' };

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
    const { fetchImpl, calls } = fakeFetch(json(lines));
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

describe('SwitcherClient endpoints', () => {
  const SW_STATUS: SwitcherStatus = {
    apiVersion: 1,
    switcherVersion: '1.0.0',
    startedAt: '2026-07-06T00:00:00Z',
    uptimeSec: 10,
    desiredRevision: null,
    channels: [],
  };
  const SW_DESIRED: SwitcherDesiredState = { apiVersion: 1, revision: 'rev-2', channels: [] };

  it('status(): GET /v1/status', async () => {
    const { fetchImpl, calls } = fakeFetch(json(SW_STATUS));
    const client = new SwitcherClient(SWITCHER, fetchImpl);
    expect(await client.status()).toEqual(SW_STATUS);
    expect(calls[0]).toMatchObject({ url: 'http://switcher:5581/v1/status', method: 'GET' });
  });

  it('getDesired(): 404 -> null, 200 -> doc', async () => {
    const { fetchImpl } = fakeFetch(new Response('nope', { status: 404 }), json(SW_DESIRED));
    const client = new SwitcherClient(SWITCHER, fetchImpl);
    expect(await client.getDesired()).toBeNull();
    expect(await client.getDesired()).toEqual(SW_DESIRED);
  });

  it('putDesired(): PUT /v1/desired with the JSON doc', async () => {
    const { fetchImpl, calls } = fakeFetch(new Response(null, { status: 204 }));
    const client = new SwitcherClient(SWITCHER, fetchImpl);
    await client.putDesired(SW_DESIRED);
    expect(calls[0]).toEqual({
      url: 'http://switcher:5581/v1/desired',
      method: 'PUT',
      body: JSON.stringify(SW_DESIRED),
      contentType: 'application/json',
    });
  });

  it('switchChannel(): POST /v1/channels/:slug/switch with {upstreamId}', async () => {
    const { fetchImpl, calls } = fakeFetch(new Response(null, { status: 204 }));
    const client = new SwitcherClient(SWITCHER, fetchImpl);
    await client.switchChannel('at-x', 'placement-7');
    expect(calls[0]).toEqual({
      url: 'http://switcher:5581/v1/channels/at-x/switch',
      method: 'POST',
      body: JSON.stringify({ upstreamId: 'placement-7' }),
      contentType: 'application/json',
    });
  });

  it('non-2xx -> RestreamerError', async () => {
    const { fetchImpl } = fakeFetch(new Response('bad', { status: 400 }));
    const client = new SwitcherClient(SWITCHER, fetchImpl);
    const err = await client.putDesired(SW_DESIRED).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestreamerError);
    expect((err as RestreamerError).status).toBe(400);
    expect(isTransientRestreamerError(err)).toBe(false);
  });
});
