/*
 * hlsParse.ts is PURE (text in, facts out) — no I/O.
 */

import { describe, expect, it } from 'vitest';
import { parseLastPdtEndMs, parseMasterVariant, parseNewestSegment } from '../src/restreamer/hlsParse.js';

describe('parseMasterVariant', () => {
  it('extracts the URI following #EXT-X-STREAM-INF', () => {
    const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000000', 'variant.m3u8', ''].join('\n');
    expect(parseMasterVariant(text)).toBe('variant.m3u8');
  });

  it('returns null for a plain media playlist (no #EXT-X-STREAM-INF)', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:5.0,', 'seg1.ts', ''].join('\n');
    expect(parseMasterVariant(text)).toBeNull();
  });

  it('tolerates blank lines and CRLF', () => {
    const text = '#EXTM3U\r\n\r\n#EXT-X-STREAM-INF:BANDWIDTH=1\r\nv.m3u8\r\n';
    expect(parseMasterVariant(text)).toBe('v.m3u8');
  });
});

describe('parseNewestSegment', () => {
  it('returns the LAST segment with its EXTINF duration', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXTINF:5.0,',
      'seg1.ts',
      '#EXTINF:5.5,',
      'seg2.ts',
      '',
    ].join('\n');
    expect(parseNewestSegment(text)).toEqual({ uri: 'seg2.ts', durationSec: 5.5 });
  });

  it('falls back to #EXT-X-TARGETDURATION when a segment has no preceding EXTINF', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', 'seg1.ts', ''].join('\n');
    expect(parseNewestSegment(text)).toEqual({ uri: 'seg1.ts', durationSec: 6 });
  });

  it('returns null when the playlist has no segments', () => {
    const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', ''].join('\n');
    expect(parseNewestSegment(text)).toBeNull();
  });

  it('an empty/blank text has no segments', () => {
    expect(parseNewestSegment('')).toBeNull();
  });
});

describe('parseLastPdtEndMs', () => {
  it('PDT + EXTINF duration -> PDT + duration in ms', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
      '#EXTINF:5.0,',
      'seg1.ts',
      '',
    ].join('\n');
    const expected = Date.parse('2026-01-01T00:00:00.000Z') + 5000;
    expect(parseLastPdtEndMs(text)).toBe(expected);
  });

  it('no PDT at all -> null', () => {
    const text = ['#EXTM3U', '#EXTINF:5.0,', 'seg1.ts', ''].join('\n');
    expect(parseLastPdtEndMs(text)).toBeNull();
  });

  it('an unparsable PDT is skipped (does not corrupt a later good one)', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-PROGRAM-DATE-TIME:not-a-date',
      '#EXTINF:5.0,',
      'seg1.ts',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:10.000Z',
      '#EXTINF:5.0,',
      'seg2.ts',
      '',
    ].join('\n');
    const expected = Date.parse('2026-01-01T00:00:10.000Z') + 5000;
    expect(parseLastPdtEndMs(text)).toBe(expected);
  });

  it('a PDT with no EXTINF duration defaults to 0s added', () => {
    const text = ['#EXTM3U', '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z', 'seg1.ts', ''].join(
      '\n',
    );
    expect(parseLastPdtEndMs(text)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('uses the LAST PDT-tagged segment when several are present', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z',
      '#EXTINF:5.0,',
      'seg1.ts',
      '#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:05.000Z',
      '#EXTINF:5.0,',
      'seg2.ts',
      '',
    ].join('\n');
    expect(parseLastPdtEndMs(text)).toBe(Date.parse('2026-01-01T00:00:05.000Z') + 5000);
  });
});
