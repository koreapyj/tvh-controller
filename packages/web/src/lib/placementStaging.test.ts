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
import type { RestreamPlacement } from '@tvhc/shared';
import {
  buildPlacementsPayload,
  removedPlacementIds,
  seedStagedPlacements,
  type StagedPlacement,
} from './placementStaging.js';

function placement(over: Partial<RestreamPlacement> = {}): RestreamPlacement {
  return {
    id: 'p1',
    channelId: 'c1',
    instanceId: 'tokyo',
    nodeId: 'node-a',
    priority: 1,
    enabled: true,
    mode: 'hot',
    weight: null,
    programNumber: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('seedStagedPlacements', () => {
  it('sorts by priority', () => {
    const seeded = seedStagedPlacements([
      placement({ id: 'a', priority: 2 }),
      placement({ id: 'b', priority: 1 }),
    ]);
    expect(seeded.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('breaks priority ties by id', () => {
    const seeded = seedStagedPlacements([
      placement({ id: 'z', priority: 1 }),
      placement({ id: 'a', priority: 1 }),
    ]);
    expect(seeded.map((p) => p.id)).toEqual(['a', 'z']);
  });

  it('formats null weight/programNumber as blank strings, numbers as strings', () => {
    const seeded = seedStagedPlacements([
      placement({ id: 'a', weight: null, programNumber: null }),
      placement({ id: 'b', weight: 500, programNumber: 3 }),
    ]);
    expect(seeded[0]).toMatchObject({ weight: '', programNumber: '' });
    expect(seeded[1]).toMatchObject({ weight: '500', programNumber: '3' });
  });

  it('round-trips through buildPlacementsPayload back to the original numeric values', () => {
    const original = [
      placement({ id: 'a', priority: 1, weight: 500, programNumber: 3, mode: 'hot' }),
      placement({ id: 'b', priority: 2, weight: null, programNumber: null, mode: 'cold', enabled: false }),
    ];
    const seeded = seedStagedPlacements(original);
    const built = buildPlacementsPayload(seeded);
    expect(built).toEqual({
      ok: true,
      placements: [
        { id: 'a', instanceId: 'tokyo', nodeId: 'node-a', mode: 'hot', weight: 500, programNumber: 3, enabled: true },
        { id: 'b', instanceId: 'tokyo', nodeId: 'node-a', mode: 'cold', weight: null, programNumber: null, enabled: false },
      ],
    });
  });
});

describe('buildPlacementsPayload', () => {
  function row(over: Partial<StagedPlacement> = {}): StagedPlacement {
    return {
      instanceId: 'tokyo',
      nodeId: 'node-a',
      mode: 'hot',
      weight: '',
      programNumber: '',
      enabled: true,
      ...over,
    };
  }

  it('a new row (no id) builds without an id key', () => {
    const built = buildPlacementsPayload([row()]);
    expect(built.ok).toBe(true);
    if (built.ok) expect('id' in built.placements[0]!).toBe(false);
  });

  it('blank weight/programNumber parse to null', () => {
    const built = buildPlacementsPayload([row({ weight: '', programNumber: '' })]);
    expect(built).toEqual({
      ok: true,
      placements: [{ instanceId: 'tokyo', nodeId: 'node-a', mode: 'hot', weight: null, programNumber: null, enabled: true }],
    });
  });

  it('parses positive integers', () => {
    const built = buildPlacementsPayload([row({ weight: '500', programNumber: '12' })]);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.placements[0]).toMatchObject({ weight: 500, programNumber: 12 });
  });

  it('rejects a non-integer weight, naming the node', () => {
    const built = buildPlacementsPayload([row({ weight: '3.5', instanceId: 'tokyo', nodeId: 'node-b' })]);
    expect(built).toEqual({ ok: false, error: 'tokyo/node-b: weight must be a positive integer, or blank' });
  });

  it('rejects zero and negative values', () => {
    expect(buildPlacementsPayload([row({ weight: '0' })]).ok).toBe(false);
    expect(buildPlacementsPayload([row({ weight: '-5' })]).ok).toBe(false);
  });

  it('rejects a non-numeric program number, naming the node', () => {
    const built = buildPlacementsPayload([row({ programNumber: 'abc', instanceId: 'osaka', nodeId: 'node-c' })]);
    expect(built).toEqual({ ok: false, error: 'osaka/node-c: program number must be a positive integer, or blank' });
  });

  it('preserves staged array order (priority = index)', () => {
    const built = buildPlacementsPayload([
      row({ id: 'b', nodeId: 'node-b' }),
      row({ id: 'a', nodeId: 'node-a' }),
    ]);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.placements.map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('removedPlacementIds', () => {
  const original = [placement({ id: 'a' }), placement({ id: 'b' }), placement({ id: 'c' })];

  it('reports ids missing from the staged rows', () => {
    const staged: StagedPlacement[] = [
      { id: 'a', instanceId: 'tokyo', nodeId: 'node-a', mode: 'hot', weight: '', programNumber: '', enabled: true },
    ];
    expect(removedPlacementIds(original, staged)).toEqual(['b', 'c']);
  });

  it('is empty when every original id is still staged (new unsaved rows ignored)', () => {
    const staged: StagedPlacement[] = [
      ...original.map((p): StagedPlacement => ({
        id: p.id,
        instanceId: p.instanceId,
        nodeId: p.nodeId,
        mode: p.mode,
        weight: '',
        programNumber: '',
        enabled: p.enabled,
      })),
      { instanceId: 'osaka', nodeId: 'node-x', mode: 'hot', weight: '', programNumber: '', enabled: true },
    ];
    expect(removedPlacementIds(original, staged)).toEqual([]);
  });

  it('reports every original id when all placements are removed', () => {
    expect(removedPlacementIds(original, [])).toEqual(['a', 'b', 'c']);
  });
});
