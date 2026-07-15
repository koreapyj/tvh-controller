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
  EnrichedSessionStatus,
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
    eventLogRetentionDays: 30,
  };
}

function sess(name: string, opts: Partial<SessionStatus> = {}): EnrichedSessionStatus {
  return {
    name,
    state: 'running',
    enabled: true,
    configHash: 'h',
    restarts: 0,
    consecutiveFailures: 0,
    channelSlug: null,
    ...opts,
  };
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
    capabilities: null,
    templates: null,
    maxSessions: null,
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

/**
 * adds one session to a node's cached status without clobbering sessions of
 * other channels already there. `sessionName` is a placement id in
 * production (sessions are named after the placement, not the channel slug)
 * — callers must pass the relevant placement's id.
 */
function addSession(cache: InstanceCache, instanceId: string, nodeId: string, sessionName: string): void {
  const snap = cache.get(instanceId);
  let entry = snap.restreamers.find((r) => r.nodeId === nodeId);
  if (!entry) {
    entry = nodeStatusFixture(instanceId, nodeId);
    snap.restreamers.push(entry);
  }
  entry.sessions = [...entry.sessions, sess(sessionName)];
}

/** removes one placement's session from a node's cached status, leaving any others intact */
function removeSession(cache: InstanceCache, instanceId: string, nodeId: string, sessionName: string): void {
  const entry = cache.get(instanceId).restreamers.find((r) => r.nodeId === nodeId);
  if (entry) entry.sessions = entry.sessions.filter((s) => s.name !== sessionName);
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
  lastSpeedRatio?: number | null;
}

interface MutableSnapshot {
  liveness: Map<string, CounterLike>;
  underspeed: Map<string, CounterLike>;
  lag: Map<string, CounterLike>;
}

function emptySnapshot(): MutableSnapshot {
  return { liveness: new Map(), underspeed: new Map(), lag: new Map() };
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
    transient?: boolean;
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
      profile_id: null,
      program_number: null,
      transient: fields.transient ? 1 : 0,
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

async function insertNodeSettings(
  db: Kysely<Database>,
  fields: { instanceId: string; nodeId: string; maxSessions: number | null },
): Promise<void> {
  await db
    .insertInto('restream_node_settings')
    .values({
      instance_id: fields.instanceId,
      node_id: fields.nodeId,
      max_sessions: fields.maxSessions,
      updated_at: TS,
    })
    .execute();
}

// ---------- harness ----------

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

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
  markCutoverComplete: ReturnType<typeof vi.fn>;
  deleteCutoverPlacement: ReturnType<typeof vi.fn>;
  advanceNow: (ms: number) => void;
  nowMs: () => number;
  logs: LoggedEvent[];
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
  const markCutoverComplete = vi.fn(async (_placementId: string) => {});
  const deleteCutoverPlacement = vi.fn(async (_placementId: string) => {});
  const logs: LoggedEvent[] = [];

  let ms = Date.parse('2026-06-01T00:00:00.000Z');
  const sync = new FailoverSync(
    db,
    cache,
    config,
    switcherClients,
    () => snapshot as unknown as ProbeSnapshot,
    async () => settingsMap,
    { pushNodes, pushSwitchers, publishChannel, onSwitchIssued, markCutoverComplete, deleteCutoverPlacement },
    () => new Date(ms),
    { log: (e) => logs.push(e) },
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
    markCutoverComplete,
    deleteCutoverPlacement,
    advanceNow: (delta: number) => {
      ms += delta;
    },
    nowMs: () => ms,
    logs,
  };
}

/** two-placement redundant channel (A active on zoneA/n1, B standby on zoneA/n2) with the switcher reporting A active */
async function seedTwoPlacementChannel(h: Harness, slug = 'chan1') {
  const chanId = await insertChannel(h.db, { slug });
  const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
  const bId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n2', priority: 2 });
  addSession(h.cache, 'zoneA', 'n1', aId);
  addSession(h.cache, 'zoneA', 'n2', bId);
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

// ---------- 1b. oldSessionGone matches the FROM placement id precisely ----------

describe('FailoverSync: oldSessionGone matches the FROM placement id precisely', () => {
  it('stays at awaiting-stop-confirm while a session named for the FROM placement id is present; an unrelated session name does not fool it', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    h.snapshot.lag.set(aId, lagFail(40));

    await h.sync.tick(); // BEGIN -> awaiting-lag
    h.snapshot.lag.set(bId, lagOk(5));
    await h.sync.tick(); // -> awaiting-switch-confirm, switch issued
    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = bId;
    await h.sync.tick(); // -> stopping-old -> awaiting-stop-confirm (A's session, named aId, still present)
    let row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('awaiting-stop-confirm');

    // tick again with A's own session unchanged — still present by placement
    // id, so the procedure must still be waiting
    await h.sync.tick();
    row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('awaiting-stop-confirm');

    // A's node's session list is swapped for one with an unrelated name (e.g.
    // a stale/decoy entry) rather than emptied outright — the node still has
    // *a* session running, but not one named aId. The match is strictly by
    // placement id (from.id), so this correctly counts as "A's own session
    // gone" (a broken "does this node have any session at all" check would
    // wrongly keep waiting here).
    h.cache.get('zoneA').restreamers.find((r) => r.nodeId === 'n1')!.sessions = [sess('some-other-name')];
    await h.sync.tick();
    row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('complete');
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
    removeSession(h.cache, 'zoneA', 'n1', chan1.aId); // chan2's session on the same node is untouched
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
    seedNode(h.cache, 'zoneA', 'n1', { sessions: [sess(aId)] });
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

  it('fails back to the first HOT placement even when a cold holds priority 1', async () => {
    // priorities [1: cold, 2: hot, ...]: Reset must fail back to the hot
    // placement, not treat the cold priority-1 as already the target
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
    addSession(h.cache, 'zoneA', 'n1', coldId); // the cold is what's running
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
    addSession(h.cache, 'zoneA', 'n1', c1);
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
    removeSession(h.cache, 'zoneA', 'n2', bId); // B's encode stopped
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

// ---------- 7b. blocked auto-clear and explicit clearBlocked() ----------

describe('FailoverSync: blocked auto-clear and explicit clearBlocked()', () => {
  it('auto-clears a stale blocked reason once the trigger that set it heals', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });

    h.snapshot.liveness.set('zoneA/n1', failing());
    await h.sync.tick(); // trigger fires; single placement -> no candidate -> blocked set
    expect(h.sync.blockedReason(chanId)).not.toBeNull();
    expect(await failoverRow(h.db, chanId)).toBeUndefined();

    h.publishChannel.mockClear();
    h.advanceNow(RETRIGGER_BACKOFF_MIN_MS + 1_000);
    h.snapshot.liveness.delete('zoneA/n1'); // heals on its own
    await h.sync.tick();

    expect(h.sync.blockedReason(chanId)).toBeNull();
    expect(h.publishChannel).toHaveBeenCalledWith(chanId);
    expect(h.publishChannel).toHaveBeenCalledTimes(1);
  });

  it('does not clear blocked while the trigger that set it is still failing', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });

    h.snapshot.liveness.set('zoneA/n1', failing());
    await h.sync.tick();
    expect(h.sync.blockedReason(chanId)).not.toBeNull();

    h.publishChannel.mockClear();
    h.advanceNow(RETRIGGER_BACKOFF_MIN_MS + 1_000);
    await h.sync.tick(); // trigger still failing -> re-enqueues, re-blocks, but never spuriously clears
    expect(h.sync.blockedReason(chanId)).not.toBeNull();
  });

  it('clearBlocked() clears an existing entry and returns false when nothing to clear', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    expect(h.sync.clearBlocked(chanId)).toBe(false);
    expect(h.publishChannel).not.toHaveBeenCalled();

    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    h.snapshot.liveness.set('zoneA/n1', failing());
    await h.sync.tick();
    expect(h.sync.blockedReason(chanId)).not.toBeNull();

    h.publishChannel.mockClear();
    expect(h.sync.clearBlocked(chanId)).toBe(true);
    expect(h.sync.blockedReason(chanId)).toBeNull();
    expect(h.publishChannel).toHaveBeenCalledWith(chanId);
    expect(h.publishChannel).toHaveBeenCalledTimes(1);

    expect(h.sync.clearBlocked(chanId)).toBe(false);
  });

  it('drops a stale blocked reason once its channel is disabled entirely (no failover_state row to catch it)', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });

    h.snapshot.liveness.set('zoneA/n1', failing());
    await h.sync.tick();
    expect(h.sync.blockedReason(chanId)).not.toBeNull();

    await h.db.updateTable('restream_channels').set({ enabled: 0 }).where('id', '=', chanId).execute();
    h.publishChannel.mockClear();
    await h.sync.tick(); // channel no longer in data.channels -> rowHygiene's sweep catches it
    expect(h.sync.blockedReason(chanId)).toBeNull();
    expect(h.publishChannel).toHaveBeenCalledWith(chanId);
    expect(h.publishChannel).toHaveBeenCalledTimes(1);
  });
});

// ---------- 8. event-log emission ----------

describe('FailoverSync: event-log emission', () => {
  it('warns on an automatic BEGIN and logs a normal on complete', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    h.snapshot.lag.set(aId, lagFail(40));

    await h.sync.tick(); // BEGIN
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'controller' });
    expect(h.logs[0]!.message).toMatch(/BEGIN/);
    expect(h.logs[0]!.message).toContain('chan1');

    h.snapshot.lag.set(bId, lagOk(5));
    await h.sync.tick(); // -> awaiting-switch-confirm
    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = bId;
    await h.sync.tick(); // -> awaiting-stop-confirm
    h.cache.get('zoneA').restreamers.find((r) => r.nodeId === 'n1')!.sessions = [];
    await h.sync.tick(); // -> complete

    const normals = h.logs.filter((l) => l.type === 'normal');
    expect(normals).toHaveLength(1);
    expect(normals[0]!.message).toMatch(/complete/);
    expect(normals[0]!.message).toContain('chan1');
  });

  it('warns on an automatic RETARGET and ABORT', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    const bId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n2', priority: 2 });
    const cId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneB', nodeId: 'n1', priority: 3 });
    seedNode(h.cache, 'zoneA', 'n1', { sessions: [sess(aId)] });
    seedNode(h.cache, 'zoneA', 'n2', { sessions: [] });
    seedNode(h.cache, 'zoneB', 'n1', { sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', aId, [{ id: aId, healthy: true }])]);
    void bId;
    void cId;

    h.snapshot.lag.set(aId, lagFail(40));
    await h.sync.tick(); // BEGIN -> targets B
    h.advanceNow(LAG_DISCOVERY_TIMEOUT_MS + 1_000);
    await h.sync.tick(); // RETARGET -> C
    h.advanceNow(LAG_DISCOVERY_TIMEOUT_MS + 1_000);
    await h.sync.tick(); // ABORT — candidates exhausted

    const warnings = h.logs.filter((l) => l.type === 'warning').map((l) => l.message);
    expect(warnings.some((m) => /BEGIN/.test(m))).toBe(true);
    expect(warnings.some((m) => /RETARGET/.test(m))).toBe(true);
    expect(warnings.some((m) => /ABORTED/.test(m))).toBe(true);
    expect(h.logs.every((l) => l.source === 'controller' && l.service === 'restreamer')).toBe(true);
  });

  it('logs nothing for a manual-reason procedure start through completion', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chan1', bId, [
        { id: aId, healthy: true },
        { id: bId, healthy: true },
      ]),
    ]);
    await h.sync.requestFailover(chanId, { toPlacementId: aId, reason: 'manual', detail: 'operator' });
    h.snapshot.lag.set(aId, lagOk(2));

    await h.sync.tick(); // begin -> ... -> issue-switch
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chan1', aId, [
        { id: aId, healthy: true },
        { id: bId, healthy: true },
      ]),
    ]);
    removeSession(h.cache, 'zoneA', 'n2', bId);
    await h.sync.tick(); // confirm -> stopping-old -> stop-confirm -> complete

    expect(h.logs).toHaveLength(0);
  });

  it('logs nothing for a reset-reason procedure', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: bId,
      phase: 'complete',
      triggerReason: 'lag',
    });
    h.snapshot.lag.set(aId, lagFail(40)); // still failing — force bypasses the check

    const outcome = await h.sync.requestReset(chanId, { force: true });
    expect(outcome).toEqual({ ok: true, queued: true });
    await h.sync.tick(); // begins a 'reset' procedure

    expect(h.logs).toHaveLength(0);
  });
});

// ---------- 9. cutover ----------
//
// These tests create a cutover row directly rather than through a real
// trigger: either via seedFailoverRowDirect + reconcileOnStartup(), which
// adopts a directly-seeded mid-procedure row as the active procedure without
// going through beginNext, or via requestFailover's ordinary explicit-target
// path, exercised once below to confirm reason:'cutover' needs no
// special-casing there.

describe('FailoverSync: cutover completion', () => {
  it('drives an explicit cutover through to complete, promoting the clone and entering draining', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);

    const queued = await h.sync.requestFailover(chanId, { toPlacementId: bId, reason: 'cutover', force: true });
    expect(queued).toEqual({ ok: true, queued: true });
    h.snapshot.lag.set(bId, lagOk(2)); // clone's lag already discovered -- crosses bringing-up -> issue-switch in one tick
    await h.sync.tick(); // begin -> awaiting-switch-confirm, switch issued
    let row = await failoverRow(h.db, chanId);
    expect(row).toMatchObject({
      phase: 'awaiting-switch-confirm',
      trigger_reason: 'cutover',
      to_placement_id: bId,
      from_placement_id: aId,
    });
    expect(h.switcher.switches()).toHaveLength(1);

    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = bId;
    await h.sync.tick(); // confirm -> stopping-old -> awaiting-stop-confirm (A's session still present)
    row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('awaiting-stop-confirm');
    expect(h.markCutoverComplete).not.toHaveBeenCalled();

    removeSession(h.cache, 'zoneA', 'n1', aId);
    await h.sync.tick(); // -> complete -> finishCutover -> draining

    row = await failoverRow(h.db, chanId);
    expect(row!.phase).toBe('draining');
    expect(row!.drain_until).not.toBeNull();
    expect(row!.to_placement_id).toBe(bId);
    expect(h.sync.activeChannelId()).toBeNull();

    // The clone is NOT promoted yet at the complete -> draining transition:
    // `from` (aId) still holds the (channel, instance, node) triple with
    // transient=0, and promoting the clone (also on that triple) before
    // `from` is removed would collide with the unique index. Promotion is
    // deferred to the drain-expiry sweep, right after `from` is deleted.
    expect(h.markCutoverComplete).not.toHaveBeenCalled();
    expect(h.deleteCutoverPlacement).not.toHaveBeenCalled();

    const normals = h.logs.filter((l) => l.type === 'normal');
    expect(normals).toHaveLength(1);
    expect(normals[0]!.message).toMatch(/cutover COMPLETE/);
    expect(normals[0]!.message).toContain(bId);
    expect(normals[0]!.message).toContain(aId);

    // advance past the drain window -- rowHygiene() now deletes `from` and,
    // only once that's done, promotes the clone to permanent
    h.advanceNow(600_001);
    await h.sync.tick();

    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.deleteCutoverPlacement).toHaveBeenCalledTimes(1);
    expect(h.deleteCutoverPlacement).toHaveBeenCalledWith(aId);
    expect(h.markCutoverComplete).toHaveBeenCalledTimes(1);
    expect(h.markCutoverComplete).toHaveBeenCalledWith(bId);
  });
});

describe('FailoverSync: cutover abort (loss-free, never retargets)', () => {
  it('aborts a cutover whose clone never becomes healthy, deleting only the clone and leaving `from` untouched -- even with an eligible cold standby on another node', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    // `from`: hot, currently serving
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    // the cutover clone: same node as `from`, transient (mirrors createCutoverClone)
    const cloneId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 2,
      transient: true,
    });
    // a healthy, otherwise-eligible cold standby on a DIFFERENT node -- would
    // win a normal candidate-search retarget; must be left completely alone
    const coldId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneB',
      nodeId: 'n1',
      priority: 3,
      mode: 'cold',
    });
    seedNode(h.cache, 'zoneA', 'n1', { sessions: [sess(aId)] });
    seedNode(h.cache, 'zoneB', 'n1', { sessions: [] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', aId, [{ id: aId, healthy: true }])]);

    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: cloneId,
      phase: 'awaiting-lag',
      triggerReason: 'cutover',
      suppressFrom: true,
    });
    await h.sync.reconcileOnStartup(); // adopt the directly-seeded row as the active procedure
    expect(h.sync.activeChannelId()).toBe(chanId);

    // clone never gets a lag measurement -- past the discovery timeout, an
    // ordinary automatic procedure would retarget onto `coldId` here
    h.advanceNow(LAG_DISCOVERY_TIMEOUT_MS + 1_000);
    await h.sync.tick();

    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.sync.activeChannelId()).toBeNull();
    expect(h.deleteCutoverPlacement).toHaveBeenCalledTimes(1);
    expect(h.deleteCutoverPlacement).toHaveBeenCalledWith(cloneId);
    expect(h.markCutoverComplete).not.toHaveBeenCalled();

    // `from` was never suppressed/switched away from -- the switcher's own
    // report (unchanged throughout) still shows it active
    expect(h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId).toBe(aId);

    const warnings = h.logs.filter((l) => l.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/cutover ABORTED/);
    expect(warnings[0]!.message).toContain(cloneId);
    expect(warnings[0]!.message).toContain(aId);
  });
});

describe('FailoverSync: cutover drain-expiry cleanup', () => {
  it('calls deleteCutoverPlacement(from) and markCutoverComplete(to) together when an expired draining cutover row is cleaned up', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: bId,
      phase: 'draining',
      triggerReason: 'cutover',
      drainUntil: '2020-01-01 00:00:00',
    });

    await h.sync.tick();

    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.deleteCutoverPlacement).toHaveBeenCalledTimes(1);
    expect(h.deleteCutoverPlacement).toHaveBeenCalledWith(aId);
    // the clone can only be promoted to permanent once `from` no longer
    // holds the (channel, instance, node) triple -- both hooks fire in the
    // same drain-expiry sweep, delete first, then promote
    expect(h.markCutoverComplete).toHaveBeenCalledTimes(1);
    expect(h.markCutoverComplete).toHaveBeenCalledWith(bId);
  });

  it('does not call deleteCutoverPlacement for an expired non-cutover draining row', async () => {
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
    expect(h.deleteCutoverPlacement).not.toHaveBeenCalled();
  });

  it('leaves an unexpired draining cutover row alone (no cleanup, no deletion)', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: bId,
      phase: 'draining',
      triggerReason: 'cutover',
      drainUntil: '2099-01-01 00:00:00',
    });

    await h.sync.tick();

    expect(await failoverRow(h.db, chanId)).toBeDefined();
    expect(h.deleteCutoverPlacement).not.toHaveBeenCalled();
  });
});

// ---------- 9b. reset mid-cutover must not leak the clone ----------
//
// requestReset's loss-free (pre-commit-point) abort branch must reclaim a
// cutover's transient clone just like the automatic abortCutover path —
// otherwise the clone keeps encoding forever (reclaimed only by the next
// controller-restart orphan sweep) with `from` left pinned to its snapshot.

describe('FailoverSync: requestReset during an in-flight cutover (loss-free — mirrors abortCutover)', () => {
  it('reset before the commit point deletes the row, reclaims the clone, leaves `from` untouched, and logs nothing', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    // `from`: hot, currently serving
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    // the cutover clone: same node as `from`, transient (mirrors createCutoverClone)
    const cloneId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 2,
      transient: true,
    });
    seedNode(h.cache, 'zoneA', 'n1', { sessions: [sess(aId)] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', aId, [{ id: aId, healthy: true }])]);

    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: cloneId,
      phase: 'awaiting-lag',
      triggerReason: 'cutover',
      suppressFrom: true,
    });

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toEqual<ResetOutcome>({ ok: true, aborted: true });

    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.deleteCutoverPlacement).toHaveBeenCalledTimes(1);
    expect(h.deleteCutoverPlacement).toHaveBeenCalledWith(cloneId);
    expect(h.markCutoverComplete).not.toHaveBeenCalled();

    // `from` was never suppressed/switched away from -- the switcher's own
    // report (unchanged throughout) still shows it active, and no switch was
    // ever issued
    expect(h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId).toBe(aId);
    expect(h.switcher.switches()).toHaveLength(0);

    // the RESET is the user-initiated action here (unlike automatic
    // abortCutover, which logs a warning because nothing else reports the
    // outcome) -- per the event-log rule, no event is emitted
    expect(h.logs).toHaveLength(0);
  });

  it('reset at the commit point (switch-ordered+) still rejects mid-procedure -- no cleanup, nothing to leave', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    const cloneId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 2,
      transient: true,
    });
    seedNode(h.cache, 'zoneA', 'n1', { sessions: [sess(aId)] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', aId, [{ id: aId, healthy: true }])]);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: cloneId,
      phase: 'awaiting-switch-confirm',
      triggerReason: 'cutover',
      suppressFrom: true,
    });

    const outcome = await h.sync.requestReset(chanId);
    expect(outcome).toMatchObject({ rejected: 'rejected-mid-procedure' });
    expect(await failoverRow(h.db, chanId)).toMatchObject({ phase: 'awaiting-switch-confirm' });
    expect(h.deleteCutoverPlacement).not.toHaveBeenCalled();
  });
});

describe('FailoverSync: rowHygiene reclaims a cutover clone that falls out of validity (same leak class as requestReset)', () => {
  it('reclaims the clone via deleteCutoverPlacement when it gets disabled out from under an in-flight cutover', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    const cloneId = await insertPlacement(h.db, {
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 2,
      transient: true,
    });
    seedNode(h.cache, 'zoneA', 'n1', { sessions: [sess(aId)] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', aId, [{ id: aId, healthy: true }])]);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: cloneId,
      phase: 'awaiting-lag',
      triggerReason: 'cutover',
      suppressFrom: true,
    });

    // "vanished" here means disabled, not hard-deleted: a hard delete of the
    // placement row cascades the failover_state row with it independently,
    // so this branch never even sees it. A disable (or the clone's channel
    // being turned off) is what actually reaches this code path.
    await h.db.updateTable('restream_placements').set({ enabled: 0 }).where('id', '=', cloneId).execute();

    await h.sync.tick();

    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.deleteCutoverPlacement).toHaveBeenCalledTimes(1);
    expect(h.deleteCutoverPlacement).toHaveBeenCalledWith(cloneId);
    expect(h.markCutoverComplete).not.toHaveBeenCalled();
  });

  it('does not call deleteCutoverPlacement for a non-cutover row caught by the same branch', async () => {
    const h = await setup();
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: bId,
      phase: 'awaiting-lag',
      triggerReason: 'lag',
    });

    await h.db.updateTable('restream_placements').set({ enabled: 0 }).where('id', '=', bId).execute();

    await h.sync.tick();

    expect(await failoverRow(h.db, chanId)).toBeUndefined();
    expect(h.deleteCutoverPlacement).not.toHaveBeenCalled();
  });
});

// ---------- 10. activePlacementOf never infers a transient clone as "active" ----------
//
// createCutoverClone copies `from`'s priority and always uses mode:'hot', so
// a freshly-created clone ties with `from` in the (priority, id) order that
// activePlacementOf's third fallback uses before any failover row or
// switcher report names either one — transient placements must be excluded
// from that fallback outright, or the wrong one can be inferred active.

describe('FailoverSync: activePlacementOf never infers a transient clone as "active"', () => {
  /** clone id sorts lexically BEFORE from's id, so it would win the (priority, id) tie if not excluded */
  const CLONE_ID = '0aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const FROM_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  async function seedTiedCloneChannel(h: Harness, slug = 'chan1') {
    const chanId = await insertChannel(h.db, { slug });
    // `from`: real, currently-serving placement
    await insertPlacement(h.db, {
      id: FROM_ID,
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 1,
      mode: 'hot',
    });
    // the cutover clone: same priority (copied from `from`), also 'hot',
    // transient -- mirrors createCutoverClone exactly. No failover row and no
    // switcher report name either placement yet (freshly created channel /
    // switcher briefly behind), so only the third (priority, id) fallback
    // can resolve "active".
    await insertPlacement(h.db, {
      id: CLONE_ID,
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 1,
      mode: 'hot',
      transient: true,
    });
    return { chanId };
  }

  it('requestFailover(cutover, toPlacementId: clone) enqueues instead of silently no-op-ing as already-active', async () => {
    const h = await setup();
    const { chanId } = await seedTiedCloneChannel(h);

    const result = await h.sync.requestFailover(chanId, {
      toPlacementId: CLONE_ID,
      reason: 'cutover',
      force: true, // same-node clone admission isn't under test here (mirrors the "cutover completion" test)
    });
    expect(result).toEqual({ ok: true, queued: true });

    await h.sync.tick(); // begin -> bringing-up auto-advances -> awaiting-lag (clone has no lag measurement yet)
    const row = await failoverRow(h.db, chanId);
    expect(row).toMatchObject({
      from_placement_id: FROM_ID,
      to_placement_id: CLONE_ID,
      phase: 'awaiting-lag',
      trigger_reason: 'cutover',
    });
  });

  it('scanTriggers skips a channel whose only enabled hot placement is transient (no crash, no spurious trigger)', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    // ONLY a transient placement -- no real placement exists at all (a more
    // extreme degenerate case than the tie-break above: activePlacementOf
    // must resolve to null rather than falling through to the clone anyway).
    await insertPlacement(h.db, {
      id: CLONE_ID,
      channelId: chanId,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 1,
      mode: 'hot',
      transient: true,
    });
    h.snapshot.liveness.set('zoneA/n1', failing());

    await expect(h.sync.tick()).resolves.toBeUndefined();

    expect(h.sync.activeChannelId()).toBeNull();
    expect(await failoverRow(h.db, chanId)).toBeUndefined();
  });
});

// ---------- 11. per-node session capacity (restream_node_settings) ----------
//
// candidateOf charges a candidate one session slot unless it is already
// counted in the node's desired-session total (alreadyDesired — hot
// placements and the current failover row's own from/to). Exercised end to
// end: seeded restream_node_settings rows, requestFailover/requestReset,
// tick().

describe('FailoverSync: per-node session capacity (restream_node_settings)', () => {
  /**
   * chanA has a single hot placement on zoneA/n1 — steady-state running, and
   * therefore always counted in that node's desired-session total. chanB is
   * the channel under test: hot on zoneA/n2 (currently active per the
   * switcher), cold on zoneA/n1 (the failover candidate — sharing chanA's
   * node, so capacity on n1 is contended between the two channels).
   */
  async function seedSharedNodeChannels(h: Harness) {
    const chanA = await insertChannel(h.db, { slug: 'chanA' });
    const aHot = await insertPlacement(h.db, { channelId: chanA, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    addSession(h.cache, 'zoneA', 'n1', aHot);

    const chanB = await insertChannel(h.db, { slug: 'chanB' });
    const bHot = await insertPlacement(h.db, { channelId: chanB, instanceId: 'zoneA', nodeId: 'n2', priority: 1 });
    const bCold = await insertPlacement(h.db, {
      channelId: chanB,
      instanceId: 'zoneA',
      nodeId: 'n1',
      priority: 2,
      mode: 'cold',
    });
    addSession(h.cache, 'zoneA', 'n2', bHot);
    seedSwitcherStatus(h.cache, 'sw1', [
      swChan('chanB', bHot, [
        { id: bHot, healthy: true },
        { id: bCold, healthy: true },
      ]),
    ]);

    return { chanA, aHot, chanB, bHot, bCold };
  }

  it('rejects a cold candidate that would push a capped node over max_sessions, with an at-capacity blocked reason', async () => {
    const h = await setup();
    const { chanB, bCold } = await seedSharedNodeChannels(h);
    // zoneA/n1 already carries chanA's hot session (desired=1); capped at 1
    await insertNodeSettings(h.db, { instanceId: 'zoneA', nodeId: 'n1', maxSessions: 1 });

    const outcome = await h.sync.requestFailover(chanB, { toPlacementId: bCold, reason: 'manual' });
    expect(outcome).toEqual({ ok: true, queued: true });

    await h.sync.tick();
    expect(await failoverRow(h.db, chanB)).toBeUndefined();
    expect(h.sync.blockedReason(chanB)).toContain('at-capacity');
    expect(h.sync.activeChannelId()).toBeNull();
  });

  it('admits the same candidate once max_sessions is explicitly NULL (uncapped)', async () => {
    const h = await setup();
    const { chanB, bCold } = await seedSharedNodeChannels(h);
    await insertNodeSettings(h.db, { instanceId: 'zoneA', nodeId: 'n1', maxSessions: null });

    const outcome = await h.sync.requestFailover(chanB, { toPlacementId: bCold, reason: 'manual' });
    expect(outcome).toEqual({ ok: true, queued: true });

    await h.sync.tick();
    expect(h.sync.blockedReason(chanB)).toBeNull();
    expect(await failoverRow(h.db, chanB)).toMatchObject({ to_placement_id: bCold, phase: 'awaiting-lag' });
    expect(h.sync.activeChannelId()).toBe(chanB);
  });

  it('a node with no restream_node_settings row at all is uncapped', async () => {
    const h = await setup();
    const { chanB, bCold } = await seedSharedNodeChannels(h);

    const outcome = await h.sync.requestFailover(chanB, { toPlacementId: bCold, reason: 'manual' });
    expect(outcome).toEqual({ ok: true, queued: true });

    await h.sync.tick();
    expect(h.sync.blockedReason(chanB)).toBeNull();
    expect(await failoverRow(h.db, chanB)).toMatchObject({ to_placement_id: bCold, phase: 'awaiting-lag' });
  });

  it('an already-desired hot placement is free at exactly capacity — retargeting onto it costs no extra slot', async () => {
    const h = await setup();
    // hot-hot redundant channel: A active on zoneA/n1, B standby-but-running
    // (hot) on zoneA/n2 — B already contributes to zoneA/n2's desired count
    // regardless of which one the switcher currently reports active.
    const { chanId, aId, bId } = await seedTwoPlacementChannel(h);
    // B's node capped at exactly 1: without the alreadyDesired exemption,
    // failing over onto B (desired=1, +1 candidate charge = 2) would be
    // rejected; with it, B costs no extra slot (1 + 0 = 1, at the cap).
    await insertNodeSettings(h.db, { instanceId: 'zoneA', nodeId: 'n2', maxSessions: 1 });
    h.snapshot.lag.set(aId, lagFail(40)); // trigger: A (active) is failing

    await h.sync.tick();
    const row = await failoverRow(h.db, chanId);
    expect(row).toMatchObject({ from_placement_id: aId, to_placement_id: bId, phase: 'awaiting-lag' });
    expect(h.sync.blockedReason(chanId)).toBeNull();
  });
});

// ---------- 12. reset-all recovery flow, end to end ----------
//
// The operator's actual recovery move for a stuck-fleet incident: hit reset
// on every affected channel. It must never get stuck behind retriggerBackoff
// (that Map is scanTriggers-only) and a failed admission attempt must leave
// the channel retryable, not wedged.

describe('FailoverSync: reset-all recovery flow after a fleet-wide probe-failure incident', () => {
  it('requires-confirm -> force queues -> admission-reject sets blocked+backoff but stays retryable -> immediate retry succeeds once the node heals', async () => {
    const h = await setup();
    const chanId = await insertChannel(h.db, { slug: 'chan1' });
    const aId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n1', priority: 1 });
    const bId = await insertPlacement(h.db, { channelId: chanId, instanceId: 'zoneA', nodeId: 'n2', priority: 2 });
    // currently failed over to B; A's node is fleet-wide unreachable -- the incident
    seedNode(h.cache, 'zoneA', 'n1', { reachable: false, error: 'unreachable' });
    seedNode(h.cache, 'zoneA', 'n2', { sessions: [sess(bId)] });
    seedSwitcherStatus(h.cache, 'sw1', [swChan('chan1', bId, [{ id: bId, healthy: true }])]);

    await seedFailoverRowDirect(h.db, {
      channelId: chanId,
      fromPlacementId: aId,
      toPlacementId: bId,
      phase: 'complete',
      triggerReason: 'liveness',
      triggerNodeId: 'n1',
      suppressFrom: true,
    });
    h.snapshot.liveness.set('zoneA/n1', failing()); // original trigger still failing

    // 1. plain reset -- trigger still failing -> requires-confirm
    const first = await h.sync.requestReset(chanId);
    expect(first).toMatchObject({ rejected: 'requires-confirm' });

    // 2. force reset -- bypasses the trigger check, queues the fail-back
    const forced = await h.sync.requestReset(chanId, { force: true });
    expect(forced).toEqual<ResetOutcome>({ ok: true, queued: true });
    expect(await failoverRow(h.db, chanId)).toMatchObject({ phase: 'complete' }); // not begun yet

    // 3. beginNext dequeues -- target (A) is on the still-unreachable node ->
    //    admission rejects: blocked + backoff, but the queue slot is freed
    //    and the untouched row stays exactly as it was -- NOT stuck.
    await h.sync.tick();
    expect(h.sync.blockedReason(chanId)).not.toBeNull();
    expect(h.sync.blockedReason(chanId)).toContain('node-unreachable');
    expect(await failoverRow(h.db, chanId)).toMatchObject({ phase: 'complete', to_placement_id: bId });
    expect(h.sync.activeChannelId()).toBeNull();

    // 4. operator retries immediately -- no clock advance, proving the retry
    //    is NOT gated by retriggerBackoff (that Map is scanTriggers-only) --
    //    this is the exact "hammer reset" recovery motion.
    const retry = await h.sync.requestReset(chanId, { force: true });
    expect(retry).toEqual<ResetOutcome>({ ok: true, queued: true });

    // 5. the node has since come back -- admission now passes
    seedNode(h.cache, 'zoneA', 'n1', { reachable: true, sessions: [] });
    await h.sync.tick(); // begin -> bringing-up auto-advances -> awaiting-lag (A has no lag measurement yet)
    let row = await failoverRow(h.db, chanId);
    expect(row).toMatchObject({
      from_placement_id: bId,
      to_placement_id: aId,
      trigger_reason: 'reset',
      phase: 'awaiting-lag',
    });
    expect(h.sync.blockedReason(chanId)).toBeNull(); // cleared the instant the retry was admitted

    // drive it home: lag discovered, switch confirmed
    h.snapshot.lag.set(aId, lagOk(2));
    await h.sync.tick(); // -> awaiting-switch-confirm, switch issued
    expect(h.switcher.switches()).toContainEqual(expect.objectContaining({ slug: 'chan1', upstreamId: aId }));
    h.cache.switchers.get('sw1')!.channels[0]!.activeUpstreamId = aId;
    await h.sync.tick(); // confirm -> complete (B is a healthy hot outgoing -> suppress_from=0 -> never stopped -> complete deletes the row)
    row = await failoverRow(h.db, chanId);
    expect(row).toBeUndefined();
    expect(h.sync.activeChannelId()).toBeNull();
  });
});
