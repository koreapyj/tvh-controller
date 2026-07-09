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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TvhDvrEntry, UploadJob } from '@tvhc/shared';
import {
  AutoUploader,
  identityOf,
  isStillPending,
  pickBestCopy,
  siblingCopies,
  strictlyBetter,
} from '../src/uploads/autoUpload.js';
import { EventBus } from '../src/state/events.js';

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

// --- AutoUploader evaluation (Parts 1 & 3) ----------------------------------

const DEBOUNCE_MS = 3_000;

function snap(
  id: string,
  finished: TvhDvrEntry[],
  upcoming: TvhDvrEntry[] = [],
  opts: { reachable?: boolean; hasTvh?: boolean } = {},
) {
  return {
    summary: { id, reachable: opts.reachable ?? true, hasTvh: opts.hasTvh ?? true },
    finished,
    upcoming,
    topology: { dvrConfigs: [] },
  };
}

function makeAuto(snaps: ReturnType<typeof snap>[], rows: Partial<UploadJob>[]) {
  const cfg = { overlapThreshold: THRESHOLD, autoUpload: { enabled: true, graceSeconds: 120 } };
  const cache = {
    all: () => snaps,
    get: (id: string) => snaps.find((s) => s.summary.id === id),
  };
  const ledger = {
    findAllByIdentity: vi.fn(async () => rows),
    listIncompletePicks: vi.fn(async () => [] as UploadJob[]),
  };
  const dispatcher = { enqueue: vi.fn(async () => ({ job: { id: 'j' } })) };
  const bus = new EventBus();
  const auto = new AutoUploader(
    cfg as never,
    cache as never,
    ledger as never,
    dispatcher as never,
    bus,
  );
  return { auto, ledger, dispatcher, bus };
}

function fireRecordings(bus: EventBus, instanceId = 'tyo1') {
  bus.publish({ type: 'recordings', data: { instanceId, state: 'finished' } } as never);
}

describe('AutoUploader candidate fallback (Part 3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('skips a copy that already failed permanently and uploads the next-best one', async () => {
    vi.setSystemTime((2800 + 1000) * 1000); // well past the 120s grace window
    const best = entry({ uuid: 'a1', errors: 0 }); // best copy, but it failed permanently
    const other = entry({ uuid: 'a2', errors: 5 }); // worse, on another instance
    const { auto, dispatcher, bus } = makeAuto(
      [snap('tyo1', [best]), snap('tyo2', [other])],
      [{ instanceId: 'tyo1', dvrUuid: 'a1', status: 'failed', failureKind: 'permanent', origin: 'auto' }],
    );

    fireRecordings(bus);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);

    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue.mock.calls[0]![0]).toBe('tyo2');
    expect((dispatcher.enqueue.mock.calls[0]![1] as TvhDvrEntry).uuid).toBe('a2');
    auto.stop();
  });

  it('does not re-upload while the only copy is failed-transient (the sweep handles it)', async () => {
    vi.setSystemTime((2800 + 1000) * 1000);
    const { auto, dispatcher, bus } = makeAuto(
      [snap('tyo1', [entry({ uuid: 'a1' })])],
      [{ instanceId: 'tyo1', dvrUuid: 'a1', status: 'failed', failureKind: 'transient', origin: 'auto' }],
    );

    fireRecordings(bus);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);

    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    auto.stop();
  });
});

describe('AutoUploader grace re-check (Part 1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uploads a grace-deferred recording without any further event', async () => {
    vi.setSystemTime((2800 + 60) * 1000); // 60s after stop, inside the 120s grace
    const { auto, dispatcher, bus } = makeAuto([snap('tyo1', [entry({ uuid: 'a1' })])], []);

    fireRecordings(bus);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    // still inside grace → deferred, nothing enqueued yet
    expect(dispatcher.enqueue).not.toHaveBeenCalled();

    // no new event fires; only the armed re-check timer drives the next pass
    await vi.advanceTimersByTimeAsync(61_000 + DEBOUNCE_MS + 100);
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue.mock.calls[0]![0]).toBe('tyo1');
    auto.stop();
  });
});

describe('AutoUploader reachability accounting (tvh-less zones)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('excludes a tvh-less zone (hasTvh: false) entirely, so the pick is complete and pass 2 runs', async () => {
    vi.setSystemTime((2800 + 1000) * 1000); // well past the 120s grace window
    const { auto, dispatcher, ledger, bus } = makeAuto(
      [
        snap('tyo1', [entry({ uuid: 'a1' })]),
        snap('tyo2', []),
        snap('ext1', [], [], { reachable: false, hasTvh: false }), // tvh-less zone: no poller, ever
      ],
      [],
    );

    fireRecordings(bus);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);

    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue.mock.calls[0]![3]).toMatchObject({ incompletePick: false });
    expect(ledger.listIncompletePicks).toHaveBeenCalled(); // pass 2 must not short-circuit
    auto.stop();
  });

  it('a genuinely unreachable tvh instance (hasTvh: true) still marks the pick incomplete and skips pass 2', async () => {
    vi.setSystemTime((2800 + 1000) * 1000);
    const { auto, dispatcher, ledger, bus } = makeAuto(
      [snap('tyo1', [entry({ uuid: 'a1' })]), snap('tyo2', [], [], { reachable: false })],
      [],
    );

    fireRecordings(bus);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);

    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue.mock.calls[0]![3]).toMatchObject({ incompletePick: true });
    expect(ledger.listIncompletePicks).not.toHaveBeenCalled(); // pass 2 skipped
    auto.stop();
  });
});
