/*
 * Restreamer REST route tests: real Fastify app via inject(), hermetic
 * in-memory SQLite (createTestDb), real RestreamerService with fake nodes at
 * the client boundary, hand-built AppContext. No network, no real pollers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  channelStableId,
  type EnrichedSessionStatus,
  type NodeProbeSettings,
  type RestreamChannel,
  type RestreamChannelWithStatus,
  type RestreamPlaylist,
  type RestreamProfile,
  type SessionStatus,
  type SourceCatalogEntry,
  type TvhEpgEvent,
} from '@tvhc/shared';
import type { AppConfig } from '../src/config.js';
import type { InstancePoller } from '../src/tvh/poller.js';
import type { RestreamerClient } from '../src/restreamer/client.js';
import {
  RestreamerService,
  nodeKey,
  type RestreamerNodeClient,
} from '../src/restreamer/service.js';
import { NODE_PROBE_DEFAULTS } from '../src/restreamer/probeSettings.js';
import { registerRestreamerRoutes } from '../src/routes/restreamer.js';
import type { AppContext } from '../src/routes/context.js';
import type { TvhClient } from '../src/tvh/client.js';
import { EventBus } from '../src/state/events.js';
import { InstanceCache, type TopologySnapshot } from '../src/state/instanceCache.js';
import { createTestDb } from './support/testDb.js';
import { fakeRestreamerNode } from './support/fakeRestreamerNode.js';
import { FakeSwitcherHub, seedReplicaStatus } from './support/fakeSwitcherHub.js';

// ---------- fixtures ----------

/** AT-X 9.1 (relative imagecache icon) and BBB 10 (absolute icon) */
function zone1Topology(): TopologySnapshot {
  return {
    channels: [
      {
        uuid: 'ch-atx-91',
        name: 'AT-X',
        number: '9.1',
        services: ['svc-atx'],
        iconPublicUrl: 'imagecache/32736',
      },
      {
        uuid: 'ch-bbb',
        name: 'BBB',
        number: '10',
        services: ['svc-bbb'],
        iconPublicUrl: 'http://icons.example/bbb.png',
      },
      { uuid: 'ch-ccc', name: 'CCC', number: '3', services: ['svc-ccc'] },
    ],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [
      { uuid: 'svc-atx', sid: 101 },
      { uuid: 'svc-bbb', sid: 102 },
      { uuid: 'svc-ccc', sid: 103 },
    ],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
  };
}

/**
 * BBB (no icon — logo-fallback tests never target it directly, since zone1's
 * BBB already has a valid absolute icon and would win at the first placement)
 * and CCC (same name+number as zone1Topology's CCC, but WITH an imagecache
 * icon) — the latter backs the logo-fallback-across-zones test coverage.
 */
function zone2Topology(): TopologySnapshot {
  return {
    channels: [
      { uuid: 'ch2-bbb', name: 'BBB', number: '10', services: ['svc2-bbb'] },
      {
        uuid: 'ch2-ccc',
        name: 'CCC',
        number: '3',
        services: ['svc2-ccc'],
        iconPublicUrl: 'imagecache/777',
      },
    ],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [
      { uuid: 'svc2-bbb', sid: 202 },
      { uuid: 'svc2-ccc', sid: 203 },
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
        restreamer: {
          nodes: [{ id: 'n1', url: 'http://zone2-n1:5580', serveUrl: 'http://hls.zone2-n1' }],
        },
      },
    ],
    rclone: { remote: '' },
    databaseUrl: null,
    port: 0,
    pollIntervals: { dvr: 15_000, autorec: 60_000, topology: 600_000, epg: 600_000, restreamer: 15_000 },
    overlapThreshold: 0.7,
    autoUpload: { enabled: false, graceSeconds: 120 },
    restreamer: { switcher: { publicUrl: 'http://sw.example' } },
    eventLogRetentionDays: 30,
    ...overrides,
  };
}

function profilePayload(): unknown {
  return { template: 'arib-hls', templateVersion: 1, video: { mode: 'ivtc' }, audio: [{}] };
}

function sessionStatus(name: string, state: SessionStatus['state'] = 'running'): EnrichedSessionStatus {
  return { name, state, enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0, channelSlug: null };
}

function seedNodeStatus(
  cache: InstanceCache,
  instanceId: string,
  nodeId: string,
  sessions: EnrichedSessionStatus[] = [],
  sources: SourceCatalogEntry[] | null = null,
): void {
  cache.get(instanceId).restreamers = [
    ...cache.get(instanceId).restreamers,
    {
      instanceId,
      nodeId,
      url: `http://${instanceId}-${nodeId}:5580`,
      serveUrl: null,
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '0.0.0-test',
      uptimeSec: 1,
      apiVersionSupported: true,
      desiredRevision: null,
      pendingPush: false,
      probes: null,
      sessions,
      sourcesHash: sources === null ? null : 'h1',
      sources,
      capabilities: null,
      templates: null,
      maxSessions: null,
    },
  ];
}

/**
 * Mutates an already-seeded node's session list in place (rather than
 * appending a duplicate restreamers[] entry via seedNodeStatus). Needed
 * whenever session names must be a placement's id, which only exists after
 * the channel/placement is created — so catalog data goes in up front via
 * seedNodeStatus, and sessions are attached afterward via this helper.
 */
function setSessions(
  cache: InstanceCache,
  instanceId: string,
  nodeId: string,
  sessions: EnrichedSessionStatus[],
): void {
  const entry = cache.get(instanceId).restreamers.find((r) => r.nodeId === nodeId);
  if (entry) entry.sessions = sessions;
}

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  cache: InstanceCache;
  service: RestreamerService;
  restartSession: ReturnType<typeof vi.fn>;
  sessionLog: ReturnType<typeof vi.fn>;
  resetSessionRestarts: ReturnType<typeof vi.fn>;
  hub: FakeSwitcherHub;
  tvhGetRaw: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

async function setup(configOverrides: Partial<AppConfig> = {}): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  const bus = new EventBus();
  const config = makeConfig(configOverrides);
  const pollers = new Map<string, InstancePoller>();
  const clients = new Map<string, RestreamerNodeClient>();
  const restartSession = vi.fn(async () => {});
  const sessionLog = vi.fn(async () => [{ ts: '2026-01-01T00:00:00Z', src: 'daemon', line: 'hello' }]);
  const resetSessionRestarts = vi.fn(async () => {});
  const restreamerClients = new Map<string, RestreamerClient>();
  for (const inst of config.instances) {
    cache.init(inst.id, inst.name, inst.url);
    cache.get(inst.id).topology = inst.id === 'zone1' ? zone1Topology() : zone2Topology();
    pollers.set(inst.id, { pollTopology: vi.fn(async () => {}) } as unknown as InstancePoller);
    for (const n of inst.restreamer?.nodes ?? []) {
      clients.set(nodeKey(inst.id, n.id), fakeRestreamerNode());
      restreamerClients.set(nodeKey(inst.id, n.id), {
        restartSession,
        sessionLog,
        resetSessionRestarts,
      } as unknown as RestreamerClient);
    }
  }
  const hub = new FakeSwitcherHub();
  const tvhGetRaw = vi.fn(
    async () => new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }),
  );
  const tvhHttp = new Map<string, TvhClient>();
  for (const inst of config.instances) {
    tvhHttp.set(inst.id, { getRaw: tvhGetRaw } as unknown as TvhClient);
  }
  // the service gets the switcher hub too (reset switching goes through it)
  const service = new RestreamerService(db, cache, pollers, bus, config, clients, hub);
  const ctx = {
    config,
    db,
    cache,
    bus,
    pollers,
    tvhHttp,
    sync: null,
    ledger: null,
    dispatcher: null,
    restreamer: service,
    restreamerClients,
    restreamerPollers: [],
  } as unknown as AppContext;
  const app = Fastify();
  registerRestreamerRoutes(app, ctx);
  await app.ready();
  return {
    app,
    ctx,
    cache,
    service,
    restartSession,
    sessionLog,
    resetSessionRestarts,
    hub,
    tvhGetRaw,
    close: async () => {
      await app.close();
      await destroy();
    },
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function harness(configOverrides: Partial<AppConfig> = {}): Promise<Harness> {
  const h = await setup(configOverrides);
  closers.push(h.close);
  return h;
}

async function createProfile(app: FastifyInstance, name = 'default'): Promise<RestreamProfile> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/restreamer/profiles',
    payload: { name, payload: profilePayload() },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as RestreamProfile;
}

async function createPlaylist(
  app: FastifyInstance,
  body: { slug: string; title: string },
): Promise<RestreamPlaylist> {
  const res = await app.inject({ method: 'POST', url: '/api/restreamer/playlists', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json() as RestreamPlaylist;
}

/** looks up one channel's placement id on a specific instance via a live GET — sessions are named for placement ids, not the channel slug */
async function placementId(h: Harness, channelId: string, instanceId: string): Promise<string> {
  const list = (
    await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' })
  ).json() as RestreamChannelWithStatus[];
  return list.find((c) => c.id === channelId)!.placements.find((p) => p.instanceId === instanceId)!.id;
}

// ---------- profiles ----------

describe('restreamer profile routes', () => {
  it('CRUD happy path', async () => {
    const { app } = await harness();
    const created = await createProfile(app, 'hd');

    const list = await app.inject({ method: 'GET', url: '/api/restreamer/profiles' });
    expect(list.statusCode).toBe(200);
    expect((list.json() as RestreamProfile[]).map((p) => p.name)).toEqual(['hd']);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/restreamer/profiles/${created.id}`,
      payload: { name: 'hd2' },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as RestreamProfile).name).toBe('hd2');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/restreamer/profiles/${created.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
  });

  it('duplicate name -> 409, invalid payload -> 400', async () => {
    const { app } = await harness();
    await createProfile(app, 'hd');
    const dup = await app.inject({
      method: 'POST',
      url: '/api/restreamer/profiles',
      payload: { name: 'hd', payload: profilePayload() },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/restreamer/profiles',
      payload: { name: 'x', payload: { template: 'nope' } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

// ---------- channels ----------

describe('restreamer channel routes', () => {
  it('create + list returns the WithStatus shape', async () => {
    const { app, cache } = await harness();
    const profile = await createProfile(app);
    seedNodeStatus(cache, 'zone1', 'n1', []);

    const created = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: profile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json() as RestreamChannel;
    expect(channel.slug).toBe('at-x');
    expect(channel.channelNumber).toBe('9.1');
    // the sourceType/sourceKey model is gone — the DTO no longer carries them
    expect(channel).not.toHaveProperty('sourceType');
    expect(channel).not.toHaveProperty('sourceKey');

    // the running session is named after the placement id, not the channel slug
    const before = await app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const placementId = (before.json() as RestreamChannelWithStatus[])[0]!.placements[0]!.id;
    setSessions(cache, 'zone1', 'n1', [sessionStatus(placementId)]);

    const list = await app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    expect(list.statusCode).toBe(200);
    const [withStatus] = list.json() as RestreamChannelWithStatus[];
    expect(withStatus!.profileName).toBe('default');
    expect(withStatus!.placements).toHaveLength(1);
    expect(withStatus!.placements[0]!.blockedReason).toBeNull();
    expect(withStatus!.placements[0]!.resolvedVia).toBe('tvh');
    expect(withStatus!.placements[0]!.session?.state).toBe('running');
    // a switcher is configured -> even a single-placement channel is fronted by it
    expect(withStatus!.playbackUrl).toBe('http://sw.example/hls/at-x/playlist.m3u8');

    const got = await app.inject({ method: 'GET', url: `/api/restreamer/channels/${channel.id}` });
    expect(got.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/api/restreamer/channels/ghost' });
    expect(missing.statusCode).toBe(404);
  });

  it('batch returns per-id partial results', async () => {
    const { app } = await harness();
    const profile = await createProfile(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: { channelName: 'AT-X', channelNumber: '9.1', profileId: profile.id },
    });
    const channel = created.json() as RestreamChannel;

    const res = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels/batch',
      payload: { action: 'disable', ids: [channel.id, 'ghost'] },
    });
    expect(res.statusCode).toBe(200);
    const results = res.json() as Array<{ id: string; ok: boolean; error?: string }>;
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: channel.id, ok: true });
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.error).toMatch(/not found/);
  });

  it('placement add + reorder', async () => {
    const { app } = await harness();
    const profile = await createProfile(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'BBB',
        channelNumber: '10',
        profileId: profile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    const channel = created.json() as RestreamChannel;

    const added = await app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements`,
      payload: { instanceId: 'zone2', nodeId: 'n1' },
    });
    expect(added.statusCode).toBe(201);

    const list = () =>
      app
        .inject({ method: 'GET', url: '/api/restreamer/channels' })
        .then((r) => (r.json() as RestreamChannelWithStatus[])[0]!.placements);
    const before = await list();
    expect(before.map((p) => p.instanceId)).toEqual(['zone1', 'zone2']);

    const reordered = await app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements/reorder`,
      payload: { orderedPlacementIds: [before[1]!.id, before[0]!.id] },
    });
    expect(reordered.statusCode).toBe(200);
    expect((await list()).map((p) => p.instanceId)).toEqual(['zone2', 'zone1']);

    const bad = await app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements/reorder`,
      payload: { orderedPlacementIds: [before[0]!.id] },
    });
    expect(bad.statusCode).toBe(400);
  });

});

// ---------- write-time availability + external source parsing ----------

describe('write-time availability and catalog-resolved identity (routes)', () => {
  const CAM: SourceCatalogEntry = {
    id: 'cam1',
    name: 'Cam 1',
    url: 'http://cam.example/1.m3u8',
    chno: '5',
    logo: 'http://logos.example/cam1.png',
  };

  it('create 409s with {error, unavailable:[{instanceId,nodeId,reason}]}; force creates', async () => {
    const { app, cache } = await harness();
    const profile = await createProfile(app);
    seedNodeStatus(cache, 'zone2', 'n1', [], []); // known-empty catalog — no fallback either
    const payload = {
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: profile.id,
      placements: [{ instanceId: 'zone2', nodeId: 'n1' }], // zone2 has no AT-X
    };
    const denied = await app.inject({ method: 'POST', url: '/api/restreamer/channels', payload });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({
      error: expect.stringContaining('— pass force to create anyway'),
      unavailable: [
        {
          instanceId: 'zone2',
          nodeId: 'n1',
          reason:
            'channel "AT-X" (#9.1) not found on instance zone2 nor in node zone2/n1\'s sources catalog',
        },
      ],
    });

    const forced = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: { ...payload, force: true },
    });
    expect(forced.statusCode).toBe(201);
  });

  it('PUT channel identity change 409s with the shape; force passes', async () => {
    const { app, cache } = await harness();
    const profile = await createProfile(app);
    seedNodeStatus(cache, 'zone1', 'n1', [], []); // known-empty catalog — no fallback either
    const created = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: profile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    const channel = created.json() as RestreamChannel;

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/restreamer/channels/${channel.id}`,
      payload: { channelName: 'Ghost' },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toEqual({
      error: expect.stringContaining('— pass force to update anyway'),
      unavailable: [
        {
          instanceId: 'zone1',
          nodeId: 'n1',
          reason: 'channel "Ghost" not found on instance zone1 nor in node zone1/n1\'s sources catalog',
        },
      ],
    });

    const forced = await app.inject({
      method: 'PUT',
      url: `/api/restreamer/channels/${channel.id}`,
      payload: { channelName: 'Ghost', force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect((forced.json() as RestreamChannel).channelName).toBe('Ghost');
  });

  it('placement add and move 409 with the shape; force passes', async () => {
    const { app, cache } = await harness();
    const profile = await createProfile(app);
    seedNodeStatus(cache, 'zone2', 'n1', [], []); // known-empty catalog — no fallback either
    const created = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: profile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    const channel = created.json() as RestreamChannel;

    const addDenied = await app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements`,
      payload: { instanceId: 'zone2', nodeId: 'n1' },
    });
    expect(addDenied.statusCode).toBe(409);
    expect(addDenied.json()).toEqual({
      error: expect.stringContaining('— pass force to add anyway'),
      unavailable: [{ instanceId: 'zone2', nodeId: 'n1', reason: expect.any(String) }],
    });

    const list = await app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const placementId = (list.json() as RestreamChannelWithStatus[])[0]!.placements[0]!.id;
    const moveDenied = await app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${placementId}`,
      payload: { instanceId: 'zone2' },
    });
    expect(moveDenied.statusCode).toBe(409);
    expect(moveDenied.json()).toEqual({
      error: expect.stringContaining('— pass force to move anyway'),
      unavailable: [{ instanceId: 'zone2', nodeId: 'n1', reason: expect.any(String) }],
    });

    const moveForced = await app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${placementId}`,
      payload: { instanceId: 'zone2', force: true },
    });
    expect(moveForced.statusCode).toBe(200);
  });

  it('batch edit forwards force through the patch', async () => {
    const { app, cache } = await harness();
    const profile = await createProfile(app);
    seedNodeStatus(cache, 'zone1', 'n1', [], []); // known-empty catalog — no fallback either
    const created = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: profile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    const channel = created.json() as RestreamChannel;

    const denied = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels/batch',
      payload: { action: 'edit', ids: [channel.id], patch: { channelName: 'Ghost' } },
    });
    const deniedResults = denied.json() as Array<{ ok: boolean; error?: string }>;
    expect(deniedResults[0]!.ok).toBe(false);
    expect(deniedResults[0]!.error).toContain('pass force');

    const forced = await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels/batch',
      payload: { action: 'edit', ids: [channel.id], patch: { channelName: 'Ghost', force: true } },
    });
    expect((forced.json() as Array<{ ok: boolean }>)[0]!.ok).toBe(true);
  });

  it('renders catalog-resolved channels in the M3U among tvh channels, sorted by chno', async () => {
    const h = await harness();
    const profile = await createProfile(h.app);
    const playlist = await createPlaylist(h.app, { slug: 'tv', title: 'TV' });
    // the catalog must be in the cache BEFORE the "Cam 1" create (write-time
    // availability checks it); sessions are attached AFTER creation, once
    // each channel's placement id (the session name) is known
    seedNodeStatus(h.cache, 'zone1', 'n1', [], [CAM]);

    const post = async (payload: Record<string, unknown>) => {
      const res = await h.app.inject({ method: 'POST', url: '/api/restreamer/channels', payload });
      expect(res.statusCode).toBe(201);
      return res.json() as RestreamChannel;
    };
    const atx = await post({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    // "Cam 1" is absent from zone1's tvh topology — resolves via the node catalog
    const cam1 = await post({
      channelName: 'Cam 1',
      channelNumber: '5', // matches CAM's chno exactly
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    // resolves nowhere (neither tvh nor the catalog) → identity falls back to nulls
    const cam9 = await post({
      channelName: 'Cam 9',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true,
    });

    // sessions are named for each channel's placement id, attached after creation
    const withStatus = (
      await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' })
    ).json() as RestreamChannelWithStatus[];
    const placementIdOf = (channelId: string) =>
      withStatus.find((c) => c.id === channelId)!.placements[0]!.id;
    setSessions(h.cache, 'zone1', 'n1', [
      sessionStatus(placementIdOf(atx.id)),
      sessionStatus(placementIdOf(cam1.id)),
      sessionStatus(placementIdOf(cam9.id)),
    ]);

    const res = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(res.statusCode).toBe(200);
    // chno sort: cam1 ("5") < AT-X ("9.1") < cam9 (numberless last); the
    // catalog-resolved logo is the entry value VERBATIM (never proxied);
    // tvg-id is always the generated stable id (name+number), never the tvh
    // uuid or catalog entry id — Cam 9 gets one too even with no tvg-chno
    // (its identity number is unresolved)
    expect(res.body).toBe(
      [
        `#EXTM3U url-tvg=http://ctrl.example/xmltv/tv.xml`,
        '#PLAYLIST:TV',
        '#KODIPROP:mimetype=application/x-mpegURL',
        `#EXTINF:-1 tvg-id="${channelStableId('Cam 1', '5')}" tvg-chno="5" x-url="cam-1" tvg-logo="http://logos.example/cam1.png",Cam 1`,
        'http://sw.example/hls/cam-1/playlist.m3u8',
        `#EXTINF:-1 tvg-id="${channelStableId('AT-X', '9.1')}" tvg-chno="9.1" x-url="at-x" tvg-logo="http://ctrl.example/logos/zone1/imagecache/32736",AT-X`,
        'http://sw.example/hls/at-x/playlist.m3u8',
        `#EXTINF:-1 tvg-id="${channelStableId('Cam 9', null)}" x-url="cam-9",Cam 9`,
        'http://sw.example/hls/cam-9/playlist.m3u8',
        '',
      ].join('\n'),
    );
  });
});

// ---------- manual switch / reset — the serialized failover procedure ----------

describe('POST /api/restreamer/channels/:id/switch', () => {
  /** redundant BBB channel across zone1/n1 + zone2/n1; returns its placements */
  async function seedRedundantChannel(h: Harness) {
    const profile = await createProfile(h.app);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'BBB',
        channelNumber: '10',
        profileId: profile.id,
        placements: [
          { instanceId: 'zone1', nodeId: 'n1' },
          { instanceId: 'zone2', nodeId: 'n1' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json() as RestreamChannel;
    const list = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const withStatus = (list.json() as RestreamChannelWithStatus[]).find((c) => c.id === channel.id)!;
    return { channel, placements: withStatus.placements };
  }

  /** reachable node statuses (with the slug running) so beginNext's admission gate passes */
  function seedAdmission(h: Harness, slug: string): void {
    seedNodeStatus(h.cache, 'zone1', 'n1', [sessionStatus(slug)]);
    seedNodeStatus(h.cache, 'zone2', 'n1', [sessionStatus(slug)]);
  }

  function seedSwitcherStatus(
    h: Harness,
    channels: Array<{
      slug: string;
      activeUpstreamId: string | null;
      upstreams: Array<{ id: string; healthy: boolean }>;
    }>,
  ): void {
    seedReplicaStatus(h.cache, {
      channels: channels.map((c) => ({ ...c, lastSwitch: null })),
      publicUrl: 'http://sw.example',
    });
  }

  async function seedFailoverRow(
    h: Harness,
    channelId: string,
    fields: {
      fromPlacementId: string | null;
      toPlacementId: string;
      phase: string;
      triggerReason?: string;
      suppressFrom?: boolean;
    },
  ): Promise<void> {
    await h.ctx.db!
      .insertInto('restream_failover_state')
      .values({
        channel_id: channelId,
        from_placement_id: fields.fromPlacementId,
        to_placement_id: fields.toPlacementId,
        phase: fields.phase,
        trigger_reason: fields.triggerReason ?? 'manual',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: fields.suppressFrom ? 1 : 0,
        drain_until: null,
        started_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      })
      .execute();
  }

  async function failoverRow(h: Harness, channelId: string) {
    return h.ctx.db!
      .selectFrom('restream_failover_state')
      .selectAll()
      .where('channel_id', '=', channelId)
      .executeTakeFirst();
  }

  // ---------- {placementId} — manual selection ----------

  it('manual selection: 200 {ok:true, queued:true}; a bringing-up row appears once the enqueued tick runs', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    seedAdmission(h, 'bbb');
    seedSwitcherStatus(h, [
      { slug: 'bbb', activeUpstreamId: placements[0]!.id, upstreams: placements.map((p) => ({ id: p.id, healthy: true })) },
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[1]!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: true });

    // requestManualSwitch fire-and-forgets failoverTick(); await it explicitly for determinism
    await h.ctx.restreamer!.failoverTick();
    const row = await failoverRow(h, channel.id);
    expect(row).toMatchObject({
      phase: 'awaiting-lag', // bringing-up always advances immediately within the same tick
      trigger_reason: 'manual',
      to_placement_id: placements[1]!.id,
      from_placement_id: placements[0]!.id,
    });
  });

  it('switching to the currently-active placement -> {ok:true, already:true}, no row created', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    seedSwitcherStatus(h, [
      { slug: 'bbb', activeUpstreamId: placements[0]!.id, upstreams: placements.map((p) => ({ id: p.id, healthy: true })) },
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[0]!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, already: true });
    expect(await failoverRow(h, channel.id)).toBeUndefined();
  });

  it('404 for an unknown channel', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels/ghost/switch',
      payload: { placementId: 'p1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 when the placement belongs to another channel', async () => {
    const h = await harness();
    const { channel } = await seedRedundantChannel(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: 'not-a-placement-of-this-channel' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a body with both, neither, or a non-true reset', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    for (const payload of [{}, { placementId: placements[0]!.id, reset: true }, { reset: false }]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/restreamer/channels/${channel.id}/switch`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  // ---------- {reset: true} — fail back in natural placement order ----------

  it('reset with no failover row -> 409', async () => {
    const h = await harness();
    const { channel } = await seedRedundantChannel(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it('reset from phase=complete: {ok:true, queued:true}; a tick flips trigger_reason to reset', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    seedAdmission(h, 'bbb');
    // completed onto zone2 (placements[1]); natural (lowest priority) is zone1 (placements[0])
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: placements[0]!.id,
      toPlacementId: placements[1]!.id,
      phase: 'complete',
      triggerReason: 'manual',
    });
    seedSwitcherStatus(h, [
      { slug: 'bbb', activeUpstreamId: placements[1]!.id, upstreams: placements.map((p) => ({ id: p.id, healthy: true })) },
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: true });

    await h.ctx.restreamer!.failoverTick();
    const row = await failoverRow(h, channel.id);
    expect(row!.trigger_reason).toBe('reset');
    expect(row!.to_placement_id).toBe(placements[0]!.id); // back to natural order
  });

  it('reset when already on the natural placement: {ok:true, cleared:true}; row deleted (hot outgoing resumes)', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: placements[1]!.id,
      toPlacementId: placements[0]!.id, // already the natural placement
      phase: 'complete',
      triggerReason: 'manual',
      suppressFrom: false,
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cleared: true });
    expect(await failoverRow(h, channel.id)).toBeUndefined();
  });

  it('reset when already on natural with a suppressed HOT outgoing: cleared immediately (hot never leaves the switcher doc)', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: placements[1]!.id,
      toPlacementId: placements[0]!.id,
      phase: 'complete',
      triggerReason: 'manual',
      suppressFrom: true,
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cleared: true });
    expect(await failoverRow(h, channel.id)).toBeUndefined();
  });

  it('reset when already on natural with a COLD outgoing: draining with drain_until set', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    await h.ctx
      .db!.updateTable('restream_placements')
      .set({ mode: 'cold' })
      .where('id', '=', placements[1]!.id)
      .execute();
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: placements[1]!.id,
      toPlacementId: placements[0]!.id,
      phase: 'complete',
      triggerReason: 'manual',
      suppressFrom: true,
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cleared: true });
    const row = await failoverRow(h, channel.id);
    expect(row!.phase).toBe('draining');
    expect(row!.drain_until).not.toBeNull();
  });

  it('reset from a pre-commit mid-procedure phase (awaiting-lag) aborts loss-free: {ok:true, aborted:true}, row gone', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: placements[0]!.id,
      toPlacementId: placements[1]!.id,
      phase: 'awaiting-lag',
      triggerReason: 'lag',
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, aborted: true });
    expect(await failoverRow(h, channel.id)).toBeUndefined();
  });

  it('reset from a past-commit-point phase (awaiting-switch-confirm) 409s rejected-mid-procedure', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: placements[0]!.id,
      toPlacementId: placements[1]!.id,
      phase: 'awaiting-switch-confirm',
      triggerReason: 'lag',
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'rejected-mid-procedure', message: expect.any(String) });
    expect(await failoverRow(h, channel.id)).toMatchObject({ phase: 'awaiting-switch-confirm' });
  });

  it('a manual switch still queues without a configured switcher (issuing the switch itself just never completes)', async () => {
    const h = await harness({ restreamer: undefined });
    const { channel, placements } = await seedRedundantChannel(h);
    seedAdmission(h, 'bbb');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[1]!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: true });
  });

  // ---------- {failover/clear-blocked} — operator dismiss of the badge ----------

  describe('POST /api/restreamer/channels/:id/failover/clear-blocked', () => {
    it('200 {ok:true, cleared:true} when a blocked reason exists, then {cleared:false} on retry', async () => {
      const h = await harness();
      const { channel, placements } = await seedRedundantChannel(h);
      seedSwitcherStatus(h, [
        {
          slug: 'bbb',
          activeUpstreamId: placements[0]!.id,
          upstreams: placements.map((p) => ({ id: p.id, healthy: true })),
        },
      ]);
      // deliberately skip seedAdmission: the target's node is never polled, so
      // beginNext's admission gate rejects it and sets `blocked`
      const switchRes = await h.app.inject({
        method: 'POST',
        url: `/api/restreamer/channels/${channel.id}/switch`,
        payload: { placementId: placements[1]!.id },
      });
      expect(switchRes.statusCode).toBe(200);
      await h.ctx.restreamer!.failoverTick();

      const list = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
      const chan = (list.json() as RestreamChannelWithStatus[]).find((c) => c.id === channel.id)!;
      expect(chan.failoverBlocked).not.toBeNull();

      const clear1 = await h.app.inject({
        method: 'POST',
        url: `/api/restreamer/channels/${channel.id}/failover/clear-blocked`,
      });
      expect(clear1.statusCode).toBe(200);
      expect(clear1.json()).toEqual({ ok: true, cleared: true });

      const clear2 = await h.app.inject({
        method: 'POST',
        url: `/api/restreamer/channels/${channel.id}/failover/clear-blocked`,
      });
      expect(clear2.statusCode).toBe(200);
      expect(clear2.json()).toEqual({ ok: true, cleared: false });
    });

    it('404 for an unknown channel', async () => {
      const h = await harness();
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/restreamer/channels/ghost/failover/clear-blocked',
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

// ---------- session passthrough ----------

describe('restreamer session passthrough', () => {
  it('restart + log route to the node client; unknown node -> 404', async () => {
    const { app, restartSession, sessionLog } = await harness();
    const restart = await app.inject({
      method: 'POST',
      url: '/api/restreamer/nodes/zone1/n1/sessions/at-x/restart',
    });
    expect(restart.statusCode).toBe(200);
    expect(restart.json()).toEqual({ ok: true });
    expect(restartSession).toHaveBeenCalledWith('at-x');

    const log = await app.inject({
      method: 'GET',
      url: '/api/restreamer/nodes/zone1/n1/sessions/at-x/log?lines=5',
    });
    expect(log.statusCode).toBe(200);
    expect(sessionLog).toHaveBeenCalledWith('at-x', 5);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/restreamer/nodes/zone1/ghost/sessions/at-x/restart',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('unreachable node surfaces as 502', async () => {
    const { app, restartSession } = await harness();
    restartSession.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/restreamer/nodes/zone1/n1/sessions/at-x/restart',
    });
    expect(res.statusCode).toBe(502);
  });
});

// ---------- playlists + M3U ----------

describe('restreamer playlist routes', () => {
  it('CRUD happy path + duplicate slug 409', async () => {
    const { app } = await harness();
    const created = await createPlaylist(app, { slug: 'tv', title: 'TV' });
    expect(created).not.toHaveProperty('epgUrl');

    const dup = await app.inject({
      method: 'POST',
      url: '/api/restreamer/playlists',
      payload: { slug: 'tv', title: 'Other' },
    });
    expect(dup.statusCode).toBe(409);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/restreamer/playlists/${created.id}`,
      payload: { title: 'TV 2' },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as RestreamPlaylist).title).toBe('TV 2');

    const list = await app.inject({ method: 'GET', url: '/api/restreamer/playlists' });
    expect((list.json() as RestreamPlaylist[]).map((p) => p.slug)).toEqual(['tv']);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/restreamer/playlists/${created.id}` });
    expect(deleted.statusCode).toBe(200);
  });
});

describe('GET /playlists/:slug.m3u', () => {
  /** playlist with AT-X (single placement), BBB (redundant), CCC (backoff session — still advertised) */
  async function seedM3uFixture(
    h: Harness,
  ): Promise<{ atxPlacementId: string; bbbZone1PlacementId: string }> {
    const profile = await createProfile(h.app);
    const playlist = await createPlaylist(h.app, { slug: 'tv', title: 'Mock TV' });
    const post = async (payload: Record<string, unknown>) => {
      const res = await h.app.inject({ method: 'POST', url: '/api/restreamer/channels', payload });
      expect(res.statusCode).toBe(201);
      return res.json() as RestreamChannel;
    };
    const atx = await post({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    const bbb = await post({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
    });
    // backoff session on its only placement -> still advertised, not deleted
    const ccc = await post({
      channelName: 'CCC',
      channelNumber: '3',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });

    // sessions are named for each placement's id, not the channel slug
    const withStatus = (
      await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' })
    ).json() as RestreamChannelWithStatus[];
    const placementsOf = (channelId: string) =>
      withStatus.find((c) => c.id === channelId)!.placements;
    const atxPlacementId = placementsOf(atx.id)[0]!.id;
    const bbbPlacements = placementsOf(bbb.id);
    const bbbZone1PlacementId = bbbPlacements.find((p) => p.instanceId === 'zone1')!.id;
    const bbbZone2PlacementId = bbbPlacements.find((p) => p.instanceId === 'zone2')!.id;
    const cccPlacementId = placementsOf(ccc.id)[0]!.id;

    seedNodeStatus(h.cache, 'zone1', 'n1', [
      sessionStatus(atxPlacementId),
      sessionStatus(bbbZone1PlacementId),
      sessionStatus(cccPlacementId, 'backoff'),
    ]);
    seedNodeStatus(h.cache, 'zone2', 'n1', [sessionStatus(bbbZone2PlacementId)]);

    return { atxPlacementId, bbbZone1PlacementId };
  }

  it('renders the prod format: header, EXTINF attrs, URL rule, sort', async () => {
    const h = await harness();
    await seedM3uFixture(h);

    const res = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/x-mpegurl');
    // sorted by chanNumberOrder: CCC ("3") first, then "9.1", then "10"
    // (numeric, not lexical); CCC's session is in backoff yet still renders —
    // channels stay advertised regardless of encode state, with its logo
    // falling back to zone2's icon (see logo-fallback tests); a switcher is
    // configured -> EVERY entry (single-placement AT-X included) points at
    // the switcher publicUrl — uniform viewer URLs; relative imagecache icon
    // -> controller logo proxy against the request base (no forwarded
    // headers, no configured publicUrl here); absolute icon (BBB) passes
    // through verbatim; tvg-id is the generated stable id, never the tvh
    // uuid, so it matches the XMLTV <channel id> for the same entry
    expect(res.body).toBe(
      [
        '#EXTM3U url-tvg=http://ctrl.example/xmltv/tv.xml',
        '#PLAYLIST:Mock TV',
        '#KODIPROP:mimetype=application/x-mpegURL',
        `#EXTINF:-1 tvg-id="${channelStableId('CCC', '3')}" tvg-chno="3" x-url="ccc" tvg-logo="http://ctrl.example/logos/zone2/imagecache/777",CCC`,
        'http://sw.example/hls/ccc/playlist.m3u8',
        `#EXTINF:-1 tvg-id="${channelStableId('AT-X', '9.1')}" tvg-chno="9.1" x-url="at-x" tvg-logo="http://ctrl.example/logos/zone1/imagecache/32736",AT-X`,
        'http://sw.example/hls/at-x/playlist.m3u8',
        `#EXTINF:-1 tvg-id="${channelStableId('BBB', '10')}" tvg-chno="10" x-url="bbb" tvg-logo="http://icons.example/bbb.png",BBB`,
        'http://sw.example/hls/bbb/playlist.m3u8',
        '',
      ].join('\n'),
    );

    // the /api twin serves the identical body
    const api = await h.app.inject({
      method: 'GET',
      url: '/api/restreamer/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(api.statusCode).toBe(200);
    expect(api.body).toBe(res.body);
  });

  it('derives the logo-proxy base from X-Forwarded-Proto/Host (first value each)', async () => {
    const h = await harness();
    await seedM3uFixture(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: {
        'x-forwarded-proto': 'https, http',
        'x-forwarded-host': 'tv.example, inner.local',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('tvg-logo="https://tv.example/logos/zone1/imagecache/32736"');
    // absolute icons stay verbatim regardless of the base
    expect(res.body).toContain('tvg-logo="http://icons.example/bbb.png"');
  });

  it('config restreamer.publicUrl wins over forwarded headers as the logo-proxy base', async () => {
    const h = await harness({
      restreamer: {
        switcher: { publicUrl: 'http://sw.example' },
        publicUrl: 'https://pub.example',
      },
    });
    await seedM3uFixture(h);
    const res = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'tv.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('tvg-logo="https://pub.example/logos/zone1/imagecache/32736"');
  });

  it('url-tvg always points at the generated per-playlist XMLTV endpoint', async () => {
    const h = await harness();
    await createPlaylist(h.app, { slug: 'bare', title: 'Bare' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/playlists/bare.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\n')[0]).toBe('#EXTM3U url-tvg=http://ctrl.example/xmltv/bare.xml');
  });

  it('uses direct node serveUrls without a switcher (single and redundant alike)', async () => {
    const h = await harness({ restreamer: undefined });
    const { atxPlacementId, bbbZone1PlacementId } = await seedM3uFixture(h);
    const res = await h.app.inject({ method: 'GET', url: '/playlists/tv.m3u' });
    expect(res.statusCode).toBe(200);
    // URL path segment is the placement id, not the channel slug
    expect(res.body).toContain(`http://hls.zone1-n1/${atxPlacementId}/playlist.m3u8`);
    // redundant channel: first placement whose node has a serveUrl
    expect(res.body).toContain(`http://hls.zone1-n1/${bbbZone1PlacementId}/playlist.m3u8`);
    expect(res.body).not.toContain('sw.example');
  });

  it('404s for an unknown playlist slug', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/playlists/nope.m3u' });
    expect(res.statusCode).toBe(404);
  });
});

// ---------- playlist XMLTV ----------

describe('GET /xmltv/:slug.xml', () => {
  /** minimal TvhEpgEvent builder — only the fields the renderer reads are required by callers */
  function epgEvent(
    e: Partial<TvhEpgEvent> & { eventId: number; channelName: string; start: number; stop: number },
  ): TvhEpgEvent {
    return { channelUuid: 'irrelevant', ...e };
  }

  /**
   * AT-X (9.1, single placement), BBB (10, redundant zone1+zone2), CCC (3,
   * enabled member with no enabled placement — present in .xml, absent from
   * .m3u via the entryUrl filter), DDD (disabled member — excluded from
   * both), EEE (enabled, not a playlist member — excluded from both).
   */
  async function seedXmltvFixture(h: Harness): Promise<RestreamPlaylist> {
    const profile = await createProfile(h.app);
    const playlist = await createPlaylist(h.app, { slug: 'tv', title: 'Mock TV' });
    const post = async (payload: Record<string, unknown>) => {
      const res = await h.app.inject({ method: 'POST', url: '/api/restreamer/channels', payload });
      expect(res.statusCode).toBe(201);
      return res.json() as RestreamChannel;
    };
    await post({
      channelName: 'AT-X',
      channelNumber: '9.1',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    await post({
      channelName: 'BBB',
      channelNumber: '10',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [
        { instanceId: 'zone1', nodeId: 'n1' },
        { instanceId: 'zone2', nodeId: 'n1' },
      ],
    });
    await post({
      channelName: 'CCC',
      channelNumber: '3',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1', enabled: false }],
    });
    await post({
      channelName: 'DDD',
      channelNumber: '4',
      profileId: profile.id,
      playlistIds: [playlist.id],
      enabled: false,
    });
    await post({ channelName: 'EEE', channelNumber: '6', profileId: profile.id });
    return playlist;
  }

  /** installs epgEventsAll stubs on the harness's per-instance tvhHttp clients */
  function stubEpg(
    h: Harness,
    zone1: TvhEpgEvent[] | (() => Promise<TvhEpgEvent[]>),
    zone2: TvhEpgEvent[] | (() => Promise<TvhEpgEvent[]>) = [],
  ): { zone1: ReturnType<typeof vi.fn>; zone2: ReturnType<typeof vi.fn> } {
    const toFn = (v: TvhEpgEvent[] | (() => Promise<TvhEpgEvent[]>)) =>
      typeof v === 'function' ? vi.fn(v) : vi.fn(async () => v);
    const zone1Fn = toFn(zone1);
    const zone2Fn = toFn(zone2);
    h.ctx.tvhHttp.set('zone1', { getRaw: h.tvhGetRaw, epgEventsAll: zone1Fn } as unknown as TvhClient);
    h.ctx.tvhHttp.set('zone2', { getRaw: h.tvhGetRaw, epgEventsAll: zone2Fn } as unknown as TvhClient);
    return { zone1: zone1Fn, zone2: zone2Fn };
  }

  it('members = all enabled playlist members; disabled/non-members excluded', async () => {
    const h = await harness();
    await seedXmltvFixture(h);
    stubEpg(h, []);

    const res = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(res.body).toContain(`<channel id="${channelStableId('AT-X', '9.1')}">`);
    expect(res.body).toContain(`<channel id="${channelStableId('BBB', '10')}">`);
    // CCC has no enabled placement anywhere -> the .m3u omits it (entryUrl filter), .xml must not
    expect(res.body).toContain(`<channel id="${channelStableId('CCC', '3')}">`);
    expect(res.body).not.toContain('DDD');
    expect(res.body).not.toContain('EEE');

    const m3u = await h.app.inject({ method: 'GET', url: '/playlists/tv.m3u' });
    expect(m3u.statusCode).toBe(200);
    expect(m3u.body).not.toContain('CCC');
  });

  it('buckets deduped programmes to the right channel; past-24h and future included, stale excluded', async () => {
    const h = await harness();
    await seedXmltvFixture(h);
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - 86400;
    stubEpg(h, [
      epgEvent({ eventId: 1, channelName: 'AT-X', channelNumber: '9.1', start: now - 1800, stop: now + 1800, title: 'AT-X Now' }),
      // already ended, but within the past-24h window
      epgEvent({ eventId: 2, channelName: 'CCC', channelNumber: '3', start: now - 7200, stop: now - 3600, title: 'CCC Past' }),
      epgEvent({ eventId: 3, channelName: 'CCC', channelNumber: '3', start: now + 3600, stop: now + 7200, title: 'CCC Future' }),
      // ended before the window even starts -> excluded (belt-and-braces)
      epgEvent({ eventId: 4, channelName: 'CCC', channelNumber: '3', start: windowStart - 7200, stop: windowStart - 10, title: 'Too Old' }),
    ]);

    const res = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>AT-X Now</title>');
    expect(res.body).toContain('<title>CCC Past</title>');
    expect(res.body).toContain('<title>CCC Future</title>');
    expect(res.body).not.toContain('Too Old');

    const atxId = channelStableId('AT-X', '9.1');
    const cccId = channelStableId('CCC', '3');
    expect(res.body.split(`channel="${atxId}"`).length - 1).toBe(1);
    expect(res.body.split(`channel="${cccId}"`).length - 1).toBe(2);
  });

  it('dedups the same broadcast across instances (BBB on zone1+zone2 appears once)', async () => {
    const h = await harness();
    await seedXmltvFixture(h);
    const now = Math.floor(Date.now() / 1000);
    const bbb = (eventId: number) =>
      epgEvent({ eventId, channelName: 'BBB', channelNumber: '10', start: now + 3600, stop: now + 7200, title: 'BBB Shared Show' });
    stubEpg(h, [bbb(10)], [bbb(20)]);

    const res = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
    expect(res.statusCode).toBe(200);
    expect(res.body.split('BBB Shared Show').length - 1).toBe(1);
  });

  it('escapes < and & in programme titles; timestamps are UTC XMLTV format', async () => {
    const h = await harness();
    await seedXmltvFixture(h);
    const now = Math.floor(Date.now() / 1000);
    stubEpg(h, [
      epgEvent({ eventId: 1, channelName: 'AT-X', channelNumber: '9.1', start: now - 1800, stop: now + 1800, title: 'News <Live> & More' }),
    ]);

    const res = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>News &lt;Live&gt; &amp; More</title>');
    expect(res.body).not.toContain('<Live>');
    expect(res.body).toMatch(/start="\d{14} \+0000" stop="\d{14} \+0000"/);
  });

  it('fetches each instance with a stop > now-86400 filter', async () => {
    const h = await harness();
    await seedXmltvFixture(h);
    const { zone1, zone2 } = stubEpg(h, [], []);

    const before = Math.floor(Date.now() / 1000);
    const res = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
    expect(res.statusCode).toBe(200);
    for (const fn of [zone1, zone2]) {
      expect(fn).toHaveBeenCalledTimes(1);
      const arg = fn.mock.calls[0]![0] as {
        filter: Array<{ field: string; comparison: string; value: number }>;
      };
      expect(arg.filter[0]!.field).toBe('stop');
      expect(arg.filter[0]!.comparison).toBe('gt');
      expect(Math.abs(arg.filter[0]!.value - (before - 86400))).toBeLessThan(5);
    }
  });

  it('404s for an unknown playlist slug', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/xmltv/nope.xml' });
    expect(res.statusCode).toBe(404);
  });

  it('one instance rejecting still 200s with the other instance programmes present', async () => {
    const h = await harness();
    await seedXmltvFixture(h);
    const now = Math.floor(Date.now() / 1000);
    stubEpg(
      h,
      [epgEvent({ eventId: 1, channelName: 'AT-X', channelNumber: '9.1', start: now - 1800, stop: now + 1800, title: 'AT-X Still Up' })],
      () => Promise.reject(new Error('fetch failed: ECONNREFUSED')),
    );

    const res = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('AT-X Still Up');
  });

  it('caches the rendered document for 60s, then refetches past the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = await harness();
      await seedXmltvFixture(h);
      const { zone1 } = stubEpg(h, [], []);

      const first = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
      expect(first.statusCode).toBe(200);
      const second = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
      expect(second.statusCode).toBe(200);
      expect(zone1).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 61_000);
      const third = await h.app.inject({ method: 'GET', url: '/xmltv/tv.xml' });
      expect(third.statusCode).toBe(200);
      expect(zone1).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- logo fallback across zones/catalogs ----------

describe('logo fallback across zones and catalogs (M3U + XMLTV)', () => {
  /**
   * CCC identity: zone1Topology carries it with NO icon; zone2Topology
   * carries the same (name, number) WITH an imagecache/777 icon (see
   * zone2Topology's doc comment). `placements` controls whether zone2 is
   * also a placement (rule 1: scan past a resolving-but-logo-less placement)
   * or left out entirely (rule 2: a zone with no placement at all).
   */
  async function createCcc(
    h: Harness,
    placements: Array<{ instanceId: string; nodeId: string }>,
  ): Promise<RestreamChannel> {
    const profile = await createProfile(h.app);
    const playlist = await createPlaylist(h.app, { slug: 'tv', title: 'Mock TV' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'CCC',
        channelNumber: '3',
        profileId: profile.id,
        playlistIds: [playlist.id],
        placements,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as RestreamChannel;
  }

  it('rule 1: scans past a resolving placement with no icon to a later placement\'s zone icon', async () => {
    const h = await harness();
    const ccc = await createCcc(h, [
      { instanceId: 'zone1', nodeId: 'n1' },
      { instanceId: 'zone2', nodeId: 'n1' },
    ]);
    seedNodeStatus(h.cache, 'zone1', 'n1', [sessionStatus(await placementId(h, ccc.id, 'zone1'))]);

    const m3u = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(m3u.statusCode).toBe(200);
    // identity (tvg-id/tvg-chno) still comes from zone1 — the first resolving
    // placement — but the logo falls back to zone2's proxied icon
    expect(m3u.body).toContain(`tvg-id="${channelStableId('CCC', '3')}" tvg-chno="3"`);
    expect(m3u.body).toContain('tvg-logo="http://ctrl.example/logos/zone2/imagecache/777"');

    const xmltv = await h.app.inject({
      method: 'GET',
      url: '/xmltv/tv.xml',
      headers: { host: 'ctrl.example' },
    });
    expect(xmltv.statusCode).toBe(200);
    expect(xmltv.body).toContain('<icon src="http://ctrl.example/logos/zone2/imagecache/777"/>');
  });

  it('rule 2: a zone with NO placement for the channel still supplies the logo via its tvh topology', async () => {
    const h = await harness();
    const ccc = await createCcc(h, [{ instanceId: 'zone1', nodeId: 'n1' }]); // zone2 has no placement at all
    seedNodeStatus(h.cache, 'zone1', 'n1', [sessionStatus(await placementId(h, ccc.id, 'zone1'))]);

    const m3u = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(m3u.statusCode).toBe(200);
    expect(m3u.body).toContain('tvg-logo="http://ctrl.example/logos/zone2/imagecache/777"');

    const xmltv = await h.app.inject({
      method: 'GET',
      url: '/xmltv/tv.xml',
      headers: { host: 'ctrl.example' },
    });
    expect(xmltv.statusCode).toBe(200);
    expect(xmltv.body).toContain('<icon src="http://ctrl.example/logos/zone2/imagecache/777"/>');
  });

  it('rule 3: falls back to another node\'s sources catalog when no zone topology has an icon', async () => {
    const h = await harness();
    const profile = await createProfile(h.app);
    const playlist = await createPlaylist(h.app, { slug: 'tv', title: 'Mock TV' });
    // zone1/n1's catalog resolves the identity (chno match) but its own entry
    // has no logo; zone2/n1 is NOT a placement of this channel, yet its
    // catalog carries the same (name, chno) WITH a logo
    // sessions are attached after creation once the placement id is known (see below)
    seedNodeStatus(
      h.cache,
      'zone1',
      'n1',
      [],
      [{ id: 'ghost-z1', name: 'Ghost Cam', url: 'http://cam.example/ghost1.m3u8', chno: '77' }],
    );
    seedNodeStatus(
      h.cache,
      'zone2',
      'n1',
      [],
      [
        {
          id: 'ghost-z2',
          name: 'Ghost Cam',
          url: 'http://cam.example/ghost2.m3u8',
          chno: '77',
          logo: 'http://logos.example/ghost.png',
        },
      ],
    );

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'Ghost Cam',
        channelNumber: '77',
        profileId: profile.id,
        playlistIds: [playlist.id],
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const ghostCam = created.json() as RestreamChannel;
    setSessions(h.cache, 'zone1', 'n1', [sessionStatus(await placementId(h, ghostCam.id, 'zone1'))]);

    const m3u = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(m3u.statusCode).toBe(200);
    expect(m3u.body).toContain('tvg-logo="http://logos.example/ghost.png"');
  });
});

// ---------- logo proxy ----------

describe('GET /logos/:instanceId/imagecache/:iconId', () => {
  const CACHE_CONTROL = 'public, max-age=2592000, immutable'; // 30 days, exact

  it('200: streams the upstream body through with content-type, etag and Cache-Control', async () => {
    const h = await harness();
    h.tvhGetRaw.mockResolvedValueOnce(
      new Response(Buffer.from('png-bytes'), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          etag: '"icon-32736"',
          'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        },
      }),
    );
    const res = await h.app.inject({ method: 'GET', url: '/logos/zone1/imagecache/32736' });
    expect(res.statusCode).toBe(200);
    expect(h.tvhGetRaw).toHaveBeenCalledWith('/imagecache/32736', {});
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers.etag).toBe('"icon-32736"');
    expect(res.headers['last-modified']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
    expect(res.headers['cache-control']).toBe(CACHE_CONTROL);
    expect(res.body).toBe('png-bytes');
  });

  it('falls back to image/png when the upstream sends no content-type', async () => {
    const h = await harness();
    h.tvhGetRaw.mockResolvedValueOnce(
      new Response(Buffer.from('bytes'), { status: 200, headers: {} }),
    );
    const res = await h.app.inject({ method: 'GET', url: '/logos/zone1/imagecache/1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('forwards If-None-Match upstream and passes a 304 through with validators', async () => {
    const h = await harness();
    h.tvhGetRaw.mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { etag: '"icon-32736"' } }),
    );
    const res = await h.app.inject({
      method: 'GET',
      url: '/logos/zone1/imagecache/32736',
      headers: { 'if-none-match': '"icon-32736"' },
    });
    expect(h.tvhGetRaw).toHaveBeenCalledWith('/imagecache/32736', {
      'if-none-match': '"icon-32736"',
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers.etag).toBe('"icon-32736"');
    expect(res.headers['cache-control']).toBe(CACHE_CONTROL);
  });

  it('forwards If-Modified-Since upstream', async () => {
    const h = await harness();
    h.tvhGetRaw.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const res = await h.app.inject({
      method: 'GET',
      url: '/logos/zone1/imagecache/7',
      headers: { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
    });
    expect(h.tvhGetRaw).toHaveBeenCalledWith('/imagecache/7', {
      'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT',
    });
    expect(res.statusCode).toBe(304);
  });

  it('404s non-numeric or traversal iconIds without contacting the upstream', async () => {
    const h = await harness();
    // (a raw `/1/../2` path is not testable here: the inject client normalizes
    // dot segments before routing; on the wire it would simply not match the
    // route, since a path param never spans `/`)
    for (const url of [
      '/logos/zone1/imagecache/abc',
      '/logos/zone1/imagecache/1%2F..%2F2', // urlencoded traversal decodes into the param
      '/logos/zone1/imagecache/..%2F..%2Fapi%2Fserverinfo',
    ]) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
    expect(h.tvhGetRaw).not.toHaveBeenCalled();
  });

  it('404s an unknown instanceId without contacting the upstream', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/logos/ghost/imagecache/1' });
    expect(res.statusCode).toBe(404);
    expect(h.tvhGetRaw).not.toHaveBeenCalled();
  });

  it('maps upstream 404/401 to a plain 404 without the long-lived Cache-Control', async () => {
    const h = await harness();
    h.tvhGetRaw.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    const missing = await h.app.inject({ method: 'GET', url: '/logos/zone1/imagecache/9' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBeUndefined();

    h.tvhGetRaw.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const denied = await h.app.inject({ method: 'GET', url: '/logos/zone1/imagecache/9' });
    expect(denied.statusCode).toBe(404);
  });

  it('502s when the upstream fetch throws', async () => {
    const h = await harness();
    h.tvhGetRaw.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
    const res = await h.app.inject({ method: 'GET', url: '/logos/zone1/imagecache/1' });
    expect(res.statusCode).toBe(502);
  });
});

// ---------- cold backup ----------

describe('restreamer cold backup routes', () => {
  async function createChannelWithColdPlacement(h: Harness): Promise<{ channel: RestreamChannel; coldId: string }> {
    const profile = await createProfile(h.app);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: profile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json() as RestreamChannel;
    const addedCold = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements`,
      payload: { instanceId: 'zone1', nodeId: 'n2', mode: 'cold' },
    });
    expect(addedCold.statusCode).toBe(201);
    return { channel, coldId: (addedCold.json() as { id: string }).id };
  }

  async function seedFailoverRow(
    h: Harness,
    channelId: string,
    fields: {
      fromPlacementId: string | null;
      toPlacementId: string;
      suppressFrom?: boolean;
      phase?: string;
    },
  ): Promise<void> {
    await h.ctx.db!
      .insertInto('restream_failover_state')
      .values({
        channel_id: channelId,
        from_placement_id: fields.fromPlacementId,
        to_placement_id: fields.toPlacementId,
        phase: fields.phase ?? 'complete',
        trigger_reason: 'manual',
        trigger_node_id: null,
        trigger_detail: null,
        suppress_from: fields.suppressFrom ? 1 : 0,
        drain_until: null,
        started_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      })
      .execute();
  }

  it('placement create accepts mode and echoes it; invalid mode -> 400', async () => {
    const h = await harness();
    const { channel, coldId } = await createChannelWithColdPlacement(h);
    expect(coldId).toBeTruthy();

    const badCreate = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements`,
      payload: { instanceId: 'zone2', nodeId: 'n1', mode: 'weird' },
    });
    expect(badCreate.statusCode).toBe(400);
  });

  it('PUT placement patch flips mode; invalid mode -> 400', async () => {
    const h = await harness();
    const { coldId } = await createChannelWithColdPlacement(h);

    const flipped = await h.app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { mode: 'hot' },
    });
    expect(flipped.statusCode).toBe(200);
    expect((flipped.json() as { mode: string }).mode).toBe('hot');

    const badPatch = await h.app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { mode: 'weird' },
    });
    expect(badPatch.statusCode).toBe(400);
  });

  it('placement create accepts profileId and echoes it; invalid type -> 400', async () => {
    const h = await harness();
    const { channel } = await createChannelWithColdPlacement(h);
    const overrideProfile = await createProfile(h.app, 'override');

    const created = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements`,
      payload: { instanceId: 'zone2', nodeId: 'n1', profileId: overrideProfile.id, force: true },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { profileId: string | null }).profileId).toBe(overrideProfile.id);

    const badCreate = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/placements`,
      payload: { instanceId: 'zone2', nodeId: 'n1', profileId: 42, force: true },
    });
    expect(badCreate.statusCode).toBe(400);
  });

  it('PUT placement patch sets and clears profileId; invalid type -> 400', async () => {
    const h = await harness();
    const { coldId } = await createChannelWithColdPlacement(h);
    const overrideProfile = await createProfile(h.app, 'override');

    const set = await h.app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { profileId: overrideProfile.id },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { profileId: string | null }).profileId).toBe(overrideProfile.id);

    const cleared = await h.app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { profileId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { profileId: string | null }).profileId).toBeNull();

    const badPatch = await h.app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { profileId: 42 },
    });
    expect(badPatch.statusCode).toBe(400);
  });

  it('GET channels carries failover:null when no row; a complete row populates failover and per-placement indicators', async () => {
    const h = await harness();
    const { channel, coldId } = await createChannelWithColdPlacement(h);

    const before = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const beforeChan = (before.json() as RestreamChannelWithStatus[]).find((c) => c.id === channel.id)!;
    expect(beforeChan.failover).toBeNull();
    expect(beforeChan.placements.every((p) => p.indicator === 'idle')).toBe(true);

    const hotId = beforeChan.placements.find((p) => p.id !== coldId)!.id;
    await seedFailoverRow(h, channel.id, { fromPlacementId: hotId, toPlacementId: coldId, suppressFrom: true });

    const after = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const afterChan = (after.json() as RestreamChannelWithStatus[]).find((c) => c.id === channel.id)!;
    expect(afterChan.failover).toMatchObject({
      toPlacementId: coldId,
      phase: 'complete',
      triggerReason: 'manual',
    });
    // 'active' on the to_placement; 'stopped' on the suppressed (suppress_from=1) from
    expect(afterChan.placements.find((p) => p.id === coldId)!.indicator).toBe('active');
    expect(afterChan.placements.find((p) => p.id === hotId)!.indicator).toBe('stopped');
  });

  it('GET channels: an unsuppressed complete row leaves the from placement idle', async () => {
    const h = await harness();
    const { channel, coldId } = await createChannelWithColdPlacement(h);
    const list = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const hotId = (list.json() as RestreamChannelWithStatus[])
      .find((c) => c.id === channel.id)!
      .placements.find((p) => p.id !== coldId)!.id;
    await seedFailoverRow(h, channel.id, { fromPlacementId: hotId, toPlacementId: coldId, suppressFrom: false });

    const after = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const afterChan = (after.json() as RestreamChannelWithStatus[]).find((c) => c.id === channel.id)!;
    expect(afterChan.placements.find((p) => p.id === hotId)!.indicator).toBe('idle');
  });

  it('POST /channels/:id/cold/deactivate is gone — 404', async () => {
    const h = await harness();
    const { channel } = await createChannelWithColdPlacement(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/cold/deactivate`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT placement on a mid-procedure placement 409s; force:true passes through', async () => {
    const h = await harness();
    const { channel, coldId } = await createChannelWithColdPlacement(h);
    const list = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const hotId = (list.json() as RestreamChannelWithStatus[])
      .find((c) => c.id === channel.id)!
      .placements.find((p) => p.id !== coldId)!.id;
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: hotId,
      toPlacementId: coldId,
      phase: 'bringing-up',
    });

    const denied = await h.app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { priority: 7 },
    });
    expect(denied.statusCode).toBe(409);
    expect((denied.json() as { message: string }).message).toContain('failover in progress');

    const forced = await h.app.inject({
      method: 'PUT',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { priority: 7, force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect((forced.json() as { priority: number }).priority).toBe(7);
  });

  it('DELETE placement on a mid-procedure placement 409s; body {force:true} passes through', async () => {
    const h = await harness();
    const { channel, coldId } = await createChannelWithColdPlacement(h);
    const list = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const hotId = (list.json() as RestreamChannelWithStatus[])
      .find((c) => c.id === channel.id)!
      .placements.find((p) => p.id !== coldId)!.id;
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: hotId,
      toPlacementId: coldId,
      phase: 'awaiting-lag',
    });

    const denied = await h.app.inject({
      method: 'DELETE',
      url: `/api/restreamer/placements/${coldId}`,
    });
    expect(denied.statusCode).toBe(409);
    expect((denied.json() as { message: string }).message).toContain('failover in progress');

    const forced = await h.app.inject({
      method: 'DELETE',
      url: `/api/restreamer/placements/${coldId}`,
      payload: { force: true },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toEqual({ ok: true });
  });

  it('apply delete-sweep leaves a mid-procedure placement in place (route level)', async () => {
    const h = await harness();
    const { channel, coldId } = await createChannelWithColdPlacement(h);
    const list = await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' });
    const hot = (list.json() as RestreamChannelWithStatus[])
      .find((c) => c.id === channel.id)!
      .placements.find((p) => p.id !== coldId)!;
    // first activation: only the cold placement is pinned by the procedure
    await seedFailoverRow(h, channel.id, {
      fromPlacementId: null,
      toPlacementId: coldId,
      phase: 'switch-ordered',
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/apply`,
      payload: {
        placements: [{ id: hot.id, instanceId: hot.instanceId, nodeId: hot.nodeId }],
      },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as RestreamChannelWithStatus).placements.map((p) => p.id).sort();
    expect(ids).toEqual([hot.id, coldId].sort());
  });
});

// ---------- per-node probe settings ----------

describe('GET/PUT /api/restreamer/nodes/:instanceId/:nodeId/probes', () => {
  it('GET returns code defaults when no row is stored', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n1/probes' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(NODE_PROBE_DEFAULTS);
  });

  it('PUT persists and returns the settings; a later GET reflects them', async () => {
    const { app } = await harness();
    const custom: NodeProbeSettings = {
      liveness: { timeoutSeconds: 3, periodSeconds: 8, successThreshold: 1, failureThreshold: 2 },
      underspeed: { timeoutSeconds: 15, periodSeconds: 30, successThreshold: 2, failureThreshold: 4 },
      lag: { timeoutSeconds: 20, periodSeconds: 12, successThreshold: 2, failureThreshold: 2 },
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/probes',
      payload: custom,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(custom);

    const get = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n1/probes' });
    expect(get.json()).toEqual(custom);
    // a different node is unaffected
    const other = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n2/probes' });
    expect(other.json()).toEqual(NODE_PROBE_DEFAULTS);
  });

  it('PUT with an underrun key in the body is accepted and simply ignored', async () => {
    const { app } = await harness();
    const custom: NodeProbeSettings = {
      liveness: { timeoutSeconds: 3, periodSeconds: 8, successThreshold: 1, failureThreshold: 2 },
      underspeed: { timeoutSeconds: 15, periodSeconds: 30, successThreshold: 2, failureThreshold: 4 },
      lag: { timeoutSeconds: 20, periodSeconds: 12, successThreshold: 2, failureThreshold: 2 },
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/probes',
      payload: { ...custom, underrun: { minSpeed: 0.9, periodSeconds: 10, successThreshold: 2, failureThreshold: 3 } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(custom);

    const get = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n1/probes' });
    expect(get.json()).toEqual(custom);
  });

  it('PUT with an invalid body -> 400', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/probes',
      payload: { ...NODE_PROBE_DEFAULTS, liveness: { ...NODE_PROBE_DEFAULTS.liveness, timeoutSeconds: 0 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('an unknown node -> 400', async () => {
    const { app } = await harness();
    const get = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/ghost/probes' });
    expect(get.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/ghost/probes',
      payload: NODE_PROBE_DEFAULTS,
    });
    expect(put.statusCode).toBe(400);
  });
});

// ---------- per-node session capacity ----------

describe('GET/PUT /api/restreamer/nodes/:instanceId/:nodeId/settings', () => {
  it('GET returns {maxSessions: null, initialDelaySec: null} when no row is stored', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n1/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ maxSessions: null, initialDelaySec: null });
  });

  it('PUT persists both fields; a later GET reflects them, and a different node is unaffected', async () => {
    const { app } = await harness();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: { maxSessions: 3, initialDelaySec: 45 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ maxSessions: 3, initialDelaySec: 45 });

    const get = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n1/settings' });
    expect(get.json()).toEqual({ maxSessions: 3, initialDelaySec: 45 });
    const other = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n2/settings' });
    expect(other.json()).toEqual({ maxSessions: null, initialDelaySec: null });
  });

  it('PUT accepts 0 for maxSessions (fully capped) and explicit null for both (clears back to defaults)', async () => {
    const { app } = await harness();
    const zero = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: { maxSessions: 0, initialDelaySec: null },
    });
    expect(zero.statusCode).toBe(200);
    expect(zero.json()).toEqual({ maxSessions: 0, initialDelaySec: null });

    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: { maxSessions: null, initialDelaySec: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ maxSessions: null, initialDelaySec: null });
  });

  it('PUT accepts a positive initialDelaySec and round-trips it alongside maxSessions', async () => {
    const { app } = await harness();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: { maxSessions: null, initialDelaySec: 12 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ maxSessions: null, initialDelaySec: 12 });

    const get = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/n1/settings' });
    expect(get.json()).toEqual({ maxSessions: null, initialDelaySec: 12 });
  });

  it('PUT with an invalid body -> 400: negative, non-integer, wrong type, missing key, non-object', async () => {
    const { app } = await harness();
    const bad = [-1, 1.5, '6', undefined].map((maxSessions) =>
      maxSessions === undefined ? { initialDelaySec: null } : { maxSessions, initialDelaySec: null },
    );
    for (const payload of bad) {
      const res = await app.inject({ method: 'PUT', url: '/api/restreamer/nodes/zone1/n1/settings', payload });
      expect(res.statusCode).toBe(400);
    }
    // explicit null IS valid -- re-assert separately so the loop above only covers genuinely invalid bodies
    const nullOk = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: { maxSessions: null, initialDelaySec: null },
    });
    expect(nullOk.statusCode).toBe(200);

    const nonObject = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: JSON.stringify('nope'),
      headers: { 'content-type': 'application/json' },
    });
    expect(nonObject.statusCode).toBe(400);
  });

  it('PUT with an invalid initialDelaySec -> 400: zero, negative, non-integer, wrong type, missing key', async () => {
    const { app } = await harness();
    const bad = [0, -1, 1.5, '6', undefined].map((initialDelaySec) =>
      initialDelaySec === undefined ? { maxSessions: null } : { maxSessions: null, initialDelaySec },
    );
    for (const payload of bad) {
      const res = await app.inject({ method: 'PUT', url: '/api/restreamer/nodes/zone1/n1/settings', payload });
      expect(res.statusCode).toBe(400);
    }
    // explicit null and a positive integer ARE valid
    const nullOk = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: { maxSessions: null, initialDelaySec: null },
    });
    expect(nullOk.statusCode).toBe(200);
    const positiveOk = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/n1/settings',
      payload: { maxSessions: null, initialDelaySec: 1 },
    });
    expect(positiveOk.statusCode).toBe(200);
  });

  it('an unknown node -> 400 on both GET and PUT', async () => {
    const { app } = await harness();
    const get = await app.inject({ method: 'GET', url: '/api/restreamer/nodes/zone1/ghost/settings' });
    expect(get.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/restreamer/nodes/zone1/ghost/settings',
      payload: { maxSessions: 1, initialDelaySec: null },
    });
    expect(put.statusCode).toBe(400);
  });
});

// ---------- profile clone ----------

describe('POST /api/restreamer/profiles/:id/clone', () => {
  it('clones the payload verbatim under a new name, 201', async () => {
    const { app } = await harness();
    const original = await createProfile(app, 'hd');
    const res = await app.inject({
      method: 'POST',
      url: `/api/restreamer/profiles/${original.id}/clone`,
      payload: { name: 'hd-2' },
    });
    expect(res.statusCode).toBe(201);
    const cloned = res.json() as RestreamProfile;
    expect(cloned.id).not.toBe(original.id);
    expect(cloned.name).toBe('hd-2');
    expect(cloned.payload).toEqual(original.payload);
  });

  it('409s a name conflict', async () => {
    const { app } = await harness();
    const original = await createProfile(app, 'hd');
    await createProfile(app, 'taken');
    const res = await app.inject({
      method: 'POST',
      url: `/api/restreamer/profiles/${original.id}/clone`,
      payload: { name: 'taken' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('404s an unknown source profile', async () => {
    const { app } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/restreamer/profiles/ghost/clone',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------- transactional channel apply ----------

describe('POST /api/restreamer/channels/:id/apply', () => {
  it('applies a channel patch and a full placement replacement (create + keep/reorder + delete) in one call', async () => {
    const h = await harness();
    const profile = await createProfile(h.app);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'BBB', // resolves via tvh topology on both zone1 and zone2
        channelNumber: '10',
        profileId: profile.id,
        placements: [
          { instanceId: 'zone1', nodeId: 'n1' }, // priority 1 -> KEPT, reordered to priority 2
          { instanceId: 'zone1', nodeId: 'n2' }, // priority 2 -> DELETED
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json() as RestreamChannel;
    const before = (await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' })).json() as RestreamChannelWithStatus[];
    const existing = before.find((c) => c.id === channel.id)!.placements;
    const keepId = existing.find((p) => p.nodeId === 'n1')!.id;
    const deleteId = existing.find((p) => p.nodeId === 'n2')!.id;

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/apply`,
      payload: {
        channel: { comment: 'updated via apply' },
        placements: [
          { instanceId: 'zone2', nodeId: 'n1' }, // NEW -> priority 1
          { id: keepId, instanceId: 'zone1', nodeId: 'n1' }, // KEPT -> priority 2
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as RestreamChannelWithStatus;
    expect(updated.comment).toBe('updated via apply');
    expect(updated.placements.map((p) => p.id)).not.toContain(deleteId);

    const rows = await h.ctx.db!
      .selectFrom('restream_placements')
      .selectAll()
      .where('channel_id', '=', channel.id)
      .orderBy('priority')
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ instance_id: 'zone2', node_id: 'n1', priority: 1 });
    expect(rows[1]).toMatchObject({ id: keepId, instance_id: 'zone1', node_id: 'n1', priority: 2 });
  });

  it('409s a duplicate node within the desired placement set', async () => {
    const h = await harness();
    const profile = await createProfile(h.app);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: { channelName: 'BBB', channelNumber: '10', profileId: profile.id },
    });
    const channel = created.json() as RestreamChannel;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/apply`,
      payload: {
        placements: [
          { instanceId: 'zone1', nodeId: 'n1' },
          { instanceId: 'zone1', nodeId: 'n1' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('availability 409 carries unavailable[]; force bypasses', async () => {
    const h = await harness();
    seedNodeStatus(h.cache, 'zone2', 'n1', [], []); // known-empty catalog — no fallback either
    const profile = await createProfile(h.app);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: { channelName: 'AT-X', channelNumber: '9.1', profileId: profile.id },
    });
    const channel = created.json() as RestreamChannel;

    const denied = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/apply`,
      payload: { placements: [{ instanceId: 'zone2', nodeId: 'n1' }] }, // zone2 has no AT-X 9.1
    });
    expect(denied.statusCode).toBe(409);
    const body = denied.json() as { error: string; unavailable: Array<{ instanceId: string; nodeId: string }> };
    expect(body.unavailable).toEqual([{ instanceId: 'zone2', nodeId: 'n1', reason: expect.any(String) }]);

    const forced = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/apply`,
      payload: { placements: [{ instanceId: 'zone2', nodeId: 'n1' }], force: true },
    });
    expect(forced.statusCode).toBe(200);
  });

  it('persists placement profileId on new and existing placements; invalid type -> 400', async () => {
    // no switcher -- this tests the DIRECT-write path; switcher-fronted
    // cutover routing is covered in restreamerService.test.ts
    const h = await harness({ restreamer: {} });
    const channelProfile = await createProfile(h.app, 'channel-profile');
    const overrideProfile = await createProfile(h.app, 'override-profile');
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'BBB', // resolves via tvh topology on both zone1 and zone2
        channelNumber: '10',
        profileId: channelProfile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json() as RestreamChannel;
    const before = (await h.app.inject({ method: 'GET', url: '/api/restreamer/channels' })).json() as RestreamChannelWithStatus[];
    const existingId = before.find((c) => c.id === channel.id)!.placements.find((p) => p.nodeId === 'n1')!.id;

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/apply`,
      payload: {
        placements: [
          { id: existingId, instanceId: 'zone1', nodeId: 'n1', profileId: overrideProfile.id },
          { instanceId: 'zone2', nodeId: 'n1', profileId: null },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as RestreamChannelWithStatus;
    expect(updated.placements.find((p) => p.id === existingId)!.profileId).toBe(overrideProfile.id);
    expect(updated.placements.find((p) => p.instanceId === 'zone2')!.profileId).toBeNull();

    const bad = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/apply`,
      payload: {
        placements: [{ id: existingId, instanceId: 'zone1', nodeId: 'n1', profileId: 42 }],
      },
    });
    expect(bad.statusCode).toBe(400);
  });
});

// ---------- batch edit playlistIds ----------

describe('POST /api/restreamer/channels/batch — playlistIds', () => {
  it('an edit patch carrying playlistIds replaces channel memberships', async () => {
    const h = await harness();
    const profile = await createProfile(h.app);
    const pl1 = await createPlaylist(h.app, { slug: 'a', title: 'A' });
    const pl2 = await createPlaylist(h.app, { slug: 'b', title: 'B' });
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: profile.id,
        playlistIds: [pl1.id],
      },
    });
    const channel = created.json() as RestreamChannel;
    expect(channel.playlistIds).toEqual([pl1.id]);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels/batch',
      payload: { action: 'edit', ids: [channel.id], patch: { playlistIds: [pl2.id] } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Array<{ ok: boolean }>)[0]!.ok).toBe(true);

    const updated = (await h.service.getChannel(channel.id))!;
    expect(updated.playlistIds).toEqual([pl2.id]);
  });
});

// ---------- session restart-counter reset passthrough ----------

describe('POST /api/restreamer/nodes/:instanceId/:nodeId/sessions/:name/restarts/reset', () => {
  it('passes through to the node client; unknown node -> 404', async () => {
    const { app, resetSessionRestarts } = await harness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/restreamer/nodes/zone1/n1/sessions/at-x/restarts/reset',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(resetSessionRestarts).toHaveBeenCalledWith('at-x');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/restreamer/nodes/zone1/ghost/sessions/at-x/restarts/reset',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('unreachable node surfaces as 502', async () => {
    const { app, resetSessionRestarts } = await harness();
    resetSessionRestarts.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/restreamer/nodes/zone1/n1/sessions/at-x/restarts/reset',
    });
    expect(res.statusCode).toBe(502);
  });
});

// ---------- nodes / no-DB mode ----------

describe('restreamer nodes + overview-only mode', () => {
  it('GET /api/restreamer/nodes lists cache statuses and the aggregate switcher entry (no DB required)', async () => {
    const cache = new InstanceCache();
    cache.init('zone1', 'zone1', 'http://zone1:9981');
    seedNodeStatus(cache, 'zone1', 'n1', [sessionStatus('at-x')]);
    seedReplicaStatus(cache, { channels: [], publicUrl: 'http://sw.example', replicaCount: 2 });
    const ctx = {
      config: makeConfig(),
      cache,
      restreamer: null,
      restreamerClients: new Map(),
      tvhHttp: new Map(),
    } as unknown as AppContext;
    const app = Fastify();
    registerRestreamerRoutes(app, ctx);
    await app.ready();
    closers.push(async () => app.close());

    const nodes = await app.inject({ method: 'GET', url: '/api/restreamer/nodes' });
    expect(nodes.statusCode).toBe(200);
    const body = nodes.json() as { nodes: unknown[]; switchers: Array<{ replicaCount?: number }> };
    expect(body.nodes).toHaveLength(1);
    expect(body.switchers).toHaveLength(1);
    expect(body.switchers[0]!.replicaCount).toBe(2);

    // DB-backed routes 503 in overview-only mode
    for (const url of ['/api/restreamer/profiles', '/api/restreamer/channels', '/playlists/tv.m3u']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
    }
    const push = await app.inject({ method: 'POST', url: '/api/restreamer/nodes/zone1/n1/push' });
    expect(push.statusCode).toBe(503);
  });

  it('POST push forces a node push through the service', async () => {
    const { app } = await harness();
    const profile = await createProfile(app);
    await app.inject({
      method: 'POST',
      url: '/api/restreamer/channels',
      payload: {
        channelName: 'AT-X',
        channelNumber: '9.1',
        profileId: profile.id,
        placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/restreamer/nodes/zone1/n1/push' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { action: string };
    expect(body.action).toBe('pushed');
  });
});
