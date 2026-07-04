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
import type { ChannelOption, InstanceSummary } from '@tvhc/shared';
import { commonEitOffset, conversionFor, offsetLabel, toEitTime } from './eit.js';

function channel(
  name: string,
  eitOffsetMinutes: number | null,
  number: string | null = null,
): ChannelOption {
  return { name, number, instances: [], eitOffsetMinutes };
}

function instance(serverOffsetMinutes: number | null): InstanceSummary {
  return {
    id: 'i1',
    name: 'i1',
    url: 'http://x',
    reachable: true,
    version: null,
    lastPollAt: null,
    error: null,
    serverOffsetMinutes,
  };
}

describe('commonEitOffset', () => {
  it('returns the shared offset when every known channel agrees', () => {
    expect(commonEitOffset([channel('a', 540), channel('b', 540)])).toBe(540);
  });

  it('returns null when offsets are mixed', () => {
    expect(commonEitOffset([channel('a', 540), channel('b', 0)])).toBeNull();
  });

  it('ignores null (unknown) offsets, still resolving a single distinct value', () => {
    expect(commonEitOffset([channel('a', 540), channel('b', null)])).toBe(540);
  });

  it('returns null when there is no information at all', () => {
    expect(commonEitOffset([])).toBeNull();
    expect(commonEitOffset([channel('a', null)])).toBeNull();
  });
});

describe('conversionFor', () => {
  it('returns null when no instance has a known server offset', () => {
    expect(conversionFor('a', null, [channel('a', 540)], [instance(null)])).toBeNull();
    expect(conversionFor('a', null, [channel('a', 540)], [])).toBeNull();
  });

  it('resolves per-channel eit offset and computes delta = eit - server', () => {
    const result = conversionFor('a', null, [channel('a', 540), channel('b', 0)], [instance(0)]);
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('falls back to the common offset when the named channel is not found', () => {
    // 'missing' channel not in the list -> falls back to commonEitOffset([a, b])
    const result = conversionFor(
      'missing',
      null,
      [channel('a', 540), channel('b', 540)],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('falls back to the common offset when the named channel has an unknown (null) offset', () => {
    const result = conversionFor(
      'a',
      null,
      [channel('a', null), channel('b', 540)],
      [instance(0)],
    );
    // commonEitOffset([a(null), b(540)]) -> 540 (the null is filtered out)
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('uses the common offset directly when no channel name is given', () => {
    const result = conversionFor('', null, [channel('a', 540), channel('b', 540)], [instance(0)]);
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('returns null when the eit offset cannot be resolved', () => {
    expect(
      conversionFor('missing', null, [channel('a', 540), channel('b', 0)], [instance(0)]),
    ).toBeNull();
  });

  it('returns null when server and eit zones match (no conversion needed)', () => {
    expect(conversionFor('a', null, [channel('a', 540)], [instance(540)])).toBeNull();
  });

  it('same-name duplicates -> uses the lowest-numbered channel offset', () => {
    const result = conversionFor(
      'a',
      null,
      [channel('a', 540, '1'), channel('a', 540, '2')],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('same-name duplicates, higher one unknown -> lowest still wins', () => {
    const result = conversionFor(
      'a',
      null,
      [channel('a', 540, '1'), channel('a', null, '2')],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('same-name duplicates disagree -> the lowest-numbered channel wins (the unpinned push target)', () => {
    const result = conversionFor(
      'a',
      null,
      [channel('a', 540, '1'), channel('a', 0, '2')],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('same-name duplicates, listed out of order -> still picks the lowest number, not the first entry', () => {
    const result = conversionFor(
      'a',
      null,
      [channel('a', 0, '51'), channel('a', 540, '1')],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('lowest-numbered channel offset unknown -> falls back to the global common offset', () => {
    const result = conversionFor(
      'a',
      null,
      [channel('a', null, '1'), channel('a', 0, '2'), channel('b', 540)],
      [instance(0)],
    );
    // lowest (#1) is unknown; global set {0, 540} is mixed -> no conversion
    expect(result).toBeNull();
  });

  it('same-name duplicates all unknown, but the global common offset resolves', () => {
    const result = conversionFor(
      'a',
      null,
      [channel('a', null, '1'), channel('a', null, '2'), channel('b', 540)],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('pinned number resolves exactly that channel, even when a same-name sibling differs', () => {
    const result = conversionFor(
      'a',
      '51',
      [channel('a', 0, '1'), channel('a', 540, '51')],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('pinned (name, number) pair not found -> falls back to the common offset', () => {
    const result = conversionFor(
      'a',
      '99',
      [channel('a', 540, '1'), channel('b', 540)],
      [instance(0)],
    );
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 540, deltaMinutes: 540 });
  });

  it('uses the first instance with a known offset, ignoring unknown ones', () => {
    const result = conversionFor('a', null, [channel('a', 60)], [instance(null), instance(0)]);
    expect(result).toEqual({ serverOffsetMinutes: 0, eitOffsetMinutes: 60, deltaMinutes: 60 });
  });
});

describe('offsetLabel', () => {
  it('formats a positive offset', () => {
    expect(offsetLabel(90)).toBe('+01:30');
  });

  it('formats a negative offset', () => {
    expect(offsetLabel(-90)).toBe('-01:30');
  });

  it('formats zero with a plus sign', () => {
    expect(offsetLabel(0)).toBe('+00:00');
  });

  it('formats a large offset', () => {
    expect(offsetLabel(570)).toBe('+09:30');
  });
});

describe('toEitTime', () => {
  const conv = (deltaMinutes: number) => ({
    serverOffsetMinutes: 0,
    eitOffsetMinutes: deltaMinutes,
    deltaMinutes,
  });

  it('converts a normal time with no day change', () => {
    // server offset -300 (EST), eit offset 0 (UTC) -> delta = +300
    expect(toEitTime('10:00', conv(300))).toEqual({ time: '15:00' });
  });

  it('is an identity conversion when delta is 0 (no conversion needed)', () => {
    expect(toEitTime('10:00', conv(0))).toEqual({ time: '10:00' });
  });

  it('wraps forward past midnight, running hours past 24 (TV-schedule notation)', () => {
    // 23:30 + 60min -> next day 00:30, rendered as "24:30" per the documented
    // TV-schedule convention (no subtraction of 1440 on the positive side)
    expect(toEitTime('23:30', conv(60))).toEqual({ time: '24:30' });
  });

  it('wraps backward across midnight for a negative delta', () => {
    // server 00:30 with a -60min shift -> previous day 23:30
    expect(toEitTime('00:30', conv(-60))).toEqual({ time: '23:30' });
  });

  it('returns null for an empty string', () => {
    expect(toEitTime('', conv(0))).toBeNull();
  });

  it('returns null for a malformed HH:MM (single-digit minutes)', () => {
    expect(toEitTime('1:2', conv(0))).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(toEitTime('abcd', conv(0))).toBeNull();
  });

  it('returns null when the minute part has more than two digits', () => {
    expect(toEitTime('12:345', conv(0))).toBeNull();
  });

  it('accepts surrounding whitespace and a single-digit hour', () => {
    expect(toEitTime(' 9:05 ', conv(0))).toEqual({ time: '09:05' });
  });

  it(
    'does not clamp hours that overrun a second day (current behavior, not a spec ' +
      'guarantee): a delta large enough to push total minutes past 47:59 keeps counting',
    () => {
      // NOTE: this documents the current implementation's math rather than a
      // deliberately-designed limit; toEitTime only special-cases total < 0,
      // it never re-wraps on the positive side. 23:30 + 26h(1560min) = 49:30.
      expect(toEitTime('23:30', conv(1560))).toEqual({ time: '49:30' });
    },
  );
});
