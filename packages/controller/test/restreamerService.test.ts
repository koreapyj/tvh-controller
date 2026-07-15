/*
 * RestreamerService tests: hermetic in-memory SQLite (createTestDb), real
 * InstanceCache/EventBus, hand-built topology snapshots, and fake restreamer
 * nodes at the client boundary (test/support/fakeRestreamerNode.ts). No
 * network, no real pollers.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type {
  AribHlsParams,
  DesiredState,
  EnrichedSessionStatus,
  RawArgvParams,
  RestreamProfile,
  SourceCatalogEntry,
  SseEvent,
  SwitcherNodeStatus,
} from '@tvhc/shared';
import type { Database } from '../src/db/schema.js';
import type { AppConfig } from '../src/config.js';
import type { InstancePoller } from '../src/tvh/poller.js';
import { EventBus } from '../src/state/events.js';
import { InstanceCache, type TopologySnapshot } from '../src/state/instanceCache.js';
import {
  RestreamerService,
  canonicalJson,
  deriveSlug,
  nodeKey,
  sessionsHash,
  type RestreamerNodeClient,
} from '../src/restreamer/service.js';
import { buildRawArgvParams } from '../src/restreamer/argv/index.js';
import { createTestDb } from './support/testDb.js';
import { fakeRestreamerNode, type FakeRestreamerNode } from './support/fakeRestreamerNode.js';

const TS = '2026-01-01 00:00:00';

// ---------- fixtures ----------

/**
 * zone1: AT-X exists twice ("9.1" and "9.10" — the string-identity trap),
 * BS11 has two services (lowest-sid selection), NHK's service has no sid
 * (underivable program number), and Dup has 5.2 listed BEFORE 5.1 so
 * lowest-number selection is real, not grid order.
 */
function zone1Topology(): TopologySnapshot {
  return {
    channels: [
      { uuid: 'ch-atx-91', name: 'AT-X', number: '9.1', services: ['svc-atx-91'] },
      { uuid: 'ch-atx-910', name: 'AT-X', number: '9.10', services: ['svc-atx-910'] },
      { uuid: 'ch-bs11', name: 'BS11', number: '11', services: ['svc-bs11-a', 'svc-bs11-b'] },
      { uuid: 'ch-nhk', name: 'NHK', number: '1', services: ['svc-nhk'] },
      { uuid: 'ch-dup-52', name: 'Dup', number: '5.2', services: ['svc-dup-52'] },
      { uuid: 'ch-dup-51', name: 'Dup', number: '5.1', services: ['svc-dup-51'] },
    ],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [
      { uuid: 'svc-atx-91', sid: 101 },
      { uuid: 'svc-atx-910', sid: 110 },
      { uuid: 'svc-bs11-a', sid: 1032 },
      { uuid: 'svc-bs11-b', sid: 1024 },
      { uuid: 'svc-nhk' }, // deliberately without a sid
      { uuid: 'svc-dup-51', sid: 501 },
      { uuid: 'svc-dup-52', sid: 502 },
    ],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
  };
}

/** zone2: only AT-X "9.10" (no "9.1"), and Dup "4.9" — lower than zone1's 5.1 */
function zone2Topology(): TopologySnapshot {
  return {
    channels: [
      { uuid: 'ch2-atx-910', name: 'AT-X', number: '9.10', services: ['svc2-atx'] },
      { uuid: 'ch2-dup-49', name: 'Dup', number: '4.9', services: ['svc2-dup'] },
    ],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [
      { uuid: 'svc2-atx', sid: 210 },
      { uuid: 'svc2-dup', sid: 249 },
    ],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    instances: [
      {
        id: 'zone1',
        name: 'zone1',
        url: 'http://zone1:9981',
        restreamer: {
          nodes: [
            { id: 'n1', url: 'http://zone1-n1:5580', serveUrl: 'http://hls.zone1-n1' },
            { id: 'n2', url: 'http://zone1-n2:5580' }, // no serveUrl
          ],
        },
      },
      {
        id: 'zone2',
        name: 'zone2',
        url: 'http://zone2:9981',
        restreamer: { nodes: [{ id: 'n1', url: 'http://zone2-n1:5580', serveUrl: 'http://hls.zone2-n1' }] },
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
    ...overrides,
  };
}

function profilePayload(video: Record<string, unknown> = { mode: 'ivtc' }): unknown {
  return { template: 'arib-hls', templateVersion: 1, video, audio: [{}] };
}

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
  events: SseEvent[];
  service: RestreamerService;
  nodes: Map<string, FakeRestreamerNode>;
  pollers: Map<string, InstancePoller>;
  config: AppConfig;
  logs: LoggedEvent[];
}

async function setup(configOverrides: Partial<AppConfig> = {}): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  const bus = new EventBus();
  const events: SseEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config = makeConfig(configOverrides);
  const pollers = new Map<string, InstancePoller>();
  const nodes = new Map<string, FakeRestreamerNode>();
  const clients = new Map<string, RestreamerNodeClient>();
  for (const inst of config.instances) {
    cache.init(inst.id, inst.name, inst.url);
    cache.get(inst.id).topology = inst.id === 'zone1' ? zone1Topology() : zone2Topology();
    pollers.set(inst.id, { pollTopology: vi.fn(async () => {}) } as unknown as InstancePoller);
    for (const n of inst.restreamer?.nodes ?? []) {
      const fake = fakeRestreamerNode();
      nodes.set(nodeKey(inst.id, n.id), fake);
      clients.set(nodeKey(inst.id, n.id), fake);
    }
  }
  const logs: LoggedEvent[] = [];
  const service = new RestreamerService(db, cache, pollers, bus, config, clients, new Map(), {
    log: (e) => logs.push(e),
  });
  return { db, destroy, cache, events, service, nodes, pollers, config, logs };
}

function sessionStatus(name: string): EnrichedSessionStatus {
  return { name, state: 'running', enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0, channelSlug: null };
}

function seedNodeStatusEntry(cache: InstanceCache, instanceId: string, nodeId: string, sessions: EnrichedSessionStatus[] = []): void {
  cache.get(instanceId).restreamers.push({
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
    sessions,
    sourcesHash: null,
    sources: null,
    capabilities: null,
    templates: null,
  });
}

/**
 * Set a node's polled sources catalog in the cache (what the poller would
 * write): `sources: null` = never fetched; `[] + hash null` = known-no-catalog;
 * entries + hash = live catalog. Seeds the status entry when missing.
 */
function setNodeSources(
  cache: InstanceCache,
  instanceId: string,
  nodeId: string,
  sources: SourceCatalogEntry[] | null,
  hash: string | null,
): void {
  const snap = cache.get(instanceId);
  if (!snap.restreamers.some((r) => r.nodeId === nodeId)) {
    seedNodeStatusEntry(cache, instanceId, nodeId);
  }
  const entry = snap.restreamers.find((r) => r.nodeId === nodeId)!;
  entry.sources = sources;
  entry.sourcesHash = hash;
}

async function nodeStateRow(db: Kysely<Database>, instanceId: string, nodeId: string) {
  return db
    .selectFrom('restream_node_state')
    .selectAll()
    .where('instance_id', '=', instanceId)
    .where('node_id', '=', nodeId)
    .executeTakeFirst();
}

/** channel row inserted directly (bypasses write-time pin, for compute-time tests) */
async function insertChannelRow(
  db: Kysely<Database>,
  fields: { id?: string; slug: string; name: string; number: string | null; profileId: string; enabled?: boolean },
): Promise<string> {
  const id = fields.id ?? randomUUID();
  await db
    .insertInto('restream_channels')
    .values({
      id,
      slug: fields.slug,
      channel_name: fields.name,
      channel_number: fields.number,
      profile_id: fields.profileId,
      enabled: fields.enabled === false ? 0 : 1,
      comment: null,
      updated_at: TS,
    })
    .execute();
  return id;
}

async function insertPlacementRow(
  db: Kysely<Database>,
  fields: {
    channelId: string;
    instanceId: string;
    nodeId: string;
    priority?: number;
    enabled?: boolean;
    programNumber?: number | null;
    profileId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('restream_placements')
    .values({
      id,
      channel_id: fields.channelId,
      instance_id: fields.instanceId,
      node_id: fields.nodeId,
      priority: fields.priority ?? 1,
      enabled: fields.enabled === false ? 0 : 1,
      profile_id: fields.profileId ?? null,
      program_number: fields.programNumber ?? null,
      updated_at: TS,
    })
    .execute();
  return id;
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------- helpers under test ----------

describe('deriveSlug', () => {
  it('lowercases and collapses non [a-z0-9-] runs to single dashes', () => {
    expect(deriveSlug('AT-X')).toBe('at-x');
    expect(deriveSlug('TOKYO MX1')).toBe('tokyo-mx1');
    expect(deriveSlug('  BS日テレ (HD)  ')).toBe('bs-hd');
    expect(deriveSlug('--x--')).toBe('x');
  });

  it('caps at 64 chars without a trailing dash and never returns empty', () => {
    // 63 a's + '-b' would cut at "…a-": the dangling dash is trimmed too
    expect(deriveSlug(`${'a'.repeat(63)}-b`)).toBe('a'.repeat(63));
    expect(deriveSlug('a'.repeat(70))).toHaveLength(64);
    expect(deriveSlug('日本語だけ')).toBe('channel');
  });
});

describe('canonicalJson / sessionsHash', () => {
  it('is key-order independent at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe(
      canonicalJson({ a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('drops undefined members like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('array order matters (sessions are pre-sorted by name)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(sessionsHash([])).toHaveLength(64);
  });
});

// ---------- profile CRUD ----------

describe('profiles', () => {
  it('createProfile validates and default-completes the payload', async () => {
    const h = await setup();
    const profile = await h.service.createProfile('default-3M', profilePayload());
    expect(profile.payload).toMatchObject({
      template: 'arib-hls',
      video: { mode: 'ivtc', codec: 'hevc_qsv', bitrate: '3M', preset: 7 },
      audio: [{ volume: '5dB' }],
    });
    expect(await h.service.listProfiles()).toHaveLength(1);
    await h.destroy();
  });

  it('rejects an invalid payload with a 400-flavored error', async () => {
    const h = await setup();
    await expect(
      h.service.createProfile('bad', profilePayload({ mode: 'weird' })),
    ).rejects.toMatchObject({ statusCode: 400 });
    await h.destroy();
  });

  it('rejects a duplicate name with a 409-flavored error', async () => {
    const h = await setup();
    await h.service.createProfile('dup', profilePayload());
    await expect(h.service.createProfile('dup', profilePayload())).rejects.toMatchObject({
      statusCode: 409,
    });
    await h.destroy();
  });

  it('updateProfile with a payload change re-pushes every node hosting the profile', async () => {
    // no switcher -- this tests the DIRECT-write path; the switcher-fronted
    // cutover path (Stage B.3) is covered separately in its own describe block
    const h = await setup({ restreamer: { switchers: [] } });
    const profile = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: profile.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.puts()).toHaveLength(1);

    await h.service.updateProfile(profile.id, {
      payload: profilePayload({ mode: 'ivtc', bitrate: '4M' }),
    });
    expect(node.puts()).toHaveLength(2);
    expect(node.puts()[1]!.revision).not.toBe(node.puts()[0]!.revision);
    const session = node.desired!.sessions[0]!;
    const argv = (session.pipeline as RawArgvParams).ffmpegArgv;
    expect(argv[argv.indexOf('-b:v:0') + 1]).toBe('4M');
    await h.destroy();
  });

  it('deleteProfile is blocked with 409 while a channel references it, allowed after', async () => {
    const h = await setup();
    const profile = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({ channelName: 'AT-X', profileId: profile.id });
    await expect(h.service.deleteProfile(profile.id)).rejects.toMatchObject({ statusCode: 409 });
    await h.service.deleteChannel(chan.id);
    await h.service.deleteProfile(profile.id);
    expect(await h.service.listProfiles()).toHaveLength(0);
    await h.destroy();
  });

  it('deleteProfile is blocked with 409 while only a placement overrides it (channel uses a different profile)', async () => {
    // no switcher -- this tests the DIRECT-write path (see comment above)
    const h = await setup({ restreamer: { switchers: [] } });
    const channelProfile = await h.service.createProfile('channel-profile', profilePayload());
    const overrideProfile = await h.service.createProfile('override-profile', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      profileId: channelProfile.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', profileId: overrideProfile.id }],
    });
    await expect(h.service.deleteProfile(overrideProfile.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    const placement = (await h.service.listChannels())[0]!.placements[0]!;
    await h.service.updatePlacement(placement.id, { profileId: null });
    await h.service.deleteProfile(overrideProfile.id);
    expect(await h.service.listProfiles()).toHaveLength(1);
    await h.destroy();
  });

  it('updateProfile re-pushes a node whose only link to the profile is a placement override', async () => {
    // no switcher -- this tests the DIRECT-write path (see comment above)
    const h = await setup({ restreamer: { switchers: [] } });
    const channelProfile = await h.service.createProfile(
      'channel-profile',
      profilePayload({ mode: 'ivtc', bitrate: '3M' }),
    );
    const overrideProfile = await h.service.createProfile(
      'override-profile',
      profilePayload({ mode: 'ivtc', bitrate: '6M' }),
    );
    await h.service.createChannel({
      channelName: 'AT-X',
      profileId: channelProfile.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', profileId: overrideProfile.id }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.puts()).toHaveLength(1);

    await h.service.updateProfile(overrideProfile.id, {
      payload: profilePayload({ mode: 'ivtc', bitrate: '9M' }),
    });
    expect(node.puts()).toHaveLength(2);
    const session = node.desired!.sessions[0]!;
    const argv = (session.pipeline as RawArgvParams).ffmpegArgv;
    expect(argv[argv.indexOf('-b:v:0') + 1]).toBe('9M');
    await h.destroy();
  });
});

// ---------- channel identity ----------

describe('channel identity (string numbers)', () => {
  async function seed(h: Harness): Promise<RestreamProfile> {
    return h.service.createProfile('p', profilePayload());
  }

  it('a pinned "9.1" resolves the 9.1 channel and never "9.10"', async () => {
    const h = await setup();
    const p = await seed(h);
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions).toHaveLength(1);
    expect(doc!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-atx-91' });
    await h.destroy();
  });

  it('a pinned "9.10" resolves the 9.10 channel', async () => {
    const h = await setup();
    const p = await seed(h);
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.10',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-atx-910' });
    await h.destroy();
  });

  it('a pinned number missing on the instance blocks with a readable reason', async () => {
    // zone2 only has AT-X "9.10" — "9.1" must NOT fall back to it
    const h = await setup();
    const p = await seed(h);
    setNodeSources(h.cache, 'zone2', 'n1', [], 'known-empty'); // no catalog fallback either
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone2', nodeId: 'n1' }],
      force: true, // the compute-time blockedReason is under test
    });
    const computed = await h.service.computeNodeDoc('zone2', 'n1');
    expect(computed.doc!.sessions).toHaveLength(0);
    expect(computed.blocked).toHaveLength(1);
    expect(computed.blocked[0]!.reason).toBe(
      'channel "AT-X" (#9.1) not found on instance zone2 nor in node zone2/n1\'s sources catalog',
    );
    await h.destroy();
  });

  it('write-time pin: no number resolves the lowest same-name number across the placement instances', async () => {
    const h = await setup();
    const p = await seed(h);
    // zone1 has Dup 5.1/5.2, zone2 has Dup 4.9 — union lowest is 4.9 (which
    // zone1 then cannot serve: the write-time availability check needs force)
    const chan = await h.service.createChannel({
      channelName: 'Dup',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
      force: true,
    });
    expect(chan.channelNumber).toBe('4.9');

    const only1 = await h.service.createChannel({
      channelName: 'Dup',
      profileId: p.id,
      slug: 'dup-zone1',
      placements: [{ instanceId: 'zone1', nodeId: 'n2' }],
    });
    expect(only1.channelNumber).toBe('5.1');
    await h.destroy();
  });

  it('write-time pin keeps null when there are no placements or the name is unresolvable', async () => {
    const h = await setup();
    const p = await seed(h);
    const noPlacements = await h.service.createChannel({ channelName: 'Dup', profileId: p.id });
    expect(noPlacements.channelNumber).toBeNull();
    const ghost = await h.service.createChannel({
      channelName: 'Ghost',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true, // Ghost resolves nowhere — the availability check would 409
    });
    expect(ghost.channelNumber).toBeNull();
    await h.destroy();
  });

  it('updating channelName WITHOUT a number nulls the stored pin, then re-pins', async () => {
    const h = await setup();
    const p = await seed(h);
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const updated = await h.service.updateChannel(chan.id, { channelName: 'Dup' });
    // the old 9.1 pin must not survive; re-pinned to Dup's lowest on zone1
    expect(updated.channelNumber).toBe('5.1');

    const ghosted = await h.service.updateChannel(chan.id, { channelName: 'Ghost', force: true });
    expect(ghosted.channelNumber).toBeNull();
    await h.destroy();
  });

  it('a stored null number resolves the lowest-numbered same-name channel at compute time', async () => {
    const h = await setup();
    const p = await seed(h);
    const chanId = await insertChannelRow(h.db, { slug: 'dup', name: 'Dup', number: null, profileId: p.id });
    await insertPlacementRow(h.db, { channelId: chanId, instanceId: 'zone1', nodeId: 'n1' });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    // 5.1 beats 5.2 even though 5.2 comes first in the grid
    expect(doc!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-dup-51' });
    await h.destroy();
  });

  it('an unresolvable unpinned name blocks with a readable reason', async () => {
    const h = await setup();
    const p = await seed(h);
    setNodeSources(h.cache, 'zone1', 'n1', [], 'known-empty'); // no catalog fallback either
    const chanId = await insertChannelRow(h.db, { slug: 'ghost', name: 'Ghost', number: null, profileId: p.id });
    await insertPlacementRow(h.db, { channelId: chanId, instanceId: 'zone1', nodeId: 'n1' });
    const computed = await h.service.computeNodeDoc('zone1', 'n1');
    expect(computed.blocked[0]!.reason).toBe(
      'channel "Ghost" not found on instance zone1 nor in node zone1/n1\'s sources catalog',
    );
    await h.destroy();
  });
});

// ---------- program number ----------

describe('program number derivation', () => {
  it('derives the SID from the resolved channel’s linked service', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.tsreadex.programNumber).toBe(101);
    await h.destroy();
  });

  it('picks the LOWEST sid when the channel links several services', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'BS11',
      channelNumber: '11',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.tsreadex.programNumber).toBe(1024);
    await h.destroy();
  });

  it('a placement program_number override wins over derivation', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', programNumber: 7777 }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.tsreadex.programNumber).toBe(7777);
    await h.destroy();
  });

  it('an underivable program number blocks the placement', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'NHK',
      channelNumber: '1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true, // SID-underivable — the availability check would 409
    });
    const computed = await h.service.computeNodeDoc('zone1', 'n1');
    expect(computed.doc!.sessions).toHaveLength(0);
    expect(computed.blocked[0]!.reason).toContain('cannot derive program number');
    await h.destroy();
  });
});

// ---------- doc determinism + push ----------

describe('desired doc determinism and push', () => {
  it('same inputs produce the same revision and a stable session order', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'BS11',
      channelNumber: '11',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    // session names are placement ids (uuids) now, not slugs — the doc still
    // sorts by name, so the expected order is the ids sorted lexically
    const channels = await h.service.listChannels();
    const bs11Id = channels.find((c) => c.slug === 'bs11')!.placements[0]!.id;
    const atxId = channels.find((c) => c.slug === 'at-x')!.placements[0]!.id;
    const expectedOrder = [bs11Id, atxId].sort((x, y) => x.localeCompare(y));

    const a = await h.service.computeNodeDoc('zone1', 'n1');
    const b = await h.service.computeNodeDoc('zone1', 'n1');
    expect(a.doc!.revision).toBe(b.doc!.revision);
    expect(a.doc!.sessions.map((s) => s.name)).toEqual(expectedOrder);
    expect(a.doc!.revision).toBe(sessionsHash(a.doc!.sessions));
    expect(a.doc!.apiVersion).toBe(1);
    const session = a.doc!.sessions.find((s) => s.name === atxId)!;
    expect(session).toMatchObject({ name: atxId, enabled: true });
    await h.destroy();
  });

  it('push persists the hash; an unchanged second push is hash-skipped; force bypasses', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.puts()).toHaveLength(1); // pushed by the mutation itself

    const state = await nodeStateRow(h.db, 'zone1', 'n1');
    expect(state!.pushed_hash).toBe(node.desired!.revision);

    const second = await h.service.pushNode('zone1', 'n1');
    expect(second.action).toBe('skipped');
    expect(node.puts()).toHaveLength(1);

    const forced = await h.service.pushNode('zone1', 'n1', true);
    expect(forced.action).toBe('pushed');
    expect(node.puts()).toHaveLength(2);
    expect(node.puts()[1]!.revision).toBe(node.puts()[0]!.revision);
    await h.destroy();
  });

  it('a disabled channel or placement stays out of the doc', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    await h.service.updateChannel(chan.id, { enabled: false });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions).toHaveLength(0);
    // the disable itself pushed the (now empty) doc — teardown, not a skip
    const node = h.nodes.get('zone1/n1')!;
    expect(node.desired!.sessions).toHaveLength(0);
    await h.destroy();
  });

  it('a never-pushed node with an empty doc is left alone (never wipe an unmanaged node)', async () => {
    const h = await setup();
    const results = await h.service.pushAll();
    expect(results.every((r) => r.action === 'skipped')).toBe(true);
    for (const node of h.nodes.values()) expect(node.puts()).toHaveLength(0);
    await h.destroy();
  });

  it('deleting a channel pushes the emptied doc to its former nodes', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.desired!.sessions).toHaveLength(1);
    await h.service.deleteChannel(chan.id);
    expect(node.desired!.sessions).toHaveLength(0);
    await h.destroy();
  });

  it('a per-placement profile override changes only that placement\'s pipeline; clearing it reverts the doc revision', async () => {
    // no switcher -- this tests the DIRECT-write path; Stage B.3's cutover
    // routing (switcher-fronted) has its own describe block with equivalent coverage
    const h = await setup({ restreamer: { switchers: [] } });
    const profileA = await h.service.createProfile('profile-a', profilePayload({ mode: 'ivtc', bitrate: '3M' }));
    const profileB = await h.service.createProfile('profile-b', profilePayload({ mode: 'ivtc', bitrate: '6M' }));
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: profileA.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });
    const placements = (await h.service.listChannels())[0]!.placements;
    const n1Placement = placements.find((pl) => pl.nodeId === 'n1')!;
    const n2Placement = placements.find((pl) => pl.nodeId === 'n2')!;
    // no override yet — both nodes use the channel profile (fallback path)
    expect(n1Placement.profileId).toBeNull();

    function pipelineBitrate(pipeline: unknown): string | undefined {
      const argv = (pipeline as RawArgvParams).ffmpegArgv;
      const i = argv.indexOf('-b:v:0');
      return i === -1 ? undefined : argv[i + 1];
    }

    const before = await h.service.computeNodeDoc('zone1', 'n1');
    const baselineRevision = before.doc!.revision;
    expect(pipelineBitrate(before.doc!.sessions[0]!.pipeline)).toBe('3M');

    // override n2 only — n1's doc (and revision) must be unaffected
    await h.service.updatePlacement(n2Placement.id, { profileId: profileB.id });
    const n2Doc = await h.service.computeNodeDoc('zone1', 'n2');
    expect(pipelineBitrate(n2Doc.doc!.sessions[0]!.pipeline)).toBe('6M');
    const n1DocAfter = await h.service.computeNodeDoc('zone1', 'n1');
    expect(pipelineBitrate(n1DocAfter.doc!.sessions[0]!.pipeline)).toBe('3M');
    expect(n1DocAfter.doc!.revision).toBe(baselineRevision);

    // override n1 too, then clear it — the doc reverts to the exact original hash
    await h.service.updatePlacement(n1Placement.id, { profileId: profileB.id });
    const overriddenDoc = await h.service.computeNodeDoc('zone1', 'n1');
    expect(overriddenDoc.doc!.revision).not.toBe(baselineRevision);
    await h.service.updatePlacement(n1Placement.id, { profileId: null });
    const revertedDoc = await h.service.computeNodeDoc('zone1', 'n1');
    expect(revertedDoc.doc!.revision).toBe(baselineRevision);
    await h.destroy();
  });

  it('two placements of one channel on DIFFERENT nodes each resolve their own session name (placement id)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });
    const placements = (await h.service.listChannels())[0]!.placements;
    const n1Placement = placements.find((pl) => pl.nodeId === 'n1')!;
    const n2Placement = placements.find((pl) => pl.nodeId === 'n2')!;
    expect(n1Placement.id).not.toBe(n2Placement.id);

    const n1Doc = await h.service.computeNodeDoc('zone1', 'n1');
    const n2Doc = await h.service.computeNodeDoc('zone1', 'n2');
    // each node's session is named after ITS OWN placement, never the other's
    expect(n1Doc.doc!.sessions.map((s) => s.name)).toEqual([n1Placement.id]);
    expect(n2Doc.doc!.sessions.map((s) => s.name)).toEqual([n2Placement.id]);
    await h.destroy();
  });
});

// ---------- blocked / defer semantics ----------

describe('blocked and defer semantics', () => {
  it('a never-pushed blocked placement stays out while the rest of the node pushes', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const node = h.nodes.get('zone1/n1')!;
    node.unreachable = true; // mutations succeed, their auto-pushes fail
    await h.service.createChannel({
      channelName: 'Ghost',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true, // unresolvable on purpose — pre-provisioned blocked placement
    });
    const atx = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    node.unreachable = false;
    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('pushed');
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.slug).toBe('ghost');
    const atxPlacementId = (await h.service.listChannels()).find((c) => c.id === atx.id)!
      .placements[0]!.id;
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([atxPlacementId]);
    await h.destroy();
  });

  it('a previously-pushed placement that becomes blocked defers the whole node push', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [], 'known-empty'); // no catalog fallback either
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.desired!.sessions).toHaveLength(1);
    const placementId = node.desired!.sessions[0]!.name;
    const putsBefore = node.puts().length;

    // the channel vanishes from the topology (rename to something unresolvable;
    // force bypasses the write-time re-check — the defer logic is under test)
    await h.service.updateChannel(chan.id, { channelName: 'Ghost', force: true });
    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('deferred');
    expect(result.blocked[0]!.reason).toBe(
      'channel "Ghost" not found on instance zone1 nor in node zone1/n1\'s sources catalog',
    );
    // the running session was NOT torn down
    expect(node.puts().length).toBe(putsBefore);
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([placementId]);
    await h.destroy();
  });

  it('a cold controller hydrates the last-pushed doc from the node before deciding to defer', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    // out-of-band identity break, then a FRESH service instance (cold cache)
    await h.db
      .updateTable('restream_channels')
      .set({ channel_name: 'Ghost', channel_number: null })
      .where('id', '=', chan.id)
      .execute();
    const clients = new Map<string, RestreamerNodeClient>(h.nodes);
    const service2 = new RestreamerService(h.db, h.cache, h.pollers, new EventBus(), h.config, clients);
    const node = h.nodes.get('zone1/n1')!;
    node.calls.length = 0;

    const result = await service2.pushNode('zone1', 'n1');
    expect(result.action).toBe('deferred');
    expect(node.calls.some((c) => c.method === 'getDesired')).toBe(true);
    expect(node.puts()).toHaveLength(0);
    await h.destroy();
  });

  it('missing topology no longer defers on its own (no placements to resolve) but still triggers a topology poll', async () => {
    const h = await setup();
    h.cache.get('zone1').topology = null;
    const computed = await h.service.computeNodeDoc('zone1', 'n1');
    expect(computed.deferred).toBe(false);
    expect(computed.blocked).toEqual([]);
    expect(computed.doc!.sessions).toEqual([]);
    const poller = h.pollers.get('zone1')! as unknown as { pollTopology: ReturnType<typeof vi.fn> };
    expect(poller.pollTopology).toHaveBeenCalledTimes(1);
    // never-pushed node with nothing to run: push is a no-op skip, not an error
    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('skipped');
    expect(result.detail).toBe('nothing to manage');
    await h.destroy();
  });

  it('a permanently topology-less (external-only) zone resolves catalog-only placements — not deferred', async () => {
    const h = await setup();
    const pf = await h.service.createProfile('p', profilePayload());
    h.cache.get('zone1').topology = null; // this zone's tvh never answers
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    await h.service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: pf.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const computed = await h.service.computeNodeDoc('zone1', 'n1');
    expect(computed.deferred).toBe(false);
    expect(computed.blocked).toEqual([]);
    expect(computed.doc!.sessions[0]!.source).toEqual({ url: 'http://cam.example/1.m3u8' });
    const poller = h.pollers.get('zone1')! as unknown as { pollTopology: ReturnType<typeof vi.fn> };
    expect(poller.pollTopology).toHaveBeenCalled(); // still keeps trying to recover tvh
    await h.destroy();
  });

  it('topology unavailable + catalog miss blocks (never-pushed placement stays out, rest of node still pushes)', async () => {
    const h = await setup();
    const pf = await h.service.createProfile('p', profilePayload());
    h.cache.get('zone1').topology = null;
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1'); // catalog present but no match
    await h.service.createChannel({
      channelName: 'Cam 9',
      profileId: pf.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true, // unresolvable on purpose — the compute-time reason is under test
    });
    const computed = await h.service.computeNodeDoc('zone1', 'n1');
    expect(computed.deferred).toBe(false);
    expect(computed.doc!.sessions).toHaveLength(0);
    expect(computed.blocked[0]!.reason).toBe(
      'topology not loaded for instance zone1 and channel "Cam 9" not in node zone1/n1\'s sources catalog',
    );
    await h.destroy();
  });

  it('topology drops + the catalog entry for a previously-pushed placement also disappears: the node defers', async () => {
    const h = await setup();
    const pf = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    await h.service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: pf.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    const placementId = node.desired!.sessions[0]!.name;
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([placementId]);
    const putsBefore = node.puts().length;

    h.cache.get('zone1').topology = null; // this zone's tvh stops answering...
    setNodeSources(h.cache, 'zone1', 'n1', [], 'h2'); // ...AND the catalog entry vanishes too

    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('deferred');
    expect(result.blocked[0]!.reason).toBe(
      'topology not loaded for instance zone1 and channel "Cam 1" (#1) not in node zone1/n1\'s sources catalog',
    );
    expect(node.puts().length).toBe(putsBefore); // running session left untouched
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([placementId]);
    await h.destroy();
  });

  it('anti-flap: refuses to re-source a previously tvh-sourced session from the catalog when topology drops', async () => {
    const h = await setup();
    const pf = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pf.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.desired!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-atx-91' });
    const putsBefore = node.puts().length;

    // topology drops AND a same-identity catalog entry shows up — a naive
    // catalog-only resolution would silently re-source the live tvh session
    h.cache.get('zone1').topology = null;
    const shadow: SourceCatalogEntry = {
      id: 'shadow',
      name: 'AT-X',
      url: 'http://shadow.example/atx.m3u8',
      chno: '9.1',
    };
    setNodeSources(h.cache, 'zone1', 'n1', [shadow], 'h1');

    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('deferred');
    expect(result.blocked[0]!.reason).toBe(
      'topology not loaded for instance zone1 — refusing to re-source a tvheadend session from the catalog',
    );
    expect(node.puts().length).toBe(putsBefore); // running tvh session left untouched
    expect(node.desired!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-atx-91' });

    // topology returns — normal tvh resolution resumes, doc unchanged so the push hash-skips
    h.cache.get('zone1').topology = zone1Topology();
    const resumed = await h.service.pushNode('zone1', 'n1');
    expect(resumed.action).toBe('skipped');
    expect(node.desired!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-atx-91' });
    await h.destroy();
  });

  it('anti-flap does not apply to a slug previously pushed with a {url} (catalog) source — it proceeds catalog-only', async () => {
    const h = await setup();
    const pf = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    await h.service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: pf.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.desired!.sessions[0]!.source).toEqual({ url: 'http://cam.example/1.m3u8' });

    // the catalog entry's URL changes while topology happens to be down too —
    // this was already a {url} source, so the anti-flap guard must not apply
    h.cache.get('zone1').topology = null;
    const camMoved: SourceCatalogEntry = { ...CAM, url: 'http://cam.example/2.m3u8' };
    setNodeSources(h.cache, 'zone1', 'n1', [camMoved], 'h2');

    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('pushed');
    expect(node.desired!.sessions[0]!.source).toEqual({ url: 'http://cam.example/2.m3u8' });
    await h.destroy();
  });
});

// ---------- channel / placement CRUD ----------

describe('channel and placement CRUD', () => {
  it('derives and uniquifies slugs for same-name channels', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const first = await h.service.createChannel({ channelName: 'AT-X', profileId: p.id });
    const second = await h.service.createChannel({ channelName: 'AT-X', profileId: p.id });
    const third = await h.service.createChannel({ channelName: 'AT-X', profileId: p.id });
    expect(first.slug).toBe('at-x');
    expect(second.slug).toBe('at-x-2');
    expect(third.slug).toBe('at-x-3');
    await h.destroy();
  });

  it('rejects an invalid explicit slug (400) and a duplicate one (409)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    for (const bad of ['Bad Slug', '-x', 'UPPER', 'a'.repeat(65)]) {
      await expect(
        h.service.createChannel({ channelName: 'X', profileId: p.id, slug: bad }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await h.service.createChannel({ channelName: 'X', profileId: p.id, slug: 'taken' });
    await expect(
      h.service.createChannel({ channelName: 'Y', profileId: p.id, slug: 'taken' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await h.destroy();
  });

  it('rejects placements on unknown instances/nodes at write time', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await expect(
      h.service.createChannel({
        channelName: 'AT-X',
        profileId: p.id,
        placements: [{ instanceId: 'zone9', nodeId: 'n1' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const chan = await h.service.createChannel({ channelName: 'AT-X', profileId: p.id });
    await expect(
      h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'ghost-node' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await h.destroy();
  });

  it('tolerates an existing placement row whose node left the config (blockedReason, no crash)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({ channelName: 'AT-X', channelNumber: '9.1', profileId: p.id });
    // simulate a config shrink: the row exists but the node is gone
    await insertPlacementRow(h.db, { channelId: chan.id, instanceId: 'zone1', nodeId: 'gone' });
    const [listed] = await h.service.listChannels();
    expect(listed!.placements).toHaveLength(1);
    expect(listed!.placements[0]!.blockedReason).toBe(
      'restreamer node "gone" is not configured on instance zone1',
    );
    // pushes simply skip the unknown node
    await expect(h.service.pushAffectedByChannel(chan.id)).resolves.toEqual([]);
    await h.destroy();
  });

  it('addPlacement defaults priority to max+1 and rejects duplicates per node', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({ channelName: 'AT-X', channelNumber: '9.1', profileId: p.id });
    const first = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n1' });
    const second = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n2' });
    expect(first.priority).toBe(1);
    expect(second.priority).toBe(2);
    await expect(
      h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n1' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await h.destroy();
  });

  it('reorderPlacements rewrites priorities and validates the id set', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({ channelName: 'AT-X', channelNumber: '9.1', profileId: p.id });
    const a = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n1' });
    const b = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n2' });
    await h.service.reorderPlacements(chan.id, [b.id, a.id]);
    const [listed] = await h.service.listChannels();
    const byId = new Map(listed!.placements.map((x) => [x.id, x.priority]));
    expect(byId.get(b.id)).toBe(1);
    expect(byId.get(a.id)).toBe(2);
    await expect(h.service.reorderPlacements(chan.id, [a.id])).rejects.toMatchObject({
      statusCode: 400,
    });
    await h.destroy();
  });

  it('moving a placement pushes BOTH the old and the new node', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const n1 = h.nodes.get('zone1/n1')!;
    const n2 = h.nodes.get('zone1/n2')!;
    expect(n1.desired!.sessions).toHaveLength(1);

    const placement = (await h.service.listChannels())[0]!.placements[0]!;
    await h.service.updatePlacement(placement.id, { nodeId: 'n2' });
    expect(n1.desired!.sessions).toHaveLength(0); // torn down on the old node
    // moving a placement keeps its id, so the session name is unchanged
    expect(n2.desired!.sessions.map((s) => s.name)).toEqual([placement.id]); // started on the new one
    expect((await h.service.getChannel(chan.id))).not.toBeNull();
    await h.destroy();
  });

  it('rejects an unknown placement profileId on create/addPlacement/updatePlacement/apply', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await expect(
      h.service.createChannel({
        channelName: 'AT-X',
        profileId: p.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1', profileId: 'ghost-profile' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const chan = await h.service.createChannel({ channelName: 'AT-X', profileId: p.id });
    await expect(
      h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n1', profileId: 'ghost-profile' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const placement = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n1' });
    await expect(
      h.service.updatePlacement(placement.id, { profileId: 'ghost-profile' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      h.service.applyChannelChanges(chan.id, {
        placements: [
          {
            id: placement.id,
            instanceId: 'zone1',
            nodeId: 'n1',
            mode: 'hot',
            profileId: 'ghost-profile',
            programNumber: null,
            enabled: true,
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await h.destroy();
  });

  it('updatePlacement profileId round-trips; null clears the override (inherits the channel profile)', async () => {
    // no switcher -- this tests the DIRECT-write path (see comment above)
    const h = await setup({ restreamer: { switchers: [] } });
    const channelProfile = await h.service.createProfile('channel-profile', profilePayload());
    const overrideProfile = await h.service.createProfile('override-profile', profilePayload());
    const chan = await h.service.createChannel({ channelName: 'AT-X', profileId: channelProfile.id });
    const placement = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n1' });
    expect(placement.profileId).toBeNull();

    const overridden = await h.service.updatePlacement(placement.id, { profileId: overrideProfile.id });
    expect(overridden.profileId).toBe(overrideProfile.id);

    const cleared = await h.service.updatePlacement(placement.id, { profileId: null });
    expect(cleared.profileId).toBeNull();
    await h.destroy();
  });

  it('applyChannelChanges persists profileId on new and existing placements', async () => {
    // no switcher -- this tests the DIRECT-write path (see comment above)
    const h = await setup({ restreamer: { switchers: [] } });
    const channelProfile = await h.service.createProfile('channel-profile', profilePayload());
    const overrideProfile = await h.service.createProfile('override-profile', profilePayload());
    const chan = await h.service.createChannel({ channelName: 'AT-X', profileId: channelProfile.id });
    const existing = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n1' });

    const applied = await h.service.applyChannelChanges(chan.id, {
      placements: [
        {
          id: existing.id,
          instanceId: 'zone1',
          nodeId: 'n1',
          mode: 'hot',
          profileId: overrideProfile.id,
          programNumber: null,
          enabled: true,
        },
        {
          instanceId: 'zone1',
          nodeId: 'n2',
          mode: 'hot',
          profileId: null,
          programNumber: null,
          enabled: true,
        },
      ],
    });
    const byNode = new Map(applied.placements.map((pl) => [pl.nodeId, pl]));
    expect(byNode.get('n1')!.profileId).toBe(overrideProfile.id);
    expect(byNode.get('n2')!.profileId).toBeNull();
    await h.destroy();
  });

  it('batchChannels returns per-id results and a failing id does not abort the rest', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const a = await h.service.createChannel({ channelName: 'AT-X', channelNumber: '9.1', profileId: p.id });
    const b = await h.service.createChannel({ channelName: 'BS11', channelNumber: '11', profileId: p.id });

    const results = await h.service.batchChannels('disable', [a.id, 'missing', b.id]);
    expect(results).toEqual([
      { id: a.id, ok: true },
      { id: 'missing', ok: false, error: expect.stringContaining('not found') },
      { id: b.id, ok: true },
    ]);
    const listed = await h.service.listChannels();
    expect(listed.every((c) => !c.enabled)).toBe(true);

    const edited = await h.service.batchChannels('edit', [a.id], { patch: { comment: 'hi' } });
    expect(edited[0]).toEqual({ id: a.id, ok: true });
    expect((await h.service.getChannel(a.id))!.comment).toBe('hi');

    const deleted = await h.service.batchChannels('delete', [a.id, b.id]);
    expect(deleted.every((r) => r.ok)).toBe(true);
    expect(await h.service.listChannels()).toHaveLength(0);
    await h.destroy();
  });
});

// ---------- push failure + heal sweep ----------

describe('push failure and heal sweep', () => {
  it('a mutation still succeeds when the node is down; the sweep heals after recovery', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const node = h.nodes.get('zone1/n1')!;
    node.unreachable = true;

    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    expect(chan.id).toBeTruthy(); // mutation did not throw
    expect(await nodeStateRow(h.db, 'zone1', 'n1')).toBeUndefined();
    expect(await h.service.getPendingPush('zone1', 'n1')).toBe(true);

    node.unreachable = false;
    const results = await h.service.pushAll();
    expect(results.find((r) => r.instanceId === 'zone1' && r.nodeId === 'n1')!.action).toBe('pushed');
    expect(node.desired!.sessions).toHaveLength(1);
    expect((await nodeStateRow(h.db, 'zone1', 'n1'))!.pushed_hash).toBe(node.desired!.revision);
    expect(await h.service.getPendingPush('zone1', 'n1')).toBe(false);
    await h.destroy();
  });

  it('a failed re-push keeps the old hash so the change stays pending', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    const oldHash = (await nodeStateRow(h.db, 'zone1', 'n1'))!.pushed_hash;

    node.failNextPut();
    await h.service.updateProfile(p.id, { payload: profilePayload({ mode: 'deinterlace' }) });
    expect((await nodeStateRow(h.db, 'zone1', 'n1'))!.pushed_hash).toBe(oldHash);
    expect(await h.service.getPendingPush('zone1', 'n1')).toBe(true);

    // startSweep() heals it on the next tick
    vi.useFakeTimers();
    h.service.startSweep();
    await vi.advanceTimersByTimeAsync(60_000);
    h.service.stopSweep();
    vi.useRealTimers();

    expect((await nodeStateRow(h.db, 'zone1', 'n1'))!.pushed_hash).not.toBe(oldHash);
    expect(await h.service.getPendingPush('zone1', 'n1')).toBe(false);
    await h.destroy();
  });

  it('a push failure surfaces on the cached node status and SSE; success clears pendingPush', async () => {
    const h = await setup();
    seedNodeStatusEntry(h.cache, 'zone1', 'n1');
    const p = await h.service.createProfile('p', profilePayload());
    const node = h.nodes.get('zone1/n1')!;
    node.failNextPut(new Error('boom'));
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    let entry = h.cache.get('zone1').restreamers[0]!;
    expect(entry.pendingPush).toBe(true);
    expect(entry.error).toBe('boom');
    expect(h.events.some((e) => e.type === 'restreamer')).toBe(true);

    await h.service.pushNode('zone1', 'n1');
    entry = h.cache.get('zone1').restreamers[0]!;
    expect(entry.pendingPush).toBe(false);
    expect(entry.desiredRevision).toBe(node.desired!.revision);
    await h.destroy();
  });
});

// ---------- playlists ----------

describe('playlists', () => {
  it('slug-unique create (409 on duplicate, 400 on invalid)', async () => {
    const h = await setup();
    await h.service.createPlaylist({ slug: 'anime', title: 'Anime' });
    await expect(h.service.createPlaylist({ slug: 'anime', title: 'Again' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(h.service.createPlaylist({ slug: 'Bad Slug', title: 'x' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await h.service.listPlaylists()).toHaveLength(1);
    await h.destroy();
  });

  it('setChannelPlaylists replaces memberships and rejects unknown playlists', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({ channelName: 'AT-X', profileId: p.id });
    const pl1 = await h.service.createPlaylist({ slug: 'a', title: 'A' });
    const pl2 = await h.service.createPlaylist({ slug: 'b', title: 'B' });

    await h.service.setChannelPlaylists(chan.id, [pl1.id]);
    expect((await h.service.getChannel(chan.id))!.playlistIds).toEqual([pl1.id]);
    await h.service.setChannelPlaylists(chan.id, [pl2.id]);
    expect((await h.service.getChannel(chan.id))!.playlistIds).toEqual([pl2.id]);
    await expect(h.service.setChannelPlaylists(chan.id, ['nope'])).rejects.toMatchObject({
      statusCode: 400,
    });
    await h.destroy();
  });

  it('deletePlaylist cascades memberships; channel deletion cascades too', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const pl = await h.service.createPlaylist({ slug: 'a', title: 'A' });
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      profileId: p.id,
      playlistIds: [pl.id],
    });
    expect((await h.service.getChannel(chan.id))!.playlistIds).toEqual([pl.id]);

    await h.service.deletePlaylist(pl.id);
    expect((await h.service.getChannel(chan.id))!.playlistIds).toEqual([]);
    expect(
      await h.db.selectFrom('restream_playlist_members').selectAll().execute(),
    ).toHaveLength(0);
    await h.destroy();
  });

  it('batch add-playlist / remove-playlist is idempotent per channel', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const a = await h.service.createChannel({ channelName: 'AT-X', profileId: p.id });
    const b = await h.service.createChannel({ channelName: 'BS11', profileId: p.id });
    const pl = await h.service.createPlaylist({ slug: 'x', title: 'X' });

    const added = await h.service.batchChannels('add-playlist', [a.id, b.id, a.id], {
      playlistId: pl.id,
    });
    expect(added.every((r) => r.ok)).toBe(true);
    expect((await h.service.getChannel(a.id))!.playlistIds).toEqual([pl.id]);

    const removed = await h.service.batchChannels('remove-playlist', [a.id], { playlistId: pl.id });
    expect(removed[0]!.ok).toBe(true);
    expect((await h.service.getChannel(a.id))!.playlistIds).toEqual([]);
    expect((await h.service.getChannel(b.id))!.playlistIds).toEqual([pl.id]);
    await h.destroy();
  });
});

// ---------- listChannels status join ----------

describe('listChannels status', () => {
  it('playbackUrl: with a switcher configured every channel with an enabled placement uses it', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    await h.service.createChannel({
      channelName: 'BS11',
      channelNumber: '11',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n2' }], // n2 has no serveUrl — irrelevant
    });
    const noPlacements = await h.service.createChannel({ channelName: 'NHK', profileId: p.id });
    const listed = await h.service.listChannels();
    const atx = listed.find((c) => c.slug === 'at-x')!;
    const bs11 = listed.find((c) => c.slug === 'bs11')!;
    // single-placement channels are fronted by the switcher too: the URL is
    // uniform and never changes when a second placement is added later
    expect(atx.playbackUrl).toBe('https://tv.example/hls/at-x/playlist.m3u8');
    expect(bs11.playbackUrl).toBe('https://tv.example/hls/bs11/playlist.m3u8');
    expect(listed.find((c) => c.id === noPlacements.id)!.playbackUrl).toBeNull();
    await h.destroy();
  });

  it('playbackUrl without a switcher: single placement uses the node serveUrl; none without serveUrl', async () => {
    const h = await setup({ restreamer: undefined });
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    await h.service.createChannel({
      channelName: 'BS11',
      channelNumber: '11',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n2' }], // n2 has no serveUrl
    });
    const listed = await h.service.listChannels();
    const atx = listed.find((c) => c.slug === 'at-x')!;
    const bs11 = listed.find((c) => c.slug === 'bs11')!;
    // no switcher: the fallback URL is keyed by the placement id, not the slug
    const atxPlacementId = atx.placements[0]!.id;
    expect(atx.playbackUrl).toBe(`http://hls.zone1-n1/${atxPlacementId}/playlist.m3u8`);
    expect(bs11.playbackUrl).toBeNull();
    await h.destroy();
  });

  it('playbackUrl: a redundant channel points at the first switcher; null without switchers', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'Dup',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
      force: true, // pins to zone2's 4.9, which zone1 cannot serve
    });
    const [chan] = await h.service.listChannels();
    expect(chan!.playbackUrl).toBe('https://tv.example/hls/dup/playlist.m3u8');
    await h.destroy();

    const h2 = await setup({ restreamer: undefined });
    const p2 = await h2.service.createProfile('p', profilePayload());
    await h2.service.createChannel({
      channelName: 'Dup',
      profileId: p2.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
      force: true, // pins to zone2's 4.9, which zone1 cannot serve
    });
    const [chan2] = await h2.service.listChannels();
    expect(chan2!.playbackUrl).toBeNull();
    await h2.destroy();
  });

  it('joins live sessions by slug and the switcher’s active placement', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone2', 'n1', [], 'known-empty'); // no catalog fallback either
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
      force: true, // zone2 has no AT-X 9.1 — blockedReason is under test
    });
    const placementId = (await h.service.listChannels())[0]!.placements[0]!.id;
    seedNodeStatusEntry(h.cache, 'zone1', 'n1', [sessionStatus(placementId), sessionStatus('other')]);
    const swStatus: SwitcherNodeStatus = {
      switcherId: 'sw1',
      url: 'http://sw1:5581',
      publicUrl: 'https://tv.example',
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '1.0.0',
      pendingPush: false,
      channels: [
        {
          slug: 'at-x',
          activeUpstreamId: placementId,
          upstreams: [{ id: placementId, healthy: true }],
          lastSwitch: { at: '2026-07-06T00:00:00Z', from: null, to: placementId, reason: 'push' },
        },
      ],
    };
    h.cache.switchers.set('sw1', swStatus);

    const [listed] = await h.service.listChannels();
    const zone1Placement = listed!.placements.find((x) => x.instanceId === 'zone1')!;
    const zone2Placement = listed!.placements.find((x) => x.instanceId === 'zone2')!;
    expect(zone1Placement.session?.name).toBe(placementId);
    expect(zone1Placement.blockedReason).toBeNull();
    expect(zone2Placement.session).toBeNull();
    // zone2 has no AT-X 9.1 — surfaced per placement, not per channel
    expect(zone2Placement.blockedReason).toBe(
      'channel "AT-X" (#9.1) not found on instance zone2 nor in node zone2/n1\'s sources catalog',
    );
    expect(listed!.activePlacementId).toBe(placementId);
    expect(listed!.lastSwitch?.reason).toBe('push');
    expect(listed!.profileName).toBe('p');
    expect(chan.id).toBe(listed!.id);
    await h.destroy();
  });

  it('resolves each placement its OWN live session, never the channel\'s first placement', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });
    const placements = (await h.service.listChannels())[0]!.placements;
    const n1Placement = placements.find((pl) => pl.nodeId === 'n1')!;
    const n2Placement = placements.find((pl) => pl.nodeId === 'n2')!;

    // seed live sessions on BOTH nodes keyed by each placement's OWN id — a
    // bug matching by channel slug (or always taking the channel's first
    // placement) would attribute one node's session to the other's placement
    seedNodeStatusEntry(h.cache, 'zone1', 'n1', [sessionStatus(n1Placement.id)]);
    seedNodeStatusEntry(h.cache, 'zone1', 'n2', [sessionStatus(n2Placement.id)]);

    const [listed] = await h.service.listChannels();
    const gotN1 = listed!.placements.find((pl) => pl.nodeId === 'n1')!;
    const gotN2 = listed!.placements.find((pl) => pl.nodeId === 'n2')!;
    expect(gotN1.session?.name).toBe(n1Placement.id);
    expect(gotN2.session?.name).toBe(n2Placement.id);
    await h.destroy();
  });
});

// ---------- failover state placements (cold-backup successor) ----------

describe('failover state placements', () => {
  async function seedColdChannel(h: Harness) {
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' }, // hot (default)
        { instanceId: 'zone1', nodeId: 'n2', mode: 'cold' },
      ],
    });
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    const hot = placements.find((x) => x.nodeId === 'n1')!;
    const cold = placements.find((x) => x.nodeId === 'n2')!;
    return { chan, hot, cold };
  }

  async function insertFailoverRow(
    h: Harness,
    fields: {
      channelId: string;
      fromPlacementId: string | null;
      toPlacementId: string;
      phase?: string;
      suppressFrom?: boolean;
      triggerReason?: string;
    },
  ): Promise<void> {
    await h.db
      .insertInto('restream_failover_state')
      .values({
        channel_id: fields.channelId,
        from_placement_id: fields.fromPlacementId,
        to_placement_id: fields.toPlacementId,
        phase: fields.phase ?? 'complete',
        trigger_reason: fields.triggerReason ?? 'manual',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: fields.suppressFrom ? 1 : 0,
        drain_until: null,
        started_at: TS,
        updated_at: TS,
      })
      .onDuplicateKeyUpdate({
        from_placement_id: fields.fromPlacementId,
        to_placement_id: fields.toPlacementId,
        phase: fields.phase ?? 'complete',
        trigger_reason: fields.triggerReason ?? 'manual',
        suppress_from: fields.suppressFrom ? 1 : 0,
        updated_at: TS,
      })
      .execute();
  }

  it('computeNodeDoc excludes an enabled cold placement with no failover row', async () => {
    const h = await setup();
    const { cold } = await seedColdChannel(h);
    expect(cold.mode).toBe('cold');
    const { doc } = await h.service.computeNodeDoc('zone1', 'n2');
    expect(doc!.sessions).toHaveLength(0);
    await h.destroy();
  });

  it('computeNodeDoc includes it once a row exists with to_placement_id = that placement, in ANY phase', async () => {
    const h = await setup();
    const { chan, hot, cold } = await seedColdChannel(h);
    for (const phase of ['bringing-up', 'awaiting-lag', 'switch-ordered', 'complete', 'draining']) {
      await h.db.deleteFrom('restream_failover_state').execute();
      await insertFailoverRow(h, { channelId: chan.id, fromPlacementId: hot.id, toPlacementId: cold.id, phase });
      const { doc } = await h.service.computeNodeDoc('zone1', 'n2');
      // n2 hosts the cold placement — its session is named after cold.id
      expect(doc!.sessions.map((s) => s.name), `phase=${phase}`).toEqual([cold.id]);
    }
    await h.destroy();
  });

  it('EXCLUDES the hot `from` placement once suppress_from=1 and phase is a suppressing one', async () => {
    const h = await setup();
    const { chan, hot, cold } = await seedColdChannel(h);
    for (const phase of ['stopping-old', 'awaiting-stop-confirm', 'complete', 'draining']) {
      await h.db.deleteFrom('restream_failover_state').execute();
      await insertFailoverRow(h, {
        channelId: chan.id,
        fromPlacementId: hot.id,
        toPlacementId: cold.id,
        phase,
        suppressFrom: true,
      });
      const { doc: hotDoc } = await h.service.computeNodeDoc('zone1', 'n1');
      expect(hotDoc!.sessions, `phase=${phase}`).toHaveLength(0);
      const { doc: coldDoc } = await h.service.computeNodeDoc('zone1', 'n2');
      expect(coldDoc!.sessions.map((s) => s.name), `phase=${phase}`).toEqual([cold.id]);
    }
    await h.destroy();
  });

  it('still includes the hot `from` placement while phase=awaiting-lag, even with suppress_from=1', async () => {
    const h = await setup();
    const { chan, hot, cold } = await seedColdChannel(h);
    await insertFailoverRow(h, {
      channelId: chan.id,
      fromPlacementId: hot.id,
      toPlacementId: cold.id,
      phase: 'awaiting-lag',
      suppressFrom: true,
    });
    const { doc: hotDoc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(hotDoc!.sessions.map((s) => s.name)).toEqual([hot.id]);
    await h.destroy();
  });

  it('listChannels surfaces placement.indicator/lagProbe and channel.failover shape', async () => {
    const h = await setup();
    const { chan, hot, cold } = await seedColdChannel(h);
    let [listed] = await h.service.listChannels();
    expect(listed!.failover).toBeNull();
    expect(listed!.failoverBlocked).toBeNull();
    const hotBefore = listed!.placements.find((x) => x.id === hot.id)!;
    expect(hotBefore.mode).toBe('hot');
    expect(hotBefore.indicator).toBe('idle');
    expect(hotBefore.lagProbe).toBeNull();
    const coldBefore = listed!.placements.find((x) => x.id === cold.id)!;
    expect(coldBefore.mode).toBe('cold');
    expect(coldBefore.indicator).toBe('idle');

    await insertFailoverRow(h, {
      channelId: chan.id,
      fromPlacementId: hot.id,
      toPlacementId: cold.id,
      phase: 'stopping-old',
      suppressFrom: true,
      triggerReason: 'lag',
    });
    [listed] = await h.service.listChannels();
    expect(listed!.failover).toMatchObject({
      fromPlacementId: hot.id,
      toPlacementId: cold.id,
      phase: 'stopping-old',
      triggerReason: 'lag',
    });
    expect(listed!.placements.find((x) => x.id === cold.id)!.indicator).toBe('active');
    expect(listed!.placements.find((x) => x.id === hot.id)!.indicator).toBe('stopping');
    await h.destroy();
  });

  it('addPlacement with mode:"cold" persists; updatePlacement({mode:"hot"}) flips it', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const cold = await h.service.addPlacement(chan.id, { instanceId: 'zone1', nodeId: 'n2', mode: 'cold' });
    expect(cold.mode).toBe('cold');

    const flipped = await h.service.updatePlacement(cold.id, { mode: 'hot' });
    expect(flipped.mode).toBe('hot');
    await h.destroy();
  });

  describe('mid-procedure mutation guard', () => {
    const MID = { statusCode: 409, message: expect.stringContaining('failover in progress') };

    it('deletePlacement 409s on a placement referenced by a mid-procedure row; force deletes', async () => {
      const h = await setup();
      const { chan, hot, cold } = await seedColdChannel(h);
      await insertFailoverRow(h, {
        channelId: chan.id,
        fromPlacementId: hot.id,
        toPlacementId: cold.id,
        phase: 'awaiting-lag',
      });
      await expect(h.service.deletePlacement(cold.id)).rejects.toMatchObject(MID);
      // the from side is protected too
      await expect(h.service.deletePlacement(hot.id)).rejects.toMatchObject(MID);

      await h.service.deletePlacement(cold.id, true);
      const gone = await h.db
        .selectFrom('restream_placements')
        .select('id')
        .where('id', '=', cold.id)
        .executeTakeFirst();
      expect(gone).toBeUndefined();
      await h.destroy();
    });

    it('updatePlacement 409s on a placement referenced by a mid-procedure row; force updates', async () => {
      const h = await setup();
      const { chan, hot, cold } = await seedColdChannel(h);
      await insertFailoverRow(h, {
        channelId: chan.id,
        fromPlacementId: hot.id,
        toPlacementId: cold.id,
        phase: 'switch-ordered',
      });
      await expect(h.service.updatePlacement(hot.id, { priority: 5 })).rejects.toMatchObject(MID);

      const forced = await h.service.updatePlacement(hot.id, { priority: 5, force: true });
      expect(forced.priority).toBe(5);
      await h.destroy();
    });

    it('complete and draining rows do NOT block update or delete', async () => {
      const h = await setup();
      const { chan, hot, cold } = await seedColdChannel(h);
      for (const phase of ['complete', 'draining']) {
        await insertFailoverRow(h, {
          channelId: chan.id,
          fromPlacementId: hot.id,
          toPlacementId: cold.id,
          phase,
        });
        const updated = await h.service.updatePlacement(cold.id, { priority: 9 });
        expect(updated.priority).toBe(9);
      }
      await h.service.deletePlacement(cold.id); // draining row: no 409
      await h.destroy();
    });

    it('applyChannelChanges 409s when a kept placement is mid-procedure; force applies', async () => {
      const h = await setup();
      const { chan, hot, cold } = await seedColdChannel(h);
      await insertFailoverRow(h, {
        channelId: chan.id,
        fromPlacementId: hot.id,
        toPlacementId: cold.id,
        phase: 'bringing-up',
      });
      const desired = [hot, cold].map((p) => ({
        id: p.id,
        instanceId: p.instanceId,
        nodeId: p.nodeId,
        mode: p.mode,
        profileId: null,
        programNumber: null,
        enabled: true,
      }));
      await expect(
        h.service.applyChannelChanges(chan.id, { placements: desired }),
      ).rejects.toMatchObject(MID);

      const applied = await h.service.applyChannelChanges(chan.id, {
        placements: desired,
        force: true,
      });
      expect(applied.placements).toHaveLength(2);
      await h.destroy();
    });

    it('applyChannelChanges delete-sweep silently skips a mid-procedure placement, even with force', async () => {
      const h = await setup();
      const { chan, hot, cold } = await seedColdChannel(h);
      // row references ONLY cold (first activation) — the kept hot is unguarded
      await insertFailoverRow(h, {
        channelId: chan.id,
        fromPlacementId: null,
        toPlacementId: cold.id,
        phase: 'awaiting-switch-confirm',
      });
      const keepHot = [
        {
          id: hot.id,
          instanceId: hot.instanceId,
          nodeId: hot.nodeId,
          mode: hot.mode,
          profileId: null,
          programNumber: null,
          enabled: true,
        },
      ];
      for (const force of [false, true]) {
        const applied = await h.service.applyChannelChanges(chan.id, {
          placements: keepHot,
          ...(force ? { force: true } : {}),
        });
        // cold was omitted from the desired set but survives the sweep
        expect(applied.placements.map((p) => p.id).sort()).toEqual([hot.id, cold.id].sort());
      }
      await h.destroy();
    });
  });
});

// ---------- cutover primitives (Stage B.2) ----------
//
// createCutoverClone/freezeOutgoingProfile/markCutoverCompleteInner/
// deleteCutoverPlacementInner are internal-only — Stage B.2 ships no trigger
// wiring (Stage B.3), so there is no public entry point yet. They're
// exercised directly here via a narrow structural cast, mirroring how
// FailoverSync's cutover branches already drive them through the
// FailoverSyncHooks wired in the constructor (markCutoverComplete/
// deleteCutoverPlacement — see failoverSync.test.ts's "cutover" describes for
// full state-machine coverage with mocked hooks). The drain-expiry test below
// additionally proves the REAL hook wiring end to end (no mocks).

interface CutoverPrimitives {
  createCutoverClone(
    from: {
      channel_id: string;
      instance_id: string;
      node_id: string;
      priority: number;
      program_number: number | null;
    },
    profileId: string | null,
  ): Promise<{
    id: string;
    channelId: string;
    instanceId: string;
    nodeId: string;
    profileId: string | null;
    mode: string;
    transient: boolean;
  }>;
  freezeOutgoingProfile(
    from: { id: string },
    freeze: { kind: 'pin'; profileId: string } | { kind: 'snapshot'; payload: AribHlsParams },
  ): Promise<void>;
  markCutoverCompleteInner(placementId: string): Promise<void>;
  deleteCutoverPlacementInner(placementId: string): Promise<void>;
}

function cutoverPrimitives(service: RestreamerService): CutoverPrimitives {
  return service as unknown as CutoverPrimitives;
}

describe('cutover primitives (Stage B.2)', () => {
  async function insertCutoverDrainingRow(
    h: Harness,
    fields: { channelId: string; fromPlacementId: string | null; toPlacementId: string; drainUntil: string },
  ): Promise<void> {
    await h.db
      .insertInto('restream_failover_state')
      .values({
        channel_id: fields.channelId,
        from_placement_id: fields.fromPlacementId,
        to_placement_id: fields.toPlacementId,
        phase: 'draining',
        trigger_reason: 'cutover',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: 1,
        drain_until: fields.drainUntil,
        started_at: TS,
        updated_at: TS,
      })
      .execute();
  }

  it('createCutoverClone inserts a same-node transient clone that bypasses the one-placement-per-node uniqueness gate', async () => {
    const h = await setup();
    const p1 = await h.service.createProfile('p1', profilePayload());
    const p2 = await h.service.createProfile('p2', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p1.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;
    const fromRow = await h.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', fromId)
      .executeTakeFirstOrThrow();

    const clone = await cutoverPrimitives(h.service).createCutoverClone(fromRow, p2.id);
    expect(clone).toMatchObject({
      channelId: chan.id,
      instanceId: 'zone1',
      nodeId: 'n1',
      profileId: p2.id,
      mode: 'hot',
      transient: true,
    });
    expect(clone.id).not.toBe(fromId);

    // both rows coexist on the same channel/instance/node -- no 409, no collision
    const placements = (await h.service.listChannels())[0]!.placements;
    expect(placements.map((pl) => pl.id).sort()).toEqual([fromId, clone.id].sort());
    expect(placements.find((pl) => pl.id === clone.id)!.transient).toBe(true);
    expect(placements.find((pl) => pl.id === fromId)!.transient).toBe(false);
    await h.destroy();
  });

  it('freezeOutgoingProfile "pin" keeps `from` rendering the pinned profile after the channel is reassigned to a different one', async () => {
    const h = await setup();
    const p1 = await h.service.createProfile('p1', profilePayload({ mode: 'ivtc', bitrate: '3M' }));
    const p2 = await h.service.createProfile('p2', profilePayload({ mode: 'ivtc', bitrate: '9M' }));
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p1.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await cutoverPrimitives(h.service).freezeOutgoingProfile({ id: fromId }, { kind: 'pin', profileId: p1.id });
    // reassign the channel to p2 -- without the pin this would instantly
    // change what `from` renders (placement-override-wins in computeNodeDoc)
    await h.db
      .updateTable('restream_channels')
      .set({ profile_id: p2.id, updated_at: TS })
      .where('id', '=', chan.id)
      .execute();

    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    const argv = (doc!.sessions[0]!.pipeline as RawArgvParams).ffmpegArgv;
    expect(argv[argv.indexOf('-b:v:0') + 1]).toBe('3M');
    await h.destroy();
  });

  it('freezeOutgoingProfile "snapshot" keeps `from` rendering the pre-edit payload after the live profile row is edited in place', async () => {
    const h = await setup();
    const p1 = await h.service.createProfile('p1', profilePayload({ mode: 'ivtc', bitrate: '3M' }));
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p1.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await cutoverPrimitives(h.service).freezeOutgoingProfile(
      { id: fromId },
      { kind: 'snapshot', payload: p1.payload },
    );
    // live-edit the SAME profile row in place, as updateProfile would
    await h.db
      .updateTable('restream_profiles')
      .set({ payload: JSON.stringify(profilePayload({ mode: 'ivtc', bitrate: '9M' })), updated_at: TS })
      .where('id', '=', p1.id)
      .execute();

    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    const argv = (doc!.sessions[0]!.pipeline as RawArgvParams).ffmpegArgv;
    expect(argv[argv.indexOf('-b:v:0') + 1]).toBe('3M');

    const placementRow = await h.db
      .selectFrom('restream_placements')
      .select('profile_id')
      .where('id', '=', fromId)
      .executeTakeFirstOrThrow();
    expect(placementRow.profile_id).not.toBe(p1.id);
    const snapshotRow = await h.db
      .selectFrom('restream_profiles')
      .select('transient')
      .where('id', '=', placementRow.profile_id!)
      .executeTakeFirstOrThrow();
    expect(snapshotRow.transient).toBe(1);
    await h.destroy();
  });

  it('listProfiles excludes a freeze-snapshot transient profile', async () => {
    const h = await setup();
    const p1 = await h.service.createProfile('p1', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p1.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;
    await cutoverPrimitives(h.service).freezeOutgoingProfile(
      { id: fromId },
      { kind: 'snapshot', payload: p1.payload },
    );

    const listed = await h.service.listProfiles();
    expect(listed.map((p) => p.id)).toEqual([p1.id]);
    await h.destroy();
  });

  it('markCutoverCompleteInner promotes a transient clone to permanent', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;
    const fromRow = await h.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', fromId)
      .executeTakeFirstOrThrow();
    const clone = await cutoverPrimitives(h.service).createCutoverClone(fromRow, p.id);
    expect((await h.service.listChannels()).find((c) => c.id === chan.id)!.placements.find((pl) => pl.id === clone.id)!.transient).toBe(true);

    // `from` and the clone share the exact (channel, instance, node) triple,
    // and the unique index is scoped over `transient` -- promoting the clone
    // while `from`'s transient=0 row still holds that triple would collide.
    // `from` must be removed first, mirroring the real call order enforced
    // by rowHygiene()'s draining-expiry branch (deleteCutoverPlacement then
    // markCutoverComplete).
    await cutoverPrimitives(h.service).deleteCutoverPlacementInner(fromId);
    await cutoverPrimitives(h.service).markCutoverCompleteInner(clone.id);

    const placements = (await h.service.listChannels())[0]!.placements;
    expect(placements.find((pl) => pl.id === clone.id)!.transient).toBe(false);
    await h.destroy();
  });

  it('deleteCutoverPlacementInner removes the placement and its orphaned transient snapshot profile', async () => {
    const h = await setup();
    const p1 = await h.service.createProfile('p1', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p1.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;
    await cutoverPrimitives(h.service).freezeOutgoingProfile(
      { id: fromId },
      { kind: 'snapshot', payload: p1.payload },
    );
    const snapshotId = (
      await h.db.selectFrom('restream_placements').select('profile_id').where('id', '=', fromId).executeTakeFirstOrThrow()
    ).profile_id!;

    await cutoverPrimitives(h.service).deleteCutoverPlacementInner(fromId);

    expect(
      await h.db.selectFrom('restream_placements').select('id').where('id', '=', fromId).executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await h.db.selectFrom('restream_profiles').select('id').where('id', '=', snapshotId).executeTakeFirst(),
    ).toBeUndefined();
    await h.destroy();
  });

  it('deleteCutoverPlacementInner leaves a non-transient (shared) profile untouched', async () => {
    const h = await setup();
    const p1 = await h.service.createProfile('p1', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p1.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;
    // pin -- from.profile_id now overrides to a real, non-transient profile
    await cutoverPrimitives(h.service).freezeOutgoingProfile({ id: fromId }, { kind: 'pin', profileId: p1.id });

    await cutoverPrimitives(h.service).deleteCutoverPlacementInner(fromId);

    expect(
      await h.db.selectFrom('restream_placements').select('id').where('id', '=', fromId).executeTakeFirst(),
    ).toBeUndefined();
    // p1 is shared (still the channel's own profile) and non-transient -- must survive
    expect(
      await h.db.selectFrom('restream_profiles').select('id').where('id', '=', p1.id).executeTakeFirst(),
    ).toMatchObject({ id: p1.id });
    await h.destroy();
  });

  it('deleteCutoverPlacementInner is idempotent on an already-deleted placement', async () => {
    const h = await setup();
    await expect(cutoverPrimitives(h.service).deleteCutoverPlacementInner(randomUUID())).resolves.toBeUndefined();
  });

  it('a real drain-expiry sweep (via the public failoverTick) calls the actual wired hooks: deleteCutoverPlacement removes the retired `from` placement, and markCutoverComplete promotes the clone to permanent', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });
    const placements = (await h.service.listChannels())[0]!.placements;
    const fromPlacement = placements[0]!;
    const toPlacement = placements[1]!;
    // mirrors a real cutover clone: transient=1 until promoted at drain-expiry
    await h.db.updateTable('restream_placements').set({ transient: 1 }).where('id', '=', toPlacement.id).execute();
    await insertCutoverDrainingRow(h, {
      channelId: chan.id,
      fromPlacementId: fromPlacement.id,
      toPlacementId: toPlacement.id,
      drainUntil: '2020-01-01 00:00:00', // already expired
    });

    await h.service.failoverTick();

    expect(
      await h.db
        .selectFrom('restream_failover_state')
        .select('channel_id')
        .where('channel_id', '=', chan.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    // the real hook wiring (not a mock) ran deleteCutoverPlacementInner on the retired `from`
    expect(
      await h.db.selectFrom('restream_placements').select('id').where('id', '=', fromPlacement.id).executeTakeFirst(),
    ).toBeUndefined();
    // ... and, only after that, ran markCutoverCompleteInner on `to`, promoting it to permanent
    expect(
      await h.db.selectFrom('restream_placements').select(['id', 'transient']).where('id', '=', toPlacement.id).executeTakeFirst(),
    ).toMatchObject({ id: toPlacement.id, transient: 0 });
    await h.destroy();
  });
});

// ---------- startup orphan sweep (leaked cutover clones) ----------
//
// Regression coverage for the live E2E bug's collateral damage: a crash
// between createCutoverClone and the requestFailover that would have created
// a restream_failover_state row -- or the activePlacementOf tie-break bug
// itself (see failoverSync.test.ts) mistaking a fresh clone for
// already-active and short-circuiting the request -- leaves a transient=1
// placement with NO referencing failover row. Nothing will ever drive or
// clean it up, and being enabled+hot it keeps encoding forever.
// reconcileFailoverOnStartup's sweep must reclaim exactly those orphans (plus
// any transient profile snapshot referenced by nothing), and leave every
// legitimately-referenced transient row alone.

describe('reconcileFailoverOnStartup: orphaned cutover artifact sweep', () => {
  async function insertFailoverRow(
    h: Harness,
    fields: { channelId: string; fromPlacementId: string | null; toPlacementId: string; phase?: string },
  ): Promise<void> {
    await h.db
      .insertInto('restream_failover_state')
      .values({
        channel_id: fields.channelId,
        from_placement_id: fields.fromPlacementId,
        to_placement_id: fields.toPlacementId,
        phase: fields.phase ?? 'awaiting-lag',
        trigger_reason: 'cutover',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: 0,
        drain_until: null,
        started_at: TS,
        updated_at: TS,
      })
      .execute();
  }

  async function insertTransientProfileRow(h: Harness, name: string): Promise<string> {
    const id = randomUUID();
    await h.db
      .insertInto('restream_profiles')
      .values({
        id,
        name,
        payload: JSON.stringify(profilePayload()),
        transient: 1,
        updated_at: TS,
      })
      .execute();
    return id;
  }

  it('deletes an orphaned transient clone and an orphaned transient profile snapshot, leaves a referenced clone and a still-used snapshot untouched', async () => {
    const h = await setup();
    const pReal = await h.service.createProfile('real', profilePayload());

    // -- channel A: leaked clone, no failover row referencing it ---------
    const chanA = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pReal.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromA = (await h.service.listChannels()).find((c) => c.id === chanA.id)!.placements[0]!.id;
    const fromARow = await h.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', fromA)
      .executeTakeFirstOrThrow();
    const orphanClone = await cutoverPrimitives(h.service).createCutoverClone(fromARow, pReal.id);
    // (deliberately no insertFailoverRow call -- this is the leak)

    // -- an unrelated orphaned transient profile snapshot, pinned by nothing
    const orphanProfileId = await insertTransientProfileRow(h, 'orphan-snapshot');

    // -- channel B: legitimate in-progress cutover -- clone IS referenced -
    const chanB = await h.service.createChannel({
      channelName: 'BS11',
      channelNumber: '11',
      profileId: pReal.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n2' }],
    });
    const fromB = (await h.service.listChannels()).find((c) => c.id === chanB.id)!.placements[0]!.id;
    const fromBRow = await h.db
      .selectFrom('restream_placements')
      .selectAll()
      .where('id', '=', fromB)
      .executeTakeFirstOrThrow();
    const liveClone = await cutoverPrimitives(h.service).createCutoverClone(fromBRow, pReal.id);
    await insertFailoverRow(h, { channelId: chanB.id, fromPlacementId: fromB, toPlacementId: liveClone.id });

    // -- channel C: a transient snapshot still referenced by a placement --
    const chanC = await h.service.createChannel({
      channelName: 'NHK',
      channelNumber: '1',
      profileId: pReal.id,
      placements: [{ instanceId: 'zone2', nodeId: 'n1' }],
    });
    const fromC = (await h.service.listChannels()).find((c) => c.id === chanC.id)!.placements[0]!.id;
    await cutoverPrimitives(h.service).freezeOutgoingProfile({ id: fromC }, { kind: 'snapshot', payload: pReal.payload as AribHlsParams });
    const stillUsedSnapshotId = (
      await h.db.selectFrom('restream_placements').select('profile_id').where('id', '=', fromC).executeTakeFirstOrThrow()
    ).profile_id!;

    h.logs.length = 0; // drop any setup-time push/log noise before the assertion

    await h.service.reconcileFailoverOnStartup();

    // orphaned clone: gone
    expect(
      await h.db.selectFrom('restream_placements').select('id').where('id', '=', orphanClone.id).executeTakeFirst(),
    ).toBeUndefined();
    // orphaned profile snapshot: gone
    expect(
      await h.db.selectFrom('restream_profiles').select('id').where('id', '=', orphanProfileId).executeTakeFirst(),
    ).toBeUndefined();

    // legitimately-referenced clone: untouched
    expect(
      await h.db.selectFrom('restream_placements').select('id').where('id', '=', liveClone.id).executeTakeFirst(),
    ).toMatchObject({ id: liveClone.id });
    // still-used transient snapshot profile: untouched
    expect(
      await h.db.selectFrom('restream_profiles').select('id').where('id', '=', stillUsedSnapshotId).executeTakeFirst(),
    ).toMatchObject({ id: stillUsedSnapshotId });

    // one warning per reclaimed artifact, matching the documented message shape
    const warnings = h.logs.filter((l) => l.type === 'warning' && l.service === 'restreamer' && l.source === 'controller');
    expect(warnings).toHaveLength(2);
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: `reclaimed orphaned cutover clone ${orphanClone.id} for channel "at-x" (leaked by an interrupted cutover)`,
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: `reclaimed orphaned cutover profile snapshot ${orphanProfileId} (leaked by an interrupted cutover)`,
      }),
    );

    await h.destroy();
  });

  it('is a no-op when there are no transient rows at all', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    h.logs.length = 0;
    await expect(h.service.reconcileFailoverOnStartup()).resolves.toBeUndefined();
    expect(h.logs.filter((l) => l.type === 'warning')).toHaveLength(0);
    await h.destroy();
  });
});

// ---------- profile-change cutover routing (Stage B.3) ----------
//
// The four interception sites (updateChannel's profileId flip = case A,
// updatePlacement's profile-override flip = case B, updateProfile's payload
// edit = case C, and applyChannelChanges' existing-placement UPDATE loop)
// all funnel through the private routeProfileChange -- exercised here only
// through the public surface, no structural cast needed.

describe('profile-change cutover routing (Stage B.3)', () => {
  it('case A: a channel-level profile flip pins an inheriting placement to the OLD profile and clones onto the NEW one', async () => {
    const h = await setup(); // default config has a switcher
    const pOld = await h.service.createProfile('old', profilePayload({ mode: 'ivtc', bitrate: '3M' }));
    const pNew = await h.service.createProfile('new', profilePayload({ mode: 'ivtc', bitrate: '9M' }));
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pOld.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }], // inherits (no override)
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.updateChannel(chan.id, { profileId: pNew.id });

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(2);
    const from = placements.find((p) => p.id === fromId)!;
    const clone = placements.find((p) => p.id !== fromId)!;
    expect(from.profileId).toBe(pOld.id); // pinned to OLD, not left inheriting
    expect(from.transient).toBe(false);
    expect(clone.profileId).toBe(pNew.id);
    expect(clone.transient).toBe(true);
    expect(clone.instanceId).toBe('zone1');
    expect(clone.nodeId).toBe('n1');

    // the channel row itself DID flip to the new profile
    const chanRow = await h.db
      .selectFrom('restream_channels')
      .select('profile_id')
      .where('id', '=', chan.id)
      .executeTakeFirstOrThrow();
    expect(chanRow.profile_id).toBe(pNew.id);

    // sanity check: the clone is already encoding on its very first push,
    // decoupled from FIFO activation -- no failoverTick() has run at all here
    const node = h.nodes.get('zone1/n1')!;
    expect(node.desired!.sessions).toHaveLength(2);
    await h.destroy();
  });

  it('case A: a per-placement override is untouched by a channel-level profile flip (it never inherited the default)', async () => {
    const h = await setup();
    const pOld = await h.service.createProfile('old', profilePayload());
    const pNew = await h.service.createProfile('new', profilePayload());
    const pOverride = await h.service.createProfile('override', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pOld.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', profileId: pOverride.id }],
    });
    const placementId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.updateChannel(chan.id, { profileId: pNew.id });

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(1); // no clone -- nothing eligible
    expect(placements[0]!.id).toBe(placementId);
    expect(placements[0]!.profileId).toBe(pOverride.id); // unaffected
    await h.destroy();
  });

  it('case B: a placement-level profile-override flip never writes `from` at all (freeze:none), and clones onto the new override', async () => {
    const h = await setup();
    const pChan = await h.service.createProfile('chan', profilePayload());
    const pOverrideOld = await h.service.createProfile('override-old', profilePayload());
    const pOverrideNew = await h.service.createProfile('override-new', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pChan.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', profileId: pOverrideOld.id }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.updatePlacement(fromId, { profileId: pOverrideNew.id });

    const fromAfter = await h.db
      .selectFrom('restream_placements')
      .select('profile_id')
      .where('id', '=', fromId)
      .executeTakeFirstOrThrow();
    expect(fromAfter.profile_id).toBe(pOverrideOld.id); // untouched

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(2);
    const clone = placements.find((p) => p.id !== fromId)!;
    expect(clone.profileId).toBe(pOverrideNew.id);
    expect(clone.transient).toBe(true);
    expect(clone.instanceId).toBe('zone1');
    expect(clone.nodeId).toBe('n1');
    await h.destroy();
  });

  it('case B: clearing a placement override (explicit null) is itself a routable profile change', async () => {
    const h = await setup();
    const pChan = await h.service.createProfile('chan', profilePayload());
    const pOverrideOld = await h.service.createProfile('override-old', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pChan.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', profileId: pOverrideOld.id }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.updatePlacement(fromId, { profileId: null });

    const fromAfter = await h.db
      .selectFrom('restream_placements')
      .select('profile_id')
      .where('id', '=', fromId)
      .executeTakeFirstOrThrow();
    expect(fromAfter.profile_id).toBe(pOverrideOld.id); // untouched, freeze:none
    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(2);
    const clone = placements.find((p) => p.id !== fromId)!;
    expect(clone.profileId).toBeNull(); // clone inherits the channel default
    expect(clone.transient).toBe(true);
    await h.destroy();
  });

  it('case C: a profile payload edit snapshots the OLD payload onto `from` before the live row updates, and the clone renders the NEW payload', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload({ mode: 'ivtc', bitrate: '3M' }));
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }], // inherits
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;
    const beforeDoc = (await h.service.computeNodeDoc('zone1', 'n1')).doc!;
    const beforeSession = beforeDoc.sessions.find((s) => s.name === fromId)!;

    await h.service.updateProfile(p.id, { payload: profilePayload({ mode: 'ivtc', bitrate: '9M' }) });

    const placements = (await h.service.listChannels())[0]!.placements;
    expect(placements).toHaveLength(2);
    const from = placements.find((pl) => pl.id === fromId)!;
    const clone = placements.find((pl) => pl.id !== fromId)!;
    expect(from.transient).toBe(false);
    expect(clone.transient).toBe(true);

    const afterDoc = (await h.service.computeNodeDoc('zone1', 'n1')).doc!;
    const fromSessionAfter = afterDoc.sessions.find((s) => s.name === fromId)!;
    const cloneSession = afterDoc.sessions.find((s) => s.name === clone.id)!;
    // `from`'s rendered pipeline is byte-unchanged
    expect(fromSessionAfter.pipeline).toEqual(beforeSession.pipeline);
    // the clone renders the NEW payload
    const cloneArgv = (cloneSession.pipeline as RawArgvParams).ffmpegArgv;
    expect(cloneArgv[cloneArgv.indexOf('-b:v:0') + 1]).toBe('9M');
    await h.destroy();
  });

  it('applyChannelChanges: an existing-placement UPDATE where profileId AND mode change together is a combined edit -- always goes direct, never cutover', async () => {
    const h = await setup();
    const pOld = await h.service.createProfile('old', profilePayload());
    const pNew = await h.service.createProfile('new', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pOld.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', profileId: pOld.id }],
    });
    const placementId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.applyChannelChanges(chan.id, {
      placements: [
        {
          id: placementId,
          instanceId: 'zone1',
          nodeId: 'n1',
          mode: 'cold',
          profileId: pNew.id,
          programNumber: null,
          enabled: true,
        },
      ],
    });

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(1); // no clone
    expect(placements[0]!.id).toBe(placementId);
    expect(placements[0]!.profileId).toBe(pNew.id); // direct write
    expect(placements[0]!.mode).toBe('cold');
    await h.destroy();
  });

  it('applyChannelChanges: a pure profile flip on one placement cutovers while a combined edit on another placement in the SAME call goes direct -- no cross-contamination', async () => {
    const h = await setup();
    const pOld = await h.service.createProfile('old', profilePayload());
    const pNew = await h.service.createProfile('new', profilePayload());
    const pOther = await h.service.createProfile('other', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pOld.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1', profileId: pOld.id }, // cutover candidate
        { instanceId: 'zone1', nodeId: 'n2', profileId: pOld.id }, // combined-edit candidate
      ],
    });
    const rows = (await h.service.listChannels())[0]!.placements;
    const cutoverFromId = rows.find((p) => p.nodeId === 'n1')!.id;
    const directId = rows.find((p) => p.nodeId === 'n2')!.id;

    await h.service.applyChannelChanges(chan.id, {
      placements: [
        {
          id: cutoverFromId,
          instanceId: 'zone1',
          nodeId: 'n1',
          mode: 'hot',
          profileId: pNew.id,
          programNumber: null,
          enabled: true,
        },
        {
          id: directId,
          instanceId: 'zone1',
          nodeId: 'n2',
          mode: 'cold', // + profileId change = combined edit, direct
          profileId: pOther.id,
          programNumber: null,
          enabled: true,
        },
      ],
    });

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(3); // cutoverFrom (frozen) + clone + direct
    const cutoverFrom = placements.find((p) => p.id === cutoverFromId)!;
    const clone = placements.find((p) => p.nodeId === 'n1' && p.id !== cutoverFromId)!;
    const direct = placements.find((p) => p.id === directId)!;

    expect(cutoverFrom.profileId).toBe(pOld.id); // untouched (freeze:'none') -- never wrote the new value
    expect(clone.profileId).toBe(pNew.id);
    expect(clone.transient).toBe(true);
    expect(direct.profileId).toBe(pOther.id); // direct write applied
    expect(direct.mode).toBe('cold');
    await h.destroy();
  });

  it('no switcher configured: profile-change routing degrades entirely to direct writes (no cutover clone ever created)', async () => {
    const h = await setup({ restreamer: { switchers: [] } });
    const pOld = await h.service.createProfile('old', profilePayload());
    const pNew = await h.service.createProfile('new', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pOld.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.updateChannel(chan.id, { profileId: pNew.id });

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(1); // no clone
    expect(placements[0]!.id).toBe(fromId);
    expect(placements[0]!.profileId).toBeNull(); // still inheriting -- channel row flipped directly
    const chanRow = await h.db
      .selectFrom('restream_channels')
      .select('profile_id')
      .where('id', '=', chan.id)
      .executeTakeFirstOrThrow();
    expect(chanRow.profile_id).toBe(pNew.id);
    await h.destroy();
  });

  it('an ineligible `from` (cold mode) never cutovers even with a switcher configured -- profile-only changes apply directly', async () => {
    const h = await setup();
    const pOld = await h.service.createProfile('old', profilePayload());
    const pNew = await h.service.createProfile('new', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pOld.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', mode: 'cold' }],
    });
    const fromId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.updateChannel(chan.id, { profileId: pNew.id });

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(1);
    expect(placements[0]!.id).toBe(fromId);
    await h.destroy();
  });

  it('a channel already mid-procedure falls back to direct + logs a warning event, instead of layering a second cutover on top', async () => {
    const h = await setup();
    const pOld = await h.service.createProfile('old', profilePayload());
    const pNew = await h.service.createProfile('new', profilePayload());
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: pOld.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });
    const rows = (await h.service.listChannels())[0]!.placements;
    const fromId = rows[0]!.id;
    const toId = rows[1]!.id;
    // a real in-flight (non-cutover) failover row, e.g. lag-triggered
    await h.db
      .insertInto('restream_failover_state')
      .values({
        channel_id: chan.id,
        from_placement_id: fromId,
        to_placement_id: toId,
        phase: 'bringing-up',
        trigger_reason: 'lag',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: 0,
        drain_until: null,
        started_at: TS,
        updated_at: TS,
      })
      .execute();

    await h.service.updateChannel(chan.id, { profileId: pNew.id });

    const placements = (await h.service.listChannels()).find((c) => c.id === chan.id)!.placements;
    expect(placements).toHaveLength(2); // no clone added
    expect(placements.find((p) => p.id === fromId)!.profileId).toBeNull(); // direct: still inherits (now the new channel default)
    const chanRow = await h.db
      .selectFrom('restream_channels')
      .select('profile_id')
      .where('id', '=', chan.id)
      .executeTakeFirstOrThrow();
    expect(chanRow.profile_id).toBe(pNew.id);

    expect(h.logs).toContainEqual(
      expect.objectContaining({ type: 'warning', service: 'restreamer', source: `channel.${chan.slug}` }),
    );
    await h.destroy();
  });
});

// ---------- poller hooks ----------

describe('poller hooks', () => {
  it('getExpectedRevision is the stored pushed hash (== the doc revision), null before any push', async () => {
    const h = await setup();
    expect(await h.service.getExpectedRevision('zone1', 'n1')).toBeNull();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(await h.service.getExpectedRevision('zone1', 'n1')).toBe(node.desired!.revision);
    await h.destroy();
  });

  it('onRevisionMismatch force-pushes even when the hash matches (node lost its state file)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    expect(node.puts()).toHaveLength(1);
    const placementId = node.desired!.sessions[0]!.name;
    node.desired = null; // simulate state-file loss

    const hooks = h.service.pollerHooks();
    hooks.onRevisionMismatch!('zone1', 'n1', null);
    // the forced push runs through the serialized op chain — join it
    await h.service.pushAll();
    expect(node.puts().length).toBeGreaterThanOrEqual(2);
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([placementId]);
    await h.destroy();
  });

  it('getPendingPush is false while topology is unknown (no false badge at startup)', async () => {
    const h = await setup();
    h.cache.get('zone1').topology = null;
    expect(await h.service.getPendingPush('zone1', 'n1')).toBe(false);
    await h.destroy();
  });

  it('enrichSessions resolves channelSlug for a known placement and null for an unknown session name', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const placementId = (await h.service.listChannels())[0]!.placements[0]!.id;

    const hooks = h.service.pollerHooks();
    const enriched = await hooks.enrichSessions!('zone1', 'n1', [
      sessionStatus(placementId),
      sessionStatus('orphan-uuid'),
    ]);
    expect(enriched.find((s) => s.name === placementId)?.channelSlug).toBe('at-x');
    expect(enriched.find((s) => s.name === 'orphan-uuid')?.channelSlug).toBeNull();
    await h.destroy();
  });
});

// ---------- probe engine wiring (delivery-path URL construction) ----------

describe('probe engine wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('liveness/underspeed/lag probes fetch URLs built from the placement id, not the channel slug', async () => {
    // ProbeEngine's fetchImpl defaults to the global `fetch` captured AT
    // CONSTRUCTION TIME (a plain default-parameter value, not a live lookup),
    // so the stub must be installed before setup() constructs the service —
    // stubbing afterward would silently leave the engine on the real fetch.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response('', { status: 500 }); // every probe fails gracefully, we only care about the URL
      }),
    );

    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }], // n1 has a serveUrl
    });
    const placementId = (await h.service.listChannels())[0]!.placements[0]!.id;

    await h.service.probeEngine.tick();

    expect(calls.length).toBeGreaterThan(0);
    for (const url of calls) {
      expect(url).toContain(`/${placementId}/playlist.m3u8`);
      expect(url).not.toContain('/at-x/');
    }
    await h.destroy();
  });
});

// ---------- topology-changed debounce ----------

describe('onTopologyChanged', () => {
  it('debounces 2s and then pushes the instance’s nodes', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const node = h.nodes.get('zone1/n1')!;
    node.unreachable = true;
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    node.unreachable = false;
    const putsBefore = node.puts().length;
    const placementId = (await h.service.listChannels()).find((c) => c.id === chan.id)!
      .placements[0]!.id;

    vi.useFakeTimers();
    h.service.onTopologyChanged('zone1');
    h.service.onTopologyChanged('zone1'); // coalesced
    await vi.advanceTimersByTimeAsync(1900);
    expect(node.puts().length).toBe(putsBefore);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();
    await h.service.pushAll(); // join the op chain
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([placementId]);
    h.service.stopSweep();
    await h.destroy();
  });
});

// ---------- catalog resolution (tvh-miss fallback) ----------

const CAM: SourceCatalogEntry = { id: 'cam1', name: 'Cam 1', url: 'http://cam.example/1.m3u8', chno: '1' };

describe('catalog resolution (tvh-miss fallback)', () => {
  it('a placement programNumber override is emitted for a catalog-resolved source', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    await h.service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', programNumber: 210 }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.tsreadex).toEqual({ programNumber: 210 });
    await h.destroy();
  });

  it('a pinned catalog chno matches exactly — never a different chno for the same name', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const relay1: SourceCatalogEntry = {
      id: 'relay-1',
      name: 'Relay',
      url: 'http://relay.example/1.m3u8',
      chno: '20.1',
    };
    const relay10: SourceCatalogEntry = {
      id: 'relay-10',
      name: 'Relay',
      url: 'http://relay.example/10.m3u8',
      chno: '20.10',
    };
    setNodeSources(h.cache, 'zone1', 'n1', [relay1, relay10], 'h1');
    await h.service.createChannel({
      channelName: 'Relay',
      channelNumber: '20.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.source).toEqual({ url: 'http://relay.example/1.m3u8' });
    await h.destroy();
  });

  it('an unpinned name resolves the LOWEST chno among same-name catalog entries', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const relayHi: SourceCatalogEntry = {
      id: 'relay-hi',
      name: 'Relay',
      url: 'http://relay.example/hi.m3u8',
      chno: '20.2',
    };
    const relayLo: SourceCatalogEntry = {
      id: 'relay-lo',
      name: 'Relay',
      url: 'http://relay.example/lo.m3u8',
      chno: '20.1',
    };
    // listed hi-before-lo on purpose — lowest wins by VALUE, not catalog order
    setNodeSources(h.cache, 'zone1', 'n1', [relayHi, relayLo], 'h1');
    const chan = await h.service.createChannel({
      channelName: 'Relay',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    expect(chan.channelNumber).toBe('20.1'); // write-time pin-lowest across the catalog
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.source).toEqual({ url: 'http://relay.example/lo.m3u8' });
    await h.destroy();
  });

  it('tvh takes priority over a same-identity catalog entry on the same zone', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    const shadow: SourceCatalogEntry = {
      id: 'shadow',
      name: 'AT-X',
      url: 'http://shadow.example/atx.m3u8',
      chno: '9.1',
    };
    setNodeSources(h.cache, 'zone1', 'n1', [shadow], 'h1');
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const [listed] = await h.service.listChannels();
    expect(listed!.placements[0]!.resolvedVia).toBe('tvh');
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-atx-91' });
    await h.destroy();
  });

  it('a cross-source channel resolves via tvh on one zone and via catalog on another', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // zone2's tvh only has AT-X "9.10" (not "9.1") — its node catalog fills the gap
    const relayAtx: SourceCatalogEntry = {
      id: 'atx-relay',
      name: 'AT-X',
      url: 'http://relay.example/atx.m3u8',
      chno: '9.1',
    };
    setNodeSources(h.cache, 'zone2', 'n1', [relayAtx], 'h1');
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
    });
    const zone1Doc = await h.service.computeNodeDoc('zone1', 'n1');
    const zone2Doc = await h.service.computeNodeDoc('zone2', 'n1');
    expect(zone1Doc.blocked).toEqual([]);
    expect(zone2Doc.blocked).toEqual([]);
    expect(zone1Doc.doc!.sessions[0]!.source).toMatchObject({ channelUuid: 'ch-atx-91' });
    expect(zone2Doc.doc!.sessions[0]!.source).toEqual({ url: 'http://relay.example/atx.m3u8' });

    const [listed] = await h.service.listChannels();
    const zone1Placement = listed!.placements.find((x) => x.instanceId === 'zone1')!;
    const zone2Placement = listed!.placements.find((x) => x.instanceId === 'zone2')!;
    expect(zone1Placement.resolvedVia).toBe('tvh');
    expect(zone2Placement.resolvedVia).toBe('catalog');
    await h.destroy();
  });

  it('write-time pin-lowest considers BOTH topology and node catalogs (union)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // zone1 tvh has Dup 5.1/5.2; the SAME node's catalog additionally
    // advertises a lower Dup "4.5" — the pin must consider the catalog too
    const dupRelay: SourceCatalogEntry = {
      id: 'dup-relay',
      name: 'Dup',
      url: 'http://relay.example/dup.m3u8',
      chno: '4.5',
    };
    setNodeSources(h.cache, 'zone1', 'n1', [dupRelay], 'h1');
    const chan = await h.service.createChannel({
      channelName: 'Dup',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    expect(chan.channelNumber).toBe('4.5'); // catalog's 4.5 beats tvh's 5.1
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.source).toEqual({ url: 'http://relay.example/dup.m3u8' });
    await h.destroy();
  });

  it('a name+number matching neither tvh nor a KNOWN catalog blocks with the combined reason', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    await h.service.createChannel({
      channelName: 'Cam 9',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true, // the compute-time blockedReason is under test
    });
    const computed = await h.service.computeNodeDoc('zone1', 'n1');
    expect(computed.doc!.sessions).toHaveLength(0);
    expect(computed.blocked[0]!.reason).toBe(
      'channel "Cam 9" not found on instance zone1 nor in node zone1/n1\'s sources catalog',
    );
    await h.destroy();
  });

  it('a known-empty catalog blocks with the same combined reason', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [], null); // known: no catalog configured / empty
    await h.service.createChannel({
      channelName: 'Cam 1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true,
    });
    const computed = await h.service.computeNodeDoc('zone1', 'n1');
    expect(computed.blocked[0]!.reason).toBe(
      'channel "Cam 1" not found on instance zone1 nor in node zone1/n1\'s sources catalog',
    );
    await h.destroy();
  });

  it('an unfetched catalog blocks with "not loaded" — and the write is allowed (unknown)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // no node status at all: availability is unknown → create passes WITHOUT force
    await h.service.createChannel({
      channelName: 'Cam 1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const [listed] = await h.service.listChannels();
    expect(listed!.placements[0]!.blockedReason).toBe(
      'channel "Cam 1" not found on instance zone1; node zone1/n1\'s sources catalog not loaded',
    );
    expect(listed!.placements[0]!.resolvedVia).toBeNull();
    await h.destroy();
  });

  it('an entry removed from the catalog while pushed DEFERS the node push', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    await h.service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const node = h.nodes.get('zone1/n1')!;
    const placementId = node.desired!.sessions[0]!.name;
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([placementId]);
    const putsBefore = node.puts().length;

    // the entry disappears (rename in sources.m3u) — catalog-flap analog of
    // the topology flap: never tear down a running stream on a full replace
    setNodeSources(h.cache, 'zone1', 'n1', [], 'h2');
    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('deferred');
    expect(result.blocked[0]!.reason).toBe(
      'channel "Cam 1" (#1) not found on instance zone1 nor in node zone1/n1\'s sources catalog',
    );
    expect(node.puts().length).toBe(putsBefore);
    expect(node.desired!.sessions.map((s) => s.name)).toEqual([placementId]);
    await h.destroy();
  });

  it('a catalog appearing later resolves the placement; onSourcesChanged re-pushes debounced', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    // catalog unknown at write time → allowed, blocked at compute time
    const chan = await h.service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const placementId = (await h.service.listChannels()).find((c) => c.id === chan.id)!
      .placements[0]!.id;
    const node = h.nodes.get('zone1/n1')!;
    expect(node.puts()).toHaveLength(0); // never-pushed node, blocked session stays out

    // the poller fetched the catalog (cache write) and fired the hook
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    vi.useFakeTimers();
    h.service.onSourcesChanged('zone1', 'n1');
    h.service.onSourcesChanged('zone1', 'n1'); // coalesced
    await vi.advanceTimersByTimeAsync(1900);
    expect(node.puts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    vi.useRealTimers();

    // the debounced push already happened: a manual push is a hash-skip
    const result = await h.service.pushNode('zone1', 'n1');
    expect(result.action).toBe('skipped');
    expect(node.puts()).toHaveLength(1);
    expect(node.desired!.sessions[0]).toMatchObject({
      name: placementId,
      source: { url: 'http://cam.example/1.m3u8' },
      tsreadex: {},
    });
    h.service.stopSweep();
    await h.destroy();
  });
});

// ---------- write-time availability ----------

describe('write-time availability', () => {
  it('create 409s listing exactly the failing node; nothing is written', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone2', 'n1', [], 'known-empty'); // no catalog fallback either
    await expect(
      h.service.createChannel({
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: p.id,
        placements: [
          { instanceId: 'zone1', nodeId: 'n1' }, // resolves
          { instanceId: 'zone2', nodeId: 'n1' }, // zone2 has no AT-X 9.1
        ],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('— pass force to create anyway'),
      unavailable: [
        {
          instanceId: 'zone2',
          nodeId: 'n1',
          reason: 'channel "AT-X" (#9.1) not found on instance zone2 nor in node zone2/n1\'s sources catalog',
        },
      ],
    });
    expect(await h.service.listChannels()).toHaveLength(0);
    const node = h.nodes.get('zone1/n1')!;
    expect(node.puts()).toHaveLength(0);
    await h.destroy();
  });

  it('unloaded topology means unknown — the write is allowed', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    h.cache.get('zone2').topology = null;
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone2', nodeId: 'n1' }],
    });
    expect(chan.id).toBeTruthy();
    await h.destroy();
  });

  it('unloaded topology + a KNOWN catalog hit is "ok" — the write is allowed without force (external-only zone)', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    h.cache.get('zone2').topology = null;
    setNodeSources(h.cache, 'zone2', 'n1', [CAM], 'h1');
    const chan = await h.service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: p.id,
      placements: [{ instanceId: 'zone2', nodeId: 'n1' }], // NOT forced — availability must be 'ok'
    });
    expect(chan.id).toBeTruthy();
    const [listed] = await h.service.listChannels();
    expect(listed!.placements[0]!.resolvedVia).toBe('catalog');
    expect(listed!.placements[0]!.blockedReason).toBeNull();
    await h.destroy();
  });

  it('force creates the row anyway (pre-provisioning) — blocked at compute time', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone2', 'n1', [], 'known-empty'); // no catalog fallback either
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone2', nodeId: 'n1' }],
      force: true,
    });
    expect(chan.id).toBeTruthy();
    const [listed] = await h.service.listChannels();
    expect(listed!.placements[0]!.blockedReason).toBe(
      'channel "AT-X" (#9.1) not found on instance zone2 nor in node zone2/n1\'s sources catalog',
    );
    await h.destroy();
  });

  it('an identity patch re-validates ALL existing placements; non-identity patches never check', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [], 'known-empty'); // no catalog fallback either
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    await expect(
      h.service.updateChannel(chan.id, { channelName: 'Ghost' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('— pass force to update anyway'),
      unavailable: [
        {
          instanceId: 'zone1',
          nodeId: 'n1',
          reason: 'channel "Ghost" not found on instance zone1 nor in node zone1/n1\'s sources catalog',
        },
      ],
    });
    expect((await h.service.getChannel(chan.id))!.channelName).toBe('AT-X');

    // a channel that is ALREADY unavailable still accepts non-identity patches
    const ghost = await h.service.createChannel({
      channelName: 'Ghost',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n2' }],
      force: true,
    });
    const patched = await h.service.updateChannel(ghost.id, { comment: 'still fine' });
    expect(patched.comment).toBe('still fine');
    // …and a no-op identity patch (same values) does not check either
    const samePatch = await h.service.updateChannel(ghost.id, { enabled: true });
    expect(samePatch.id).toBe(ghost.id);
    await h.destroy();
  });

  it('addPlacement to a zone lacking the channel 409s; force bypasses', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone2', 'n1', [], 'known-empty'); // no catalog fallback either
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    await expect(
      h.service.addPlacement(chan.id, { instanceId: 'zone2', nodeId: 'n1' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('— pass force to add anyway'),
      unavailable: [{ instanceId: 'zone2', nodeId: 'n1', reason: expect.any(String) }],
    });
    const forced = await h.service.addPlacement(chan.id, {
      instanceId: 'zone2',
      nodeId: 'n1',
      force: true,
    });
    expect(forced.id).toBeTruthy();
    await h.destroy();
  });

  it('moving a placement re-checks availability on the TARGET node; force bypasses', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone2', 'n1', [], 'known-empty'); // no catalog fallback either
    await h.service.createChannel({
      channelName: 'BS11',
      channelNumber: '11',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const placement = (await h.service.listChannels())[0]!.placements[0]!;
    await expect(
      h.service.updatePlacement(placement.id, { instanceId: 'zone2' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('— pass force to move anyway'),
      unavailable: [
        {
          instanceId: 'zone2',
          nodeId: 'n1',
          reason:
            'channel "BS11" (#11) not found on instance zone2 nor in node zone2/n1\'s sources catalog',
        },
      ],
    });
    const moved = await h.service.updatePlacement(placement.id, {
      instanceId: 'zone2',
      force: true,
    });
    expect(moved.instanceId).toBe('zone2');
    await h.destroy();
  });

  it('a channel resolving via neither tvh nor a KNOWN catalog 409s; an UNKNOWN catalog is allowed', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [CAM], 'h1');
    await expect(
      h.service.createChannel({
        channelName: 'Nope',
        profileId: p.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      unavailable: [
        {
          instanceId: 'zone1',
          nodeId: 'n1',
          reason: 'channel "Nope" not found on instance zone1 nor in node zone1/n1\'s sources catalog',
        },
      ],
    });

    // zone2/n1 has no polled status at all → catalog unknown → allowed
    const chan = await h.service.createChannel({
      channelName: 'Nope',
      profileId: p.id,
      placements: [{ instanceId: 'zone2', nodeId: 'n1' }],
    });
    expect(chan.id).toBeTruthy();
    await h.destroy();
  });

  it('a SID-underivable tvh channel 409s without an override; a placement programNumber allows it', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await expect(
      h.service.createChannel({
        channelName: 'NHK',
        channelNumber: '1',
        profileId: p.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      unavailable: [
        {
          instanceId: 'zone1',
          nodeId: 'n1',
          reason: expect.stringContaining('cannot derive program number'),
        },
      ],
    });
    const chan = await h.service.createChannel({
      channelName: 'NHK',
      channelNumber: '1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1', programNumber: 1024 }],
    });
    expect(chan.id).toBeTruthy();
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    expect(doc!.sessions[0]!.tsreadex).toEqual({ programNumber: 1024 });
    await h.destroy();
  });

  it('batch edit forwards force through the patch', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    setNodeSources(h.cache, 'zone1', 'n1', [], 'known-empty'); // no catalog fallback either
    const chan = await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const denied = await h.service.batchChannels('edit', [chan.id], {
      patch: { channelName: 'Ghost' },
    });
    expect(denied[0]!.ok).toBe(false);
    expect(denied[0]!.error).toContain('pass force');

    const forced = await h.service.batchChannels('edit', [chan.id], {
      patch: { channelName: 'Ghost', force: true },
    });
    expect(forced[0]!.ok).toBe(true);
    expect((await h.service.getChannel(chan.id))!.channelName).toBe('Ghost');
    await h.destroy();
  });
});

// ---------------------------------------------------------------------------
// tvh-less instances (config url: null) — first-class, not a degraded tvh zone
// ---------------------------------------------------------------------------

describe('tvh-less instance (url: null)', () => {
  it('a zone with url: null, NO poller and a catalog-fed node computes and pushes docs', async () => {
    const { db, destroy } = await createTestDb();
    const cache = new InstanceCache();
    const bus = new EventBus();
    // exactly how main.ts wires a tvh-less zone: snapshot seeded with url null,
    // no InstancePoller constructed, restreamer node client as usual
    const config = makeConfig({
      instances: [
        {
          id: 'ext1',
          name: 'ext1',
          url: null,
          restreamer: {
            nodes: [{ id: 'n1', url: 'http://ext1-n1:5580', serveUrl: 'http://hls.ext1-n1' }],
          },
        },
      ],
    });
    cache.init('ext1', 'ext1', null);
    expect(cache.get('ext1').summary.hasTvh).toBe(false);
    const pollers = new Map<string, InstancePoller>(); // deliberately EMPTY
    const fake = fakeRestreamerNode();
    const clients = new Map<string, RestreamerNodeClient>([[nodeKey('ext1', 'n1'), fake]]);
    const service = new RestreamerService(db, cache, pollers, bus, config, clients);

    setNodeSources(cache, 'ext1', 'n1', [CAM], 'h1');
    const pf = await service.createProfile('p', profilePayload());
    await service.createChannel({
      channelName: 'Cam 1',
      channelNumber: '1',
      profileId: pf.id,
      placements: [{ instanceId: 'ext1', nodeId: 'n1' }],
    });

    const computed = await service.computeNodeDoc('ext1', 'n1');
    expect(computed.deferred).toBe(false);
    expect(computed.blocked).toEqual([]);
    expect(computed.doc!.sessions[0]!.source).toEqual({ url: 'http://cam.example/1.m3u8' });

    const result = await service.pushNode('ext1', 'n1', true);
    expect(result.action).toBe('pushed');
    expect(fake.desired!.sessions[0]!.source).toEqual({ url: 'http://cam.example/1.m3u8' });
    await destroy();
  });
});

// ---------- event-log emission: node push failed/healed (site #7) ----------

describe('RestreamerService: node push failed/healed event-log emission (site #7)', () => {
  it('logs a warning on the first push failure, nothing on a repeated failure, and a normal once it recovers', async () => {
    const h = await setup();
    // this harness's config carries a switcher ('sw1') with no client wired up
    // (site #11 territory) — filter this test's assertions down to node.zone1.n1
    // logs so the two sites' coverage stay independent
    const nodeLogs = () => h.logs.filter((l) => l.source === 'node.zone1.n1');
    // updateNodeStatus() (and therefore the cached-error read the site #7
    // transition guard relies on) is a no-op until the node has a cached
    // status entry — normally seeded by main.ts before any poller runs
    seedNodeStatusEntry(h.cache, 'zone1', 'n1');

    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    // the createChannel push above succeeded — no failure yet, no log
    expect(nodeLogs()).toHaveLength(0);

    const node = h.nodes.get('zone1/n1')!;
    node.failNextPut(new Error('putDesired: connection refused'));
    const failed = await h.service.pushNode('zone1', 'n1', true);
    expect(failed.action).toBe('error');
    expect(nodeLogs()).toHaveLength(1);
    expect(nodeLogs()[0]).toMatchObject({ type: 'warning', service: 'restreamer', source: 'node.zone1.n1' });
    expect(nodeLogs()[0]!.message).toContain('connection refused');

    // the 60s sweep (pushAll) hitting the SAME still-down node must not spam
    node.unreachable = true;
    const stillFailing = await h.service.pushNode('zone1', 'n1', true);
    expect(stillFailing.action).toBe('error');
    expect(nodeLogs()).toHaveLength(1);

    // the exact spam bug being fixed: the RestreamerPoller runs concurrently
    // and overwrites cache.restreamers[].error every tick with its OWN
    // reachability result, independent of push outcomes — simulate it
    // resetting the cached error back to null while the push is still broken
    h.cache.get('zone1').restreamers = h.cache.get('zone1').restreamers.map((r) =>
      r.nodeId === 'n1' ? { ...r, error: null } : r,
    );
    node.unreachable = true;
    const stillFailingAfterPollerReset = await h.service.pushNode('zone1', 'n1', true);
    expect(stillFailingAfterPollerReset.action).toBe('error');
    // must NOT re-log: the transition guard reads the dedicated pushProblems
    // map, not the poller-owned cache field the code above just reset
    expect(nodeLogs()).toHaveLength(1);

    node.unreachable = false;
    const healed = await h.service.pushNode('zone1', 'n1', true);
    expect(healed.action).toBe('pushed');
    expect(nodeLogs()).toHaveLength(2);
    expect(nodeLogs()[1]).toMatchObject({ type: 'normal', service: 'restreamer', source: 'node.zone1.n1' });
    // the successful push also clears the stale error on the cached status
    expect(h.cache.get('zone1').restreamers.find((r) => r.nodeId === 'n1')!.error).toBeNull();

    await h.destroy();
  });
});

// ---------- raw-argv rendering ----------

/**
 * Profiles/placements stay semantic ('arib-hls') in the DB and UI throughout.
 * Every node now speaks only the wire's 'raw-argv' template — there is no
 * per-node capability gating any more, so computeNodeDoc unconditionally
 * pre-renders the stored semantic profile into a 'raw-argv' doc.
 */
describe('raw-argv rendering', () => {
  it('computeNodeDoc always pre-renders the stored profile into a raw-argv doc matching buildRawArgvParams', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    const pipeline = doc!.sessions[0]!.pipeline as RawArgvParams;
    expect(pipeline.template).toBe('raw-argv');
    expect(pipeline.templateVersion).toBe(1);
    expect(pipeline.segmentSeconds).toBe(5);
    expect(pipeline.listSize).toBe(120);
    expect(pipeline.ffmpegArgv.some((a) => a.includes('{OUT_DIR}'))).toBe(true);

    const expected = buildRawArgvParams(p.payload as AribHlsParams);
    expect(pipeline.ffmpegArgv).toEqual(expected.ffmpegArgv);
    await h.destroy();
  });

  it('doc revision for a raw-argv-rendered node is deterministic across repeated computes', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const a = await h.service.computeNodeDoc('zone1', 'n1');
    const b = await h.service.computeNodeDoc('zone1', 'n1');
    expect(a.doc!.revision).toBe(b.doc!.revision);
    expect(a.doc!.revision).toBe(sessionsHash(a.doc!.sessions));
    await h.destroy();
  });

  it('every node in a fleet gets rendered raw-argv, and both push cleanly', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload());
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone1', nodeId: 'n2' },
      ],
    });
    const n1 = h.nodes.get('zone1/n1')!;
    const n2 = h.nodes.get('zone1/n2')!;
    expect(n1.desired!.sessions[0]!.pipeline).toMatchObject({ template: 'raw-argv' });
    expect(n2.desired!.sessions[0]!.pipeline).toMatchObject({ template: 'raw-argv' });

    const pushed1 = await h.service.pushNode('zone1', 'n1', true);
    const pushed2 = await h.service.pushNode('zone1', 'n2', true);
    expect(pushed1.action).toBe('pushed');
    expect(pushed2.action).toBe('pushed');
    await h.destroy();
  });

  it('a yadif-mode profile renders the yadif_opencl OpenCL sandwich into the pushed doc', async () => {
    const h = await setup();
    const p = await h.service.createProfile('p', profilePayload({ mode: 'yadif' }));
    await h.service.createChannel({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: p.id,
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const { doc } = await h.service.computeNodeDoc('zone1', 'n1');
    const pipeline = doc!.sessions[0]!.pipeline as RawArgvParams;
    expect(pipeline.template).toBe('raw-argv');
    const filterComplex = pipeline.ffmpegArgv[pipeline.ffmpegArgv.indexOf('-filter_complex') + 1];
    expect(filterComplex).toContain(
      'hwmap=derive_device=opencl,yadif_opencl,hwmap=derive_device=qsv:reverse=1',
    );
    await h.destroy();
  });
});
