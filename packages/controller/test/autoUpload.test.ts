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
import type { TvhDvrEntry } from '@tvhc/shared';
import {
  identityOf,
  isStillPending,
  pickBestCopy,
  siblingCopies,
  strictlyBetter,
} from '../src/uploads/autoUpload.js';

const THRESHOLD = 0.7;

function entry(over: Partial<TvhDvrEntry>): TvhDvrEntry {
  return {
    uuid: 'u',
    channelname: 'ＡＴ－Ｘ',
    start: 1000,
    stop: 2800,
    disp_title: 'Show #1',
    filename: '/rec/show.ts',
    filesize: 1_000_000,
    errors: 0,
    data_errors: 0,
    ...over,
  } as TvhDvrEntry;
}

const finishedA = entry({ uuid: 'a1' });
const ident = identityOf(finishedA);

describe('isStillPending', () => {
  it('waits while a sibling copy is still in an upcoming grid', () => {
    const upcoming = new Map([
      ['tyo1', []],
      ['tyo2', [entry({ uuid: 'b1', sched_status: 'recording' })]],
    ]);
    expect(isStillPending(ident, upcoming, THRESHOLD)).toBe(true);
  });

  it('does not wait for unrelated broadcasts', () => {
    const upcoming = new Map([
      ['tyo2', [entry({ uuid: 'b1', start: 90_000, stop: 92_000 })]], // future rerun
    ]);
    expect(isStillPending(ident, upcoming, THRESHOLD)).toBe(false);
  });

  it('does not wait for the same show on a different channel (per-zone variants)', () => {
    const upcoming = new Map([['tyo2', [entry({ channelname: 'ＴＯＫＹＯ　ＭＸ１' })]]]);
    expect(isStillPending(ident, upcoming, THRESHOLD)).toBe(false);
  });
});

describe('siblingCopies', () => {
  it('collects matching finished copies across instances; failed grids are simply not offered', () => {
    const finished = new Map([
      ['tyo1', [finishedA, entry({ uuid: 'other', start: 50_000, stop: 51_800 })]],
      ['tyo2', [entry({ uuid: 'a2', start: 1060, stop: 2860 })]], // shifted EIT copy
    ]);
    const copies = siblingCopies(ident, finished, THRESHOLD);
    expect(copies.map((c) => c.entry.uuid).sort()).toEqual(['a1', 'a2']);
  });

  it('skips copies without a file', () => {
    const finished = new Map([['tyo1', [entry({ uuid: 'nofile', filename: undefined })]]]);
    expect(siblingCopies(ident, finished, THRESHOLD)).toEqual([]);
  });
});

describe('pickBestCopy / strictlyBetter', () => {
  it('prefers fewer stream errors over everything', () => {
    const best = pickBestCopy(
      [
        { instanceId: 'tyo1', entry: entry({ uuid: 'x', errors: 1, filesize: 9_999_999 }) },
        { instanceId: 'tyo2', entry: entry({ uuid: 'y', errors: 0, filesize: 1 }) },
      ],
      ['tyo1', 'tyo2'],
    );
    expect(best?.entry.uuid).toBe('y');
  });

  it('breaks error ties by data errors, then by size, then by instance order', () => {
    const byData = pickBestCopy(
      [
        { instanceId: 'tyo1', entry: entry({ uuid: 'x', data_errors: 5 }) },
        { instanceId: 'tyo2', entry: entry({ uuid: 'y', data_errors: 0 }) },
      ],
      ['tyo1', 'tyo2'],
    );
    expect(byData?.entry.uuid).toBe('y');

    const bySize = pickBestCopy(
      [
        { instanceId: 'tyo1', entry: entry({ uuid: 'x', filesize: 100 }) },
        { instanceId: 'tyo2', entry: entry({ uuid: 'y', filesize: 200 }) },
      ],
      ['tyo1', 'tyo2'],
    );
    expect(bySize?.entry.uuid).toBe('y');

    const byOrder = pickBestCopy(
      [
        { instanceId: 'tyo2', entry: entry({ uuid: 'y' }) },
        { instanceId: 'tyo1', entry: entry({ uuid: 'x' }) },
      ],
      ['tyo1', 'tyo2'],
    );
    expect(byOrder?.instanceId).toBe('tyo1');
  });

  it('returns null with no candidates (e.g. every copy failed)', () => {
    expect(pickBestCopy([], ['tyo1'])).toBeNull();
  });

  it('strictlyBetter is false for equal copies (no pointless supersede churn)', () => {
    expect(strictlyBetter(entry({}), entry({}))).toBe(false);
    expect(strictlyBetter(entry({ filesize: 2 }), entry({ filesize: 1 }))).toBe(true);
    expect(strictlyBetter(entry({ errors: 1, filesize: 999 }), entry({ errors: 0 }))).toBe(false);
  });
});
