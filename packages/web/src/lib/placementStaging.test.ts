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
    profileId: null,
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

  it('formats null programNumber as a blank string, numbers as strings', () => {
    const seeded = seedStagedPlacements([
      placement({ id: 'a', programNumber: null }),
      placement({ id: 'b', programNumber: 3 }),
    ]);
    expect(seeded[0]).toMatchObject({ programNumber: '' });
    expect(seeded[1]).toMatchObject({ programNumber: '3' });
  });

  it('formats null profileId as a blank string (inherit channel default), else the id', () => {
    const seeded = seedStagedPlacements([
      placement({ id: 'a', profileId: null }),
      placement({ id: 'b', profileId: 'prof-1' }),
    ]);
    expect(seeded[0]).toMatchObject({ profileId: '' });
    expect(seeded[1]).toMatchObject({ profileId: 'prof-1' });
  });

  it('round-trips through buildPlacementsPayload back to the original values', () => {
    const original = [
      placement({ id: 'a', priority: 1, programNumber: 3, profileId: 'prof-1', mode: 'hot' }),
      placement({ id: 'b', priority: 2, programNumber: null, profileId: null, mode: 'cold', enabled: false }),
    ];
    const seeded = seedStagedPlacements(original);
    const built = buildPlacementsPayload(seeded);
    expect(built).toEqual({
      ok: true,
      placements: [
        { id: 'a', instanceId: 'tokyo', nodeId: 'node-a', mode: 'hot', programNumber: 3, profileId: 'prof-1', enabled: true },
        { id: 'b', instanceId: 'tokyo', nodeId: 'node-a', mode: 'cold', programNumber: null, profileId: null, enabled: false },
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
      programNumber: '',
      profileId: '',
      enabled: true,
      ...over,
    };
  }

  it('a new row (no id) builds without an id key', () => {
    const built = buildPlacementsPayload([row()]);
    expect(built.ok).toBe(true);
    if (built.ok) expect('id' in built.placements[0]!).toBe(false);
  });

  it('blank programNumber parses to null', () => {
    const built = buildPlacementsPayload([row({ programNumber: '' })]);
    expect(built).toEqual({
      ok: true,
      placements: [{ instanceId: 'tokyo', nodeId: 'node-a', mode: 'hot', programNumber: null, profileId: null, enabled: true }],
    });
  });

  it('parses a positive integer program number', () => {
    const built = buildPlacementsPayload([row({ programNumber: '12' })]);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.placements[0]).toMatchObject({ programNumber: 12 });
  });

  it('rejects a non-numeric program number, naming the node', () => {
    const built = buildPlacementsPayload([row({ programNumber: 'abc', instanceId: 'osaka', nodeId: 'node-c' })]);
    expect(built).toEqual({ ok: false, error: 'osaka/node-c: program number must be a positive integer, or blank' });
  });

  it('rejects zero and negative program numbers', () => {
    expect(buildPlacementsPayload([row({ programNumber: '0' })]).ok).toBe(false);
    expect(buildPlacementsPayload([row({ programNumber: '-5' })]).ok).toBe(false);
  });

  it('blank profileId maps to null (inherit channel default)', () => {
    const built = buildPlacementsPayload([row({ profileId: '' })]);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.placements[0]).toMatchObject({ profileId: null });
  });

  it('a non-empty profileId is passed through as the override', () => {
    const built = buildPlacementsPayload([row({ profileId: 'prof-2' })]);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.placements[0]).toMatchObject({ profileId: 'prof-2' });
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
      { id: 'a', instanceId: 'tokyo', nodeId: 'node-a', mode: 'hot', programNumber: '', profileId: '', enabled: true },
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
        programNumber: '',
        profileId: '',
        enabled: p.enabled,
      })),
      { instanceId: 'osaka', nodeId: 'node-x', mode: 'hot', programNumber: '', profileId: '', enabled: true },
    ];
    expect(removedPlacementIds(original, staged)).toEqual([]);
  });

  it('reports every original id when all placements are removed', () => {
    expect(removedPlacementIds(original, [])).toEqual(['a', 'b', 'c']);
  });
});
