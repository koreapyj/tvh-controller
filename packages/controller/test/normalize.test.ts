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
import type { TvhAutorecRule } from '@tvhc/shared';
import { diffPayloads } from '../src/sync/diff.js';
import { normalizePayload, normalizeRule, payloadHash, type NameMaps } from '../src/sync/normalize.js';

const maps: NameMaps = {
  channelsByUuid: new Map([['ch-uuid-1', 'KBS1']]),
  tagsByUuid: new Map([['tag-uuid-1', 'Terrestrial']]),
  dvrConfigsByUuid: new Map([['cfg-uuid-1', 'default profile']]),
};

const tvhRule: TvhAutorecRule = {
  uuid: 'rule-uuid',
  enabled: true,
  name: 'News',
  title: '^News',
  channel: 'ch-uuid-1',
  tag: 'tag-uuid-1',
  config_name: 'cfg-uuid-1',
  weekdays: [5, 1, 3],
  pri: 6,
  serieslink: 'crid://foo', // read-only, must be dropped
  owner: 'admin',
  creator: 'admin',
};

describe('normalizeRule', () => {
  it('maps instance-local uuids to names', () => {
    const p = normalizeRule(tvhRule, maps);
    expect(p.channel).toBe('KBS1');
    expect(p.tag).toBe('Terrestrial');
    expect(p.config_name).toBe('default profile');
  });

  it('sorts weekdays for stable comparison', () => {
    expect(normalizeRule(tvhRule, maps).weekdays).toEqual([1, 3, 5]);
  });

  it('drops uuid/serieslink/owner/creator', () => {
    const p = normalizeRule(tvhRule, maps) as Record<string, unknown>;
    expect(p.uuid).toBeUndefined();
    expect(p.serieslink).toBeUndefined();
    expect(p.owner).toBeUndefined();
    expect(p.creator).toBeUndefined();
  });

  it('round-trip: a sparse rule and a default-filled rule hash identically', () => {
    // tvheadend fills defaults on save; baseline comparison must not drift
    const sparse = normalizeRule({ uuid: 'x', name: 'A', title: 't' }, maps);
    const filled = normalizeRule(
      {
        uuid: 'y',
        name: 'A',
        title: 't',
        enabled: true,
        fulltext: false,
        weekdays: [],
        minduration: 0,
        maxduration: 0,
        pri: 6,
        record: 0,
        retention: 0,
        removal: 0,
        maxcount: 0,
        maxsched: 0,
        start_extra: 0,
        stop_extra: 0,
      },
      maps,
    );
    expect(payloadHash(sparse)).toBe(payloadHash(filled));
  });
});

describe('payloadHash', () => {
  it('is insensitive to key order', () => {
    const a = normalizeRule(tvhRule, maps);
    const reordered = JSON.parse(
      JSON.stringify(a, Object.keys(a).sort().reverse()),
    ) as typeof a;
    expect(payloadHash(a)).toBe(payloadHash(reordered));
  });

  it('changes when a field changes', () => {
    const a = normalizeRule(tvhRule, maps);
    const b = { ...a, title: '^News 9' };
    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });
});

describe('diffPayloads', () => {
  it('reports only changed fields', () => {
    const a = normalizePayload(normalizeRule(tvhRule, maps));
    const b = { ...a, title: '^News 9', pri: 2 };
    const diffs = diffPayloads(a, b);
    expect(diffs.map((d) => d.field).sort()).toEqual(['pri', 'title']);
  });

  it('treats equal weekday arrays as equal', () => {
    const a = normalizePayload(normalizeRule(tvhRule, maps));
    const b = { ...a, weekdays: [1, 3, 5] };
    expect(diffPayloads(a, b)).toEqual([]);
  });
});
