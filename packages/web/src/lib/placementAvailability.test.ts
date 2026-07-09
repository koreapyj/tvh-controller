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
import type { ChannelOption, RestreamerNodeStatus, SourceCatalogEntry } from '@tvhc/shared';
import { placementAvailability } from './placementAvailability.js';

function channel(name: string, number: string | null, instances: string[]): ChannelOption {
  return { name, number, instances, eitOffsetMinutes: null };
}

const options: ChannelOption[] = [
  channel('KBS1', '9', ['seoul', 'busan']),
  channel('KBS1', '51', ['seoul']),
  channel('SubChan', '9.1', ['tokyo']),
  channel('SubChan', '9.10', ['osaka']),
  channel('NoNumber', null, ['seoul']),
];

function node(
  nodeId: string,
  sources: SourceCatalogEntry[] | null,
  instanceId = 'seoul',
): RestreamerNodeStatus {
  return {
    instanceId,
    nodeId,
    url: 'http://node1:8080',
    serveUrl: null,
    reachable: true,
    error: null,
    lastPollAt: null,
    version: null,
    uptimeSec: null,
    apiVersionSupported: true,
    desiredRevision: null,
    pendingPush: false,
    probes: null,
    sessions: [],
    sourcesHash: sources === null ? null : 'hash',
    sources,
  };
}

const catalogEntries: SourceCatalogEntry[] = [
  { id: 'louise', name: 'Louise', url: 'https://louise.example/stream', chno: '1' },
  { id: 'radio-2', name: 'Radio 2', url: 'https://radio.example/2', chno: '99' },
  { id: 'subchan-tokyo', name: 'SubChan', url: 'https://sub.example/tokyo', chno: '9.1' },
];

describe('placementAvailability', () => {
  it('is unknown when the tvh option list has not loaded (empty), regardless of the catalog', () => {
    expect(
      placementAvailability('KBS1', '9', 'seoul', 'node1', [], node('node1', catalogEntries)),
    ).toBe('unknown');
  });

  it('is ok on a tvh hit — pinned (name, number) present on the instance', () => {
    expect(
      placementAvailability('KBS1', '9', 'seoul', 'node1', options, undefined),
    ).toBe('ok');
  });

  it('is ok on a tvh hit for the unpinned form (any same-name channel on the instance)', () => {
    expect(
      placementAvailability('KBS1', null, 'seoul', 'node1', options, undefined),
    ).toBe('ok');
  });

  it('falls back to the catalog on a tvh known-miss and finds a hit', () => {
    // "Louise" is absent from every tvh instance, but the node's catalog has it.
    expect(
      placementAvailability('Louise', '1', 'seoul', 'node1', options, node('node1', catalogEntries)),
    ).toBe('ok');
  });

  it('pinned chno is exact STRING identity on the catalog side too — "9.1" never matches "9.10"', () => {
    // tvh has SubChan 9.1 on tokyo and 9.10 on osaka; querying busan (tvh miss)
    // falls to the catalog, which only carries the 9.1 entry.
    expect(
      placementAvailability(
        'SubChan',
        '9.1',
        'busan',
        'node1',
        options,
        node('node1', catalogEntries, 'busan'),
      ),
    ).toBe('ok');
    expect(
      placementAvailability(
        'SubChan',
        '9.10',
        'busan',
        'node1',
        options,
        node('node1', catalogEntries, 'busan'),
      ),
    ).toBe('unavailable');
  });

  it('is unavailable when both tvh and a known catalog miss', () => {
    expect(
      placementAvailability('Missing', null, 'seoul', 'node1', options, node('node1', catalogEntries)),
    ).toBe('unavailable');
    expect(
      placementAvailability('Missing', null, 'seoul', 'node1', options, node('node1', [])),
    ).toBe('unavailable');
  });

  it('is unknown when the tvh side misses and the catalog was never fetched or the node is unknown', () => {
    expect(
      placementAvailability('Louise', '1', 'seoul', 'node1', options, node('node1', null)),
    ).toBe('unknown');
    expect(
      placementAvailability('Louise', '1', 'seoul', 'node1', options, undefined),
    ).toBe('unknown');
  });

  it('ignores a node status keyed to a different nodeId (wrong lookup) as unknown', () => {
    expect(
      placementAvailability('Louise', '1', 'seoul', 'node1', options, node('node2', catalogEntries)),
    ).toBe('unknown');
  });
});
