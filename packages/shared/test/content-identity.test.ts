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
import { compareRecordings, intervalOverlapRatio } from '../src/content-identity.js';

const base = { channelname: 'KBS1', start: 1000, stop: 4600, title: 'News 9' };

describe('intervalOverlapRatio', () => {
  it('is 1 for identical intervals', () => {
    expect(intervalOverlapRatio(base, { ...base })).toBe(1);
  });

  it('is 0 for disjoint intervals', () => {
    expect(intervalOverlapRatio(base, { ...base, start: 4600, stop: 8200 })).toBe(0);
  });

  it('is relative to the shorter recording', () => {
    // b covers half of a, but b itself is fully inside a
    const b = { ...base, start: 1000, stop: 2800 };
    expect(intervalOverlapRatio(base, b)).toBe(1);
  });
});

describe('compareRecordings', () => {
  it('detects an identical broadcast as duplicate', () => {
    expect(compareRecordings(base, { ...base }).isDuplicate).toBe(true);
  });

  it('tolerates shifted EIT start times', () => {
    // second instance captured an EPG revision moving the show 5 min later
    const shifted = { ...base, start: 1300, stop: 4900 };
    const v = compareRecordings(base, shifted);
    expect(v.isDuplicate).toBe(true);
  });

  it('tolerates differing titles (EIT revisions) — title is advisory only', () => {
    const renamed = { ...base, title: 'News Nine (KBS)' };
    const v = compareRecordings(base, renamed);
    expect(v.isDuplicate).toBe(true);
    expect(v.titleSimilar).toBe(false);
  });

  it('never matches across different channels', () => {
    const other = { ...base, channelname: 'MBC' };
    expect(compareRecordings(base, other).isDuplicate).toBe(false);
  });

  it('does not match consecutive shows on the same channel', () => {
    const next = { ...base, start: 4600, stop: 8200, title: 'Drama' };
    expect(compareRecordings(base, next).isDuplicate).toBe(false);
  });

  it('does not match a short overlap below the threshold', () => {
    // 30% overlap of the shorter interval
    const partial = { ...base, start: 3520, stop: 7120 };
    expect(compareRecordings(base, partial).isDuplicate).toBe(false);
  });

  it('treats empty channel names as never-duplicate', () => {
    const a = { ...base, channelname: '' };
    expect(compareRecordings(a, { ...a }).isDuplicate).toBe(false);
  });
});
