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
import type { ChannelOption } from '@tvhc/shared';
import { lowestNumberFor, parseChannelInput, resolveChannelPick } from './channelPick.js';

function channel(name: string, number: string | null): ChannelOption {
  return { name, number, instances: [], eitOffsetMinutes: null };
}

const options: ChannelOption[] = [
  channel('KBS1', '51'),
  channel('KBS1', '9'),
  channel('ABC', '2'),
  channel('NoNumber', null),
  channel('SubChan', '9.1'),
  channel('SubChan', '51'),
];

describe('parseChannelInput', () => {
  it('matches an exact chanLabel against the channel list', () => {
    expect(parseChannelInput('51　KBS1', options)).toEqual({ name: 'KBS1', number: '51' });
    expect(parseChannelInput('9　KBS1', options)).toEqual({ name: 'KBS1', number: '9' });
  });

  it('matches an exact chanLabel for a decimal-numbered channel', () => {
    expect(parseChannelInput('9.1　SubChan', options)).toEqual({ name: 'SubChan', number: '9.1' });
  });

  it('parses the "N　Name" textual shape even when absent from the list (offline channel)', () => {
    expect(parseChannelInput('123　Offline Channel', options)).toEqual({
      name: 'Offline Channel',
      number: '123',
    });
  });

  it('parses a decimal number in the "N　Name" shape', () => {
    expect(parseChannelInput('5.1　Sub Channel', options)).toEqual({
      name: 'Sub Channel',
      number: '5.1',
    });
  });

  it('keeps a full-width name with an internal full-width space intact', () => {
    expect(parseChannelInput('9.1　ＴＯＫＹＯ　ＭＸ１', options)).toEqual({
      name: 'ＴＯＫＹＯ　ＭＸ１',
      number: '9.1',
    });
  });

  it('treats a bare name as name with no number', () => {
    expect(parseChannelInput('KBS1', options)).toEqual({ name: 'KBS1', number: null });
  });

  it('treats a name containing digits, but not in the "N　Name" shape, as a bare name', () => {
    expect(parseChannelInput('Channel 5', options)).toEqual({ name: 'Channel 5', number: null });
    expect(parseChannelInput('5 Channel', options)).toEqual({ name: '5 Channel', number: null });
  });

  it('treats empty input as a bare empty name', () => {
    expect(parseChannelInput('', options)).toEqual({ name: '', number: null });
  });
});

describe('lowestNumberFor', () => {
  it('returns the lowest number among same-name channels', () => {
    expect(lowestNumberFor('KBS1', options)).toBe('9');
  });

  it('returns the lowest number by numeric order, not lexicographic order', () => {
    expect(lowestNumberFor('SubChan', options)).toBe('9.1');
  });

  it('returns null when no same-name channel carries a number', () => {
    expect(lowestNumberFor('NoNumber', options)).toBeNull();
  });

  it('returns null when the name matches nothing', () => {
    expect(lowestNumberFor('Missing', options)).toBeNull();
  });
});

describe('resolveChannelPick', () => {
  it('returns "any" for empty input', () => {
    expect(resolveChannelPick('', options)).toEqual({ name: '', number: null });
  });

  it('returns the pinned pair as-is for an exact label match', () => {
    expect(resolveChannelPick('51　KBS1', options)).toEqual({ name: 'KBS1', number: '51' });
  });

  it('returns the pinned pair as-is for an exact decimal-numbered label match', () => {
    expect(resolveChannelPick('9.1　SubChan', options)).toEqual({
      name: 'SubChan',
      number: '9.1',
    });
  });

  it('pins a bare known name to its lowest number', () => {
    expect(resolveChannelPick('KBS1', options)).toEqual({ name: 'KBS1', number: '9' });
  });

  it('pins a bare name whose candidates are "9.1" and "51" to the numerically lowest', () => {
    expect(resolveChannelPick('SubChan', options)).toEqual({ name: 'SubChan', number: '9.1' });
  });

  it('pins a bare known name with no numbered variants to null', () => {
    expect(resolveChannelPick('NoNumber', options)).toEqual({ name: 'NoNumber', number: null });
  });

  it('returns null (blocks save) for a bare unknown name', () => {
    expect(resolveChannelPick('Nonexistent', options)).toBeNull();
  });

  it('keeps a parsed pinned pair for an offline "N　Name" input, even though absent from the list', () => {
    expect(resolveChannelPick('7　Offline', options)).toEqual({ name: 'Offline', number: '7' });
  });
});
