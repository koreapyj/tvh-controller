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
import { analyze } from '../src/capacity/analyze.js';
import { checkWindow } from '../src/capacity/matching.js';
import type { CapacityEntry, CapacityModel } from '../src/capacity/model.js';
import { overlapWindows } from '../src/capacity/sweep.js';

function model(opts: {
  channels: Record<string, string[]>; // channel -> muxes
  muxes: Record<string, string>; // mux -> network
  frontends: string[][]; // each frontend's serveable networks
  iptv?: Record<string, number>;
}): CapacityModel {
  return {
    channelMuxes: new Map(Object.entries(opts.channels)),
    muxNetwork: new Map(Object.entries(opts.muxes)),
    networkNames: new Map(
      [...new Set(Object.values(opts.muxes))].map((n) => [n, n.toUpperCase()]),
    ),
    frontends: opts.frontends.map((nets, i) => ({ uuid: `fe${i}`, networks: new Set(nets) })),
    iptvMaxStreams: new Map(Object.entries(opts.iptv ?? {})),
  };
}

function entry(uuid: string, channel: string, start: number, stop: number): CapacityEntry {
  return { uuid, channelUuid: channel, title: uuid, start, stop };
}

describe('overlapWindows', () => {
  it('finds no windows for sequential recordings', () => {
    expect(overlapWindows([entry('a', 'c1', 0, 10), entry('b', 'c2', 10, 20)])).toEqual([]);
  });

  it('finds the overlap window and merges identical adjacent sets', () => {
    const ws = overlapWindows([entry('a', 'c1', 0, 30), entry('b', 'c2', 10, 20)]);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ start: 10, stop: 20 });
    expect(ws[0]!.entries.map((e) => e.uuid).sort()).toEqual(['a', 'b']);
  });
});

describe('checkWindow', () => {
  it('two channels on the same mux share one tuner', () => {
    const m = model({
      channels: { c1: ['m1'], c2: ['m1'] },
      muxes: { m1: 'dvbt' },
      frontends: [['dvbt']],
    });
    const r = checkWindow([entry('a', 'c1', 0, 10), entry('b', 'c2', 0, 10)], m);
    expect(r.feasible).toBe(true);
  });

  it('two channels on different muxes need two tuners — conflict with one', () => {
    const m = model({
      channels: { c1: ['m1'], c2: ['m2'] },
      muxes: { m1: 'dvbt', m2: 'dvbt' },
      frontends: [['dvbt']],
    });
    const r = checkWindow([entry('a', 'c1', 0, 10), entry('b', 'c2', 0, 10)], m);
    expect(r.feasible).toBe(false);
    expect(r.unservedEntries.length).toBeGreaterThan(0);
  });

  it('multi-service channel picks the shareable mux (backtracking)', () => {
    // c2 is available on m1 (shared with c1) and m2; only one frontend exists,
    // so feasibility requires picking m1 for c2
    const m = model({
      channels: { c1: ['m1'], c2: ['m2', 'm1'] },
      muxes: { m1: 'dvbt', m2: 'dvbt' },
      frontends: [['dvbt']],
    });
    const r = checkWindow([entry('a', 'c1', 0, 10), entry('b', 'c2', 0, 10)], m);
    expect(r.feasible).toBe(true);
  });

  it('cross-network frontends are matched correctly (no double counting)', () => {
    // fe0 serves both networks, fe1 only dvbt. muxes on dvbt and dvbs.
    const m = model({
      channels: { c1: ['m1'], c2: ['m2'] },
      muxes: { m1: 'dvbt', m2: 'dvbs' },
      frontends: [['dvbt', 'dvbs'], ['dvbt']],
    });
    // m2 (dvbs) can only go to fe0 — matching must put m1 on fe1
    const r = checkWindow([entry('a', 'c1', 0, 10), entry('b', 'c2', 0, 10)], m);
    expect(r.feasible).toBe(true);
    // dvbs has zero spare (only fe0 could serve it and it's busy)
    expect(r.spare.get('dvbs')).toBe(0);
  });

  it('IPTV networks respect max_streams', () => {
    const m = model({
      channels: { c1: ['m1'], c2: ['m2'], c3: ['m3'] },
      muxes: { m1: 'iptv', m2: 'iptv', m3: 'iptv' },
      frontends: [],
      iptv: { iptv: 2 },
    });
    const ok = checkWindow([entry('a', 'c1', 0, 10), entry('b', 'c2', 0, 10)], m);
    expect(ok.feasible).toBe(true);
    const over = checkWindow(
      [entry('a', 'c1', 0, 10), entry('b', 'c2', 0, 10), entry('c', 'c3', 0, 10)],
      m,
    );
    expect(over.feasible).toBe(false);
    expect(over.shortNetwork).toBe('iptv');
  });

  it('channel with no known services is unserved', () => {
    const m = model({ channels: {}, muxes: {}, frontends: [['dvbt']] });
    const r = checkWindow([entry('a', 'ghost', 0, 10), entry('b', 'ghost2', 0, 10)], m);
    expect(r.feasible).toBe(false);
  });
});

describe('analyze', () => {
  const twoTuners = model({
    channels: { c1: ['m1'], c2: ['m2'], c3: ['m3'] },
    muxes: { m1: 'dvbt', m2: 'dvbt', m3: 'dvbt' },
    frontends: [['dvbt'], ['dvbt']],
  });

  it('reports conflict when three muxes overlap on two tuners', () => {
    const reports = analyze(
      [entry('a', 'c1', 0, 100), entry('b', 'c2', 0, 100), entry('c', 'c3', 50, 150)],
      twoTuners,
    );
    expect(reports.some((r) => r.level === 'conflict')).toBe(true);
  });

  it('reports low-margin when all tuners are exactly used', () => {
    const reports = analyze([entry('a', 'c1', 0, 100), entry('b', 'c2', 0, 100)], twoTuners);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.level).toBe('low-margin');
  });

  it('reports nothing when there is spare capacity', () => {
    const threeTuners = model({
      channels: { c1: ['m1'], c2: ['m2'] },
      muxes: { m1: 'dvbt', m2: 'dvbt' },
      frontends: [['dvbt'], ['dvbt'], ['dvbt']],
    });
    expect(analyze([entry('a', 'c1', 0, 100), entry('b', 'c2', 0, 100)], threeTuners)).toEqual([]);
  });
});
