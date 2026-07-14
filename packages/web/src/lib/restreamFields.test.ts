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

import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AribHlsParams,
  type ProbeStatus,
  type RestreamerNodeStatus,
  type RestreamPlaylist,
  type RestreamProfile,
} from '@tvhc/shared';
import type { AribHlsParams as AribHlsParamsT } from '@tvhc/shared';
import {
  addAudioRow,
  AUDIO_ENTRY_FIELDS,
  buildProfilePayload,
  CHANNEL_BATCH_FIELDS,
  compareChannels,
  defaultProfilePayload,
  deriveSlug,
  emptyAudioRow,
  failingProbeBadges,
  getByPath,
  isRestreamSubscription,
  MAX_AUDIO_ENTRIES,
  MIN_AUDIO_ENTRIES,
  parseProfileValue,
  placementModeBadge,
  probeMeasurementLabel,
  PROFILE_FIELDS,
  profileToVals,
  removeAudioRow,
  restreamSessionName,
  sessionStateBadge,
  setByPath,
  SLUG_PATTERN,
  VIDEO_MODE_OPTIONS,
  type ProfileFieldSpec,
} from './restreamFields.js';

function spec(path: string): ProfileFieldSpec {
  const s =
    PROFILE_FIELDS.find((f) => f.path === path) ?? AUDIO_ENTRY_FIELDS.find((f) => f.path === path);
  if (!s) throw new Error(`no spec for ${path}`);
  return s;
}

describe('PROFILE_FIELDS', () => {
  it('has unique paths (top-level and audio separately)', () => {
    const top = PROFILE_FIELDS.map((f) => f.path);
    expect(new Set(top).size).toBe(top.length);
    const audio = AUDIO_ENTRY_FIELDS.map((f) => f.path);
    expect(new Set(audio).size).toBe(audio.length);
  });

  it('audio entry paths cover every AribHlsAudio knob', () => {
    // a new audio knob in the contract permanently fails this until exposed
    const schemaKeys = Object.keys(AribHlsParams.properties.audio.items.properties);
    expect(new Set(AUDIO_ENTRY_FIELDS.map((f) => f.path))).toEqual(new Set(schemaKeys));
  });

  it('every VIDEO_MODE_OPTIONS value validates against the contract', () => {
    expect(VIDEO_MODE_OPTIONS.map((o) => o.value)).toEqual(['ivtc', 'deinterlace', 'none']);
    for (const o of VIDEO_MODE_OPTIONS) {
      const p = defaultProfilePayload();
      p.video.mode = o.value as AribHlsParamsT['video']['mode'];
      expect(Value.Check(AribHlsParams, p), o.value).toBe(true);
    }
  });
});

describe('defaultProfilePayload', () => {
  it('passes the wire-contract schema', () => {
    expect(Value.Check(AribHlsParams, defaultProfilePayload())).toBe(true);
  });

  it('carries the prod dual-audio layout', () => {
    expect(defaultProfilePayload().audio).toHaveLength(2);
  });
});

describe('path get/set', () => {
  it('getByPath reads nested values and returns undefined for missing segments', () => {
    const p = defaultProfilePayload();
    expect(getByPath(p, 'video.mode')).toBe('ivtc');
    expect(getByPath(p, 'hls.segmentSeconds')).toBeUndefined();
    expect(getByPath(p, 'video.mode.nope')).toBeUndefined();
  });

  it('setByPath creates intermediate objects and deletes on undefined', () => {
    const obj: Record<string, unknown> = {};
    setByPath(obj, 'hls.listSize', 60);
    expect(obj).toEqual({ hls: { listSize: 60 } });
    setByPath(obj, 'hls.listSize', undefined);
    expect(obj).toEqual({ hls: {} });
    // deleting through a missing parent is a no-op
    setByPath(obj, 'thumbnail.width', undefined);
    expect(obj).toEqual({ hls: {} });
  });
});

describe('parseProfileValue', () => {
  it("'' means unset for every type", () => {
    for (const f of [...PROFILE_FIELDS, ...AUDIO_ENTRY_FIELDS]) {
      expect(parseProfileValue(f, '')).toEqual({ ok: true, value: undefined });
    }
  });

  it('int rejects non-integers, num rejects non-numbers', () => {
    expect(parseProfileValue(spec('video.preset'), '7')).toEqual({ ok: true, value: 7 });
    expect(parseProfileValue(spec('video.preset'), '7.5').ok).toBe(false);
    expect(parseProfileValue(spec('video.preset'), 'x').ok).toBe(false);
    expect(parseProfileValue(spec('hls.segmentSeconds'), '2.5')).toEqual({ ok: true, value: 2.5 });
    expect(parseProfileValue(spec('hls.segmentSeconds'), 'x').ok).toBe(false);
  });

  it('bool yes/no, str passthrough', () => {
    expect(parseProfileValue(spec('subtitles.enabled'), 'yes')).toEqual({ ok: true, value: true });
    expect(parseProfileValue(spec('subtitles.enabled'), 'no')).toEqual({ ok: true, value: false });
    expect(parseProfileValue(spec('video.bitrate'), '3M')).toEqual({ ok: true, value: '3M' });
  });
});

describe('profileToVals / buildProfilePayload round trip', () => {
  it('the production default round-trips exactly and re-validates', () => {
    const built = buildProfilePayload(profileToVals(defaultProfilePayload()));
    expect(built).toEqual({ ok: true, payload: defaultProfilePayload() });
    if (built.ok) expect(Value.Check(AribHlsParams, built.payload)).toBe(true);
  });

  it('a fully populated payload round-trips exactly and re-validates', () => {
    const full: AribHlsParamsT = {
      template: 'arib-hls',
      templateVersion: 1,
      video: { mode: 'deinterlace', bitrate: '5M', gop: '30000/1001', preset: 4 },
      audio: [
        { bitrate: '192k', volume: '3dB', language: 'jpn', name: 'Main', isDefault: true },
        { bitrate: '64k', volume: '5dB', language: 'eng', name: 'Sub', isDefault: false },
      ],
      subtitles: { enabled: true, language: 'jpn' },
      thumbnail: { enabled: false, width: 320, height: 180, intervalSec: 10 },
      hls: { segmentSeconds: 4, listSize: 60 },
    };
    const built = buildProfilePayload(profileToVals(full));
    expect(built).toEqual({ ok: true, payload: full });
    if (built.ok) expect(Value.Check(AribHlsParams, built.payload)).toBe(true);
  });

  it('requires video.mode', () => {
    const state = profileToVals(defaultProfilePayload());
    state.vals['video.mode'] = '';
    expect(buildProfilePayload(state).ok).toBe(false);
  });

  it('propagates knob parse errors with the field label', () => {
    const state = profileToVals(defaultProfilePayload());
    state.vals['video.preset'] = 'fast';
    const built = buildProfilePayload(state);
    expect(built).toEqual({ ok: false, error: '"QSV preset" must be an integer' });
  });

  it('rejects audio row counts outside the contract bounds', () => {
    const state = profileToVals(defaultProfilePayload());
    expect(buildProfilePayload({ ...state, audio: [] }).ok).toBe(false);
    expect(
      buildProfilePayload({ ...state, audio: Array.from({ length: 5 }, () => emptyAudioRow()) }).ok,
    ).toBe(false);
    const four = buildProfilePayload({
      ...state,
      audio: Array.from({ length: 4 }, () => emptyAudioRow()),
    });
    expect(four.ok).toBe(true);
    if (four.ok) expect(Value.Check(AribHlsParams, four.payload)).toBe(true);
  });
});

describe('audio row add/remove bounds (1..4)', () => {
  it('addAudioRow appends a blank row and stops at the cap', () => {
    let rows = [emptyAudioRow()];
    for (let i = 0; i < 10; i++) rows = addAudioRow(rows);
    expect(rows).toHaveLength(MAX_AUDIO_ENTRIES);
    expect(rows[rows.length - 1]).toEqual(emptyAudioRow());
  });

  it('removeAudioRow drops the given index and stops at the floor', () => {
    const a = { ...emptyAudioRow(), name: 'a' };
    const b = { ...emptyAudioRow(), name: 'b' };
    expect(removeAudioRow([a, b], 0)).toEqual([b]);
    expect(removeAudioRow([a], 0)).toEqual([a]); // floor: never below MIN
    expect(MIN_AUDIO_ENTRIES).toBe(1);
  });
});

describe('CHANNEL_BATCH_FIELDS', () => {
  const profiles: RestreamProfile[] = [
    { id: 'p1', name: 'hevc-3M', payload: defaultProfilePayload(), updatedAt: '' },
    { id: 'p2', name: 'hevc-5M', payload: defaultProfilePayload(), updatedAt: '' },
  ];
  const playlists: RestreamPlaylist[] = [
    { id: 'pl1', slug: 'main', title: 'Main channels', updatedAt: '' },
    { id: 'pl2', slug: 'sports', title: 'Sports', updatedAt: '' },
  ];

  it('exposes enabled, profileId, comment, playlistIds', () => {
    expect(CHANNEL_BATCH_FIELDS(profiles, playlists).map((f) => f.key)).toEqual([
      'enabled',
      'profileId',
      'comment',
      'playlistIds',
    ]);
  });

  it('builds the profile enum from runtime profiles (ids as opaque strings)', () => {
    const f = CHANNEL_BATCH_FIELDS(profiles, playlists).find((x) => x.key === 'profileId')!;
    expect(f.type).toBe('strenum');
    expect(f.strOptions).toEqual([
      { value: 'p1', label: 'hevc-3M' },
      { value: 'p2', label: 'hevc-5M' },
    ]);
  });

  it('builds the playlist multiselect from runtime playlists', () => {
    const f = CHANNEL_BATCH_FIELDS(profiles, playlists).find((x) => x.key === 'playlistIds')!;
    expect(f.type).toBe('multiselect');
    expect(f.strOptions).toEqual([
      { value: 'pl1', label: 'Main channels' },
      { value: 'pl2', label: 'Sports' },
    ]);
  });
});

describe('deriveSlug (mirror of the controller derivation)', () => {
  it('lowercases and collapses non [a-z0-9-] runs', () => {
    expect(deriveSlug('AT-X')).toBe('at-x');
    expect(deriveSlug('TVh 東京 MX!')).toBe('tvh-mx');
    expect(deriveSlug('--a--b--')).toBe('a-b');
  });

  it('never returns an invalid slug', () => {
    for (const name of ['', '　', '!!!', 'x'.repeat(200), 'a'.repeat(63) + '--b']) {
      expect(SLUG_PATTERN.test(deriveSlug(name)), JSON.stringify(name)).toBe(true);
    }
    expect(deriveSlug('')).toBe('channel');
  });
});

describe('compareChannels', () => {
  const ch = (channelName: string, channelNumber: string | null) => ({
    channelName,
    channelNumber,
  });

  it('orders numerically, not lexicographically ("9.1" < "10" < "51")', () => {
    expect(compareChannels(ch('a', '9.1'), ch('b', '10'))).toBeLessThan(0);
    expect(compareChannels(ch('a', '10'), ch('b', '51'))).toBeLessThan(0);
    expect(compareChannels(ch('a', '51'), ch('b', '9.1'))).toBeGreaterThan(0);
  });

  it('puts channels without a number AFTER numbered ones', () => {
    expect(compareChannels(ch('a', null), ch('b', '999'))).toBeGreaterThan(0);
    expect(compareChannels(ch('a', '999'), ch('b', null))).toBeLessThan(0);
  });

  it('tie-breaks equal numbers by name (localeCompare)', () => {
    expect(compareChannels(ch('ABC', '9'), ch('XYZ', '9'))).toBeLessThan(0);
    expect(compareChannels(ch('XYZ', '9'), ch('ABC', '9'))).toBeGreaterThan(0);
  });

  it('tie-breaks two number-less channels by name', () => {
    expect(compareChannels(ch('ABC', null), ch('XYZ', null))).toBeLessThan(0);
    expect(compareChannels(ch('ABC', null), ch('ABC', null))).toBe(0);
  });

  it('sorts a channel list into playlist order', () => {
    const sorted = [
      ch('ext one', null),
      ch('SubTen', '9.10'),
      ch('Fifty-one', '51'),
      ch('SubOne', '9.1'),
      ch('Ten', '10'),
      ch('another ext', null),
    ].sort(compareChannels);
    expect(sorted.map((c) => c.channelName)).toEqual([
      'SubOne',
      'SubTen', // "9.10" ties "9.1" numerically (ordering only) — name breaks it
      'Ten',
      'Fifty-one',
      'another ext',
      'ext one',
    ]);
  });
});

describe('sessionStateBadge', () => {
  it('maps every session state to a badge class', () => {
    expect(sessionStateBadge('running')).toBe('ok');
    expect(sessionStateBadge('starting')).toBe('info');
    expect(sessionStateBadge('backoff')).toBe('warn');
    expect(sessionStateBadge('invalid')).toBe('bad');
    expect(sessionStateBadge('stopping')).toBe('neutral');
    expect(sessionStateBadge('disabled')).toBe('neutral');
  });
});

describe('placementModeBadge', () => {
  it('hot placements carry no badge', () => {
    expect(placementModeBadge({ mode: 'hot' })).toBeNull();
  });

  it('cold placements show a neutral "cold" tag', () => {
    expect(placementModeBadge({ mode: 'cold' })).toEqual({ cls: 'neutral', label: 'cold' });
  });
});

function probeStatus(over: Partial<ProbeStatus> = {}): ProbeStatus {
  return {
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    failed: false,
    lastResult: null,
    lastCheckedAt: null,
    detail: null,
    ...over,
  };
}

function node(over: Partial<RestreamerNodeStatus> = {}): RestreamerNodeStatus {
  return {
    instanceId: 'tokyo',
    nodeId: 'node-a',
    url: 'http://node-a:5580',
    serveUrl: null,
    reachable: true,
    error: null,
    lastPollAt: null,
    version: '1.0.0',
    uptimeSec: 60,
    apiVersionSupported: true,
    desiredRevision: null,
    pendingPush: false,
    probes: null,
    sessions: [],
    sourcesHash: null,
    sources: null,
    capabilities: null,
    templates: null,
    ...over,
  };
}

describe('failingProbeBadges', () => {
  it('is empty when probes are null (nothing probeable yet)', () => {
    expect(failingProbeBadges(node({ probes: null }))).toEqual([]);
  });

  it('is empty when liveness/underspeed have no consecutive failures', () => {
    const n = node({
      probes: { liveness: probeStatus(), underspeed: { ...probeStatus(), lastSpeedRatio: null } },
    });
    expect(failingProbeBadges(n)).toEqual([]);
  });

  it('surfaces liveness and underspeed failures with their counts', () => {
    const n = node({
      probes: {
        liveness: probeStatus({ consecutiveFailures: 2 }),
        underspeed: { ...probeStatus({ consecutiveFailures: 5 }), lastSpeedRatio: 0.4 },
      },
    });
    expect(failingProbeBadges(n)).toEqual([
      { name: 'liveness', count: 2 },
      { name: 'underspeed', count: 5 },
    ]);
  });
});

describe('probeMeasurementLabel', () => {
  it('is null when nothing is measured', () => {
    expect(probeMeasurementLabel(node())).toBeNull();
  });

  it('shows the underspeed ratio alone when no session has a lag measurement', () => {
    const n = node({
      probes: {
        liveness: probeStatus(),
        underspeed: { ...probeStatus(), lastSpeedRatio: 1.4 },
      },
    });
    expect(probeMeasurementLabel(n)).toBe('net 1.4×');
  });

  it('shows the WORST (max) lag across sessions alone when underspeed is unmeasured', () => {
    const n = node({
      sessions: [
        { name: 'a', lagProbe: { ...probeStatus(), lastLagSec: 2, firstMeasuredAt: null } },
        { name: 'b', lagProbe: { ...probeStatus(), lastLagSec: 9.6, firstMeasuredAt: null } },
      ] as unknown as RestreamerNodeStatus['sessions'],
    });
    expect(probeMeasurementLabel(n)).toBe('lag 10s');
  });

  it('combines both pieces when available', () => {
    const n = node({
      probes: { liveness: probeStatus(), underspeed: { ...probeStatus(), lastSpeedRatio: 0.9 } },
      sessions: [
        { name: 'a', lagProbe: { ...probeStatus(), lastLagSec: 4, firstMeasuredAt: null } },
      ] as unknown as RestreamerNodeStatus['sessions'],
    });
    expect(probeMeasurementLabel(n)).toBe('net 0.9× · lag 4s');
  });
});

describe('isRestreamSubscription / restreamSessionName', () => {
  // exact format from restreamer supervise/session.ts:
  //   `tvhc-restreamer/${daemonVersion} (${name})`
  const daemonUa = 'tvhc-restreamer/1.4.0 (at-x)';

  it('matches the daemon UA in the client field and extracts the session name', () => {
    const sub = { client: daemonUa };
    expect(isRestreamSubscription(sub)).toBe(true);
    expect(restreamSessionName(sub)).toBe('at-x');
  });

  it('falls back to the title field when client lacks the UA', () => {
    const sub = { client: '192.0.2.10', title: daemonUa };
    expect(isRestreamSubscription(sub)).toBe(true);
    expect(restreamSessionName(sub)).toBe('at-x');
  });

  it('requires the prefix at position 0', () => {
    expect(isRestreamSubscription({ client: 'proxy tvhc-restreamer/1.0.0 (x)' })).toBe(false);
  });

  it('is null-safe on missing/empty fields', () => {
    expect(isRestreamSubscription({})).toBe(false);
    expect(isRestreamSubscription({ client: '', title: '' })).toBe(false);
    expect(isRestreamSubscription({ client: undefined, title: undefined })).toBe(false);
    expect(restreamSessionName({})).toBe(null);
  });

  it('rejects ordinary player user agents', () => {
    for (const ua of [
      'VLC/3.0.20 LibVLC/3.0.20',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Lavf/61.1.100',
      'Kodi/21.0 (X11; Linux x86_64)',
    ]) {
      expect(isRestreamSubscription({ client: ua }), ua).toBe(false);
      expect(restreamSessionName({ client: ua }), ua).toBe(null);
    }
  });

  it('detects a restream sub without a parenthesized name (name null)', () => {
    const sub = { client: 'tvhc-restreamer/2.0.0' };
    expect(isRestreamSubscription(sub)).toBe(true);
    expect(restreamSessionName(sub)).toBe(null);
  });

  it('uses the LAST parenthesized group so names survive versioned suffixes', () => {
    expect(restreamSessionName({ client: 'tvhc-restreamer/1.4.0 (dev) (tokyo-mx)' })).toBe('tokyo-mx');
  });
});
