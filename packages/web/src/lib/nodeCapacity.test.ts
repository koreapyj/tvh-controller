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
import {
  configuredHotCount,
  isAtCapacity,
  isOverCapacity,
  maxSessionsToInput,
  parseMaxSessionsInput,
} from './nodeCapacity.js';

interface PlacementOpts {
  instanceId?: string;
  nodeId?: string;
  enabled?: boolean;
  mode?: 'hot' | 'cold';
  transient?: boolean;
}

function placement(opts: PlacementOpts = {}) {
  return {
    instanceId: opts.instanceId ?? 'i1',
    nodeId: opts.nodeId ?? 'n1',
    enabled: opts.enabled ?? true,
    mode: opts.mode ?? 'hot',
    transient: opts.transient ?? false,
  };
}

function channel(enabled: boolean, placements: ReturnType<typeof placement>[]) {
  return { enabled, placements };
}

describe('configuredHotCount', () => {
  it('counts only hot+enabled placements on enabled channels', () => {
    const channels = [channel(true, [placement(), placement({ mode: 'cold' }), placement({ enabled: false })])];
    expect(configuredHotCount(channels, 'i1', 'n1')).toBe(1);
  });

  it('excludes transient (cutover-owned) clones', () => {
    const channels = [channel(true, [placement(), placement({ transient: true })])];
    expect(configuredHotCount(channels, 'i1', 'n1')).toBe(1);
  });

  it('excludes placements on disabled channels', () => {
    const channels = [channel(false, [placement()])];
    expect(configuredHotCount(channels, 'i1', 'n1')).toBe(0);
  });

  it('only counts placements matching the given (instanceId, nodeId)', () => {
    const channels = [
      channel(true, [placement({ nodeId: 'n1' }), placement({ nodeId: 'n2' }), placement({ instanceId: 'i2' })]),
    ];
    expect(configuredHotCount(channels, 'i1', 'n1')).toBe(1);
  });

  it('sums across multiple channels', () => {
    const channels = [channel(true, [placement()]), channel(true, [placement(), placement()])];
    expect(configuredHotCount(channels, 'i1', 'n1')).toBe(3);
  });
});

describe('isOverCapacity / isAtCapacity', () => {
  it('null cap never warns, regardless of load', () => {
    expect(isOverCapacity(null, 999)).toBe(false);
    expect(isAtCapacity(null, 999)).toBe(false);
  });

  it('cap 0 with 1 hot placement is over capacity', () => {
    expect(isOverCapacity(0, 1)).toBe(true);
    expect(isAtCapacity(0, 1)).toBe(true);
  });

  it('cap 0 with 0 configured is at capacity but not over', () => {
    expect(isAtCapacity(0, 0)).toBe(true);
    expect(isOverCapacity(0, 0)).toBe(false);
  });

  it('under the cap is neither at nor over', () => {
    expect(isAtCapacity(6, 4)).toBe(false);
    expect(isOverCapacity(6, 4)).toBe(false);
  });

  it('exactly at the cap is at-capacity but not over', () => {
    expect(isAtCapacity(6, 6)).toBe(true);
    expect(isOverCapacity(6, 6)).toBe(false);
  });

  it('past the cap is both at and over', () => {
    expect(isAtCapacity(6, 7)).toBe(true);
    expect(isOverCapacity(6, 7)).toBe(true);
  });
});

describe('maxSessionsToInput / parseMaxSessionsInput', () => {
  it('round-trips null (uncapped) as an empty string', () => {
    expect(maxSessionsToInput(null)).toBe('');
    expect(parseMaxSessionsInput('')).toBe(null);
    expect(parseMaxSessionsInput('   ')).toBe(null);
  });

  it('round-trips 0 (admit no new sessions)', () => {
    expect(maxSessionsToInput(0)).toBe('0');
    expect(parseMaxSessionsInput('0')).toBe(0);
  });

  it('round-trips a positive integer', () => {
    expect(maxSessionsToInput(6)).toBe('6');
    expect(parseMaxSessionsInput('6')).toBe(6);
  });

  it('rejects negative numbers', () => {
    expect(parseMaxSessionsInput('-1')).toBeUndefined();
  });

  it('rejects non-integers', () => {
    expect(parseMaxSessionsInput('2.5')).toBeUndefined();
  });

  it('rejects non-numeric input', () => {
    expect(parseMaxSessionsInput('abc')).toBeUndefined();
  });
});
