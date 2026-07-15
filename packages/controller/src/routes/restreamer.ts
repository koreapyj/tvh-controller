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
import { chanKey, channelStableId, chanNumberOrder } from '@tvhc/shared';
import type { RestreamChannelWithStatus, UnifiedEpgEvent } from '@tvhc/shared';
import type { AppConfig } from '../config.js';
import {
  AvailabilityError,
  nodeKey,
  resolveCatalogEntry,
  resolveTvhChannel,
  type ApplyChannelInput,
  type ChannelBatchAction,
  type ChannelPatch,
  type CreateChannelInput,
  type PlacementInput,
  type PlacementPatch,
} from '../restreamer/service.js';
import { parseProbeSettings } from '../restreamer/probeSettings.js';
import { RestreamerError } from '../restreamer/client.js';
import { httpError, requireDb, type AppContext } from './context.js';
import { mergeEpg, type EpgMergeInput } from './epg.js';

/** open log-stream relays; aborted before app.close() so shutdown never hangs */
const logRelayAborts = new Set<AbortController>();

export function abortLogRelays(): void {
  for (const abort of [...logRelayAborts]) abort.abort();
  logRelayAborts.clear();
}

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
  if (p.mode !== undefined) {
    if (p.mode !== 'hot' && p.mode !== 'cold') {
      throw httpError(400, "placement.mode must be 'hot' or 'cold'");
    }
    input.mode = p.mode;
  }
  if (p.profileId !== undefined) {
    if (p.profileId !== null && typeof p.profileId !== 'string') {
      throw httpError(400, 'placement.profileId must be a string or null');
    }
    input.profileId = p.profileId;
  }
  if (p.programNumber !== undefined) {
    if (p.programNumber !== null && typeof p.programNumber !== 'number') {
      throw httpError(400, 'placement.programNumber must be a number or null');
    }
    input.programNumber = p.programNumber;
  }
  if (p.force !== undefined) input.force = !!p.force;
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
  if (b.force !== undefined) patch.force = !!b.force;
  return patch;
}

/**
 * Availability rejections carry the per-node detail the UI renders — Fastify's
 * default error shape would drop `unavailable`, so mutating handlers send it
 * explicitly.
 */
async function withAvailability<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AvailabilityError) {
      return reply.code(409).send({ error: err.message, unavailable: err.unavailable });
    }
    throw err;
  }
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
 * Viewer-facing entry URL: with a switcher configured EVERY channel with ≥1
 * enabled placement points at the first switcher's publicUrl (uniform viewer
 * URLs — adding a second placement later never changes the entry). Without a
 * switcher: direct at the first enabled placement whose node has a serveUrl.
 */
function entryUrl(config: AppConfig, channel: RestreamChannelWithStatus): string | null {
  const enabled = channel.placements.filter((p) => p.enabled);
  if (enabled.length === 0) return null;
  const sw = config.restreamer?.switchers[0];
  if (sw) return `${sw.publicUrl}/hls/${channel.slug}/playlist.m3u8`;
  for (const p of enabled) {
    const serveUrl = nodeServeUrl(config, p.instanceId, p.nodeId);
    if (serveUrl) return `${serveUrl}/${p.id}/playlist.m3u8`;
  }
  return null;
}

/** first value of a possibly comma-joined / repeated forwarded header */
function firstForwarded(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = raw?.split(',')[0]?.trim();
  return first ? first : null;
}

/**
 * Viewer-facing base URL for controller-hosted links (the logo proxy):
 * `restreamer.publicUrl` from the config when set, else the reverse proxy's
 * X-Forwarded-Proto/Host (first value each), else the request itself.
 */
export function publicBaseUrl(
  req: Pick<FastifyRequest, 'protocol' | 'headers'>,
  config: AppConfig,
): string {
  if (config.restreamer?.publicUrl) return config.restreamer.publicUrl;
  const proto = firstForwarded(req.headers['x-forwarded-proto']) ?? req.protocol;
  const host = firstForwarded(req.headers['x-forwarded-host']) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

/**
 * tvg-logo URL rule: absolute icon URLs pass through verbatim; tvheadend's
 * relative `imagecache/N` paths are rewritten to the controller's
 * authenticated logo proxy (internal instance URLs are not publicly
 * reachable). Any other relative shape cannot be proxied safely — only the
 * imagecache namespace is exposed — so the logo is omitted.
 */
function proxiedLogoUrl(icon: string, instanceId: string, baseUrl: string): string | null {
  if (/^https?:\/\//i.test(icon)) return icon;
  const m = /^\/?imagecache\/(\d+)$/.exec(icon);
  return m ? `${baseUrl}/logos/${instanceId}/imagecache/${m[1]}` : null;
}

interface EntryIdentity {
  uuid: string | null;
  number: string | null;
  logo: string | null;
}

/**
 * Logo-only fallback across every source that carries this channel — tried in
 * priority order below, first non-null hit wins. Kept separate from identity
 * resolution: the identity's zone/uuid/number MUST come from the first
 * resolving placement (see `resolveEntryIdentity`), but a logo is cosmetic
 * and worth widening the search for, since plenty of zones simply don't have
 * a channel icon set.
 * 1. the channel's own placements, enabled ones, in their existing (priority)
 *    order — per placement, zone topology icon first (proxied), then that
 *    node's catalog `logo` (verbatim); a placement that resolves the channel
 *    but yields no logo (either field) does NOT stop the scan, unlike
 *    identity resolution.
 * 2. every OTHER cached instance's tvh topology (stable cache order) —
 *    covers zones where this channel has no placement at all but the tvh
 *    still carries it.
 * 3. every OTHER cached restreamer node's sources catalog (stable cache
 *    order).
 * Sources already tried in step 1 are skipped in steps 2/3 (they've already
 * proven logo-less); everything else is a cheap re-check over in-memory
 * cache data.
 */
function resolveEntryLogo(
  ctx: AppContext,
  channel: RestreamChannelWithStatus,
  baseUrl: string,
): string | null {
  const triedInstanceIds = new Set<string>();
  const triedNodeKeys = new Set<string>();

  for (const p of channel.placements) {
    if (!p.enabled || !ctx.cache.has(p.instanceId)) continue;
    triedInstanceIds.add(p.instanceId);
    triedNodeKeys.add(`${p.instanceId}:${p.nodeId}`);
    const snap = ctx.cache.get(p.instanceId);
    const topo = snap.topology;
    if (topo) {
      const resolved = resolveTvhChannel(topo.channels, channel.channelName, channel.channelNumber);
      if (resolved) {
        const icon = resolved.iconPublicUrl ?? resolved.icon_public_url ?? null;
        const logo = icon ? proxiedLogoUrl(icon, p.instanceId, baseUrl) : null;
        if (logo) return logo;
      }
    }
    const sources = snap.restreamers.find((r) => r.nodeId === p.nodeId)?.sources;
    if (sources) {
      const entry = resolveCatalogEntry(sources, channel.channelName, channel.channelNumber);
      if (entry?.logo) return entry.logo;
    }
  }

  for (const snap of ctx.cache.all()) {
    if (triedInstanceIds.has(snap.summary.id) || !snap.topology) continue;
    const resolved = resolveTvhChannel(snap.topology.channels, channel.channelName, channel.channelNumber);
    if (!resolved) continue;
    const icon = resolved.iconPublicUrl ?? resolved.icon_public_url ?? null;
    const logo = icon ? proxiedLogoUrl(icon, snap.summary.id, baseUrl) : null;
    if (logo) return logo;
  }

  for (const snap of ctx.cache.all()) {
    for (const node of snap.restreamers) {
      if (triedNodeKeys.has(`${node.instanceId}:${node.nodeId}`) || !node.sources) continue;
      const entry = resolveCatalogEntry(node.sources, channel.channelName, channel.channelNumber);
      if (entry?.logo) return entry.logo;
    }
  }

  return null;
}

/**
 * uuid / number (channel IDENTITY) come from the first enabled placement
 * (priority order) whose zone resolves the channel's (name, number) identity
 * — same tvh-first-then-catalog rule as the desired-doc computation, per
 * placement:
 * - tvh hit: uuid = the tvh uuid, number = the pin or the resolved channel's
 *   own number.
 * - catalog hit (only on a tvh miss for that placement): uuid = the catalog
 *   entry id, number = the pin or the entry's `chno`.
 * No placement resolves → identity nulls (channelNumber only, if pinned).
 * This ordering is load-bearing and must NOT be touched when adding sources —
 * uuid/number identify which physical channel this playlist entry IS.
 * logo is resolved separately (see `resolveEntryLogo`) and falls back across
 * every source that has the channel, not just the first resolving one —
 * many zones simply have no channel icon set, and viewers still want one.
 * tvg-id / the XMLTV `<channel id>` never use `uuid` directly — they're
 * `channelStableId(name, number)`, stable across tvh restarts and uuid churn.
 */
function resolveEntryIdentity(
  ctx: AppContext,
  channel: RestreamChannelWithStatus,
  baseUrl: string,
): EntryIdentity {
  for (const p of channel.placements) {
    if (!p.enabled || !ctx.cache.has(p.instanceId)) continue;
    const topo = ctx.cache.get(p.instanceId).topology;
    if (topo) {
      const resolved = resolveTvhChannel(topo.channels, channel.channelName, channel.channelNumber);
      if (resolved) {
        return {
          uuid: resolved.uuid,
          number: channel.channelNumber ?? resolved.number ?? null,
          logo: resolveEntryLogo(ctx, channel, baseUrl),
        };
      }
    }
    const sources = ctx.cache.get(p.instanceId).restreamers.find((r) => r.nodeId === p.nodeId)
      ?.sources;
    if (sources) {
      const entry = resolveCatalogEntry(sources, channel.channelName, channel.channelNumber);
      if (entry) {
        return {
          uuid: entry.id,
          number: channel.channelNumber ?? entry.chno,
          logo: resolveEntryLogo(ctx, channel, baseUrl),
        };
      }
    }
  }
  return { uuid: null, number: channel.channelNumber, logo: resolveEntryLogo(ctx, channel, baseUrl) };
}

/**
 * Render one DB-managed master playlist in the production channels.m3u
 * format: members that are enabled and currently RUNNING on at least one
 * enabled placement's node, sorted by chanNumberOrder.
 */
async function renderPlaylistM3u(ctx: AppContext, slug: string, baseUrl: string): Promise<string> {
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
    .map((channel) => ({ channel, url: entryUrl(ctx.config, channel), identity: resolveEntryIdentity(ctx, channel, baseUrl) }))
    .filter((e): e is typeof e & { url: string } => e.url !== null);
  entries.sort(
    (a, b) =>
      chanNumberOrder(a.identity.number) - chanNumberOrder(b.identity.number) ||
      a.channel.channelName.localeCompare(b.channel.channelName),
  );

  const lines: string[] = [
    `#EXTM3U url-tvg=${baseUrl}/xmltv/${playlist.slug}.xml`,
    `#PLAYLIST:${playlist.title}`,
    '#KODIPROP:mimetype=application/x-mpegURL',
  ];
  for (const { channel, url, identity } of entries) {
    const attrs: string[] = [`tvg-id="${channelStableId(channel.channelName, identity.number)}"`];
    if (identity.number != null) attrs.push(`tvg-chno="${identity.number}"`);
    attrs.push(`x-url="${channel.slug}"`);
    if (identity.logo) attrs.push(`tvg-logo="${identity.logo}"`);
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${channel.channelName}`);
    lines.push(url);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Master playlist XMLTV generation
// ---------------------------------------------------------------------------

/** past-programme retention window: XMLTV covers now-24h through everything tvh still holds */
const XMLTV_PAST_WINDOW_SECONDS = 86400;

/**
 * On-demand EPG fetch for the XMLTV export. Deliberately NOT the poller cache
 * (InstancePoller.pollEpg keeps only `stop > now`, dropping ended
 * programmes) — widening that cache would leak stale events into /api/epg.
 * `windowStart` is normally `now - 24h`; an unreachable/erroring instance
 * degrades to an empty, unreachable EpgMergeInput rather than failing the
 * whole export. Instances with no configured tvhHttp client are skipped
 * entirely (nothing to fetch). EIT-driven tvheadend may retain less than 24h
 * of past events — the export simply forwards whatever it returns.
 */
async function fetchPlaylistEpg(
  ctx: AppContext,
  instanceIds: Iterable<string>,
  windowStart: number,
): Promise<EpgMergeInput[]> {
  const fetches = [...instanceIds].map(async (instanceId): Promise<EpgMergeInput | null> => {
    const client = ctx.tvhHttp.get(instanceId);
    if (!client) return null;
    try {
      const epg = await client.epgEventsAll({
        filter: [{ field: 'stop', type: 'numeric', comparison: 'gt', value: windowStart }],
      });
      return { instanceId, reachable: true, conflicts: [], epg };
    } catch {
      return { instanceId, reachable: false, conflicts: [], epg: [] };
    }
  });
  const results = await Promise.all(fetches);
  return results.filter((r): r is EpgMergeInput => r !== null);
}

/** XML 1.0 predefined-entity escaping — no XML lib in the repo for five entities */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** XMLTV timestamp: UTC `YYYYMMDDHHmmss +0000` — sidesteps per-instance EIT offset guessing */
function xmltvTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}${time} +0000`;
}

/**
 * One `<programme>` element. Field mapping per TvhEpgEvent (tvh-types.ts):
 * `credits` is deliberately unmapped — tvh's flat Record doesn't translate
 * cleanly into XMLTV's `<credits>` role elements.
 */
function renderProgramme(item: UnifiedEpgEvent, channelId: string): string[] {
  const d = item.details;
  const lines: string[] = [
    `  <programme start="${xmltvTimestamp(item.start)}" stop="${xmltvTimestamp(item.stop)}" channel="${xmlEscape(channelId)}">`,
    `    <title>${xmlEscape(item.title || item.channelName)}</title>`,
  ];
  if (d.subtitle) lines.push(`    <sub-title>${xmlEscape(d.subtitle)}</sub-title>`);
  const desc = d.description ?? d.summary;
  if (desc) lines.push(`    <desc>${xmlEscape(desc)}</desc>`);
  for (const category of d.category ?? []) lines.push(`    <category>${xmlEscape(category)}</category>`);
  if (d.episodeNumber != null) {
    // XMLTV xmltv_ns is 0-based; tvh reports 1-based season/episode/part
    const season = d.seasonNumber != null ? String(d.seasonNumber - 1) : '';
    const episode = String(d.episodeNumber - 1);
    const part = d.partNumber != null ? String(d.partNumber - 1) : '';
    lines.push(`    <episode-num system="xmltv_ns">${season}.${episode}.${part}</episode-num>`);
  }
  if (d.first_aired != null) {
    lines.push(`    <date>${new Date(d.first_aired * 1000).getUTCFullYear()}</date>`);
  }
  if (d.new) lines.push('    <new/>');
  if (d.repeat) lines.push('    <previously-shown/>');
  if (d.ratingLabel) {
    lines.push('    <rating>', `      <value>${xmlEscape(d.ratingLabel)}</value>`, '    </rating>');
  }
  if (d.image) lines.push(`    <icon src="${xmlEscape(d.image)}"/>`);
  lines.push('  </programme>');
  return lines;
}

/**
 * Render one DB-managed master playlist's XMLTV document. Member selection
 * intentionally differs from the M3U: every enabled playlist member, with no
 * running-placement requirement and no entryUrl filter — EPG stays stable
 * across channel restarts, unlike the viewer-facing stream list.
 */
async function renderPlaylistXmltv(ctx: AppContext, slug: string, baseUrl: string): Promise<string> {
  const service = requireDb(ctx.restreamer, 'restream playlists');
  const playlist = (await service.listPlaylists()).find((p) => p.slug === slug);
  if (!playlist) throw httpError(404, `playlist "${slug}" not found`);

  const members = (await service.listChannels()).filter(
    (c) => c.enabled && c.playlistIds.includes(playlist.id),
  );

  const entries = members.map((channel) => ({
    channel,
    identity: resolveEntryIdentity(ctx, channel, baseUrl),
  }));
  entries.sort(
    (a, b) =>
      chanNumberOrder(a.identity.number) - chanNumberOrder(b.identity.number) ||
      a.channel.channelName.localeCompare(b.channel.channelName),
  );

  const instanceIds = new Set<string>();
  for (const { channel } of entries) {
    for (const p of channel.placements) if (p.enabled) instanceIds.add(p.instanceId);
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - XMLTV_PAST_WINDOW_SECONDS;
  const inputs = await fetchPlaylistEpg(ctx, instanceIds, windowStart);
  const merged = mergeEpg(inputs, ctx.config.overlapThreshold, now);

  // bucket merged (deduplicated) programmes per playlist member by channel identity
  const buckets = new Map<string, UnifiedEpgEvent[]>();
  for (const item of merged) {
    if (item.stop <= windowStart) continue; // belt-and-braces — the per-instance filter should already exclude these
    const key = chanKey(item.channelName, item.channelNumber ?? null);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.start - b.start);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="tvh-controller">',
  ];
  for (const { channel, identity } of entries) {
    const id = channelStableId(channel.channelName, identity.number);
    lines.push(`  <channel id="${xmlEscape(id)}">`);
    lines.push(`    <display-name>${xmlEscape(channel.channelName)}</display-name>`);
    if (identity.number != null) {
      lines.push(`    <display-name>${xmlEscape(identity.number)}</display-name>`);
      lines.push(`    <lcn>${xmlEscape(identity.number)}</lcn>`);
    }
    if (identity.logo) lines.push(`    <icon src="${xmlEscape(identity.logo)}"/>`);
    lines.push('  </channel>');
  }
  for (const { channel, identity } of entries) {
    const id = channelStableId(channel.channelName, identity.number);
    const key = chanKey(channel.channelName, identity.number);
    for (const item of buckets.get(key) ?? []) lines.push(...renderProgramme(item, id));
  }
  lines.push('</tv>');
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

  app.post<{ Params: { instanceId: string; nodeId: string; name: string } }>(
    '/api/restreamer/nodes/:instanceId/:nodeId/sessions/:name/restarts/reset',
    async (req) => {
      const { instanceId, nodeId, name } = req.params;
      const client = ctx.restreamerClients.get(nodeKey(instanceId, nodeId));
      if (!client) throw httpError(404, `unknown restreamer node ${nodeKey(instanceId, nodeId)}`);
      try {
        await client.resetSessionRestarts(name);
      } catch (err) {
        throw passthroughError(err);
      }
      return { ok: true };
    },
  );

  /**
   * Transparent byte relay of the daemon's SSE log stream (the daemon frames
   * the events; the controller never re-encodes). The reply is hijacked, the
   * upstream fetch is aborted on client disconnect, and every open relay is
   * tracked so shutdown can abort them — Fastify's close() waits for in-flight
   * responses and would otherwise hang into the failsafe exit.
   */
  app.get<{ Params: { instanceId: string; nodeId: string; name: string } }>(
    '/api/restreamer/nodes/:instanceId/:nodeId/sessions/:name/log/stream',
    (req, reply) => {
      const { instanceId, nodeId, name } = req.params;
      const client = ctx.restreamerClients.get(nodeKey(instanceId, nodeId));
      if (!client) {
        void reply
          .status(404)
          .send({ error: `unknown restreamer node ${nodeKey(instanceId, nodeId)}` });
        return;
      }
      reply.hijack();
      const res = reply.raw;
      const abort = new AbortController();
      logRelayAborts.add(abort);
      const cleanup = (): void => {
        logRelayAborts.delete(abort);
        abort.abort();
        try {
          res.end();
        } catch {
          /* already gone */
        }
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);
      void (async () => {
        let upstream: Response;
        try {
          upstream = await client.sessionLogStream(name, abort.signal);
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `restreamer node unreachable: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
          cleanup();
          return;
        }
        if (!upstream.ok || !upstream.body) {
          res.writeHead(upstream.status || 502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `daemon log stream HTTP ${upstream.status}` }));
          cleanup();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        try {
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) res.write(Buffer.from(value));
          }
        } catch {
          /* upstream ended or client vanished */
        } finally {
          cleanup();
        }
      })();
    },
  );

  // ---------- per-node probe settings ----------

  app.get<{ Params: { instanceId: string; nodeId: string } }>(
    '/api/restreamer/nodes/:instanceId/:nodeId/probes',
    async (req) => svc().getNodeProbeSettings(req.params.instanceId, req.params.nodeId),
  );

  app.put<{ Params: { instanceId: string; nodeId: string } }>(
    '/api/restreamer/nodes/:instanceId/:nodeId/probes',
    async (req) =>
      svc().setNodeProbeSettings(
        req.params.instanceId,
        req.params.nodeId,
        parseProbeSettings(req.body),
      ),
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

  app.post<{ Params: { id: string } }>('/api/restreamer/profiles/:id/clone', async (req, reply) => {
    const b = asObject(req.body, 'request body');
    const profile = await svc().cloneProfile(req.params.id, requireString(b.name, 'name'));
    reply.code(201);
    return profile;
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
    if (b.force !== undefined) input.force = !!b.force;
    return withAvailability(reply, async () => {
      const channel = await svc().createChannel(input);
      reply.code(201);
      // single-channel responses use the WithStatus shape (placements,
      // playlistIds, ...) — the web treats them like list rows
      return (await svc().channelWithStatus(channel.id)) ?? channel;
    });
  });

  app.get<{ Params: { id: string } }>('/api/restreamer/channels/:id', async (req) => {
    const channel = await svc().channelWithStatus(req.params.id);
    if (!channel) throw httpError(404, `restream channel ${req.params.id} not found`);
    return channel;
  });

  app.put<{ Params: { id: string } }>('/api/restreamer/channels/:id', async (req, reply) => {
    const patch = parseChannelPatch(req.body);
    return withAvailability(reply, async () => {
      const updated = await svc().updateChannel(req.params.id, patch);
      return (await svc().channelWithStatus(updated.id)) ?? updated;
    });
  });

  // transactional Save for the edit modal: channel patch + FULL desired
  // placement set (array order = priority, missing ids = delete) in one pass
  app.post<{ Params: { id: string } }>('/api/restreamer/channels/:id/apply', async (req, reply) => {
    const b = asObject(req.body, 'request body');
    const input: ApplyChannelInput = {};
    if (b.channel !== undefined) input.channel = parseChannelPatch(b.channel);
    if (b.placements !== undefined) {
      if (!Array.isArray(b.placements)) throw httpError(400, 'placements must be an array');
      input.placements = b.placements.map((raw) => {
        const p = asObject(raw, 'placement');
        const mode = p.mode === 'cold' ? 'cold' : 'hot';
        if (p.mode !== undefined && p.mode !== 'hot' && p.mode !== 'cold') {
          throw httpError(400, "placement.mode must be 'hot' or 'cold'");
        }
        if (p.profileId != null && typeof p.profileId !== 'string') {
          throw httpError(400, 'placement.profileId must be a string or null');
        }
        if (p.programNumber != null && typeof p.programNumber !== 'number') {
          throw httpError(400, 'placement.programNumber must be a number or null');
        }
        return {
          ...(p.id !== undefined ? { id: requireString(p.id, 'placement.id') } : {}),
          instanceId: requireString(p.instanceId, 'placement.instanceId'),
          nodeId: requireString(p.nodeId, 'placement.nodeId'),
          mode,
          profileId: (p.profileId as string | null | undefined) ?? null,
          programNumber: (p.programNumber as number | null | undefined) ?? null,
          enabled: p.enabled === undefined ? true : !!p.enabled,
        };
      });
    }
    if (b.force !== undefined) input.force = !!b.force;
    return withAvailability(reply, () => svc().applyChannelChanges(req.params.id, input));
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
    const input = parsePlacementInput(req.body);
    return withAvailability(reply, async () => {
      const placement = await svc().addPlacement(req.params.id, input);
      reply.code(201);
      return placement;
    });
  });

  app.put<{ Params: { id: string } }>('/api/restreamer/placements/:id', async (req, reply) => {
    const b = asObject(req.body, 'request body');
    const patch: PlacementPatch = {};
    if (b.instanceId !== undefined) patch.instanceId = requireString(b.instanceId, 'instanceId');
    if (b.nodeId !== undefined) patch.nodeId = requireString(b.nodeId, 'nodeId');
    if (b.priority !== undefined) {
      if (typeof b.priority !== 'number') throw httpError(400, 'priority must be a number');
      patch.priority = b.priority;
    }
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.mode !== undefined) {
      if (b.mode !== 'hot' && b.mode !== 'cold') {
        throw httpError(400, "mode must be 'hot' or 'cold'");
      }
      patch.mode = b.mode;
    }
    if (b.profileId !== undefined) {
      if (b.profileId !== null && typeof b.profileId !== 'string') {
        throw httpError(400, 'profileId must be a string or null');
      }
      patch.profileId = b.profileId;
    }
    if (b.programNumber !== undefined) {
      if (b.programNumber !== null && typeof b.programNumber !== 'number') {
        throw httpError(400, 'programNumber must be a number or null');
      }
      patch.programNumber = b.programNumber;
    }
    if (b.force !== undefined) patch.force = !!b.force;
    return withAvailability(reply, () => svc().updatePlacement(req.params.id, patch));
  });

  app.delete<{ Params: { id: string } }>('/api/restreamer/placements/:id', async (req) => {
    // body is optional; { force: true } bypasses the mid-procedure guard
    const force = req.body == null ? false : !!asObject(req.body, 'request body').force;
    await svc().deletePlacement(req.params.id, force);
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
    });
    reply.code(201);
    return playlist;
  });

  app.put<{ Params: { id: string } }>('/api/restreamer/playlists/:id', async (req) => {
    const b = asObject(req.body, 'request body');
    const patch: { slug?: string; title?: string } = {};
    if (b.slug !== undefined) patch.slug = requireString(b.slug, 'slug');
    if (b.title !== undefined) patch.title = requireString(b.title, 'title');
    return svc().updatePlaylist(req.params.id, patch);
  });

  app.delete<{ Params: { id: string } }>('/api/restreamer/playlists/:id', async (req) => {
    await svc().deletePlaylist(req.params.id);
    return { ok: true };
  });

  // ---------- manual switch / reset ----------
  // Both enter the SAME serialized failover procedure the automatic triggers
  // use — the response only acknowledges queueing; progress is observed via
  // the `restreamer-channel` SSE stream. Body: {placementId} = manual
  // selection; {reset: true, force?} = fail back in natural placement order.

  app.post<{ Params: { id: string } }>('/api/restreamer/channels/:id/switch', async (req, reply) => {
    const service = svc(); // 503 without a database, like every other mutation
    const b = asObject(req.body, 'request body');
    if ((b.placementId !== undefined) === (b.reset !== undefined)) {
      throw httpError(400, 'body must be exactly one of {placementId} or {reset: true}');
    }
    if (b.reset !== undefined) {
      if (b.reset !== true) throw httpError(400, 'reset must be true');
      const outcome = await service.requestReset(req.params.id, b.force === true);
      if ('rejected' in outcome) {
        reply.code(409);
        return {
          error: outcome.rejected,
          message: outcome.message,
          ...(outcome.rejected === 'requires-confirm' ? { triggerStillFailing: true } : {}),
        };
      }
      return outcome;
    }
    const placementId = requireString(b.placementId, 'placementId');
    return service.requestManualSwitch(req.params.id, placementId);
  });

  // Operator dismiss of the ⚠ blocked badge — UI-only, does not touch the
  // failover queue/backoff or trigger a new attempt.
  app.post<{ Params: { id: string } }>(
    '/api/restreamer/channels/:id/failover/clear-blocked',
    async (req) => {
      const cleared = await svc().clearFailoverBlocked(req.params.id);
      return { ok: true, cleared };
    },
  );

  // ---------- master playlist M3U ----------
  // The viewer-facing path is registered as an explicit route, so it wins over
  // the SPA not-found fallback in main.ts; the /api twin is for the UI.

  const m3uHandler = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ): Promise<string> => {
    const body = await renderPlaylistM3u(ctx, req.params.slug, publicBaseUrl(req, ctx.config));
    void reply.header('content-type', 'audio/x-mpegurl');
    return body;
  };
  app.get<{ Params: { slug: string } }>('/playlists/:slug.m3u', m3uHandler);
  app.get<{ Params: { slug: string } }>('/api/restreamer/playlists/:slug.m3u', m3uHandler);

  // ---------- master playlist XMLTV ----------
  // Same explicit-route-beats-SPA-fallback reasoning as the M3U above. Time-based
  // TTL cache (not bus-invalidated): the poller's `epg` event doesn't cover this
  // on-demand fetch, and XMLTV clients poll on the order of hours anyway.

  const XMLTV_CACHE_TTL_MS = 60_000;
  const xmltvCache = new Map<string, { at: number; body: string }>();

  const xmltvHandler = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ): Promise<string> => {
    const baseUrl = publicBaseUrl(req, ctx.config);
    const cacheKey = `${req.params.slug}:${baseUrl}`;
    const now = Date.now();
    const cached = xmltvCache.get(cacheKey);
    let body: string;
    if (cached && now - cached.at < XMLTV_CACHE_TTL_MS) {
      body = cached.body;
    } else {
      body = await renderPlaylistXmltv(ctx, req.params.slug, baseUrl);
      xmltvCache.set(cacheKey, { at: now, body });
    }
    void reply.header('content-type', 'application/xml; charset=utf-8');
    return body;
  };
  app.get<{ Params: { slug: string } }>('/xmltv/:slug.xml', xmltvHandler);
  app.get<{ Params: { slug: string } }>('/api/restreamer/xmltv/:slug.xml', xmltvHandler);

  // ---------- logo proxy ----------
  // Authenticated passthrough to tvheadend's /imagecache so tvg-logo URLs are
  // publicly reachable without exposing instance credentials. Registered as
  // an explicit route so it wins over the SPA not-found fallback in main.ts.
  // Deliberately NO in-app cache: the controller always sits behind a reverse
  // proxy — the 30-day Cache-Control below is for it (and browsers) to honor.

  const LOGO_CACHE_CONTROL = 'public, max-age=2592000, immutable'; // 30 days — logos never change

  app.get<{ Params: { instanceId: string; iconId: string } }>(
    '/logos/:instanceId/imagecache/:iconId',
    async (req, reply) => {
      const { instanceId, iconId } = req.params;
      // open-proxy guard: only numeric imagecache ids may reach the upstream
      if (!/^\d+$/.test(iconId)) throw httpError(404, 'not found');
      const client = ctx.tvhHttp.get(instanceId);
      if (!client) throw httpError(404, `unknown instance "${instanceId}"`);

      // pass conditional-request validators through so tvheadend can 304
      const cond: Record<string, string> = {};
      const ifNoneMatch = req.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string') cond['if-none-match'] = ifNoneMatch;
      const ifModifiedSince = req.headers['if-modified-since'];
      if (typeof ifModifiedSince === 'string') cond['if-modified-since'] = ifModifiedSince;

      let res: Response;
      try {
        res = await client.getRaw(`/imagecache/${iconId}`, cond);
      } catch (err) {
        throw httpError(
          502,
          `tvheadend unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (res.status === 200 || res.status === 304) {
        void reply.header('cache-control', LOGO_CACHE_CONTROL);
        const etag = res.headers.get('etag');
        if (etag) void reply.header('etag', etag);
        const lastModified = res.headers.get('last-modified');
        if (lastModified) void reply.header('last-modified', lastModified);
        if (res.status === 304) return reply.code(304).send();
        void reply.header('content-type', res.headers.get('content-type') ?? 'image/png');
        return reply.send(Buffer.from(await res.arrayBuffer()));
      }
      // upstream 401/403/404/…: never mirror an auth failure to the viewer
      throw httpError(404, `icon ${iconId} not found on instance "${instanceId}"`);
    },
  );
}
