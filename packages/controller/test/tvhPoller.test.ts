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

/*
 * Event-log emission regressions for tvh/poller.ts (sites #1, #2, #3):
 *   - site #1 (instance up/down) and #2 (tvheadend log ingestion) are tested
 *     by constructing a REAL InstancePoller (its constructor does no network
 *     I/O — TvhClient just stores config) with a real InstanceCache/EventBus
 *     and a capture-array `events` param, then invoking its private methods
 *     via a cast (same convention test/dispatcher.test.ts uses for
 *     UploadDispatcher internals).
 *   - site #3 (recording failed) additionally swaps the poller's `client`
 *     field for a fake exposing exactly the surface pollDvrAndStatus() calls
 *     — TS `readonly` is compile-time only, so this is a plain property
 *     overwrite, no network/mocking framework needed.
 *   - the pure logtxt parse/classify helpers (tvh/logMessage.ts) are tested
 *     directly, with no poller at all.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TvhDvrEntry } from '@tvhc/shared';
import type { CometNotification } from '../src/tvh/comet.js';
import {
  classifyLogMessage,
  isNoisySubsystem,
  parseLogMessage,
} from '../src/tvh/logMessage.js';
import { InstancePoller, diffNewFailures } from '../src/tvh/poller.js';
import type { InstanceConfig } from '../src/config.js';
import { InstanceCache } from '../src/state/instanceCache.js';
import { EventBus } from '../src/state/events.js';

// ---------------------------------------------------------------------------
// pure helpers (tvh/logMessage.ts)
// ---------------------------------------------------------------------------

describe('parseLogMessage', () => {
  it('strips a plain timestamp and extracts the subsystem', () => {
    const r = parseLogMessage('2026-07-10 12:00:01 mpegts: mux tuned');
    expect(r).toEqual({ subsystem: 'mpegts', message: 'mpegts: mux tuned' });
  });

  it('strips a timestamp with milliseconds', () => {
    const r = parseLogMessage('2026-07-10 12:00:01.123 mpegts: mux tuned');
    expect(r.message).toBe('mpegts: mux tuned');
  });

  it('strips a "tid N: " prefix appearing after the timestamp', () => {
    const r = parseLogMessage('2026-07-10 12:00:01 tid 42: dvr: recording started "News"');
    expect(r).toEqual({ subsystem: 'dvr', message: 'dvr: recording started "News"' });
  });

  it('tolerates a missing timestamp', () => {
    const r = parseLogMessage('dvr: recording started "News"');
    expect(r).toEqual({ subsystem: 'dvr', message: 'dvr: recording started "News"' });
  });

  it('subsystem is null when the line has no "word:" prefix shape', () => {
    const r = parseLogMessage('2026-07-10 12:00:01 just some free text');
    expect(r.subsystem).toBeNull();
  });
});

describe('isNoisySubsystem', () => {
  it('drops the default blocklisted subsystems', () => {
    for (const s of ['subscription', 'epggrab', 'htsp', 'webui', 'avahi', 'bonjour']) {
      expect(isNoisySubsystem(s)).toBe(true);
    }
  });

  it('keeps everything else, including null (unparsed)', () => {
    expect(isNoisySubsystem('mpegts')).toBe(false);
    expect(isNoisySubsystem('dvr')).toBe(false);
    expect(isNoisySubsystem(null)).toBe(false);
  });
});

describe('classifyLogMessage', () => {
  it('classifies known error keywords as warning, case-insensitively', () => {
    expect(classifyLogMessage('mpegts: no signal on frontend')).toBe('warning');
    expect(classifyLogMessage('DVR: recording FAILED')).toBe('warning');
    expect(classifyLogMessage('mpegts: continuity errors detected')).toBe('warning');
    expect(classifyLogMessage('descrambler: unable to decode, scrambled')).toBe('warning');
  });

  it('classifies routine lines as normal', () => {
    expect(classifyLogMessage('dvr: recording started "News"')).toBe('normal');
    expect(classifyLogMessage('mpegts: mux tuned')).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// diffNewFailures (site #3 pure helper)
// ---------------------------------------------------------------------------

function dvrEntry(uuid: string, over: Partial<TvhDvrEntry> = {}): TvhDvrEntry {
  return { uuid, start: 0, stop: 0, ...over };
}

describe('diffNewFailures', () => {
  it('returns entries whose uuid is not in the prev set', () => {
    const prev = new Set(['a']);
    const next = diffNewFailures(prev, [dvrEntry('a'), dvrEntry('b')]);
    expect(next.map((e) => e.uuid)).toEqual(['b']);
  });

  it('returns everything when prev is empty', () => {
    const next = diffNewFailures(new Set(), [dvrEntry('a'), dvrEntry('b')]);
    expect(next.map((e) => e.uuid)).toEqual(['a', 'b']);
  });

  it('returns nothing when nothing is new', () => {
    const prev = new Set(['a', 'b']);
    const next = diffNewFailures(prev, [dvrEntry('a'), dvrEntry('b')]);
    expect(next).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// InstancePoller integration (real construction — no network at construction
// time; TvhClient only makes requests when its methods are called)
// ---------------------------------------------------------------------------

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

const POLL_INTERVALS = { dvr: 15_000, autorec: 60_000, topology: 600_000, epg: 600_000, restreamer: 15_000 };

function makeInstance(id = 'z1'): InstanceConfig {
  return { id, name: `Instance ${id}`, url: `http://${id}` };
}

function setupPoller(instance: InstanceConfig = makeInstance()) {
  const cache = new InstanceCache();
  cache.init(instance.id, instance.name, instance.url);
  const bus = new EventBus();
  const logs: LoggedEvent[] = [];
  const poller = new InstancePoller(instance, cache, bus, POLL_INTERVALS, { log: (e) => logs.push(e) });
  return { cache, bus, logs, poller, instance };
}

/** invoke the private comet handler directly — same access pattern the rest of the suite uses for internals */
function comet(poller: InstancePoller, n: CometNotification): void {
  (poller as unknown as { handleComet: (n: CometNotification) => void }).handleComet(n);
}

describe('InstancePoller: tvh instance up/down (site #1)', () => {
  it('the first observation (no prior poll) logs nothing; only later transitions log', () => {
    const { logs, poller } = setupPoller();
    const markReachable = (e: string | null): void =>
      (poller as unknown as { markReachable: (e: string | null) => void }).markReachable(e);

    // first-ever observation (cache default lastPollAt: null) is baseline,
    // not a transition, even though reachable itself flips false -> true
    markReachable(null);
    expect(logs).toHaveLength(0);

    markReachable(null); // still reachable — no repeat
    expect(logs).toHaveLength(0);

    markReachable('ECONNREFUSED'); // first REAL transition: up -> down
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'warning', service: 'instance', source: 'instance.z1' });
    expect(logs[0]!.message).toContain('ECONNREFUSED');

    markReachable('ECONNREFUSED'); // still down — no repeat
    expect(logs).toHaveLength(1);

    markReachable(null); // down -> up transition
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ type: 'normal', service: 'instance', source: 'instance.z1' });
  });

  it('a first-ever poll that starts down also logs nothing', () => {
    const { logs, poller } = setupPoller();
    const markReachable = (e: string | null): void =>
      (poller as unknown as { markReachable: (e: string | null) => void }).markReachable(e);

    markReachable('ECONNREFUSED'); // first observation, already down — baseline, no log
    expect(logs).toHaveLength(0);

    markReachable(null); // first REAL transition: down -> up
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'normal', service: 'instance', source: 'instance.z1' });
  });
});

describe('InstancePoller: tvheadend log ingestion (site #2)', () => {
  it('logs a normal event for a routine line, from a logmessage comet notification', () => {
    const { logs, poller } = setupPoller();
    comet(poller, {
      notificationClass: 'logmessage',
      logtxt: '2026-07-10 12:00:01 dvr: recording started "News"',
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'normal', service: 'tvheadend', source: 'instance.z1' });
    expect(logs[0]!.message).toBe('dvr: recording started "News"');
  });

  it('logs a warning event when the message matches an error keyword', () => {
    const { logs, poller } = setupPoller();
    comet(poller, {
      notificationClass: 'logmessage',
      logtxt: '2026-07-10 12:00:01 mpegts: continuity errors on mux',
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.type).toBe('warning');
  });

  it('drops lines from a blocklisted (noisy) subsystem entirely', () => {
    const { logs, poller } = setupPoller();
    comet(poller, {
      notificationClass: 'logmessage',
      logtxt: '2026-07-10 12:00:01 subscription: started for user',
    });
    expect(logs).toHaveLength(0);
  });

  it('ignores notifications without a string logtxt', () => {
    const { logs, poller } = setupPoller();
    comet(poller, { notificationClass: 'logmessage' });
    comet(poller, { notificationClass: 'logmessage', logtxt: 42 });
    expect(logs).toHaveLength(0);
  });

  it('rate-limits: after LOG_RATE_LIMIT events in the window, drops are counted and one suppression summary fires on the next line past the window', () => {
    const { logs, poller } = setupPoller();
    // 20 allowed + 5 dropped, all inside the same 60s window (Date.now() based,
    // no injected clock — the window has not rolled over yet)
    for (let i = 0; i < 25; i++) {
      comet(poller, { notificationClass: 'logmessage', logtxt: `dvr: recording started "Show ${i}"` });
    }
    expect(logs).toHaveLength(20); // the 5 overflow lines were dropped, not logged

    // force the window to roll over by faking Date.now() past LOG_RATE_WINDOW_MS
    const real = Date.now;
    try {
      Date.now = () => real() + 61_000;
      comet(poller, { notificationClass: 'logmessage', logtxt: 'dvr: recording started "Later"' });
    } finally {
      Date.now = real;
    }
    // the rolled-over window emits ONE suppression summary, then logs the new line
    expect(logs).toHaveLength(22);
    const suppression = logs[20]!;
    expect(suppression).toMatchObject({ type: 'warning', service: 'tvheadend', source: 'instance.z1' });
    expect(suppression.message).toBe('suppressed 5 tvheadend log lines (rate limit)');
    expect(logs[21]!.message).toContain('Later');
  });
});

describe('InstancePoller: recording failed diff (site #3)', () => {
  interface FakeTvhDvrClient {
    dvrUpcoming: () => Promise<TvhDvrEntry[]>;
    dvrFinished: () => Promise<TvhDvrEntry[]>;
    dvrFailed: () => Promise<TvhDvrEntry[]>;
    statusInputs: () => Promise<unknown[]>;
    statusSubscriptions: () => Promise<unknown[]>;
    serverInfo: () => Promise<never>;
  }

  function installFakeClient(poller: InstancePoller, getFailed: () => TvhDvrEntry[]): void {
    const fake: FakeTvhDvrClient = {
      dvrUpcoming: vi.fn(async () => []),
      dvrFinished: vi.fn(async () => []),
      dvrFailed: vi.fn(async () => getFailed()),
      statusInputs: vi.fn(async () => []),
      statusSubscriptions: vi.fn(async () => []),
      serverInfo: vi.fn(async () => {
        throw new Error('serverinfo not supported by this fake');
      }),
    };
    (poller as unknown as { client: FakeTvhDvrClient }).client = fake;
  }

  it('first-poll baseline: pre-existing failures are seeded but never logged', async () => {
    const { logs, poller } = setupPoller();
    let failed = [dvrEntry('f1', { disp_title: 'Show A', channelname: 'CH1' })];
    installFakeClient(poller, () => failed);

    await poller.pollDvrAndStatus();
    expect(logs).toHaveLength(0);
    void failed;
  });

  it('logs a warning for each newly-failed recording after the baseline, and nothing when nothing changed', async () => {
    const { logs, poller } = setupPoller();
    let failed = [dvrEntry('f1', { disp_title: 'Show A', channelname: 'CH1' })];
    installFakeClient(poller, () => failed);

    await poller.pollDvrAndStatus(); // baseline — seeds f1, no log
    expect(logs).toHaveLength(0);

    failed = [
      ...failed,
      dvrEntry('f2', { disp_title: 'Show B', channelname: 'CH2', errors: 3 }),
    ];
    await poller.pollDvrAndStatus(); // f2 is new
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'warning', service: 'recordings', source: 'instance.z1' });
    expect(logs[0]!.message).toContain('Show B');
    expect(logs[0]!.message).toContain('CH2');
    expect(logs[0]!.message).toContain('errors=3');

    await poller.pollDvrAndStatus(); // unchanged — no new log
    expect(logs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// first-DVR-load capacity recompute trigger (Fix 2)
// ---------------------------------------------------------------------------

describe('InstancePoller: first successful DVR poll triggers a capacity recompute even with empty grids', () => {
  interface FakeTvhDvrClient {
    dvrUpcoming: () => Promise<TvhDvrEntry[]>;
    dvrFinished: () => Promise<TvhDvrEntry[]>;
    dvrFailed: () => Promise<TvhDvrEntry[]>;
    statusInputs: () => Promise<unknown[]>;
    statusSubscriptions: () => Promise<unknown[]>;
    serverInfo: () => Promise<never>;
  }

  function installEmptyClient(poller: InstancePoller): void {
    const fake: FakeTvhDvrClient = {
      dvrUpcoming: vi.fn(async () => []),
      dvrFinished: vi.fn(async () => []),
      dvrFailed: vi.fn(async () => []),
      statusInputs: vi.fn(async () => []),
      statusSubscriptions: vi.fn(async () => []),
      serverInfo: vi.fn(async () => {
        throw new Error('serverinfo not supported by this fake');
      }),
    };
    (poller as unknown as { client: FakeTvhDvrClient }).client = fake;
  }

  it('fires onCapacityInputsChanged exactly once on the first empty poll; a second empty poll does not fire it again', async () => {
    const { poller } = setupPoller();
    installEmptyClient(poller);
    let calls = 0;
    poller.onCapacityInputsChanged = () => {
      calls++;
    };

    // first-ever poll: upcoming stays [] -> [] (not "changed"), but dvrLoaded
    // flips false -> true, which alone must still trigger the recompute so
    // the conflict baseline is seeded from THIS pass, not the next real change
    await poller.pollDvrAndStatus();
    expect(calls).toBe(1);

    // second poll: dvrLoaded already true and nothing changed — must not fire again
    await poller.pollDvrAndStatus();
    expect(calls).toBe(1);
  });
});
