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

// Pure-TS field layer for the Restreamer page (the ruleFields pattern):
// profile-editor field specs over the AribHlsParams knobs (path-addressed,
// with a 1..4 audio row model), the channel batch-edit fields, slug/state
// display helpers, and the string<->payload conversions. Also the restream
// subscription detection used by the Instance page. No Svelte imports —
// everything here is node-testable.

import {
  chanNumberOrder,
  type AribHlsParams,
  type RestreamChannel,
  type RestreamerNodeStatus,
  type RestreamPlacement,
  type RestreamPlaylist,
  type RestreamProfile,
  type SessionState,
  type TvhSubscription,
} from '@tvhc/shared';
import type { FieldSpec } from './ruleFields.js';

// ---------------------------------------------------------------------------
// profile field specs (knobs of the 'arib-hls' pipeline template)
// ---------------------------------------------------------------------------

export interface ProfileEnumOption {
  value: string;
  label: string;
}

export type ProfileFieldType = 'str' | 'int' | 'num' | 'bool' | 'strenum';

export interface ProfileFieldSpec {
  /** dot path into AribHlsParams (AUDIO_ENTRY_FIELDS: path within one audio entry) */
  path: string;
  label: string;
  type: ProfileFieldType;
  /** required for 'strenum' */
  options?: ProfileEnumOption[];
  /** shown for blank knobs — the template/production default that then applies */
  placeholder?: string;
  help?: string;
  /** section heading rendered when it differs from the previous row's */
  section?: string;
}

/** video.mode values from the profile schema — selects the filter branch + default GOP */
export const VIDEO_MODE_OPTIONS: ProfileEnumOption[] = [
  { value: 'ivtc', label: 'ivtc (film, 24000/1001)' },
  { value: 'deinterlace', label: 'deinterlace (video, 30000/1001)' },
  { value: 'none', label: 'none (pass frames through)' },
  { value: 'yadif', label: 'yadif (deinterlace, 30000/1001)' },
  { value: 'bwdif', label: 'bwdif (deinterlace, 30000/1001)' },
];

/**
 * Top-level knobs. Blank = knob omitted from the payload, so the daemon
 * template's production default applies (shown as the placeholder).
 * `video.mode` is the only required knob (no schema default).
 */
export const PROFILE_FIELDS: ProfileFieldSpec[] = [
  { path: 'video.mode', label: 'Mode', type: 'strenum', options: VIDEO_MODE_OPTIONS, section: 'Video' },
  { path: 'video.bitrate', label: 'Bitrate', type: 'str', placeholder: '3M', section: 'Video' },
  { path: 'video.gop', label: 'GOP', type: 'str', placeholder: '24000/1001', help: 'blank = derived from mode', section: 'Video' },
  { path: 'video.preset', label: 'QSV preset', type: 'int', placeholder: '7', section: 'Video' },
  { path: 'subtitles.enabled', label: 'Enabled', type: 'bool', placeholder: 'yes', help: 'ARIB caption → ASS subtitle playlist', section: 'Subtitles' },
  { path: 'subtitles.language', label: 'Language', type: 'str', placeholder: '(rendition LANGUAGE)', section: 'Subtitles' },
  { path: 'thumbnail.enabled', label: 'Enabled', type: 'bool', placeholder: 'yes', section: 'Thumbnail' },
  { path: 'thumbnail.width', label: 'Width', type: 'int', section: 'Thumbnail' },
  { path: 'thumbnail.height', label: 'Height', type: 'int', section: 'Thumbnail' },
  { path: 'thumbnail.intervalSec', label: 'Interval (s)', type: 'num', section: 'Thumbnail' },
  { path: 'hls.segmentSeconds', label: 'Segment length (s)', type: 'num', placeholder: '5', section: 'HLS' },
  { path: 'hls.listSize', label: 'Playlist size', type: 'int', placeholder: '120', section: 'HLS' },
];

/** knobs of one audio output; `path` is relative to the audio entry */
export const AUDIO_ENTRY_FIELDS: ProfileFieldSpec[] = [
  { path: 'bitrate', label: 'Bitrate', type: 'str', placeholder: '128k first, 64k rest' },
  { path: 'volume', label: 'Volume gain', type: 'str', placeholder: '5dB' },
  { path: 'language', label: 'Language', type: 'str', placeholder: '(rendition LANGUAGE)' },
  { path: 'name', label: 'Name', type: 'str', placeholder: '(rendition NAME)' },
  { path: 'isDefault', label: 'Default rendition', type: 'bool' },
];

/** audio array bounds from the wire contract (minItems/maxItems) */
export const MIN_AUDIO_ENTRIES = 1;
export const MAX_AUDIO_ENTRIES = 4;

/**
 * Production-default AribHlsParams: ivtc video and the prod dual-audio layout.
 * All other knobs stay blank so the daemon template's own defaults — which ARE
 * the production values ('3M', preset 7, 5s/120 HLS, subtitles+thumbnail on,
 * '128k'/'64k' + '5dB' audio) — apply.
 */
export function defaultProfilePayload(): AribHlsParams {
  return {
    template: 'arib-hls',
    templateVersion: 1,
    video: { mode: 'ivtc' },
    audio: [{}, {}],
  };
}

// ---------------------------------------------------------------------------
// path get/set
// ---------------------------------------------------------------------------

/** read a dot-path; undefined when any segment is missing/non-object */
export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Write a dot-path in place, creating intermediate objects as needed.
 * `undefined` deletes the leaf instead (missing parents left untouched).
 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (typeof cur[seg] !== 'object' || cur[seg] === null) {
      if (value === undefined) return;
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const leaf = segs[segs.length - 1]!;
  if (value === undefined) delete cur[leaf];
  else cur[leaf] = value;
}

// ---------------------------------------------------------------------------
// value conversions (form string <-> payload knob)
// ---------------------------------------------------------------------------

/** payload knob → form control string ('' = knob unset) */
export function formatProfileValue(spec: ProfileFieldSpec, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (spec.type === 'bool') return v ? 'yes' : 'no';
  return String(v);
}

export type ProfileParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** form control string → payload knob; '' = unset (undefined, key omitted) */
export function parseProfileValue(spec: ProfileFieldSpec, raw: string): ProfileParseResult {
  const t = raw.trim();
  if (t === '') return { ok: true, value: undefined };
  switch (spec.type) {
    case 'bool':
      return { ok: true, value: raw === 'yes' };
    case 'int': {
      const n = Number(t);
      if (!Number.isInteger(n)) return { ok: false, error: `"${spec.label}" must be an integer` };
      return { ok: true, value: n };
    }
    case 'num': {
      const n = Number(t);
      if (Number.isNaN(n)) return { ok: false, error: `"${spec.label}" must be a number` };
      return { ok: true, value: n };
    }
    default:
      // 'str' and 'strenum'
      return { ok: true, value: raw };
  }
}

// ---------------------------------------------------------------------------
// profile editor form model (pure core of the profile modal)
// ---------------------------------------------------------------------------

export interface ProfileFormState {
  /** one string per PROFILE_FIELDS path; '' = knob unset */
  vals: Record<string, string>;
  /** one row per audio output, keyed by AUDIO_ENTRY_FIELDS path */
  audio: Array<Record<string, string>>;
}

/** blank audio row (every knob unset → template defaults) */
export function emptyAudioRow(): Record<string, string> {
  return Object.fromEntries(AUDIO_ENTRY_FIELDS.map((f) => [f.path, '']));
}

/** payload → form strings (inverse of buildProfilePayload) */
export function profileToVals(payload: AribHlsParams): ProfileFormState {
  const vals: Record<string, string> = {};
  for (const f of PROFILE_FIELDS) vals[f.path] = formatProfileValue(f, getByPath(payload, f.path));
  const audio = payload.audio.map((entry) => {
    const row = emptyAudioRow();
    for (const f of AUDIO_ENTRY_FIELDS) row[f.path] = formatProfileValue(f, getByPath(entry, f.path));
    return row;
  });
  return { vals, audio };
}

/** appended row is blank; no-op at the contract's 4-entry cap */
export function addAudioRow(audio: Array<Record<string, string>>): Array<Record<string, string>> {
  if (audio.length >= MAX_AUDIO_ENTRIES) return audio;
  return [...audio, emptyAudioRow()];
}

/** no-op at the contract's 1-entry floor */
export function removeAudioRow(
  audio: Array<Record<string, string>>,
  index: number,
): Array<Record<string, string>> {
  if (audio.length <= MIN_AUDIO_ENTRIES) return audio;
  return audio.filter((_, i) => i !== index);
}

export type BuildProfileResult =
  | { ok: true; payload: AribHlsParams }
  | { ok: false; error: string };

/**
 * Fold the editor's form strings into an AribHlsParams payload: '' knobs are
 * omitted (template default applies), video.mode is required, audio rows map
 * 1:1 to audio outputs (bounds enforced).
 */
export function buildProfilePayload(state: ProfileFormState): BuildProfileResult {
  if (state.audio.length < MIN_AUDIO_ENTRIES || state.audio.length > MAX_AUDIO_ENTRIES) {
    return {
      ok: false,
      error: `audio outputs must be ${MIN_AUDIO_ENTRIES}..${MAX_AUDIO_ENTRIES}`,
    };
  }
  const mode = state.vals['video.mode'];
  if (
    mode !== 'ivtc' &&
    mode !== 'deinterlace' &&
    mode !== 'none' &&
    mode !== 'yadif' &&
    mode !== 'bwdif'
  ) {
    return { ok: false, error: 'video mode is required' };
  }
  const payload: Record<string, unknown> = {
    template: 'arib-hls',
    templateVersion: 1,
    video: { mode },
  };
  for (const f of PROFILE_FIELDS) {
    if (f.path === 'video.mode') continue;
    const parsed = parseProfileValue(f, state.vals[f.path] ?? '');
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) setByPath(payload, f.path, parsed.value);
  }
  const audio: Array<Record<string, unknown>> = [];
  for (const row of state.audio) {
    const entry: Record<string, unknown> = {};
    for (const f of AUDIO_ENTRY_FIELDS) {
      const parsed = parseProfileValue(f, row[f.path] ?? '');
      if (!parsed.ok) return parsed;
      if (parsed.value !== undefined) entry[f.path] = parsed.value;
    }
    audio.push(entry);
  }
  payload.audio = audio;
  return { ok: true, payload: payload as unknown as AribHlsParams };
}

// ---------------------------------------------------------------------------
// channel batch-edit fields (BatchEditModal)
// ---------------------------------------------------------------------------

/**
 * Batch-edit fields for restream channels. Profile/playlist options are
 * runtime data, so this is a builder rather than a constant.
 */
export function CHANNEL_BATCH_FIELDS(
  profiles: RestreamProfile[],
  playlists: RestreamPlaylist[],
): FieldSpec[] {
  return [
    { key: 'enabled', label: 'Enabled', type: 'bool' },
    {
      key: 'profileId',
      label: 'Profile',
      type: 'strenum',
      strOptions: profiles.map((p) => ({ value: p.id, label: p.name })),
    },
    { key: 'comment', label: 'Comment', type: 'str' },
    {
      key: 'playlistIds',
      label: 'Playlists',
      type: 'multiselect',
      strOptions: playlists.map((p) => ({ value: p.id, label: p.title })),
    },
  ];
}

// ---------------------------------------------------------------------------
// display helpers
// ---------------------------------------------------------------------------

/** session-name / slug rule from the wire contract */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Default slug for a channel name — PREVIEW ONLY, mirrors the controller's
 * restreamer/service.ts#deriveSlug (the server derives authoritatively when
 * the slug field is left blank).
 */
export function deriveSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'channel';
}

/**
 * Channels-table order — the same rule the generated M3U playlist uses:
 * numeric-aware channel number first (chanNumberOrder: "9.1" < "10" < "51";
 * "9.1"/"9.10" tie by design — ordering only, identity stays exact string
 * equality), channels without a number AFTER numbered ones
 * (chanNumberOrder(null) = Infinity), name (localeCompare) as the tie-break.
 */
export function compareChannels(
  a: Pick<RestreamChannel, 'channelName' | 'channelNumber'>,
  b: Pick<RestreamChannel, 'channelName' | 'channelNumber'>,
): number {
  return (
    chanNumberOrder(a.channelNumber) - chanNumberOrder(b.channelNumber) ||
    a.channelName.localeCompare(b.channelName)
  );
}

/** badge class per session state (existing badge palette) */
export function sessionStateBadge(state: SessionState): string {
  switch (state) {
    case 'running':
      return 'ok';
    case 'starting':
      return 'info';
    case 'backoff':
      return 'warn';
    case 'invalid':
      return 'bad';
    case 'stopping':
    case 'disabled':
      return 'neutral';
  }
}

/**
 * Placement mode badge (hot/cold). Hot placements always encode and carry no
 * badge. Cold's active/standby distinction is no longer a placement-local
 * boolean — it's driven by the failover indicator (see
 * failoverIndicator.ts#placementBadgeClass) — so this is just the static
 * "cold" tag.
 */
export function placementModeBadge(p: Pick<RestreamPlacement, 'mode'>): { cls: string; label: string } | null {
  if (p.mode === 'hot') return null;
  return { cls: 'neutral', label: 'cold' };
}

/** liveness/underspeed probes currently below threshold (per-node instance-level probes) */
export function failingProbeBadges(n: RestreamerNodeStatus): Array<{ name: string; count: number }> {
  const out: Array<{ name: string; count: number }> = [];
  const probes = n.probes;
  if (!probes) return out;
  if (probes.liveness.consecutiveFailures > 0) {
    out.push({ name: 'liveness', count: probes.liveness.consecutiveFailures });
  }
  if (probes.underspeed.consecutiveFailures > 0) {
    out.push({ name: 'underspeed', count: probes.underspeed.consecutiveFailures });
  }
  return out;
}

/**
 * Compact "net 1.4× · lag 4s" summary of a node's last measurements: the
 * node-level underspeed ratio, and the WORST (max) session lag across its
 * sessions. Either piece is omitted when not measured yet; null when nothing
 * is measured at all.
 */
export function probeMeasurementLabel(n: RestreamerNodeStatus): string | null {
  const parts: string[] = [];
  const ratio = n.probes?.underspeed.lastSpeedRatio;
  if (ratio !== null && ratio !== undefined) parts.push(`net ${ratio.toFixed(1)}×`);
  const lagValues = n.sessions
    .map((s) => s.lagProbe?.lastLagSec)
    .filter((v): v is number => v !== null && v !== undefined);
  if (lagValues.length) parts.push(`lag ${Math.round(Math.max(...lagValues))}s`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * User-Agent prefix the restreamer daemon sends on its tvheadend stream
 * requests: `tvhc-restreamer/<version> (<session name>)` (restreamer
 * supervise/session.ts). tvheadend surfaces the UA as the subscription's
 * `client` field in status/subscriptions.
 */
export const RESTREAMER_UA_PREFIX = 'tvhc-restreamer/';

/** the subscription field carrying the restreamer UA, or null when not a restream sub */
function restreamerUa(sub: Pick<TvhSubscription, 'client' | 'title'>): string | null {
  for (const v of [sub.client, sub.title]) {
    if (typeof v === 'string' && v.startsWith(RESTREAMER_UA_PREFIX)) return v;
  }
  return null;
}

/** true when the tvheadend subscription originates from the restreamer daemon */
export function isRestreamSubscription(sub: Pick<TvhSubscription, 'client' | 'title'>): boolean {
  return restreamerUa(sub) !== null;
}

/**
 * Session name from the UA's parenthesized part
 * (`tvhc-restreamer/1.2.3 (mbs)` → `mbs`); null when absent/not a restream sub.
 */
export function restreamSessionName(sub: Pick<TvhSubscription, 'client' | 'title'>): string | null {
  const ua = restreamerUa(sub);
  if (ua === null) return null;
  const m = /\(([^)]+)\)\s*$/.exec(ua);
  return m ? m[1]! : null;
}

/** compact "3d 4h" / "4h 12m" / "12m" uptime label */
export function uptimeLabel(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
