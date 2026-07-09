/*
 * FailoverSync tests: the impure orchestration layer over failoverPolicy.ts
 * (already fully unit-tested in test/failoverPolicy.test.ts — this file does
 * NOT re-test the pure decision function). FailoverSync is constructed
 * DIRECTLY: hermetic in-memory SQLite (createTestDb), a real InstanceCache
 * seeded by hand, a hand-built AppConfig, a Map of fake switcher clients
 * (fakeSwitcher), hand-built probe snapshot maps, an injectable clock, and
 * hooks that just record calls.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type {
  NodeProbeSettings,
  RestreamerNodeStatus,
  SessionStatus,
  SwitcherChannelStatus,
  SwitcherNodeStatus,
} from '@tvhc/shared';
import type { Database } from '../src/db/schema.js';
import type { AppConfig } from '../src/config.js';
import { InstanceCache } from '../src/state/instanceCache.js';
import { FailoverSync, type FailoverNodeRef, type ResetOutcome } from '../src/restreamer/failoverSync.js';
import { LAG_DISCOVERY_TIMEOUT_MS, RETRIGGER_BACKOFF_MIN_MS } from '../src/restreamer/failoverPolicy.js';
import type { ProbeSnapshot } from '../src/restreamer/probeEngine.js';
import { NODE_PROBE_DEFAULTS } from '../src/restreamer/probeSettings.js';
import type { SwitcherNodeClient } from '../src/restreamer/switcherSync.js';
import { createTestDb } from './support/testDb.js';
import { fakeSwitcher, type FakeSwitcher } from './support/fakeSwitcher.js';

const TS = '2026-01-01 00:00:00';

// ---------- config / cache fixtures ----------

/**
 * zoneA hosts two candidates (n1 = "A", n2 = "B") sharing one instance;
 * zoneB hosts a third (n1 = "C") on a different instance — enough spread for
 * the retarget-then-exhaust scenario. One switcher, 'sw1'.
 */
function makeConfig(): AppConfig {
  return {
    instances: [
      {
        id: 'zoneA',
        name: 'zoneA',
        url: 'http://zoneA:9981',
        restreamer: {
          nodes: [
            { id: 'n1', url: 'http://zoneA-n1:5580', serveUrl: 'http://hls.zoneA-n1' },
            { id: 'n2', url: 'http://zoneA-n2:5580', serveUrl: 'http://hls.zoneA-n2' },
          ],
        },
      },
      {
        id: 'zoneB',
        name: 'zoneB',
        url: 'http://zoneB:9981',
        restreamer: { nodes: [{ id: 'n1', url: 'http://zoneB-n1:5580', serveUrl: 'http://hls.zoneB-n1' }] },
      },
    ],
    rclone: { remote: '' },
    databaseUrl: null,
    port: 0,
    pollIntervals: { dvr: 15_000, autorec: 60_000, topology: 600_000, epg: 600_000, restreamer: 15_000 },
    overlapThreshold: 0.7,
    autoUpload: { enabled: false, graceSeconds: 120 },
    restreamer: { switchers: [{ id: 'sw1', url: 'http://sw1:5581', publicUrl: 'https://tv.example' }] },
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
    probes: null,
    sessions: [],
    sourcesHash: null,
    sources: null,
    ...opts,
  };
}

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

/** adds one session to a node's cached status without clobbering sessions of other channels already there */
function addSession(cache: InstanceCache, instanceId: string, nodeId: string, slug: string): void {
  const snap = cache.get(instanceId);
  let entry = snap.restreamers.find((r) => r.nodeId === nodeId);
  if (!entry) {
    entry = nodeStatusFixture(instanceId, nodeId);
    snap.restreamers.push(entry);
  }
  entry.sessions = [...entry.sessions, sess(slug)];
}

/** removes one channel's session from a node's cached status, leaving any others intact */
function removeSession(cache: InstanceCache, instanceId: string, nodeId: string, slug: string): void {
  const entry = cache.get(instanceId).restreamers.find((r) => r.nodeId === nodeId);
  if (entry) entry.sessions = entry.sessions.filter((s) => s.name !== slug);
}

/** merges (by slug) into any existing status for this switcher, rather than clobbering other channels' entries */
function seedSwitcherStatus(cache: InstanceCache, switcherId: string, channels: SwitcherChannelStatus[]): void {
  const existing = cache.switchers.get(switcherId)?.channels ?? [];
  const bySlug = new Map(existing.map((c) => [c.slug, c]));
  for (const c of channels) bySlug.set(c.slug, c);
  const status: SwitcherNodeStatus = {
    switcherId,
    url: `http://${switcherId}`,
    publicUrl: 'https://tv.example',
    reachable: true,
    error: null,
    lastPollAt: null,
    version: '1.0.0',
    pendingPush: false,
    channels: [...bySlug.values()],
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

// ---------- probe snapshot (hand-built, structural) ----------

interface CounterLike {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  failed: boolean;
  lastResult: 'ok' | 'fail';
  lastCheckedAt: string;
  detail: string;
  lastLagSec?: number | null;
  firstMeasuredAt?: string | null;
  lastSpeed?: number | null;
  lastSampleAt?: string | null;
  lastSpeedRatio?: number | null;
}

interface MutableSnapshot {
  liveness: Map<string, CounterLike>;
  underspeed: Map<string, CounterLike>;
  lag: Map<string, CounterLike>;
  underrun: Map<string, CounterLike>;
}

function emptySnapshot(): MutableSnapshot {
  return { liveness: new Map(), underspeed: new Map(), lag: new Map(), underrun: new Map() };
}

function failing(detail = 'failing'): CounterLike {
  return {
    consecutiveFailures: 3,
    consecutiveSuccesses: 0,
    failed: true,
    lastResult: 'fail',
    lastCheckedAt: TS,
    detail,
  };
}

function lagOk(lastLagSec: number, firstMeasuredAt = TS): CounterLike {
  return {
    consecutiveFailures: 0,
    consecutiveSuccesses: 1,
    failed: false,
    lastResult: 'ok',
    lastCheckedAt: TS,
    detail: `lag ${lastLagSec}s`,
    lastLagSec,
    firstMeasuredAt,
  };
}

function lagFail(lastLagSec: number): CounterLike {
  return {
    consecutiveFailures: 3,
    consecutiveSuccesses: 0,
    failed: true,
    lastResult: 'fail',
    lastCheckedAt: TS,
    detail: `lag ${lastLagSec}s`,
    lastLagSec,
    firstMeasuredAt: TS,
  };
}

// ---------- DB seeding ----------

async function insertProfile(db: Kysely<Database>, id = 'p1'): Promise<string> {
  await db
    .insertInto('restream_profiles')
    .values({
      id,
      name: `profile-${id}`,
      payload: JSON.stringify({ template: 'arib-hls', templateVersion: 1, video: { mode: 'ivtc' }, audio: [{}] }),
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

async function seedFailoverRowDirect(
  db: Kysely<Database>,
  fields: {
    channelId: string;
    fromPlacementId: string | null;
    toPlacementId: string;
    phase: string;
    triggerReason?: string;
    triggerNodeId?: string | null;
    suppressFrom?: boolean;
    drainUntil?: string | null;
  },
): Promise<void> {
  await db
    .insertInto('restream_failover_state')
    .values({
      channel_id: fields.channelId,
      from_placement_id: fields.fromPlacementId,
      to_placement_id: fields.toPlacementId,
      phase: fields.phase,
      trigger_reason: fields.triggerReason ?? 'manual',
      trigger_node_id: fields.triggerNodeId ?? null,
      trigger_detail: null,
      suppress_from: fields.suppressFrom ? 1 : 0,
      drain_until: fields.drainUntil ?? null,
      started_at: TS,
      updated_at: TS,
    })
    .execute();
}

function failoverRow(db: Kysely<Database>, channelId: string) {
  return db
    .selectFrom('restream_failover_state')
    .selectAll()
    .where('channel_id', '=', channelId)
    .executeTakeFirst();
}

// ---------- harness ----------

interface Harness {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
  cache: InstanceCache;
  config: AppConfig;
  switcher: FakeSwitcher;
  sync: FailoverSync;
  snapshot: MutableSnapshot;
  settingsMap: Map<string, NodeProbeSettings>;
  pushNodes: ReturnType<typeof vi.fn>;
  pushSwitchers: ReturnType<typeof vi.fn>;
  publishChannel: ReturnType<typeof vi.fn>;
  onSwitchIssued: ReturnType<typeof vi.fn>;
  advanceNow: (ms: number) => void;
  nowMs: () => number;
}

async function setup(): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  const config = makeConfig();
  for (const inst of config.instances) cache.init(inst.id, inst.name, inst.url);
  await insertProfile(db);

  const switcher = fakeSwitcher();
  const switcherClients = new Map<string, SwitcherNodeClient>([['sw1', switcher]]);

  const snapshot = emptySnapshot();
  const settingsMap = new Map<string, NodeProbeSettings>();
  for (const inst of config.instances) {
    for (const n of inst.restreamer!.nodes) settingsMap.set(`${inst.id}/${n.id}`, NODE_PROBE_DEFAULTS);
  }

  const pushNodes = vi.fn(async (_nodes: FailoverNodeRef[]) => {});
  const pushSwitchers = vi.fn(async () => {});
  const publishChannel = vi.fn((_channelId: string) => {});
  const onSwitchIssued = vi.fn(() => {});

  let ms = Date.parse('2026-06-01T00:00:00.000Z');
  const sync = new FailoverSync(
    db,
    cache,
    config,
    switcherClients,
    () => snapshot as unknown as ProbeSnapshot,
    async () => settingsMap,
    { pushNodes, pushSwitchers, publishChannel, onSwitchIssued },
    () => new Date(ms),
  );

  return {
    db,
    destroy,
    cache,
    config,
    switcher,
    sync,
    snapshot,
    settingsMap,
    pushNodes,
    pushSwitchers,
    publishChannel,
    onSwitchIssued,
    advanceNow: (delta: number) => {
      ms += delta;
    },
    nowMs: () => ms,
  };
}

/** two-placement redundant channel (A active on zoneA/n1, B standby on zoneA/n2) with the switcher reporting A active */
async function seedTwoPlacementChannel(h: Harness, slug = 'chan1') {
  const chanId = await insertChannel(h.db, { slug });
  const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
  const bId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n2', priority: 2 });
  addSession(h.cache, 'zoneA', 'n1', slug);
  addSession(h.cache, 'zoneA', 'n2', slug);
  seedSwitcherStatus(h.cache, 'sw1', [
    swChan(slug, aId, [
      { id: aId, healthy: true },
      { id: bId, healthy: true },
    ]),
  ]);
  return { chanId, aId, bId };
}

// ---------- 1. full automatic procedure ----------

describe('FailoverSync: full automatic procedure (lag trigger through completion)', () => {
  it('advances lag-triggered failover from bringing-up through complete, releasing the active slot', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);

    // trigger: lag failed on A, the currently active placement
    h.snapshot.lag.set(aId, lagFail(40));

    await h.sync.tick();
    let row = await failoverRow(h.db, chanId);
    // bringing-up always auto-advances within the same tick; B has no lag
    // measurement yet, so it stops at awaiting-lag
    expect(row).toMatchObject({ from_placement_id: aId, to_placement_id: bId, phase: 'awaiting-lag', trigger_reason: 'lag' });
    expect(h.sync.activeChannelId()).toBe(chanId);

    // B's lag becomes discovered (measured, at/below the default 30s threshold)
    h.snapshot.lag.set(bId, lagOk(5));
    h.pushNodes.mockClear();
    await h.sync.tick();
    row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('awaiting-switch-confirm');
    expect(h.switcher.switches()).toHaveLength(1);
    expect(h.switcher.switches()[0]).toMatchObject({ slug: 'chan1', upstreamId: bId });
    expect(h.onSwitchIssued).toHaveBeenCalled();

    // the switcher (simulated poll) now reports B active
    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = bId;
    h.pushNodes.mockClear();
    await h.sync.tick();
    row = await failoverRow(h.db, chanId);
    // suppress_from=1 (default for a non-reset/rebalance trigger) drives
    // stopping-old -> awaiting-stop-confirm within this same tick; A's
    // session is still cached as running, so it waits there
    expect(row!.phase).toBe('awaiting-stop-confirm');
    expect(h.pushNodes).toHaveBeenCalled();

    // A's session finally disappears from its node's cached status
    h.cache.get('zoneA').restreamers.find((r) => r.nodeId === 'n1')!.sessions = [];
    await h.sync.tick();
    row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('complete'); // non-reset rows stay at complete
    expect(h.sync.activeChannelId()).toBeNull();
  });
});

// ---------- 2. strict FIFO ----------

describe('FailoverSync: strict global FIFO', () => {
  it('a second simultaneously-triggered channel stays queued (no row) until the first finishes', async () => {
    const h = await setup();
    const chan1 = await seedTwoPlacementChannel(h, 'chan1');
    const chan2 = await seedTwoPlacementChannel(h, 'chan2');
    // both channels' active placements live on the same nodes as different sessions
    h.snapshot.lag.set(chan1.aId, lagFail(40));
    h.snapshot.lag.set(chan2.aId, lagFail(40));

    await h.sync.tick();
    expect(await failoverRow(h.db, chan1.chanId)).toBeDefined();
    expect(await failoverRow(h.db, chan2.chanId)).toBeUndefined();
    expect(h.sync.activeChannelId()).toBe(chan1.chanId);

    // drive chan1 all the way to complete
    h.snapshot.lag.set(chan1.bId, lagOk(5));
    await h.sync.tick(); // -> awaiting-switch-confirm, switch issued
    h.cache.switchers.get('sw1')!.channels.find((c) => c.slug === 'chan1')!.activeUpstreamId = chan1.bId;
    await h.sync.tick(); // -> awaiting-stop-confirm
    removeSession(h.cache, 'zoneA', 'n1', 'chan1'); // chan2's session on the same node is untouched
    await h.sync.tick(); // -> complete, active released

    expect((await failoverRow(h.db, chan1.chanId))!.phase).toBe('complete');
    // chan2 is still merely queued — beginNext for it only runs on the NEXT tick
    expect(await failoverRow(h.db, chan2.chanId)).toBeUndefined();

    await h.sync.tick();
    expect(await failoverRow(h.db, chan2.chanId)).toBeDefined();
    expect(h.sync.activeChannelId()).toBe(chan2.chanId);
  });
});

// ---------- 3. multi-phase advance within one tick ----------

describe('FailoverSync: multi-phase advance within one tick', () => {
  it('a target with lag already discovered crosses bringing-up through issue-switch in a single tick', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    h.snapshot.lag.set(aId, lagFail(40));
    h.snapshot.lag.set(bId, lagOk(2)); // already discovered before the procedure even begins

    await h.sync.tick();
    const row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('awaiting-switch-confirm');
    expect(h.switcher.switches()).toHaveLength(1);
  });
});

// ---------- 4. lag-discovery timeout: retarget then exhaustion ----------

describe('FailoverSync: lag-discovery timeout retarget and exhaustion', () => {
  it('retargets to the next candidate after the timeout; aborts with a blocked reason once candidates are exhausted', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    const bId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n2', priority: 2 });
    const cId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneB', nodeId: 'n1', priority: 3 });
    seedNode(h.cache, 'zoneA', 'n1', { sessions: [sess('chan1')] });
    seedNode(h.cache, 'zoneA', 'n2', { sessions: [] });
    seedNode(h.cache, 'zoneB', 'n1', { sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', aId, [{ id: aId, healthy: true }])]);

    h.snapshot.lag.set(aId, lagFail(40));
    await h.sync.tick(); // begins, targets B (lowest priority among B, C)
    let row = await failoverRow(h.db, chanId);
    expect(row).toMatchObject({ to_placement_id: bId, phase: 'awaiting-lag' });

    h.advanceNow(LAG_DISCOVERY_TIMEOUT_MS + 1_000);
    await h.sync.tick(); // B never got discovered -> retargets to C, within the same tick
    row = await failoverRow(h.db, chanId);
    expect(row).toMatchObject({ to_placement_id: cId, phase: 'awaiting-lag' });

    h.advanceNow(LAG_DISCOVERY_TIMEOUT_MS + 1_000);
    await h.sync.tick(); // C never discovered either -- B and C both tried, A excluded -- abort
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.sync.blockedReason(chanId)).not.toBeNull();
    expect(h.sync.activeChannelId()).toBeNull();

    // backoff prevents an immediate re-enqueue even though A is still failing
    await h.sync.tick();
    expect(await failoverRow(h.db, chanId)).toBeUndefined();

    // ...but past the backoff window, the trigger fires again
    h.advanceNow(RETRIGGER_BACKOFF_MIN_MS + 1_000);
    await h.sync.tick();
    expect(await failoverRow(h.db, chanId)).toBeDefined();
  });
});

// ---------- 5. requestReset flows ----------

describe('FailoverSync: requestReset', () => {
  it('pre-commit (awaiting-lag): aborts loss-free, row deleted', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, { channelId: chanId, fromPlacementId: aId, toPlacementId: bId, phase: 'awaiting-lag', triggerReason: 'lag' });

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toEqual<ResetOutcome>({ ok: true, aborted: true });
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.pushNodes).toHaveBeenCalled();
    expect(h.pushSwitchers).toHaveBeenCalled();
    expect(h.publishChannel).toHaveBeenCalledWith(chanId);
  });

  it('post-commit (awaiting-switch-confirm): 409-shaped rejected-mid-procedure', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, { channelId: chanId, fromPlacementId: aId, toPlacementId: bId, phase: 'awaiting-switch-confirm', triggerReason: 'lag' });

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toMatchObject({ rejected: 'rejected-mid-procedure' });
    expect(await failoverRow(h.db, chanId)).toMatchObject({ phase: 'awaiting-switch-confirm' });
  });

  it('complete + the original trigger still failing: requires-confirm (without force)', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, { channelId: chanId, fromPlacementId: aId, toPlacementId: bId, phase: 'complete', triggerReason: 'lag' });
    // the ORIGINAL trigger (lag on A, the from-placement) is still failing
    h.snapshot.lag.set(aId, lagFail(40));

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toMatchObject({ rejected: 'requires-confirm' });
    expect(await failoverRow(h.db, chanId)).toMatchObject({ phase: 'complete' });
  });

  it('complete + force: queued, and beginNext computes suppressFrom=0 for a healthy hot outgoing', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, { channelId: chanId, fromPlacementId: aId, toPlacementId: bId, phase: 'complete', triggerReason: 'lag' });
    h.snapshot.lag.set(aId, lagFail(40)); // still failing -- force bypasses the check

    const outcome = await h.sync.requestReset(chanId, { force: true });
    expect(outcome).toEqual<ResetOutcome>({ ok: true, queued: true });
    expect(await failoverRow(h.db, chanId)).toMatchObject({ phase: 'complete' }); // not begun yet

    await h.sync.tick();
    const row = await failoverRow(h.db, chanId);
    // natural (lowest priority) placement is A; the row's to (B) becomes "from"
    expect(row).toMatchObject({
      from_placement_id: bId,
      to_placement_id: aId,
      trigger_reason: 'reset',
      suppress_from: 0, // B is a healthy hot outgoing -- resumes encoding, never suppressed
    });
  });

  it('regression: fails back to the first HOT placement even when a cold holds priority 1', async () => {
    // the tvtokyo incident: priorities [1: cold, 2: hot, ...]; a failover
    // landed on the priority-1 cold and Reset answered "already on its
    // priority upstream" instead of failing back to the hot
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'tvtokyo' });
    const coldId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 1,
      mode: 'cold',
    });
    const hotId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n2',
      priority: 2,
      mode: 'hot',
    });
    // completed failover: hot -> priority-1 cold, hot suppressed (stopped)
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: hotId,
      toPlacementId: coldId,
      phase: 'complete',
      triggerReason: 'lag',
      suppressFrom: true,
    });
    addSession(h.cache, 'zoneA', 'n1', 'tvtokyo'); // the cold is what's running
    seedNode(h.cache, 'zoneA', 'n2'); // hot's node reachable, no session (stopped)
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('tvtokyo', coldId, [
        { id: coldId, healthy: true },
        { id: hotId, healthy: true },
      ]),
    ]);

    // steady state runs HOT placements — never "already" just because the
    // active cold happens to hold the lowest priority number
    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toEqual<ResetOutcome>({ ok: true, queued: true });

    await h.sync.tick();
    const row = await failoverRow(h.db, chanId);
    expect(row).toMatchObject({
      trigger_reason: 'reset',
      from_placement_id: coldId,
      to_placement_id: hotId, // the explicit natural target: first enabled hot
      suppress_from: 1, // outgoing is cold — stopped once the switch confirms
    });
  });

  it('all-cold channel: reset onto the natural cold is {ok,already} and the row SURVIVES (it is the activation)', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'allcold' });
    const c1 = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 1,
      mode: 'cold',
    });
    const c2 = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n2',
      priority: 2,
      mode: 'cold',
    });
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: c2,
      toPlacementId: c1,
      phase: 'complete',
      triggerReason: 'manual',
      suppressFrom: true,
    });
    addSession(h.cache, 'zoneA', 'n1', 'allcold');
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('allcold', c1, [
        { id: c1, healthy: true },
        { id: c2, healthy: true },
      ]),
    ]);

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toEqual<ResetOutcome>({ ok: true, already: true });
    // deleting/draining the row would stop the channel's only encoder
    expect(await failoverRow(h.db, chanId)).toMatchObject({ phase: 'complete', to_placement_id: c1 });
  });

  it('complete + already on the natural placement: {ok,cleared}; row deleted (hot outgoing resumes)', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: bId,
      toPlacementId: aId, // already the natural (lowest priority) placement
      phase: 'complete',
      triggerReason: 'manual',
      suppressFrom: false,
    });

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toEqual<ResetOutcome>({ ok: true, cleared: true });
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
  });

  it('complete + already on natural, SUPPRESSED HOT outgoing: row deleted immediately (hot never leaves the switcher doc)', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: bId,
      toPlacementId: aId,
      phase: 'complete',
      triggerReason: 'manual',
      suppressFrom: true,
    });

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toEqual<ResetOutcome>({ ok: true, cleared: true });
    // no drain grace: a hot upstream stays in the switcher doc regardless,
    // and deleting the row un-suppresses it so it resumes encoding right away
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
  });

  it('complete + already on natural, COLD outgoing: draining, then deleted once drain_until passes', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await h.db.updateTable('restream_placements').set({ mode: 'cold' }).where('id', '=', bId).execute();
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: bId,
      toPlacementId: aId,
      phase: 'complete',
      triggerReason: 'manual',
      suppressFrom: true,
    });

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toEqual<ResetOutcome>({ ok: true, cleared: true });
    let row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('draining');
    expect(row!.drain_until).not.toBeNull();

    // profile has no `hls` overrides -> default drainGraceMs = min(5*120,3600)*1000 = 600_000ms
    h.advanceNow(600_001);
    await h.sync.tick();
    row = await failoverRow(h.db, chanId);
    expect(row).toBeUndefined();
  });

  it('a MANUAL procedure landing on the natural hot auto-clears its row on completion (fail-back by hand)', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    // channel currently served from B; operator clicks the natural placement A
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chan1', bId, [
        { id: aId, healthy: true },
        { id: bId, healthy: true },
      ]),
    ]);
    await h.sync.requestFailover(chanId, { toPlacementId: aId, reason: 'manual', detail: 'operator' });
    h.snapshot.lag.set(aId, lagOk(2)); // target lag already discovered

    await h.sync.tick(); // begin → … → issue-switch (multi-phase)
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chan1', aId, [
        { id: aId, healthy: true },
        { id: bId, healthy: true },
      ]),
    ]);
    removeSession(h.cache, 'zoneA', 'n2', 'chan1'); // B's encode stopped
    await h.sync.tick(); // confirm → stopping-old → stop-confirm → complete

    // manual-to-natural = fail-back: no standing failover state remains
    // (B is hot → deleted immediately, no drain grace)
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.sync.activeChannelId()).toBeNull();
  });

  it('404-shaped error for an unknown channel; 409-shaped for no row', async () => {
    const h = await setup();
    await expect(h.sync.requestReset('ghost')).rejects.toMatchObject({ statusCode: 404 });

    const { chanId } = await seedTwoPlacementChannel(h);
    await expect(h.sync.requestReset(chanId)).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ---------- 6. reconcileOnStartup ----------

describe('FailoverSync: reconcileOnStartup', () => {
  it('adopts a mid-procedure row as the active procedure', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, { channelId: chanId, fromPlacementId: aId, toPlacementId: bId, phase: 'awaiting-lag', triggerReason: 'lag' });

    const changed = await h.sync.reconcileOnStartup();
    expect(h.sync.activeChannelId()).toBe(chanId);
    expect(changed).toEqual([]);
  });

  it('prunes a row whose to_placement no longer qualifies (disabled — FK cascade already covers hard deletes)', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    const bId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n2', priority: 2, enabled: false });
    await seedFailoverRowDirect(h.db, { channelId: chanId, fromPlacementId: aId, toPlacementId: bId, phase: 'complete', triggerReason: 'manual' });

    const changed = await h.sync.reconcileOnStartup();
    expect(changed).toContain(chanId);
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
  });

  it('defensively re-enqueues (never strands) a second mid-procedure row beyond the first adopted one', async () => {
    const h = await setup();
    const chan1 = await seedTwoPlacementChannel(h, 'chan1');
    const chan2 = await seedTwoPlacementChannel(h, 'chan2');
    await seedFailoverRowDirect(h.db, {
      channelId: chan1.chanId,
      fromPlacementId: chan1.aId,
      toPlacementId: chan1.bId,
      phase: 'awaiting-lag',
      triggerReason: 'lag',
    });
    await seedFailoverRowDirect(h.db, {
      channelId: chan2.chanId,
      fromPlacementId: chan2.aId,
      toPlacementId: chan2.bId,
      phase: 'awaiting-switch-confirm',
      triggerReason: 'lag',
    });

    await h.sync.reconcileOnStartup();
    // serialization means only ONE of the two is adopted as active; the other
    // is defensively queued rather than stranded, and its row is untouched
    expect(h.sync.activeChannelId()).not.toBeNull();
    expect([chan1.chanId, chan2.chanId]).toContain(h.sync.activeChannelId());
    expect(await failoverRow(h.db, chan1.chanId)).toBeDefined();
    expect(await failoverRow(h.db, chan2.chanId)).toBeDefined();
  });
});

// ---------- 7. rowHygiene ----------

describe('FailoverSync: rowHygiene (draining expiry)', () => {
  it('deletes a draining row once drain_until has passed', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: bId,
      phase: 'draining',
      triggerReason: 'manual',
      drainUntil: '2020-01-01 00:00:00',
    });

    await h.sync.tick();
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
  });

  it('keeps a draining row whose drain_until has not yet passed', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: bId,
      phase: 'draining',
      triggerReason: 'manual',
      drainUntil: '2099-01-01 00:00:00',
    });

    await h.sync.tick();
    expect(await failoverRow(h.db, chanId)).toBeDefined();
  });
});
