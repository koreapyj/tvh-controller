/*
 * GET /api/recordings (registerUnifiedRoutes) — first coverage of this route.
 * Scoped to `scopeInstanceIds` only (dedup, grouping, upload matching are
 * exercised implicitly but not asserted here — out of scope per the plan).
 *
 * Harness mirrors test/engine.test.ts: real InstanceCache/SyncEngine/EventBus
 * over the hermetic in-memory SQLite db (test/support/testDb.ts) with a fake
 * TvhClient/poller at the sync boundary, driven through Fastify `inject`
 * like test/recordings.test.ts.
 */

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.js';
import type { InstancePoller } from '../src/tvh/poller.js';
import type { UnifiedGroup } from '@tvhc/shared';
import { registerUnifiedRoutes } from '../src/routes/unified.js';
import type { AppContext } from '../src/routes/context.js';
import { SyncEngine } from '../src/sync/engine.js';
import { InstanceCache } from '../src/state/instanceCache.js';
import { EventBus } from '../src/state/events.js';
import { createTestDb } from './support/testDb.js';
import { fakePoller, fakeTvhClient, type FakeTvhClient } from './support/fakePoller.js';
import { masterRulePayload, topologySnapshot } from './support/fixtures.js';

interface Harness {
  destroy: () => Promise<void>;
  cache: InstanceCache;
  engine: SyncEngine;
  clients: Map<string, FakeTvhClient>;
  ctx: AppContext;
}

/**
 * tyo1/osk1 have a tvheadend; rs1 is tvh-less (url: null) — cache snapshot
 * exists but there is NO poller and NO topology, exactly how main.ts wires a
 * restreamer-only zone (see engine.test.ts's "tvh-less instances" block).
 */
async function setup(): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  const bus = new EventBus();
  const pollers = new Map<string, InstancePoller>();
  const clients = new Map<string, FakeTvhClient>();
  for (const id of ['tyo1', 'osk1']) {
    cache.init(id, id, `http://${id}`);
    const snap = cache.get(id);
    snap.summary.reachable = true;
    snap.topology = topologySnapshot();
    const client = fakeTvhClient();
    clients.set(id, client);
    const poller = fakePoller(cache, id, client);
    pollers.set(id, poller as unknown as InstancePoller);
  }
  cache.init('rs1', 'rs1', null);

  const engine = new SyncEngine(db, cache, pollers, bus);
  const ctx = {
    config: { overlapThreshold: 0.7 } as unknown as AppConfig,
    db,
    cache,
    sync: engine,
    ledger: null,
  } as unknown as AppContext;

  return { destroy, cache, engine, clients, ctx };
}

async function build(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify();
  registerUnifiedRoutes(app, ctx);
  await app.ready();
  return app;
}

async function getUnified(
  app: FastifyInstance,
  state: 'upcoming' | 'finished' | 'failed' = 'upcoming',
): Promise<UnifiedGroup[]> {
  const res = await app.inject({ method: 'GET', url: `/api/recordings?state=${state}` });
  expect(res.statusCode).toBe(200);
  return res.json() as UnifiedGroup[];
}

describe('GET /api/recordings: scopeInstanceIds', () => {
  it('an explicit-scope rule bound via a rule_binding: scopeInstanceIds is exactly that instance', async () => {
    const { destroy, cache, engine, clients, ctx } = await setup();
    const rule = await engine.createRule({
      name: 'News',
      instances: ['tyo1'],
      payload: masterRulePayload({ name: 'News', channel: 'KBS1' }),
    });
    const [result] = await engine.pushRule(rule.id);
    expect(result?.action).toBe('created');
    const autorecUuid = clients.get('tyo1')!.rules[0]!.uuid;

    cache.get('tyo1').upcoming = [
      {
        uuid: 'e1',
        start: 1000,
        stop: 2000,
        channelname: 'KBS1',
        disp_title: 'Prog',
        autorec: autorecUuid,
        enabled: true,
      },
    ];

    const app = await build(ctx);
    const groups = await getUnified(app);
    const item = groups.flatMap((g) => g.items).find((i) => i.channelname === 'KBS1');
    expect(item).toBeTruthy();
    expect(item!.scopeInstanceIds).toEqual(['tyo1']);
    // survives the JSON round trip verbatim, not just as an in-memory value
    expect(JSON.parse(JSON.stringify(item)).scopeInstanceIds).toEqual(['tyo1']);

    await app.close();
    await destroy();
  });

  it("scope 'all' materializes to the tvh-capable ids only (tvh-less rs1 excluded)", async () => {
    const { destroy, cache, engine, clients, ctx } = await setup();
    const rule = await engine.createRule({
      name: 'Sports',
      instances: 'all',
      payload: masterRulePayload({ name: 'Sports', channel: 'MBC1' }),
    });
    const results = await engine.pushRule(rule.id);
    expect(results.map((r) => r.instanceId).sort()).toEqual(['osk1', 'tyo1']);
    const autorecUuid = clients.get('tyo1')!.rules[0]!.uuid;

    cache.get('tyo1').upcoming = [
      {
        uuid: 'e2',
        start: 3000,
        stop: 4000,
        channelname: 'MBC1',
        disp_title: 'Match',
        autorec: autorecUuid,
        enabled: true,
      },
    ];

    const app = await build(ctx);
    const groups = await getUnified(app);
    const item = groups.flatMap((g) => g.items).find((i) => i.channelname === 'MBC1');
    expect(item).toBeTruthy();
    expect(item!.scopeInstanceIds).toEqual(['tyo1', 'osk1']);

    await app.close();
    await destroy();
  });

  it('a manual entry (no autorec) has scopeInstanceIds undefined', async () => {
    const { destroy, cache, ctx } = await setup();
    cache.get('osk1').upcoming = [
      {
        uuid: 'e3',
        start: 5000,
        stop: 6000,
        channelname: 'KBS1',
        disp_title: 'Manual show',
        enabled: true,
      },
    ];

    const app = await build(ctx);
    const groups = await getUnified(app);
    const item = groups.flatMap((g) => g.items).find((i) => i.channelname === 'KBS1');
    expect(item).toBeTruthy();
    expect(item!.scopeInstanceIds).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(item, 'scopeInstanceIds')).toBe(false);

    await app.close();
    await destroy();
  });
});
