/*
 * ColdFailoverSync tests: the impure orchestration layer over
 * coldFailoverPolicy.ts (already fully unit-tested in
 * test/coldFailoverPolicy.test.ts — this file does NOT re-test the pure
 * decision function). Hermetic in-memory SQLite (createTestDb), a real
 * InstanceCache seeded by hand, hand-built AppConfig, a Map of fake switcher
 * clients, and stub resolveSource/deliveryHealth callbacks. Most scenarios
 * construct ColdFailoverSync directly; a couple drive it end-to-end through
 * RestreamerService.coldFailoverTick() with fake node + switcher clients at
 * the client boundary.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type {
  RestreamerNodeStatus,
  SessionStatus,
  SwitcherChannelStatus,
  SwitcherNodeStatus,
} from '@tvhc/shared';
import type { Database } from '../src/db/schema.js';
import type { AppConfig } from '../src/config.js';
import type { InstancePoller } from '../src/tvh/poller.js';
import { EventBus } from '../src/state/events.js';
import { InstanceCache, type TopologySnapshot } from '../src/state/instanceCache.js';
import {
  RestreamerService,
  nodeKey,
  type RestreamerNodeClient,
  type SwitcherNodeClient,
} from '../src/restreamer/service.js';
import {
  ColdFailoverSync,
  type DeliveryHealthSource,
  type SourceKeyResolver,
} from '../src/restreamer/coldFailoverSync.js';
import {
  DELIVERY_SLOW_DEBOUNCE_TICKS,
  NODE_UNREACHABLE_DEBOUNCE_TICKS,
  RECOVERY_DEBOUNCE_TICKS,
  SESSION_UNHEALTHY_DEBOUNCE_TICKS,
  type SourceKey,
} from '../src/restreamer/coldFailoverPolicy.js';
import { createTestDb } from './support/testDb.js';
import { fakeRestreamerNode, type FakeRestreamerNode } from './support/fakeRestreamerNode.js';
import { fakeSwitcher, type FakeSwitcher } from './support/fakeSwitcher.js';

const TS = '2026-01-01 00:00:00';

// ---------- config / cache fixtures ----------

/**
 * zoneA: hot1 (preferred placements) + cold1 (a cold candidate SHARING
 * zoneA's tvh source with hot1 — the same-source gate trap). zoneB: cold2, a
 * candidate on a DIFFERENT tvh instance (a distinct source, and a distinct
 * serve origin for the delivery-slow gate).
 */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    instances: [
      {
        id: 'zoneA',
        name: 'zoneA',
        url: 'http://zoneA:9981',
        restreamer: {
          nodes: [
            { id: 'hot1', url: 'http://zoneA-hot1:5580', serveUrl: 'http://hls.zoneA-hot1' },
            { id: 'cold1', url: 'http://zoneA-cold1:5580', serveUrl: 'http://hls.zoneA-cold1' },
          ],
        },
      },
      {
        id: 'zoneB',
        name: 'zoneB',
        url: 'http://zoneB:9981',
        restreamer: {
          nodes: [{ id: 'cold2', url: 'http://zoneB-cold2:5580', serveUrl: 'http://hls.zoneB-cold2' }],
        },
      },
    ],
    rclone: { remote: '' },
    databaseUrl: null,
    port: 0,
    pollIntervals: { dvr: 15_000, autorec: 60_000, topology: 600_000, epg: 600_000, restreamer: 15_000 },
    overlapThreshold: 0.7,
    autoUpload: { enabled: false, graceSeconds: 120 },
    restreamer: { switchers: [{ id: 'sw1', url: 'http://sw1:5581', publicUrl: 'https://tv.example' }] },
    ...overrides,
  };
}

/** clone `config`, setting maxSessions on one node — for the admission-capacity scenario */
function withMaxSessions(config: AppConfig, instanceId: string, nodeId: string, max: number): AppConfig {
  return {
    ...config,
    instances: config.instances.map((inst) =>
      inst.id !== instanceId
        ? inst
        : {
            ...inst,
            restreamer: {
              nodes: inst.restreamer!.nodes.map((n) => (n.id === nodeId ? { ...n, maxSessions: max } : n)),
            },
          },
    ),
  };
}

function sess(name: string, opts: Partial<SessionStatus> = {}): SessionStatus {
  return { name, state: 'running', enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0, ...opts };
}

function nodeStatusFixture(
  instanceId: string,
  nodeId: string,
  opts: Partial<RestreamerNodeStatus> = {},
): RestreamerNodeStatus {
  return {
    instanceId,
    nodeId,
    url: `http://${instanceId}-${nodeId}`,
    serveUrl: null,
    reachable: true,
    error: null,
    lastPollAt: null,
    version: '1.0.0',
    uptimeSec: 1,
    apiVersionSupported: true,
    desiredRevision: null,
    pendingPush: false,
    sessions: [],
    sourcesHash: null,
    sources: null,
    ...opts,
  };
}

/** seed (or replace) a node's cached status */
function seedNode(
  cache: InstanceCache,
  instanceId: string,
  nodeId: string,
  opts: Partial<RestreamerNodeStatus> = {},
): void {
  const snap = cache.get(instanceId);
  const idx = snap.restreamers.findIndex((r) => r.nodeId === nodeId);
  const status = nodeStatusFixture(instanceId, nodeId, opts);
  if (idx >= 0) snap.restreamers[idx] = status;
  else snap.restreamers.push(status);
}

function setReachable(cache: InstanceCache, instanceId: string, nodeId: string, reachable: boolean): void {
  cache.get(instanceId).restreamers.find((r) => r.nodeId === nodeId)!.reachable = reachable;
}

function seedSwitcherStatus(cache: InstanceCache, switcherId: string, channels: SwitcherChannelStatus[]): void {
  const status: SwitcherNodeStatus = {
    switcherId,
    url: `http://${switcherId}`,
    publicUrl: 'https://tv.example',
    reachable: true,
    error: null,
    lastPollAt: null,
    version: '1.0.0',
    pendingPush: false,
    channels,
  };
  cache.switchers.set(switcherId, status);
}

function swChan(
  slug: string,
  activeUpstreamId: string | null,
  upstreams: Array<{ id: string; healthy: boolean }>,
): SwitcherChannelStatus {
  return { slug, activeUpstreamId, upstreams, lastSwitch: null };
}

// ---------- resolveSource / deliveryHealth stubs ----------

/** default: source identity keyed by tvh instance only (mirrors RestreamerService.sourceKeyFor's 'tvh' branch) */
function makeResolveSource(overrides: Record<string, SourceKey> = {}): SourceKeyResolver {
  return (instanceId, nodeId) => overrides[`${instanceId}/${nodeId}`] ?? { kind: 'tvh', instanceId };
}

function makeDeliveryHealth(): {
  fn: DeliveryHealthSource;
  set(origin: string, val: { slowStreak: number; healthyStreak: number }): void;
} {
  const m = new Map<string, { slowStreak: number; healthyStreak: number }>();
  return {
    fn: () => m,
    set(origin, val) {
      m.set(origin, val);
    },
  };
}

// ---------- DB seeding ----------

async function insertProfile(db: Kysely<Database>, id = 'p1'): Promise<string> {
  await db
    .insertInto('restream_profiles')
    .values({
      id,
      name: `profile-${id}`,
      payload: JSON.stringify({ template: 'arib-hls', templateVersion: 1 }),
      updated_at: TS,
    })
    .execute();
  return id;
}

async function insertChannel(
  db: Kysely<Database>,
  fields: { id?: string; slug: string; name?: string; number?: string | null; enabled?: boolean; profileId?: string },
): Promise<string> {
  const id = fields.id ?? randomUUID();
  await db
    .insertInto('restream_channels')
    .values({
      id,
      slug: fields.slug,
      channel_name: fields.name ?? fields.slug,
      channel_number: fields.number ?? null,
      profile_id: fields.profileId ?? 'p1',
      enabled: fields.enabled === false ? 0 : 1,
      comment: null,
      updated_at: TS,
    })
    .execute();
  return id;
}

async function insertPlacement(
  db: Kysely<Database>,
  fields: {
    id?: string;
    channelId: string;
    instanceId: string;
    nodeId: string;
    priority?: number;
    enabled?: boolean;
    mode?: 'hot' | 'cold';
  },
): Promise<string> {
  const id = fields.id ?? randomUUID();
  await db
    .insertInto('restream_placements')
    .values({
      id,
      channel_id: fields.channelId,
      instance_id: fields.instanceId,
      node_id: fields.nodeId,
      priority: fields.priority ?? 1,
      enabled: fields.enabled === false ? 0 : 1,
      mode: fields.mode ?? 'hot',
      weight: null,
      program_number: null,
      updated_at: TS,
    })
    .execute();
  return id;
}

async function insertActivation(
  db: Kysely<Database>,
  fields: { channelId: string; placementId: string; preferredPlacementId?: string | null; reason?: string },
): Promise<void> {
  await db
    .insertInto('restream_cold_activations')
    .values({
      channel_id: fields.channelId,
      placement_id: fields.placementId,
      preferred_placement_id: fields.preferredPlacementId ?? null,
      reason: fields.reason ?? 'node-unreachable',
      activated_at: TS,
      updated_at: TS,
    })
    .execute();
}

function activationRows(db: Kysely<Database>) {
  return db.selectFrom('restream_cold_activations').selectAll().execute();
}

// ---------- harness (direct ColdFailoverSync construction) ----------

interface Harness {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
  cache: InstanceCache;
  config: AppConfig;
  switchers: Map<string, FakeSwitcher>;
  sync: ColdFailoverSync;
  delivery: ReturnType<typeof makeDeliveryHealth>;
}

async function setup(config: AppConfig = makeConfig()): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  for (const inst of config.instances) cache.init(inst.id, inst.name, inst.url);
  const switchers = new Map<string, FakeSwitcher>();
  const switcherClients = new Map<string, SwitcherNodeClient>();
  for (const sw of config.restreamer?.switchers ?? []) {
    const fake = fakeSwitcher();
    switchers.set(sw.id, fake);
    switcherClients.set(sw.id, fake);
  }
  await insertProfile(db);
  const delivery = makeDeliveryHealth();
  const sync = new ColdFailoverSync(db, cache, config, switcherClients, makeResolveSource(), delivery.fn);
  return { db, destroy, cache, config, switchers, sync, delivery };
}

// ---------- 1. node-unreachable flap ----------

describe('ColdFailoverSync: node-unreachable trigger', () => {
  it('a 2-tick flap never activates; 3 consecutive ticks activate with reason node-unreachable', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    seedNode(h.cache, 'zoneA', 'hot1', { reachable: true, sessions: [sess('chan1')] });
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', hotId, [{ id: hotId, healthy: true }])]);

    // flap: 2 unreachable ticks, then reachable again
    setReachable(h.cache, 'zoneA', 'hot1', false);
    await h.sync.tick();
    await h.sync.tick();
    setReachable(h.cache, 'zoneA', 'hot1', true);
    await h.sync.tick();
    expect(await activationRows(h.db)).toHaveLength(0);

    // 3 consecutive unreachable ticks
    setReachable(h.cache, 'zoneA', 'hot1', false);
    await h.sync.tick();
    await h.sync.tick();
    const third = await h.sync.tick();

    const rows = await activationRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.placement_id).toBe(coldId);
    expect(rows[0]!.reason).toBe('node-unreachable');
    expect(third.changedChannelIds).toContain(chanId);
    await h.destroy();
  });
});

// ---------- 2. session-unhealthy same-source gate ----------

describe('ColdFailoverSync: session-unhealthy source gate', () => {
  it('a same-tvh-source candidate is gated: no activation, blocked mentions it', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' }); // same instance -> same source
    seedNode(h.cache, 'zoneA', 'hot1', { reachable: true, sessions: [] }); // no session for the slug -> session-unhealthy
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', 'irrelevant', [])]);

    let result;
    for (let i = 0; i < SESSION_UNHEALTHY_DEBOUNCE_TICKS; i++) result = await h.sync.tick();

    expect(await activationRows(h.db)).toHaveLength(0);
    expect(result!.blocked).toHaveLength(1);
    expect(result!.blocked[0]!.reason).toContain(coldId);
    expect(result!.blocked[0]!.reason).toContain('same source');
    await h.destroy();
  });

  it('a candidate on a different tvh instance passes the gate and activates', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneB', nodeId: 'cold2', priority: 2, mode: 'cold' }); // different instance
    seedNode(h.cache, 'zoneA', 'hot1', { reachable: true, sessions: [] });
    seedNode(h.cache, 'zoneB', 'cold2', { reachable: true, sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', 'irrelevant', [])]);

    let result;
    for (let i = 0; i < SESSION_UNHEALTHY_DEBOUNCE_TICKS; i++) result = await h.sync.tick();

    const rows = await activationRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.placement_id).toBe(coldId);
    expect(rows[0]!.reason).toBe('session-unhealthy');
    expect(result!.blocked).toHaveLength(0);
    await h.destroy();
  });
});

// ---------- 3. make-before-break ----------

describe('ColdFailoverSync: make-before-break deactivation', () => {
  it('deactivation waits for the switcher to move off the cold placement first', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    await insertActivation(h.db, { channelId: chanId, placementId: coldId, preferredPlacementId: hotId, reason: 'node-unreachable' });

    seedNode(h.cache, 'zoneA', 'hot1', { reachable: true, sessions: [sess('chan1')] }); // healthy again, running, no lag
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [sess('chan1')] });
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chan1', coldId, [
        { id: hotId, healthy: true },
        { id: coldId, healthy: true },
      ]),
    ]);

    for (let i = 0; i < RECOVERY_DEBOUNCE_TICKS + 1; i++) await h.sync.tick();
    // still routed through the cold placement -> no deactivate yet, even past the recovery debounce
    expect(await activationRows(h.db)).toHaveLength(1);

    // the switcher autonomously moves back onto the preferred placement
    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = hotId;
    await h.sync.tick();
    expect(await activationRows(h.db)).toHaveLength(0);
    await h.destroy();
  });
});

// ---------- 4. capacity-refused ----------

describe('ColdFailoverSync: admission-gated candidate selection', () => {
  it('the top-priority candidate is skipped for the next admissible one', async () => {
    const h = await setup(withMaxSessions(makeConfig(), 'zoneA', 'cold1', 0));
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' }); // maxSessions 0 -> refused
    const cold2Id = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneB', nodeId: 'cold2', priority: 3, mode: 'cold' }); // uncapped
    seedNode(h.cache, 'zoneA', 'hot1', { reachable: false }); // node-unreachable trigger (no source gate)
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [] });
    seedNode(h.cache, 'zoneB', 'cold2', { reachable: true, sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', 'irrelevant', [])]);

    for (let i = 0; i < NODE_UNREACHABLE_DEBOUNCE_TICKS; i++) await h.sync.tick();

    const rows = await activationRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.placement_id).toBe(cold2Id);
    await h.destroy();
  });

  it('both candidates refused -> blocked, no activation row', async () => {
    const h = await setup(withMaxSessions(withMaxSessions(makeConfig(), 'zoneA', 'cold1', 0), 'zoneB', 'cold2', 0));
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneB', nodeId: 'cold2', priority: 3, mode: 'cold' });
    seedNode(h.cache, 'zoneA', 'hot1', { reachable: false });
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [] });
    seedNode(h.cache, 'zoneB', 'cold2', { reachable: true, sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', 'irrelevant', [])]);

    let result;
    for (let i = 0; i < NODE_UNREACHABLE_DEBOUNCE_TICKS; i++) result = await h.sync.tick();

    expect(await activationRows(h.db)).toHaveLength(0);
    expect(result!.blocked).toHaveLength(1);
    await h.destroy();
  });
});

// ---------- 5. delivery-slow end-to-end ----------

describe('ColdFailoverSync: delivery-slow trigger, forced switch and switch-back', () => {
  it('activates immediately on a slow probe, force-switches once (deduped), then switches back and deactivates on recovery', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    // the WHATWG URL parser lowercases the hostname -- the origin the sync
    // layer computes is NOT byte-identical to the configured serveUrl
    const hotOrigin = new URL('http://hls.zoneA-hot1').origin;

    seedNode(h.cache, 'zoneA', 'hot1', { reachable: true, sessions: [sess('chan1')] }); // encode itself stays healthy throughout
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [sess('chan1')] }); // already running, ready to take over
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chan1', hotId, [
        { id: hotId, healthy: true },
        { id: coldId, healthy: true }, // activeColdReady needs the switcher to see it healthy
      ]),
    ]);
    const fakeSw = h.switchers.get('sw1')!;

    // tick 1: probe reports the preferred origin slow -> activates immediately
    // (the probe's own streak is already >= debounce; the sync layer does not
    // re-accumulate it)
    h.delivery.set(hotOrigin, { slowStreak: DELIVERY_SLOW_DEBOUNCE_TICKS, healthyStreak: 0 });
    await h.sync.tick();
    let rows = await activationRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('delivery-slow');
    expect(fakeSw.switches()).toHaveLength(0); // activation only, not yet a switch command

    // ticks 2-3: still slow -> exactly one switchChannel call across both (dedupe)
    await h.sync.tick();
    await h.sync.tick();
    expect(fakeSw.switches()).toHaveLength(1);
    expect(fakeSw.switches()[0]).toMatchObject({ slug: 'chan1', upstreamId: coldId });

    // probe recovers and the switcher (simulated poll) is now serving the cold
    // upstream; 3 recovery ticks while still on cold -> forced switch-back
    h.delivery.set(hotOrigin, { slowStreak: 0, healthyStreak: 1 });
    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = coldId;
    await h.sync.tick();
    await h.sync.tick();
    await h.sync.tick();
    expect(fakeSw.switches().some((c) => c.upstreamId === hotId)).toBe(true);
    rows = await activationRows(h.db);
    expect(rows).toHaveLength(1); // still active -- the switcher hasn't actually moved yet

    // the switcher (simulated) finally moves back onto the preferred placement
    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = hotId;
    await h.sync.tick();
    expect(await activationRows(h.db)).toHaveLength(0);
    await h.destroy();
  });
});

// ---------- 6. staleness pruning ----------

describe('ColdFailoverSync: stale activation pruning', () => {
  it('tick() prunes a row whose cold placement was disabled', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    await insertActivation(h.db, { channelId: chanId, placementId: coldId, preferredPlacementId: hotId });
    seedNode(h.cache, 'zoneA', 'hot1', { reachable: true, sessions: [sess('chan1')] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', coldId, [{ id: hotId, healthy: true }, { id: coldId, healthy: true }])]);

    await h.db.updateTable('restream_placements').set({ enabled: 0 }).where('id', '=', coldId).execute();
    const result = await h.sync.tick();
    expect(await activationRows(h.db)).toHaveLength(0);
    expect(result.changedChannelIds).toContain(chanId);
    await h.destroy();
  });

  it('reconcileOnStartup() alone prunes a stale row on a fresh instance', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'cold1',
      priority: 2,
      mode: 'cold',
      enabled: false,
    });
    await insertActivation(h.db, { channelId: chanId, placementId: coldId, preferredPlacementId: hotId });

    const fresh = new ColdFailoverSync(h.db, h.cache, h.config, new Map(), makeResolveSource(), h.delivery.fn);
    const changed = await fresh.reconcileOnStartup();
    expect(changed).toContain(chanId);
    expect(await activationRows(h.db)).toHaveLength(0);
    await h.destroy();
  });

  it('a placement mode flipped away from cold prunes its activation', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    await insertActivation(h.db, { channelId: chanId, placementId: coldId, preferredPlacementId: hotId });

    await h.db.updateTable('restream_placements').set({ mode: 'hot' }).where('id', '=', coldId).execute();
    await h.sync.tick();
    expect(await activationRows(h.db)).toHaveLength(0);
    await h.destroy();
  });

  it('a disabled channel prunes its activation', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    await insertActivation(h.db, { channelId: chanId, placementId: coldId, preferredPlacementId: hotId });

    await h.db.updateTable('restream_channels').set({ enabled: 0 }).where('id', '=', chanId).execute();
    await h.sync.tick();
    expect(await activationRows(h.db)).toHaveLength(0);
    await h.destroy();
  });
});

// ---------- 7. restart mid-activation ----------

describe('ColdFailoverSync: restart mid-activation', () => {
  it('reconcileOnStartup keeps a valid row; a fresh instance does not prematurely deactivate', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const hotId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    const coldId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    await insertActivation(h.db, { channelId: chanId, placementId: coldId, preferredPlacementId: hotId, reason: 'node-unreachable' });

    seedNode(h.cache, 'zoneA', 'hot1', { reachable: true, sessions: [sess('chan1')] }); // preferred healthy again
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [sess('chan1')] });
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chan1', coldId, [{ id: hotId, healthy: true }, { id: coldId, healthy: true }]), // still routed via cold
    ]);

    const fresh = new ColdFailoverSync(h.db, h.cache, h.config, new Map(), makeResolveSource(), h.delivery.fn);
    const changed = await fresh.reconcileOnStartup();
    expect(changed).toEqual([]);
    expect(await activationRows(h.db)).toHaveLength(1);

    // preferred is healthy, but this fresh instance's recovery streak starts
    // at zero -- one tick must not be enough to deactivate
    await fresh.tick();
    expect(await activationRows(h.db)).toHaveLength(1);
    await h.destroy();
  });
});

// ---------- 8. switcher-not-reporting ----------

describe('ColdFailoverSync: switcher not reporting the channel', () => {
  it('the channel is left untouched even with its node down for 5 ticks', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'hot1', priority: 1, mode: 'hot' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'cold1', priority: 2, mode: 'cold' });
    seedNode(h.cache, 'zoneA', 'hot1', { reachable: false });
    seedNode(h.cache, 'zoneA', 'cold1', { reachable: true, sessions: [] });
    // deliberately no cache.switchers entry at all

    let result;
    for (let i = 0; i < 5; i++) result = await h.sync.tick();
    expect(await activationRows(h.db)).toHaveLength(0);
    expect(result!.blocked).toHaveLength(0);
    await h.destroy();
  });
});

// ---------- 9. RestreamerService end-to-end ----------

function topologyWithAtx(uuidPrefix: string): TopologySnapshot {
  return {
    channels: [{ uuid: `${uuidPrefix}-atx`, name: 'AT-X', number: '9.1', services: [`${uuidPrefix}-svc`] }],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [{ uuid: `${uuidPrefix}-svc`, sid: 101 }],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
  };
}

interface ServiceHarness {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
  cache: InstanceCache;
  service: RestreamerService;
  nodes: Map<string, FakeRestreamerNode>;
  switcher: FakeSwitcher;
}

async function setupService(): Promise<ServiceHarness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  const bus = new EventBus();
  const config = makeConfig();
  const pollers = new Map<string, InstancePoller>();
  const nodes = new Map<string, FakeRestreamerNode>();
  const clients = new Map<string, RestreamerNodeClient>();
  for (const inst of config.instances) {
    cache.init(inst.id, inst.name, inst.url);
    cache.get(inst.id).topology = topologyWithAtx(inst.id);
    pollers.set(inst.id, { pollTopology: async () => {} } as unknown as InstancePoller);
    for (const n of inst.restreamer?.nodes ?? []) {
      const fake = fakeRestreamerNode();
      nodes.set(nodeKey(inst.id, n.id), fake);
      clients.set(nodeKey(inst.id, n.id), fake);
    }
  }
  const switcher = fakeSwitcher();
  const switcherClients = new Map<string, SwitcherNodeClient>();
  for (const sw of config.restreamer?.switchers ?? []) switcherClients.set(sw.id, switcher);
  const service = new RestreamerService(db, cache, pollers, bus, config, clients, switcherClients);
  return { db, destroy, cache, service, nodes, switcher };
}

describe('RestreamerService.coldFailoverTick (end-to-end)', () => {
  it('activation pushes the cold node and the switcher doc; deactivateColdBackup reverts both', async () => {
    const h = await setupService();
    const profile = await h.service.createProfile('p', {
      template: 'arib-hls',
      templateVersion: 1,
      video: { mode: 'ivtc' },
      audio: [{}],
    });
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: profile.id,
      placements: [
        { instanceId: 'zoneA', nodeId: 'hot1' }, // hot (default)
        { instanceId: 'zoneB', nodeId: 'cold2', mode: 'cold' },
      ],
    });
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    const hotP = placements.find((p) => p.nodeId === 'hot1')!;
    const coldP = placements.find((p) => p.nodeId === 'cold2')!;

    const nodeB = h.nodes.get(nodeKey('zoneB', 'cold2'))!;
    expect((await h.service.computeNodeDoc('zoneB', 'cold2')).doc!.sessions).toHaveLength(0);

    // seed the cold candidate's own polled status (admission needs it) and the
    // switcher's status, reporting the channel active on the hot placement
    h.cache.get('zoneB').restreamers.push({
      instanceId: 'zoneB',
      nodeId: 'cold2',
      url: 'http://zoneB-cold2',
      serveUrl: 'http://hls.zoneB-cold2',
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '1.0.0',
      uptimeSec: 1,
      apiVersionSupported: true,
      desiredRevision: null,
      pendingPush: false,
      sessions: [],
      sourcesHash: null,
      sources: null,
    });
    h.cache.switchers.set('sw1', {
      switcherId: 'sw1',
      url: 'http://sw1:5581',
      publicUrl: 'https://tv.example',
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '1.0.0',
      pendingPush: false,
      channels: [
        { slug: 'at-x', activeUpstreamId: hotP.id, upstreams: [{ id: hotP.id, healthy: true }], lastSwitch: null },
      ],
    });

    // node A (the preferred placement's node) goes unreachable
    h.cache.get('zoneA').restreamers.push({
      instanceId: 'zoneA',
      nodeId: 'hot1',
      url: 'http://zoneA-hot1',
      serveUrl: 'http://hls.zoneA-hot1',
      reachable: false,
      error: 'down',
      lastPollAt: null,
      version: '1.0.0',
      uptimeSec: 1,
      apiVersionSupported: true,
      desiredRevision: null,
      pendingPush: false,
      sessions: [],
      sourcesHash: null,
      sources: null,
    });

    await h.service.coldFailoverTick();
    await h.service.coldFailoverTick();
    await h.service.coldFailoverTick();

    const rows = await h.db.selectFrom('restream_cold_activations').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.placement_id).toBe(coldP.id);

    expect(nodeB.desired!.sessions.map((s) => s.name)).toContain('at-x');
    const swDoc = h.switcher.desired!.channels.find((c) => c.slug === 'at-x')!;
    expect(swDoc.upstreams.map((u) => u.id)).toContain(coldP.id);

    const putsBefore = nodeB.puts().length;
    const res = await h.service.deactivateColdBackup(chan.id);
    expect(res).toEqual({ ok: true, existed: true });
    expect(await h.db.selectFrom('restream_cold_activations').selectAll().execute()).toHaveLength(0);
    expect(nodeB.puts().length).toBeGreaterThan(putsBefore);
    expect(nodeB.desired!.sessions.map((s) => s.name)).not.toContain('at-x');
    await h.destroy();
  });
});
