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
import type { ConflictWindow, TvhEpgEvent } from '@tvhc/shared';
import { mergeEpg, type EpgMergeInput } from '../src/routes/epg.js';

const THRESHOLD = 0.7;

function ev(over: Partial<TvhEpgEvent>): TvhEpgEvent {
  return {
    eventId: 1,
    channelName: 'ＡＴ－Ｘ',
    channelUuid: 'ch',
    channelNumber: '300',
    start: 1000,
    stop: 2800,
    title: 'Show #1',
    ...over,
  } as TvhEpgEvent;
}

function input(over: Partial<EpgMergeInput>): EpgMergeInput {
  return { instanceId: 'tyo1', reachable: true, conflicts: [], epg: [], ...over };
}

describe('mergeEpg', () => {
  it('folds the same broadcast across instances into one event with per-instance copies', () => {
    const inputs = [
      input({ instanceId: 'tyo1', epg: [ev({ eventId: 11 })] }),
      // shifted EIT copy of the same programme on the same channel, other instance
      input({ instanceId: 'tyo2', epg: [ev({ eventId: 22, start: 1060, stop: 2860 })] }),
    ];
    const out = mergeEpg(inputs, THRESHOLD);
    expect(out).toHaveLength(1);
    expect(out[0]!.channelNumber).toBe('300');
    expect(out[0]!.copies.map((c) => `${c.instanceId}:${c.eventId}`).sort()).toEqual([
      'tyo1:11',
      'tyo2:22',
    ]);
  });

  it('keeps subchannels (same name, different number) separate', () => {
    const inputs = [
      input({
        epg: [
          ev({ eventId: 1, channelNumber: '5.1', title: 'A' }),
          ev({ eventId: 2, channelNumber: '5.2', title: 'B' }),
        ],
      }),
    ];
    const out = mergeEpg(inputs, THRESHOLD);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.channelNumber).sort()).toEqual(['5.1', '5.2']);
  });

  it('keeps different programmes separate and sorts by start', () => {
    const inputs = [
      input({
        epg: [
          ev({ eventId: 2, start: 5000, stop: 6800, title: 'Later' }),
          ev({ eventId: 1, start: 1000, stop: 2800, title: 'Earlier' }),
        ],
      }),
    ];
    const out = mergeEpg(inputs, THRESHOLD);
    expect(out.map((e) => e.title)).toEqual(['Earlier', 'Later']);
  });

  it('orders currently-airing programmes first by channel number, then upcoming by start', () => {
    const now = 2000;
    const inputs = [
      input({
        epg: [
          ev({ eventId: 1, channelName: 'A', channelNumber: '5', start: 1000, stop: 3000, title: 'A-now' }),
          ev({ eventId: 2, channelName: 'B', channelNumber: '2', start: 1500, stop: 3000, title: 'B-now' }),
          ev({ eventId: 3, channelName: 'A', channelNumber: '5', start: 5000, stop: 6000, title: 'A-later' }),
          ev({ eventId: 4, channelName: 'B', channelNumber: '2', start: 4000, stop: 5000, title: 'B-soon' }),
        ],
      }),
    ];
    const out = mergeEpg(inputs, THRESHOLD, now);
    // airing first by channel number (B=2 before A=5), then upcoming by start
    expect(out.map((e) => e.title)).toEqual(['B-now', 'A-now', 'B-soon', 'A-later']);
  });

  it('recommends a reachable instance whose tuners are free during the broadcast', () => {
    const conflict: ConflictWindow = {
      start: 900,
      stop: 3000,
      level: 'conflict',
      entryUuids: [],
      network: 'net',
      detail: '',
    };
    const inputs = [
      input({ instanceId: 'tyo1', conflicts: [conflict], epg: [ev({ eventId: 11 })] }),
      input({ instanceId: 'tyo2', conflicts: [], epg: [ev({ eventId: 22 })] }),
    ];
    const out = mergeEpg(inputs, THRESHOLD);
    expect(out[0]!.recommendedInstanceId).toBe('tyo2');
  });

  it('skips unreachable instances entirely', () => {
    const inputs = [
      input({ instanceId: 'tyo1', reachable: false, epg: [ev({ eventId: 11 })] }),
    ];
    expect(mergeEpg(inputs, THRESHOLD)).toEqual([]);
  });
});
