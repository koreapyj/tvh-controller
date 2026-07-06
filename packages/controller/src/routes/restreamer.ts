/*
 * tvh-controller - Centralized tvheadend controller
 * Copyright (C) 2026 Yoonji Park
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { chanNumberOrder } from '@tvhc/shared';
import type { RestreamChannelWithStatus } from '@tvhc/shared';
import type { AppConfig } from '../config.js';
import {
  nodeKey,
  resolveTvhChannel,
  type ChannelBatchAction,
  type ChannelPatch,
  type CreateChannelInput,
  type PlacementInput,
  type PlacementPatch,
} from '../restreamer/service.js';
import { RestreamerError } from '../restreamer/client.js';
import { httpError, requireDb, type AppContext } from './context.js';

const BATCH_ACTIONS: ReadonlySet<ChannelBatchAction> = new Set([
  'edit',
  'delete',
  'enable',
  'disable',
  'add-playlist',
  'remove-playlist',
]);

function asObject(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw httpError(400, `${what} must be a JSON object`);
  }
  return body as Record<string, unknown>;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw httpError(400, `${field} is required`);
  return v;
}

function optionalStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw httpError(400, `${field} must be an array of strings`);
  }
  return v as string[];
}

/** channel numbers are STRING identity — a YAML/JSON number is stringified, never compared numerically */
function parseChannelNumber(v: unknown, field: string): string | null {
  if (v == null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw httpError(400, `${field} must be a string (or null to pin the lowest-numbered channel)`);
  }
  return String(v);
}

function parsePlacementInput(raw: unknown): PlacementInput {
  const p = asObject(raw, 'placement');
  const input: PlacementInput = {
    instanceId: requireString(p.instanceId, 'placement.instanceId'),
    nodeId: requireString(p.nodeId, 'placement.nodeId'),
  };
  if (p.priority !== undefined) {
    if (typeof p.priority !== 'number') throw httpError(400, 'placement.priority must be a number');
    input.priority = p.priority;
  }
  if (p.enabled !== undefined) input.enabled = !!p.enabled;
  if (p.weight !== undefined) {
    if (p.weight !== null && typeof p.weight !== 'number') {
      throw httpError(400, 'placement.weight must be a number or null');
    }
    input.weight = p.weight;
  }
  if (p.programNumber !== undefined) {
    if (p.programNumber !== null && typeof p.programNumber !== 'number') {
      throw httpError(400, 'placement.programNumber must be a number or null');
    }
    input.programNumber = p.programNumber;
  }
  return input;
}

function parseChannelPatch(raw: unknown): ChannelPatch {
  const b = asObject(raw, 'request body');
  const patch: ChannelPatch = {};
  if (b.channelName !== undefined) patch.channelName = requireString(b.channelName, 'channelName');
  if (b.channelNumber !== undefined) patch.channelNumber = parseChannelNumber(b.channelNumber, 'channelNumber');
  if (b.profileId !== undefined) patch.profileId = requireString(b.profileId, 'profileId');
  if (b.slug !== undefined) patch.slug = requireString(b.slug, 'slug');
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.comment !== undefined) patch.comment = b.comment == null ? null : String(b.comment);
  const playlistIds = optionalStringArray(b.playlistIds, 'playlistIds');
  if (playlistIds !== undefined) patch.playlistIds = playlistIds;
  return patch;
}

/** node/session passthrough failures: node-side 4xx keeps its status, everything else is a 502 */
function passthroughError(err: unknown): Error {
  if (err instanceof RestreamerError && err.status >= 400 && err.status < 500) {
    return httpError(err.status, err.message);
  }
  return httpError(502, `restreamer node unreachable: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------
// Master playlist M3U generation
// ---------------------------------------------------------------------------

function nodeServeUrl(config: AppConfig, instanceId: string, nodeId: string): string | null {
  return (
    config.instances
      .find((i) => i.id === instanceId)
      ?.restreamer?.nodes.find((n) => n.id === nodeId)?.serveUrl ?? null
  );
}

/**
 * Viewer-facing entry URL (mirrors the plan's playlist URL rule): one enabled
 * placement → straight at that node's serveUrl; several (redundant channel) →
 * the first configured switcher's publicUrl, falling back to the first
 * placement whose node has a serveUrl when no switcher is configured.
 */
function entryUrl(config: AppConfig, channel: RestreamChannelWithStatus): string | null {
  const enabled = channel.placements.filter((p) => p.enabled);
  if (enabled.length === 0) return null;
  if (enabled.length === 1) {
    const serveUrl = nodeServeUrl(config, enabled[0]!.instanceId, enabled[0]!.nodeId);
    return serveUrl ? `${serveUrl}/${channel.slug}/playlist.m3u8` : null;
  }
  const sw = config.restreamer?.switchers[0];
  if (sw) return `${sw.publicUrl}/hls/${channel.slug}/playlist.m3u8`;
  for (const p of enabled) {
    const serveUrl = nodeServeUrl(config, p.instanceId, p.nodeId);
    if (serveUrl) return `${serveUrl}/${channel.slug}/playlist.m3u8`;
  }
  return null;
}

/** `imagecache/32736`-style icon paths become absolute against the instance url */
function absolutizeIcon(icon: string, instanceUrl: string): string {
  if (/^https?:\/\//i.test(icon)) return icon;
  return `${instanceUrl.replace(/\/+$/, '')}/${icon.replace(/^\/+/, '')}`;
}

interface EntryIdentity {
  uuid: string | null;
  number: string | null;
  logo: string | null;
}

/**
 * tvg-id / tvg-chno / tvg-logo come from the controller channel resolved
 * against a live topology — first enabled placement (priority order) whose
 * instance resolves wins. Same (name, exact-string number | pin-lowest)
 * identity rules as the desired-doc computation.
 */
function resolveEntryIdentity(ctx: AppContext, channel: RestreamChannelWithStatus): EntryIdentity {
  for (const p of channel.placements) {
    if (!p.enabled || !ctx.cache.has(p.instanceId)) continue;
    const topo = ctx.cache.get(p.instanceId).topology;
    if (!topo) continue;
    const resolved = resolveTvhChannel(topo.channels, channel.channelName, channel.channelNumber);
    if (!resolved) continue;
    const instanceUrl =
      ctx.config.instances.find((i) => i.id === p.instanceId)?.url ??
      ctx.cache.get(p.instanceId).summary.url;
    const icon = resolved.iconPublicUrl ?? resolved.icon_public_url ?? null;
    return {
      uuid: resolved.uuid,
      number: channel.channelNumber ?? resolved.number ?? null,
      logo: icon ? absolutizeIcon(icon, instanceUrl) : null,
    };
  }
  return { uuid: null, number: channel.channelNumber, logo: null };
}

/**
 * Render one DB-managed master playlist in the production channels.m3u
 * format: members that are enabled and currently RUNNING on at least one
 * enabled placement's node, sorted by chanNumberOrder.
 */
async function renderPlaylistM3u(ctx: AppContext, slug: string): Promise<string> {
  const service = requireDb(ctx.restreamer, 'restream playlists');
  const playlist = (await service.listPlaylists()).find((p) => p.slug === slug);
  if (!playlist) throw httpError(404, `playlist "${slug}" not found`);

  const members = (await service.listChannels()).filter(
    (c) =>
      c.enabled &&
      c.playlistIds.includes(playlist.id) &&
      c.placements.some((p) => p.enabled && p.session?.state === 'running'),
  );

  const entries = members
    .map((channel) => ({ channel, url: entryUrl(ctx.config, channel), identity: resolveEntryIdentity(ctx, channel) }))
    .filter((e): e is typeof e & { url: string } => e.url !== null);
  entries.sort(
    (a, b) =>
      chanNumberOrder(a.identity.number) - chanNumberOrder(b.identity.number) ||
      a.channel.channelName.localeCompare(b.channel.channelName),
  );

  const lines: string[] = [
    playlist.epgUrl ? `#EXTM3U url-tvg=${playlist.epgUrl}` : '#EXTM3U',
    `#PLAYLIST:${playlist.title}`,
    '#KODIPROP:mimetype=application/x-mpegURL',
  ];
  for (const { channel, url, identity } of entries) {
    const attrs: string[] = [];
    if (identity.uuid) attrs.push(`tvg-id="${identity.uuid}"`);
    if (identity.number != null) attrs.push(`tvg-chno="${identity.number}"`);
    attrs.push(`x-url="${channel.slug}"`);
    if (identity.logo) attrs.push(`tvg-logo="${identity.logo}"`);
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${channel.channelName}`);
    lines.push(url);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRestreamerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const svc = (): NonNullable<AppContext['restreamer']> =>
    requireDb(ctx.restreamer, 'restreamer management');

  // ---------- nodes (cache-only; works without a database) ----------

  app.get('/api/restreamer/nodes', async () => ({
    nodes: ctx.cache.all().flatMap((snap) => snap.restreamers),
    switchers: [...ctx.cache.switchers.values()],
  }));

  app.post<{ Params: { instanceId: string; nodeId: string } }>(
    '/api/restreamer/nodes/:instanceId/:nodeId/push',
    async (req) => svc().pushNode(req.params.instanceId, req.params.nodeId, true),
  );

  app.post<{ Params: { instanceId: string; nodeId: string; name: string } }>(
    '/api/restreamer/nodes/:instanceId/:nodeId/sessions/:name/restart',
    async (req) => {
      const { instanceId, nodeId, name } = req.params;
      const client = ctx.restreamerClients.get(nodeKey(instanceId, nodeId));
      if (!client) throw httpError(404, `unknown restreamer node ${nodeKey(instanceId, nodeId)}`);
      try {
        await client.restartSession(name);
      } catch (err) {
        throw passthroughError(err);
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { instanceId: string; nodeId: string; name: string }; Querystring: { lines?: string } }>(
    '/api/restreamer/nodes/:instanceId/:nodeId/sessions/:name/log',
    async (req) => {
      const { instanceId, nodeId, name } = req.params;
      const client = ctx.restreamerClients.get(nodeKey(instanceId, nodeId));
      if (!client) throw httpError(404, `unknown restreamer node ${nodeKey(instanceId, nodeId)}`);
      let lines: number | undefined;
      if (req.query.lines !== undefined) {
        lines = Number(req.query.lines);
        if (!Number.isInteger(lines) || lines <= 0) {
          throw httpError(400, 'lines must be a positive integer');
        }
      }
      try {
        return await client.sessionLog(name, lines);
      } catch (err) {
        throw passthroughError(err);
      }
    },
  );

  // ---------- profiles ----------

  app.get('/api/restreamer/profiles', async () => svc().listProfiles());

  app.post('/api/restreamer/profiles', async (req, reply) => {
    const b = asObject(req.body, 'request body');
    const name = requireString(b.name, 'name');
    if (b.payload === undefined) throw httpError(400, 'payload is required');
    const profile = await svc().createProfile(name, b.payload);
    reply.code(201);
    return profile;
  });

  app.put<{ Params: { id: string } }>('/api/restreamer/profiles/:id', async (req) => {
    const b = asObject(req.body, 'request body');
    const patch: { name?: string; payload?: unknown } = {};
    if (b.name !== undefined) patch.name = requireString(b.name, 'name');
    if (b.payload !== undefined) patch.payload = b.payload;
    return svc().updateProfile(req.params.id, patch);
  });

  app.delete<{ Params: { id: string } }>('/api/restreamer/profiles/:id', async (req) => {
    await svc().deleteProfile(req.params.id);
    return { ok: true };
  });

  // ---------- channels ----------

  app.get('/api/restreamer/channels', async () => svc().listChannels());

  app.post('/api/restreamer/channels', async (req, reply) => {
    const b = asObject(req.body, 'request body');
    const input: CreateChannelInput = {
      channelName: requireString(b.channelName, 'channelName'),
      profileId: requireString(b.profileId, 'profileId'),
    };
    if (b.channelNumber !== undefined) input.channelNumber = parseChannelNumber(b.channelNumber, 'channelNumber');
    if (b.slug !== undefined) input.slug = requireString(b.slug, 'slug');
    if (b.enabled !== undefined) input.enabled = !!b.enabled;
    if (b.comment !== undefined) input.comment = b.comment == null ? null : String(b.comment);
    const playlistIds = optionalStringArray(b.playlistIds, 'playlistIds');
    if (playlistIds !== undefined) input.playlistIds = playlistIds;
    if (b.placements !== undefined) {
      if (!Array.isArray(b.placements)) throw httpError(400, 'placements must be an array');
      input.placements = b.placements.map((p) => parsePlacementInput(p));
    }
    const channel = await svc().createChannel(input);
    reply.code(201);
    return channel;
  });

  app.get<{ Params: { id: string } }>('/api/restreamer/channels/:id', async (req) => {
    const channel = await svc().getChannel(req.params.id);
    if (!channel) throw httpError(404, `restream channel ${req.params.id} not found`);
    return channel;
  });

  app.put<{ Params: { id: string } }>('/api/restreamer/channels/:id', async (req) => {
    return svc().updateChannel(req.params.id, parseChannelPatch(req.body));
  });

  app.delete<{ Params: { id: string } }>('/api/restreamer/channels/:id', async (req) => {
    await svc().deleteChannel(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/restreamer/channels/:id/playlists', async (req) => {
    const b = asObject(req.body, 'request body');
    const playlistIds = optionalStringArray(b.playlistIds, 'playlistIds');
    if (playlistIds === undefined) throw httpError(400, 'playlistIds is required');
    await svc().setChannelPlaylists(req.params.id, playlistIds);
    return { ok: true };
  });

  app.post('/api/restreamer/channels/batch', async (req) => {
    const b = asObject(req.body, 'request body');
    const action = b.action as ChannelBatchAction;
    if (!BATCH_ACTIONS.has(action)) throw httpError(400, `unknown action "${String(b.action)}"`);
    const ids = optionalStringArray(b.ids, 'ids');
    if (!ids || ids.length === 0) throw httpError(400, 'ids[] is required');
    const opts: { patch?: ChannelPatch; playlistId?: string } = {};
    if (action === 'edit') {
      const patch = parseChannelPatch(b.patch ?? {});
      if (Object.keys(patch).length === 0) {
        throw httpError(400, 'patch must contain at least one change');
      }
      opts.patch = patch;
    }
    if (action === 'add-playlist' || action === 'remove-playlist') {
      opts.playlistId = requireString(b.playlistId, 'playlistId');
    }
    return svc().batchChannels(action, ids, opts);
  });

  // ---------- placements ----------

  app.post<{ Params: { id: string } }>('/api/restreamer/channels/:id/placements', async (req, reply) => {
    const placement = await svc().addPlacement(req.params.id, parsePlacementInput(req.body));
    reply.code(201);
    return placement;
  });

  app.put<{ Params: { id: string } }>('/api/restreamer/placements/:id', async (req) => {
    const b = asObject(req.body, 'request body');
    const patch: PlacementPatch = {};
    if (b.instanceId !== undefined) patch.instanceId = requireString(b.instanceId, 'instanceId');
    if (b.nodeId !== undefined) patch.nodeId = requireString(b.nodeId, 'nodeId');
    if (b.priority !== undefined) {
      if (typeof b.priority !== 'number') throw httpError(400, 'priority must be a number');
      patch.priority = b.priority;
    }
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.weight !== undefined) {
      if (b.weight !== null && typeof b.weight !== 'number') {
        throw httpError(400, 'weight must be a number or null');
      }
      patch.weight = b.weight;
    }
    if (b.programNumber !== undefined) {
      if (b.programNumber !== null && typeof b.programNumber !== 'number') {
        throw httpError(400, 'programNumber must be a number or null');
      }
      patch.programNumber = b.programNumber;
    }
    return svc().updatePlacement(req.params.id, patch);
  });

  app.delete<{ Params: { id: string } }>('/api/restreamer/placements/:id', async (req) => {
    await svc().deletePlacement(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    '/api/restreamer/channels/:id/placements/reorder',
    async (req) => {
      const b = asObject(req.body, 'request body');
      const ordered = optionalStringArray(b.orderedPlacementIds, 'orderedPlacementIds');
      if (!ordered) throw httpError(400, 'orderedPlacementIds is required');
      await svc().reorderPlacements(req.params.id, ordered);
      return { ok: true };
    },
  );

  // ---------- playlists ----------

  app.get('/api/restreamer/playlists', async () => svc().listPlaylists());

  app.post('/api/restreamer/playlists', async (req, reply) => {
    const b = asObject(req.body, 'request body');
    const playlist = await svc().createPlaylist({
      slug: requireString(b.slug, 'slug'),
      title: requireString(b.title, 'title'),
      epgUrl: b.epgUrl == null ? null : String(b.epgUrl),
    });
    reply.code(201);
    return playlist;
  });

  app.put<{ Params: { id: string } }>('/api/restreamer/playlists/:id', async (req) => {
    const b = asObject(req.body, 'request body');
    const patch: { slug?: string; title?: string; epgUrl?: string | null } = {};
    if (b.slug !== undefined) patch.slug = requireString(b.slug, 'slug');
    if (b.title !== undefined) patch.title = requireString(b.title, 'title');
    if (b.epgUrl !== undefined) patch.epgUrl = b.epgUrl == null ? null : String(b.epgUrl);
    return svc().updatePlaylist(req.params.id, patch);
  });

  app.delete<{ Params: { id: string } }>('/api/restreamer/playlists/:id', async (req) => {
    await svc().deletePlaylist(req.params.id);
    return { ok: true };
  });

  // ---------- manual switch ----------
  // Passthrough to POST /v1/channels/:slug/switch on the switcher: the
  // switcher's own state file is authoritative for the active selection (the
  // controller mirrors it via the status poll), and its lastSwitch timestamp
  // is what the sticky-1h rebalance window keys on — nothing to persist here.

  app.post<{ Params: { id: string } }>('/api/restreamer/channels/:id/switch', async (req) => {
    const service = svc(); // 503 without a database, like every other mutation
    const b = asObject(req.body, 'request body');
    const placementId = requireString(b.placementId, 'placementId');

    const channel = (await service.listChannels()).find((c) => c.id === req.params.id);
    if (!channel) throw httpError(404, `restream channel ${req.params.id} not found`);
    if (!channel.placements.some((p) => p.id === placementId)) {
      throw httpError(400, `placement ${placementId} does not belong to channel "${channel.slug}"`);
    }

    // prefer a switcher that already reports the slug; fall back to the first
    // configured one (a freshly pushed channel may not be polled yet)
    const switchers = ctx.config.restreamer?.switchers ?? [];
    const target =
      switchers.find((sw) =>
        ctx.cache.switchers.get(sw.id)?.channels.some((c) => c.slug === channel.slug),
      ) ?? switchers[0];
    const client = target ? ctx.switcherClients.get(target.id) : undefined;
    if (!client) {
      throw httpError(503, 'no switcher configured — redundant-channel switching is unavailable');
    }
    try {
      // switcher upstream ids ARE controller placement ids by construction
      await client.switchChannel(channel.slug, placementId);
    } catch (err) {
      // switcher-side 4xx (unknown slug/upstream) keeps its status, else 502
      throw passthroughError(err);
    }
    return { ok: true };
  });

  // ---------- master playlist M3U ----------
  // The viewer-facing path is registered as an explicit route, so it wins over
  // the SPA not-found fallback in main.ts; the /api twin is for the UI.

  const m3uHandler = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ): Promise<string> => {
    const body = await renderPlaylistM3u(ctx, req.params.slug);
    void reply.header('content-type', 'audio/x-mpegurl');
    return body;
  };
  app.get<{ Params: { slug: string } }>('/playlists/:slug.m3u', m3uHandler);
  app.get<{ Params: { slug: string } }>('/api/restreamer/playlists/:slug.m3u', m3uHandler);
}
