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
import { AUTOSCROLL_THRESHOLD_PX, isAtBottom, nextArmedState, type ScrollMetrics } from './autoscroll.js';

describe('isAtBottom / nextArmedState', () => {
  it('is true when scrolled all the way to the bottom', () => {
    const m: ScrollMetrics = { scrollTop: 460, scrollHeight: 800, clientHeight: 340 };
    expect(isAtBottom(m)).toBe(true);
    expect(nextArmedState(m)).toBe(true);
  });

  it('is false once scrolled well above the threshold', () => {
    const m: ScrollMetrics = { scrollTop: 100, scrollHeight: 800, clientHeight: 340 };
    expect(isAtBottom(m)).toBe(false);
    expect(nextArmedState(m)).toBe(false);
  });

  it('treats the exact threshold boundary as still-at-bottom (<=)', () => {
    // 800 - scrollTop - 340 === 40  =>  scrollTop === 420
    const atBoundary: ScrollMetrics = { scrollTop: 420, scrollHeight: 800, clientHeight: 340 };
    expect(isAtBottom(atBoundary)).toBe(true);
    // one px further away disarms it
    const justOver: ScrollMetrics = { scrollTop: 419, scrollHeight: 800, clientHeight: 340 };
    expect(isAtBottom(justOver)).toBe(false);
  });

  it('respects a custom threshold', () => {
    const m: ScrollMetrics = { scrollTop: 700, scrollHeight: 800, clientHeight: 340 };
    // gap = 800-700-340 = -240 (content shorter than viewport) => always at bottom
    expect(isAtBottom(m, 0)).toBe(true);
    const gapped: ScrollMetrics = { scrollTop: 0, scrollHeight: 800, clientHeight: 340 };
    // gap = 460, way over any sane threshold
    expect(isAtBottom(gapped, 10)).toBe(false);
    expect(isAtBottom(gapped, 500)).toBe(true);
  });

  it('an empty/unscrolled container (no content yet) counts as at bottom', () => {
    const empty: ScrollMetrics = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    expect(isAtBottom(empty)).toBe(true);
    expect(nextArmedState(empty)).toBe(true);
  });

  it('exposes the default threshold constant', () => {
    expect(AUTOSCROLL_THRESHOLD_PX).toBe(40);
  });
});
