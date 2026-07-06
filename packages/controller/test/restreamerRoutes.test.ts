/*
 * Restreamer REST route tests: real Fastify app via inject(), hermetic
 * in-memory SQLite (createTestDb), real RestreamerService with fake nodes at
 * the client boundary, hand-built AppContext. No network, no real pollers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  RestreamChannel,
  RestreamChannelWithStatus,
  RestreamPlaylist,
  RestreamProfile,
  SessionStatus,
  SourceCatalogEntry,
} from '@tvhc/shared';
import type { AppConfig } from '../src/config.js';
import type { InstancePoller } from '../src/tvh/poller.js';
import { RestreamerError } from '../src/restreamer/client.js';
import type { RestreamerClient, SwitcherClient } from '../src/restreamer/client.js';
import {
  RestreamerService,
  nodeKey,
  type RestreamerNodeClient,
} from '../src/restreamer/service.js';
import { registerRestreamerRoutes } from '../src/routes/restreamer.js';
import type { AppContext } from '../src/routes/context.js';
import type { TvhClient } from '../src/tvh/client.js';
import { EventBus } from '../src/state/events.js';
import { InstanceCache, type TopologySnapshot } from '../src/state/instanceCache.js';
import { createTestDb } from './support/testDb.js';
import { fakeRestreamerNode } from './support/fakeRestreamerNode.js';

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

function zone2Topology(): TopologySnapshot {
  return {
    channels: [{ uuid: 'ch2-bbb', name: 'BBB', number: '10', services: ['svc2-bbb'] }],
    tags: [],
    dvrConfigs: [],
    muxes: [],
    services: [{ uuid: 'svc2-bbb', sid: 202 }],
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
    restreamer: { switchers: [{ id: 'sw1', url: 'http://sw1:5581', publicUrl: 'http://sw.example' }] },
    ...overrides,
  };
}

function profilePayload(): unknown {
  return { template: 'arib-hls', templateVersion: 1, video: { mode: 'ivtc' }, audio: [{}] };
}

function sessionStatus(name: string, state: SessionStatus['state'] = 'running'): SessionStatus {
  return { name, state, enabled: true, configHash: 'h', restarts: 0, consecutiveFailures: 0 };
}

function seedNodeStatus(
  cache: InstanceCache,
  instanceId: string,
  nodeId: string,
  sessions: SessionStatus[] = [],
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
      sessions,
      sourcesHash: sources === null ? null : 'h1',
      sources,
    },
  ];
}

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  cache: InstanceCache;
  service: RestreamerService;
  restartSession: ReturnType<typeof vi.fn>;
  sessionLog: ReturnType<typeof vi.fn>;
  switchChannel: ReturnType<typeof vi.fn>;
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
      } as unknown as RestreamerClient);
    }
  }
  const switchChannel = vi.fn(async () => {});
  const putDesired = vi.fn(async () => {});
  const switcherClients = new Map<string, SwitcherClient>();
  for (const sw of config.restreamer?.switchers ?? []) {
    switcherClients.set(sw.id, { switchChannel, putDesired } as unknown as SwitcherClient);
  }
  const tvhGetRaw = vi.fn(
    async () => new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }),
  );
  const tvhHttp = new Map<string, TvhClient>();
  for (const inst of config.instances) {
    tvhHttp.set(inst.id, { getRaw: tvhGetRaw } as unknown as TvhClient);
  }
  // the service gets the switcher clients too (reset switching goes through it)
  const service = new RestreamerService(db, cache, pollers, bus, config, clients, switcherClients);
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
    switcherClients,
    switcherPollers: [],
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
    switchChannel,
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
  body: { slug: string; title: string; epgUrl?: string | null },
): Promise<RestreamPlaylist> {
  const res = await app.inject({ method: 'POST', url: '/api/restreamer/playlists', payload: body });
  expect(res.statusCode).toBe(201);
  return res.json() as RestreamPlaylist;
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
    seedNodeStatus(cache, 'zone1', 'n1', [sessionStatus('at-x')]);

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
    // availability checks it) — sessions running so the entries render
    seedNodeStatus(
      h.cache,
      'zone1',
      'n1',
      [sessionStatus('at-x'), sessionStatus('cam-1'), sessionStatus('cam-9')],
      [CAM],
    );

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
    // "Cam 1" is absent from zone1's tvh topology — resolves via the node catalog
    await post({
      channelName: 'Cam 1',
      channelNumber: '5', // matches CAM's chno exactly
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    // resolves nowhere (neither tvh nor the catalog) → identity falls back to nulls
    await post({
      channelName: 'Cam 9',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
      force: true,
    });

    const res = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(res.statusCode).toBe(200);
    // chno sort: cam1 ("5") < AT-X ("9.1") < cam9 (numberless last); the
    // catalog-resolved logo is the entry value VERBATIM (never proxied),
    // tvg-id is the catalog entry id, tvg-chno the catalog chno
    expect(res.body).toBe(
      [
        '#EXTM3U',
        '#PLAYLIST:TV',
        '#KODIPROP:mimetype=application/x-mpegURL',
        '#EXTINF:-1 tvg-id="cam1" tvg-chno="5" x-url="cam-1" tvg-logo="http://logos.example/cam1.png",Cam 1',
        'http://sw.example/hls/cam-1/playlist.m3u8',
        '#EXTINF:-1 tvg-id="ch-atx-91" tvg-chno="9.1" x-url="at-x" tvg-logo="http://ctrl.example/logos/zone1/imagecache/32736",AT-X',
        'http://sw.example/hls/at-x/playlist.m3u8',
        '#EXTINF:-1 x-url="cam-9",Cam 9',
        'http://sw.example/hls/cam-9/playlist.m3u8',
        '',
      ].join('\n'),
    );
  });
});

// ---------- manual switch ----------

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

  it('passes through to the switcher that reports the slug', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    h.cache.switchers.set('sw1', {
      switcherId: 'sw1',
      url: 'http://sw1:5581',
      publicUrl: 'http://sw.example',
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '1.0.0',
      pendingPush: false,
      channels: [
        {
          slug: 'bbb',
          activeUpstreamId: placements[0]!.id,
          upstreams: placements.map((p) => ({ id: p.id, healthy: true })),
          lastSwitch: null,
        },
      ],
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[1]!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.switchChannel).toHaveBeenCalledWith('bbb', placements[1]!.id);
  });

  it('falls back to the first configured switcher when none reports the slug yet', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[0]!.id },
    });
    expect(res.statusCode).toBe(200);
    expect(h.switchChannel).toHaveBeenCalledWith('bbb', placements[0]!.id);
  });

  it('400 when the placement does not belong to the channel; 404 for an unknown channel', async () => {
    const h = await harness();
    const { channel } = await seedRedundantChannel(h);
    const bad = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: 'not-a-placement-of-this-channel' },
    });
    expect(bad.statusCode).toBe(400);
    expect(h.switchChannel).not.toHaveBeenCalled();

    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/restreamer/channels/ghost/switch',
      payload: { placementId: 'p1' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('503 when no switcher is configured', async () => {
    const h = await harness({ restreamer: undefined });
    const { channel, placements } = await seedRedundantChannel(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[0]!.id },
    });
    expect(res.statusCode).toBe(503);
  });

  it('maps a switcher-side 404 (unknown slug/upstream) through, unreachable to 502', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);

    h.switchChannel.mockRejectedValueOnce(
      new RestreamerError(404, '/v1/channels/bbb/switch', 'unknown upstream'),
    );
    const notFound = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[1]!.id },
    });
    expect(notFound.statusCode).toBe(404);

    h.switchChannel.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
    const down = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { placementId: placements[1]!.id },
    });
    expect(down.statusCode).toBe(502);
  });

  // ---------- {reset: true} — back to the highest-priority healthy upstream ----------

  function seedSwitcherStatus(
    h: Harness,
    channels: Array<{
      slug: string;
      activeUpstreamId: string | null;
      upstreams: Array<{ id: string; healthy: boolean }>;
    }>,
  ): void {
    h.cache.switchers.set('sw1', {
      switcherId: 'sw1',
      url: 'http://sw1:5581',
      publicUrl: 'http://sw.example',
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '1.0.0',
      pendingPush: false,
      channels: channels.map((c) => ({ ...c, lastSwitch: null })),
    });
  }

  it('reset switches to the lowest-priority-number healthy placement', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    seedSwitcherStatus(h, [
      {
        slug: 'bbb',
        activeUpstreamId: placements[1]!.id, // manually switched away earlier
        upstreams: placements.map((p) => ({ id: p.id, healthy: true })),
      },
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, already: false });
    expect(h.switchChannel).toHaveBeenCalledWith('bbb', placements[0]!.id);
  });

  it('reset skips an unhealthy priority-1 upstream and picks priority-2', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    seedSwitcherStatus(h, [
      {
        slug: 'bbb',
        activeUpstreamId: placements[0]!.id,
        upstreams: [
          { id: placements[0]!.id, healthy: false },
          { id: placements[1]!.id, healthy: true },
        ],
      },
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, already: false });
    expect(h.switchChannel).toHaveBeenCalledWith('bbb', placements[1]!.id);
  });

  it('reset is a no-op when the target upstream is already active', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    seedSwitcherStatus(h, [
      {
        slug: 'bbb',
        activeUpstreamId: placements[0]!.id,
        upstreams: placements.map((p) => ({ id: p.id, healthy: true })),
      },
    ]);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, already: true });
    expect(h.switchChannel).not.toHaveBeenCalled();
  });

  it('reset 409s when the switcher reports no healthy upstream (or no channel at all)', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);

    // no switcher reports the slug yet
    const unknown = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(unknown.statusCode).toBe(409);

    seedSwitcherStatus(h, [
      {
        slug: 'bbb',
        activeUpstreamId: placements[0]!.id,
        upstreams: placements.map((p) => ({ id: p.id, healthy: false })),
      },
    ]);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/restreamer/channels/${channel.id}/switch`,
      payload: { reset: true },
    });
    expect(res.statusCode).toBe(409);
    expect(h.switchChannel).not.toHaveBeenCalled();
  });

  it('400s a body with both, neither, or a non-true reset', async () => {
    const h = await harness();
    const { channel, placements } = await seedRedundantChannel(h);
    for (const payload of [
      {},
      { placementId: placements[0]!.id, reset: true },
      { reset: false },
    ]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/api/restreamer/channels/${channel.id}/switch`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(h.switchChannel).not.toHaveBeenCalled();
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
    const created = await createPlaylist(app, { slug: 'tv', title: 'TV', epgUrl: 'http://epg.example/x' });

    const dup = await app.inject({
      method: 'POST',
      url: '/api/restreamer/playlists',
      payload: { slug: 'tv', title: 'Other' },
    });
    expect(dup.statusCode).toBe(409);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/restreamer/playlists/${created.id}`,
      payload: { title: 'TV 2', epgUrl: null },
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as RestreamPlaylist).title).toBe('TV 2');
    expect((updated.json() as RestreamPlaylist).epgUrl).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/restreamer/playlists' });
    expect((list.json() as RestreamPlaylist[]).map((p) => p.slug)).toEqual(['tv']);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/restreamer/playlists/${created.id}` });
    expect(deleted.statusCode).toBe(200);
  });
});

describe('GET /playlists/:slug.m3u', () => {
  /** playlist with AT-X (single placement), BBB (redundant), CCC (not running) */
  async function seedM3uFixture(h: Harness): Promise<void> {
    const profile = await createProfile(h.app);
    const playlist = await createPlaylist(h.app, {
      slug: 'tv',
      title: 'Mock TV',
      epgUrl: 'http://epg.example/xmltv',
    });
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
    // member but its session is not running -> excluded
    await post({
      channelName: 'CCC',
      channelNumber: '3',
      profileId: profile.id,
      playlistIds: [playlist.id],
      placements: [{ instanceId: 'zone1', nodeId: 'n1' }],
    });
    seedNodeStatus(h.cache, 'zone1', 'n1', [
      sessionStatus('at-x'),
      sessionStatus('bbb'),
      sessionStatus('ccc', 'backoff'),
    ]);
    seedNodeStatus(h.cache, 'zone2', 'n1', [sessionStatus('bbb')]);
  }

  it('renders the prod format: header, EXTINF attrs, URL rule, sort, running filter', async () => {
    const h = await harness();
    await seedM3uFixture(h);

    const res = await h.app.inject({
      method: 'GET',
      url: '/playlists/tv.m3u',
      headers: { host: 'ctrl.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/x-mpegurl');
    // sorted by chanNumberOrder: "9.1" before "10" (numeric, not lexical);
    // CCC ("3") would sort first but is excluded (session not running);
    // a switcher is configured -> EVERY entry (single-placement AT-X included)
    // points at the switcher publicUrl — uniform viewer URLs;
    // relative imagecache icon -> controller logo proxy against the request
    // base (no forwarded headers, no configured publicUrl here); absolute
    // icon (BBB) passes through verbatim
    expect(res.body).toBe(
      [
        '#EXTM3U url-tvg=http://epg.example/xmltv',
        '#PLAYLIST:Mock TV',
        '#KODIPROP:mimetype=application/x-mpegURL',
        '#EXTINF:-1 tvg-id="ch-atx-91" tvg-chno="9.1" x-url="at-x" tvg-logo="http://ctrl.example/logos/zone1/imagecache/32736",AT-X',
        'http://sw.example/hls/at-x/playlist.m3u8',
        '#EXTINF:-1 tvg-id="ch-bbb" tvg-chno="10" x-url="bbb" tvg-logo="http://icons.example/bbb.png",BBB',
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
        switchers: [{ id: 'sw1', url: 'http://sw1:5581', publicUrl: 'http://sw.example' }],
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

  it('omits url-tvg when the playlist has no epgUrl', async () => {
    const h = await harness();
    await createPlaylist(h.app, { slug: 'bare', title: 'Bare' });
    const res = await h.app.inject({ method: 'GET', url: '/playlists/bare.m3u' });
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\n')[0]).toBe('#EXTM3U');
  });

  it('uses direct node serveUrls without a switcher (single and redundant alike)', async () => {
    const h = await harness({ restreamer: undefined });
    await seedM3uFixture(h);
    const res = await h.app.inject({ method: 'GET', url: '/playlists/tv.m3u' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http://hls.zone1-n1/at-x/playlist.m3u8');
    // redundant channel: first placement whose node has a serveUrl
    expect(res.body).toContain('http://hls.zone1-n1/bbb/playlist.m3u8');
    expect(res.body).not.toContain('sw.example');
  });

  it('404s for an unknown playlist slug', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/playlists/nope.m3u' });
    expect(res.statusCode).toBe(404);
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

// ---------- nodes / no-DB mode ----------

describe('restreamer nodes + overview-only mode', () => {
  it('GET /api/restreamer/nodes lists cache statuses and switchers (no DB required)', async () => {
    const cache = new InstanceCache();
    cache.init('zone1', 'zone1', 'http://zone1:9981');
    seedNodeStatus(cache, 'zone1', 'n1', [sessionStatus('at-x')]);
    cache.switchers.set('sw1', {
      switcherId: 'sw1',
      url: 'http://sw1:5581',
      publicUrl: 'http://sw.example',
      reachable: true,
      error: null,
      lastPollAt: null,
      version: '0.0.0-test',
      pendingPush: false,
      channels: [],
    });
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
    const body = nodes.json() as { nodes: unknown[]; switchers: unknown[] };
    expect(body.nodes).toHaveLength(1);
    expect(body.switchers).toHaveLength(1);

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
