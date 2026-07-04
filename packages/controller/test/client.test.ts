/*
 * TvhClient tests against a fake fetch implementation — no network. Covers
 * EPG grid pagination, the Basic->Digest 401 retry, the double-401 digest
 * session reset (client.ts:98-108-ish), and the AbortSignal timeout mapping.
 */

import { describe, expect, it } from 'vitest';
import type { TvhEpgEvent } from '@tvhc/shared';
import { TvhClient } from '../src/tvh/client.js';

type FetchImpl = typeof fetch;

function bodyParams(init?: RequestInit): URLSearchParams {
  return new URLSearchParams((init?.body as string) ?? '');
}

describe('TvhClient.epgEventsAll', () => {
  const PAGE = 20000;

  function page(offset: number, count: number): TvhEpgEvent[] {
    return Array.from({ length: count }, (_, i) => ({
      eventId: offset + i,
      channelName: 'C',
      channelUuid: 'u',
      start: offset + i,
      stop: offset + i + 100,
    })) as TvhEpgEvent[];
  }

  it('pages until a short page, concatenating in order with correct start offsets', async () => {
    const starts: number[] = [];
    const fetchImpl: FetchImpl = (async (_url, init) => {
      const start = Number(bodyParams(init).get('start'));
      starts.push(start);
      const entries = start === 0 ? page(0, PAGE) : start === PAGE ? page(PAGE, PAGE) : page(2 * PAGE, 5);
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }) as unknown as FetchImpl;

    const client = new TvhClient('http://tvh.local', undefined, undefined, fetchImpl);
    const all = await client.epgEventsAll();

    expect(starts).toEqual([0, PAGE, 2 * PAGE]);
    expect(all).toHaveLength(2 * PAGE + 5);
    expect(all[0]?.eventId).toBe(0);
    expect(all[PAGE]?.eventId).toBe(PAGE); // first entry of the second page
    expect(all[all.length - 1]?.eventId).toBe(2 * PAGE + 4);
  });

  it('stops after a single short (or empty) page', async () => {
    const fetchImpl: FetchImpl = (async () =>
      new Response(JSON.stringify({ entries: page(0, 3) }), { status: 200 })) as unknown as FetchImpl;
    const client = new TvhClient('http://tvh.local', undefined, undefined, fetchImpl);
    const all = await client.epgEventsAll();
    expect(all).toHaveLength(3);
  });
});

describe('TvhClient auth: Basic -> Digest retry', () => {
  it('retries a 401 with a Digest Authorization header derived from the challenge', async () => {
    const authHeaders: (string | null)[] = [];
    const fetchImpl: FetchImpl = (async (_url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      authHeaders.push(auth);
      if (!auth || auth.startsWith('Basic')) {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'www-authenticate': 'Digest realm="tvheadend", qop="auth", nonce="n1"' },
        });
      }
      return new Response(JSON.stringify({ sw_version: '4.3' }), { status: 200 });
    }) as unknown as FetchImpl;

    const client = new TvhClient('http://tvh.local', 'user', 'pass', fetchImpl);
    const info = await client.serverInfo();

    expect(info).toEqual({ sw_version: '4.3' });
    expect(authHeaders).toHaveLength(2);
    expect(authHeaders[0]).toMatch(/^Basic /);
    expect(authHeaders[1]).toMatch(/^Digest /);
  });
});

describe('TvhClient auth: double-401 resets the digest session', () => {
  it('drops the digest session after two consecutive 401s; the next call starts from Basic again', async () => {
    const authHeaders: (string | null)[] = [];
    let call = 0;
    const fetchImpl: FetchImpl = (async (_url, init) => {
      call += 1;
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      authHeaders.push(auth);
      switch (call) {
        case 1: // initial Basic attempt of request #1
          return new Response('unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Digest realm="tvheadend", qop="auth", nonce="n1"' },
          });
        case 2: // digest retry of request #1 — succeeds, session established
          return new Response(JSON.stringify({}), { status: 200 });
        case 3: // initial digest attempt of request #2 — server rotates the nonce
          return new Response('unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Digest realm="tvheadend", qop="auth", nonce="n2"' },
          });
        case 4: // digest retry of request #2 with the updated challenge — rejected again
          return new Response('unauthorized', { status: 401 });
        default: // request #3: session must have been dropped, so this is Basic again
          return new Response(JSON.stringify({}), { status: 200 });
      }
    }) as unknown as FetchImpl;

    const client = new TvhClient('http://tvh.local', 'user', 'pass', fetchImpl);

    await client.serverInfo(); // request #1: establishes the digest session
    await expect(client.serverInfo()).rejects.toThrow(/HTTP 401/); // request #2: double-401
    await client.serverInfo(); // request #3

    expect(authHeaders).toHaveLength(5);
    expect(authHeaders[0]).toMatch(/^Basic /); // request #1 attempt 1
    expect(authHeaders[1]).toMatch(/^Digest /); // request #1 retry
    expect(authHeaders[2]).toMatch(/^Digest /); // request #2 attempt 1 (reused session)
    expect(authHeaders[3]).toMatch(/^Digest /); // request #2 retry (updated challenge)
    expect(authHeaders[4]).toMatch(/^Basic /); // request #3 — session was reset
  });
});

describe('TvhClient timeout', () => {
  it('maps an aborted request to a "timed out after" error', async () => {
    const fetchImpl: FetchImpl = (async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'TimeoutError';
          reject(err);
        });
      });
    }) as unknown as FetchImpl;

    const client = new TvhClient('http://tvh.local', undefined, undefined, fetchImpl, 5);
    await expect(client.serverInfo()).rejects.toThrow(/timed out after 5ms/);
  });
});
