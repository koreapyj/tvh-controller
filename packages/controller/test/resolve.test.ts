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
import type { MasterRulePayload, TvhChannel } from '@tvhc/shared';
import { normalizePayload } from '../src/sync/normalize.js';
import {
  channelSetterValue,
  definedProps,
  inScope,
  materializeScope,
  resolveEffective,
} from '../src/sync/resolve.js';

const parentPayload: MasterRulePayload = normalizePayload({
  name: '黄泉のツガイ (26Q2)',
  title: '黄泉のツガイ',
  channel: 'ＢＳ１１イレブン',
  weekdays: [5],
  pri: 6,
  comment: '26Q2',
} as MasterRulePayload);

const parent = { payload: parentPayload };

describe('resolveEffective', () => {
  it('plain rule: payload with the rule name applied', () => {
    const eff = resolveEffective({
      name: 'renamed',
      payload: parentPayload,
      parentId: null,
      overlay: null,
    });
    expect(eff.name).toBe('renamed');
    expect(eff.channel).toBe('ＢＳ１１イレブン');
  });

  it('linked clone inherits everything except the overlay', () => {
    const eff = resolveEffective(
      {
        name: '黄泉のツガイ (26Q2) (ＴＯＫＹＯ　ＭＸ１)',
        payload: {} as MasterRulePayload,
        parentId: 'p1',
        overlay: { channel: 'ＴＯＫＹＯ　ＭＸ１' },
      },
      parent,
    );
    expect(eff.channel).toBe('ＴＯＫＹＯ　ＭＸ１'); // overridden
    expect(eff.title).toBe('黄泉のツガイ'); // inherited
    expect(eff.comment).toBe('26Q2'); // inherited
    expect(eff.weekdays).toEqual([5]); // inherited
    expect(eff.name).toBe('黄泉のツガイ (26Q2) (ＴＯＫＹＯ　ＭＸ１)'); // own name
  });

  it('null/undefined overlay values do not shadow inherited fields', () => {
    const eff = resolveEffective(
      {
        name: 'clone',
        payload: {} as MasterRulePayload,
        parentId: 'p1',
        overlay: { channel: undefined, comment: null } as Partial<MasterRulePayload>,
      },
      parent,
    );
    expect(eff.channel).toBe('ＢＳ１１イレブン');
    expect(eff.comment).toBe('26Q2');
  });

  it('empty overlay equals the parent (apart from the name)', () => {
    const eff = resolveEffective(
      { name: 'copy', payload: {} as MasterRulePayload, parentId: 'p1', overlay: {} },
      parent,
    );
    expect({ ...eff, name: parentPayload.name }).toEqual(parentPayload);
  });

  it('throws on a missing parent', () => {
    expect(() =>
      resolveEffective(
        { name: 'x', payload: {} as MasterRulePayload, parentId: 'gone', overlay: {} },
        null,
      ),
    ).toThrow(/missing parent/);
  });

  describe('channel identity (name, number) pairing', () => {
    const pinnedParent = { payload: normalizePayload({ ...parentPayload, channel: 'Y', channel_number: '51' } as MasterRulePayload) };

    it('overlay overrides the channel name without a number: effective number is null, not inherited', () => {
      const eff = resolveEffective(
        { name: 'clone', payload: {} as MasterRulePayload, parentId: 'p1', overlay: { channel: 'X' } },
        pinnedParent,
      );
      expect(eff.channel).toBe('X');
      expect(eff.channel_number).toBeNull();
    });

    it('overlay overrides both channel and channel_number: the pinned pair wins', () => {
      const eff = resolveEffective(
        {
          name: 'clone',
          payload: {} as MasterRulePayload,
          parentId: 'p1',
          overlay: { channel: 'X', channel_number: '3' },
        },
        pinnedParent,
      );
      expect(eff.channel).toBe('X');
      expect(eff.channel_number).toBe('3');
    });

    it('overlay sets only channel_number: pins the parent name to that number', () => {
      const eff = resolveEffective(
        { name: 'clone', payload: {} as MasterRulePayload, parentId: 'p1', overlay: { channel_number: '7' } },
        pinnedParent,
      );
      expect(eff.channel).toBe('Y'); // parent's name, untouched
      expect(eff.channel_number).toBe('7');
    });

    it('empty overlay inherits the parent pair intact', () => {
      const eff = resolveEffective(
        { name: 'clone', payload: {} as MasterRulePayload, parentId: 'p1', overlay: {} },
        pinnedParent,
      );
      expect(eff.channel).toBe('Y');
      expect(eff.channel_number).toBe('51');
    });
  });
});

describe('channelSetterValue', () => {
  const channels: TvhChannel[] = [
    { uuid: 'ch-kbs1', name: 'KBS1', number: '1' },
    { uuid: 'ch-kbs51', name: 'KBS1', number: '51' },
    { uuid: 'ch-kbs51-dup', name: 'KBS1', number: '51' },
  ];

  it('null number: resolves to the lowest-numbered same-name channel', () => {
    expect(channelSetterValue(channels, 'KBS1', null)).toBe('ch-kbs1');
  });

  it('null number, name not on this instance: falls back to the bare name', () => {
    expect(channelSetterValue(channels, 'MBC', null)).toBe('MBC');
  });

  it('null number, only numberless candidates: first grid entry wins', () => {
    const numberless: TvhChannel[] = [
      { uuid: 'ch-a', name: 'X' },
      { uuid: 'ch-b', name: 'X' },
    ];
    expect(channelSetterValue(numberless, 'X', null)).toBe('ch-a');
  });

  it('null number: numberless channels sort behind numbered ones', () => {
    const mixed: TvhChannel[] = [
      { uuid: 'ch-nonum', name: 'Y' },
      { uuid: 'ch-y7', name: 'Y', number: '7' },
    ];
    expect(channelSetterValue(mixed, 'Y', null)).toBe('ch-y7');
  });

  it('null number: lowest across a non-integer and an integer number picks the numerically lowest ("9.1" over "51")', () => {
    const mixed: TvhChannel[] = [
      { uuid: 'ch-51', name: 'Z', number: '51' },
      { uuid: 'ch-9-1', name: 'Z', number: '9.1' },
    ];
    expect(channelSetterValue(mixed, 'Z', null)).toBe('ch-9-1');
  });

  it('empty name: returns empty string regardless of number', () => {
    expect(channelSetterValue(channels, '', '51')).toBe('');
  });

  it('pinned pair found: resolves to the channel uuid', () => {
    expect(channelSetterValue(channels, 'KBS1', '1')).toBe('ch-kbs1');
  });

  it('pinned pair missing on this instance: falls back to the name', () => {
    expect(channelSetterValue(channels, 'KBS1', '99')).toBe('KBS1');
  });

  it('duplicate name+number pair: the first grid entry wins', () => {
    expect(channelSetterValue(channels, 'KBS1', '51')).toBe('ch-kbs51');
  });
});

describe('scope helpers', () => {
  it('inScope: all matches everything', () => {
    expect(inScope('all', 'tyo1')).toBe(true);
    expect(inScope(['tyo2'], 'tyo1')).toBe(false);
    expect(inScope(['tyo1', 'tyo2'], 'tyo2')).toBe(true);
  });

  it('materializeScope expands all into the current instance list', () => {
    expect(materializeScope('all', ['tyo1', 'tyo2'])).toEqual(['tyo1', 'tyo2']);
    expect(materializeScope(['tyo2'], ['tyo1', 'tyo2'])).toEqual(['tyo2']);
  });
});

describe('definedProps', () => {
  it('drops undefined and null entries', () => {
    expect(definedProps({ a: 1, b: undefined, c: null, d: '' })).toEqual({ a: 1, d: '' });
  });
});
