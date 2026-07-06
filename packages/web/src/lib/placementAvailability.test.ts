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
import { externalAvailability, tvhAvailability } from './placementAvailability.js';

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

describe('tvhAvailability', () => {
  it('is unknown when the option list has not loaded (empty)', () => {
    expect(tvhAvailability('KBS1', '9', 'seoul', [])).toBe('unknown');
  });

  it('is ok for a pinned (name, number) pair present on the instance', () => {
    expect(tvhAvailability('KBS1', '9', 'seoul', options)).toBe('ok');
    expect(tvhAvailability('KBS1', '9', 'busan', options)).toBe('ok');
  });

  it('pinned numbers are exact STRING identity — "9.1" never matches "9.10"', () => {
    expect(tvhAvailability('SubChan', '9.1', 'tokyo', options)).toBe('ok');
    expect(tvhAvailability('SubChan', '9.1', 'osaka', options)).toBe('unavailable');
    expect(tvhAvailability('SubChan', '9.10', 'osaka', options)).toBe('ok');
    expect(tvhAvailability('SubChan', '9.10', 'tokyo', options)).toBe('unavailable');
  });

  it('is unavailable when the pinned number does not exist under that name', () => {
    expect(tvhAvailability('KBS1', '10', 'seoul', options)).toBe('unavailable');
  });

  it('filters by instance: same pair on another instance is unavailable', () => {
    expect(tvhAvailability('KBS1', '51', 'seoul', options)).toBe('ok');
    expect(tvhAvailability('KBS1', '51', 'busan', options)).toBe('unavailable');
  });

  it('null number (unpinned) matches ANY same-name channel on the instance', () => {
    expect(tvhAvailability('KBS1', null, 'seoul', options)).toBe('ok');
    expect(tvhAvailability('KBS1', null, 'busan', options)).toBe('ok');
    expect(tvhAvailability('NoNumber', null, 'seoul', options)).toBe('ok');
  });

  it('null number is unavailable when the name is absent from the instance', () => {
    expect(tvhAvailability('KBS1', null, 'tokyo', options)).toBe('unavailable');
    expect(tvhAvailability('Missing', null, 'seoul', options)).toBe('unavailable');
  });
});

function node(sources: SourceCatalogEntry[] | null): RestreamerNodeStatus {
  return {
    instanceId: 'seoul',
    nodeId: 'node1',
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
    sessions: [],
    sourcesHash: sources === null ? null : 'hash',
    sources,
  };
}

describe('externalAvailability', () => {
  const entries: SourceCatalogEntry[] = [
    { id: 'louise', name: 'Louise', url: 'https://louise.example/stream' },
    { id: 'radio-2', name: 'Radio 2', url: 'https://radio.example/2', chno: '99' },
  ];

  it('is unknown when the node status is missing (not polled / unknown node)', () => {
    expect(externalAvailability('louise', undefined)).toBe('unknown');
  });

  it('is unknown when the catalog was never fetched (sources null)', () => {
    expect(externalAvailability('louise', node(null))).toBe('unknown');
  });

  it('is ok when the entry is in the node catalog', () => {
    expect(externalAvailability('louise', node(entries))).toBe('ok');
    expect(externalAvailability('radio-2', node(entries))).toBe('ok');
  });

  it('is unavailable when a KNOWN catalog lacks the entry', () => {
    expect(externalAvailability('missing', node(entries))).toBe('unavailable');
  });

  it('is unavailable against a known-empty catalog ([])', () => {
    expect(externalAvailability('louise', node([]))).toBe('unavailable');
  });
});
