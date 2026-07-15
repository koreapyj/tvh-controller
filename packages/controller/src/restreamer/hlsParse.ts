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

/**
 * Minimal M3U8 parsing shared by the probe engine (extracted from the retired
 * deliveryProbe.ts). PURE — text in, facts out.
 */

export interface ParsedSegmentRef {
  /** raw URI as it appeared in the playlist (may be relative) */
  uri: string;
  durationSec: number | null;
}

/**
 * First variant URI of a MASTER playlist (the line after `#EXT-X-STREAM-INF`);
 * null when the text is not a master playlist. arib-hls nodes serve a master
 * at `<session directory>/playlist.m3u8` with media playlists per variant
 * underneath, so probes follow one hop before looking for segments.
 */
export function parseMasterVariant(text: string): string | null {
  let afterStreamInf = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      afterStreamInf = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (afterStreamInf) return line;
  }
  return null;
}

/**
 * The LAST segment URI in a media playlist and its EXTINF duration (falling
 * back to `#EXT-X-TARGETDURATION`). Null when the playlist has no segments.
 */
export function parseNewestSegment(text: string): ParsedSegmentRef | null {
  let lastUri: string | null = null;
  let lastDuration: number | null = null;
  let pendingDuration: number | null = null;
  let targetDuration: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const v = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
      if (Number.isFinite(v)) targetDuration = v;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:([\d.]+)/.exec(line);
      pendingDuration = m ? Number(m[1]) : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    lastUri = line;
    lastDuration = pendingDuration ?? targetDuration;
    pendingDuration = null;
  }

  if (lastUri == null) return null;
  return { uri: lastUri, durationSec: lastDuration };
}

/**
 * End time (ms since epoch) of the newest segment carrying an
 * `#EXT-X-PROGRAM-DATE-TIME` tag: last PDT + that segment's EXTINF duration
 * (0 when missing). Null when the playlist has no parseable PDT — a
 * just-created playlist or a non-PDT stream; lag cannot be measured then.
 */
export function parseLastPdtEndMs(text: string): number | null {
  let lastPdtMs: number | null = null;
  let lastPdtDurationSec = 0;
  let pendingPdtMs: number | null = null;
  let pendingDuration: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const parsed = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
      pendingPdtMs = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:([\d.]+)/.exec(line);
      pendingDuration = m ? Number(m[1]) : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    // a segment URI closes the pending tags
    if (pendingPdtMs != null) {
      lastPdtMs = pendingPdtMs;
      lastPdtDurationSec = pendingDuration ?? 0;
    }
    pendingPdtMs = null;
    pendingDuration = null;
  }

  if (lastPdtMs == null) return null;
  return lastPdtMs + lastPdtDurationSec * 1000;
}
