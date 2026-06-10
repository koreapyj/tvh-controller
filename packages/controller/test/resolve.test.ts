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
import type { MasterRulePayload } from '@tvhc/shared';
import { normalizePayload } from '../src/sync/normalize.js';
import { definedProps, inScope, materializeScope, resolveEffective } from '../src/sync/resolve.js';

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
