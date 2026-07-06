/*
 * Instance routes over a real InstanceCache — focused on tvh-less zones
 * (config url: null): the summary carries hasTvh, the overview renders
 * without errors, and the merged channel list naturally skips them.
 */

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChannelOption, InstanceOverview, InstanceSummary } from '@tvhc/shared';
import { registerInstanceRoutes } from '../src/routes/instances.js';
import { InstanceCache } from '../src/state/instanceCache.js';
import type { AppContext } from '../src/routes/context.js';

async function build(cache: InstanceCache): Promise<FastifyInstance> {
  const app = Fastify();
  const ctx = {
    cache,
    pollers: new Map(),
    db: null,
    ledger: null,
    config: { overlapThreshold: 0.7 },
  } as unknown as AppContext;
  registerInstanceRoutes(app, ctx);
  await app.ready();
  return app;
}

function seededCache(): InstanceCache {
  const cache = new InstanceCache();
  cache.init('tyo1', 'Tokyo', 'http://tyo1.local:9981');
  cache.init('ext1', 'External', null); // tvh-less zone
  const tyo = cache.get('tyo1');
  tyo.summary.reachable = true;
  tyo.topology = {
    channels: [{ uuid: 'ch1', name: 'KBS1', number: '1' }],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
  };
  return cache;
}

describe('GET /api/instances with a tvh-less instance', () => {
  it('exposes hasTvh and a null url; the tvh-less zone is not an error state', async () => {
    const app = await build(seededCache());
    const res = await app.inject({ method: 'GET', url: '/api/instances' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as InstanceSummary[];
    const byId = new Map(list.map((s) => [s.id, s]));
    expect(byId.get('tyo1')).toMatchObject({ hasTvh: true, url: 'http://tyo1.local:9981' });
    expect(byId.get('ext1')).toMatchObject({
      hasTvh: false,
      url: null,
      reachable: false,
      error: null, // neutral — never surfaced as unreachable/error
    });
    await app.close();
  });
});

describe('GET /api/instances/:id/overview for a tvh-less instance', () => {
  it('returns a valid all-empty overview instead of crashing', async () => {
    const app = await build(seededCache());
    const res = await app.inject({ method: 'GET', url: '/api/instances/ext1/overview' });
    expect(res.statusCode).toBe(200);
    const o = res.json() as InstanceOverview;
    expect(o.instance).toMatchObject({ id: 'ext1', hasTvh: false, url: null });
    expect(o.counts).toEqual({ upcoming: 0, finished: 0, failed: 0 });
    expect(o.inputs).toEqual([]);
    expect(o.subscriptions).toEqual([]);
    expect(o.nextRecordings).toEqual([]);
    expect(o.conflicts).toEqual([]);
    await app.close();
  });

  it('still 404s for a genuinely unknown instance', async () => {
    const app = await build(seededCache());
    const res = await app.inject({ method: 'GET', url: '/api/instances/nope/overview' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/channels with a tvh-less instance', () => {
  it('merges channels from tvh instances only (tvh-less has no topology, ever)', async () => {
    const app = await build(seededCache());
    const res = await app.inject({ method: 'GET', url: '/api/channels' });
    expect(res.statusCode).toBe(200);
    const channels = res.json() as ChannelOption[];
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ name: 'KBS1', instances: ['tyo1'] });
    await app.close();
  });
});
