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
import type { TvhChannel, TvhMux, TvhNetwork, TvhService } from '@tvhc/shared';
import { mergeChannels, type ChannelMergeInput } from '../src/routes/instances.js';

function channel(over: Partial<TvhChannel>): TvhChannel {
  return { uuid: 'ch', name: 'KBS1', number: '1', services: [], ...over };
}

function service(over: Partial<TvhService>): TvhService {
  return { uuid: 'svc', multiplex_uuid: 'mux', ...over };
}

function mux(over: Partial<TvhMux>): TvhMux {
  return { uuid: 'mux', network_uuid: 'net', ...over };
}

function network(over: Partial<TvhNetwork>): TvhNetwork {
  return { uuid: 'net', ...over };
}

function input(over: Partial<ChannelMergeInput>): ChannelMergeInput {
  return {
    instanceId: 'a',
    serverOffsetMinutes: null,
    topology: { channels: [], services: [], muxes: [], networks: [] },
    ...over,
  };
}

describe('mergeChannels', () => {
  it('keeps same name, different numbers on one instance as separate entries', () => {
    const inputs = [
      input({
        topology: {
          channels: [
            channel({ uuid: 'c1', name: 'KBS1', number: '1' }),
            channel({ uuid: 'c2', name: 'KBS1', number: '51' }),
          ],
          services: [],
          muxes: [],
          networks: [],
        },
      }),
    ];
    const out = mergeChannels(inputs);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.number).sort()).toEqual(['1', '51']);
  });

  it('keeps same number, different names as separate entries', () => {
    const inputs = [
      input({
        topology: {
          channels: [
            channel({ uuid: 'c1', name: 'SBS', number: '3' }),
            channel({ uuid: 'c2', name: 'Regional', number: '3' }),
          ],
          services: [],
          muxes: [],
          networks: [],
        },
      }),
    ];
    const out = mergeChannels(inputs);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.name).sort()).toEqual(['Regional', 'SBS']);
  });

  it('merges identical name+number across instances into one entry with deduped instance ids', () => {
    const topoA = {
      channels: [channel({ uuid: 'c1', name: 'KBS1', number: '1' })],
      services: [],
      muxes: [],
      networks: [],
    };
    const topoB = {
      channels: [channel({ uuid: 'c2', name: 'KBS1', number: '1' })],
      services: [],
      muxes: [],
      networks: [],
    };
    const inputs = [
      input({ instanceId: 'a', topology: topoA }),
      input({ instanceId: 'a', topology: topoA }),
      input({ instanceId: 'b', topology: topoB }),
    ];
    const out = mergeChannels(inputs);
    expect(out).toHaveLength(1);
    expect(out[0]!.instances).toEqual(['a', 'b']);
  });

  it('resolves eitOffsetMinutes via channel -> service -> mux -> network, first-non-null wins', () => {
    const topoUtc = {
      channels: [channel({ uuid: 'c1', name: 'A', number: '1', services: ['s1'] })],
      services: [service({ uuid: 's1', multiplex_uuid: 'm1' })],
      muxes: [mux({ uuid: 'm1', network_uuid: 'n1' })],
      networks: [network({ uuid: 'n1', localtime: 0 })],
    };
    expect(mergeChannels([input({ topology: topoUtc })])[0]!.eitOffsetMinutes).toBe(0);

    const topoServerLocal = {
      channels: [channel({ uuid: 'c1', name: 'A', number: '1', services: ['s1'] })],
      services: [service({ uuid: 's1', multiplex_uuid: 'm1' })],
      muxes: [mux({ uuid: 'm1', network_uuid: 'n1' })],
      networks: [network({ uuid: 'n1', localtime: 1 })],
    };
    expect(
      mergeChannels([input({ topology: topoServerLocal, serverOffsetMinutes: 540 })])[0]!
        .eitOffsetMinutes,
    ).toBe(540);

    const topoFixed = {
      channels: [channel({ uuid: 'c1', name: 'A', number: '1', services: ['s1'] })],
      services: [service({ uuid: 's1', multiplex_uuid: 'm1' })],
      muxes: [mux({ uuid: 'm1', network_uuid: 'n1' })],
      networks: [network({ uuid: 'n1', localtime: 540 })],
    };
    expect(mergeChannels([input({ topology: topoFixed })])[0]!.eitOffsetMinutes).toBe(540);

    // first-non-null wins across instances: instance 'a' resolves to null (no services),
    // instance 'b' resolves to 0 - the merged entry should pick up 'b's value.
    const topoUnknown = {
      channels: [channel({ uuid: 'c1', name: 'A', number: '1', services: [] })],
      services: [],
      muxes: [],
      networks: [],
    };
    const out = mergeChannels([
      input({ instanceId: 'a', topology: topoUnknown }),
      input({ instanceId: 'b', topology: topoUtc }),
    ]);
    expect(out[0]!.eitOffsetMinutes).toBe(0);
  });

  it('skips channels with an empty name and instances with null topology', () => {
    const inputs = [
      input({
        topology: {
          channels: [channel({ uuid: 'c1', name: '', number: '1' })],
          services: [],
          muxes: [],
          networks: [],
        },
      }),
      input({ instanceId: 'b', topology: null }),
    ];
    expect(mergeChannels(inputs)).toEqual([]);
  });

  it('sorts by number ascending, null numbers last, then name for ties', () => {
    const inputs = [
      input({
        topology: {
          channels: [
            channel({ uuid: 'c1', name: 'Zeta', number: '5' }),
            channel({ uuid: 'c2', name: 'Beta', number: undefined }),
            channel({ uuid: 'c3', name: 'Alpha', number: '5' }),
            channel({ uuid: 'c4', name: 'Gamma', number: '1' }),
          ],
          services: [],
          muxes: [],
          networks: [],
        },
      }),
    ];
    const out = mergeChannels(inputs);
    expect(out.map((c) => c.name)).toEqual(['Gamma', 'Alpha', 'Zeta', 'Beta']);
  });

  it('sorts numerically, not lexicographically: "2" comes before "10"', () => {
    const inputs = [
      input({
        topology: {
          channels: [
            channel({ uuid: 'c1', name: 'Ten', number: '10' }),
            channel({ uuid: 'c2', name: 'Two', number: '2' }),
          ],
          services: [],
          muxes: [],
          networks: [],
        },
      }),
    ];
    const out = mergeChannels(inputs);
    // a naive string sort would put '10' before '2'; chanNumberOrder must not
    expect(out.map((c) => c.number)).toEqual(['2', '10']);
  });
});
