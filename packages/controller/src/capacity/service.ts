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

import type { ConflictWindow } from '@tvhc/shared';
import type { EventLog } from '../state/eventLog.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import { analyze, toCapacityEntries } from './analyze.js';
import { buildModel } from './buildModel.js';

/** Recomputes conflict windows for an instance when its inputs change. */
export class ConflictService {
  /** site #13: per-instance conflict-window synthetic keys from the previous recompute() */
  private readonly lastConflictKeys = new Map<string, Set<string>>();
  /** first-poll baseline guard (site 13): instances already seeded once */
  private readonly conflictBaselineSeeded = new Set<string>();

  constructor(
    private readonly cache: InstanceCache,
    private readonly bus: EventBus,
    private readonly events: Pick<EventLog, 'log'> = { log: () => {} },
  ) {}

  recompute(instanceId: string): void {
    const snap = this.cache.get(instanceId);
    // dvrLoaded gate: recomputing off the pre-first-poll empty grids would
    // seed the site-13 baseline as "no conflicts" and re-log every standing
    // conflict as "appeared" on the next pass (i.e. on every restart)
    if (!snap.topology || !snap.dvrLoaded) return;
    const model = buildModel(snap.topology);
    const reports = analyze(toCapacityEntries(snap.upcoming), model);
    const windows: ConflictWindow[] = reports.map((r) => ({
      start: r.start,
      stop: r.stop,
      level: r.level,
      entryUuids: r.entryUuids,
      network: r.networkName,
      detail: r.detail,
    }));
    const changed = JSON.stringify(snap.conflicts) !== JSON.stringify(windows);
    snap.conflicts = windows;
    if (changed) {
      this.bus.publish({ type: 'conflicts', data: { instanceId, windows } });
    }
    this.logConflictTransitions(instanceId, windows);
  }

  private conflictKey(instanceId: string, w: ConflictWindow): string {
    return `${instanceId}:${w.network}:${w.start}:${w.stop}`;
  }

  /**
   * Site #13 (capacity conflict window appeared/cleared): synthetic-key set
   * diff per instance. First-poll baseline guard: the first recompute() for
   * an instance only seeds lastConflictKeys, never logs — otherwise every
   * controller restart would flood the log with conflicts that already
   * existed before it started.
   */
  private logConflictTransitions(instanceId: string, windows: ConflictWindow[]): void {
    const byKey = new Map(windows.map((w) => [this.conflictKey(instanceId, w), w]));
    const keys = new Set(byKey.keys());
    if (!this.conflictBaselineSeeded.has(instanceId)) {
      this.conflictBaselineSeeded.add(instanceId);
      this.lastConflictKeys.set(instanceId, keys);
      return;
    }
    const prevKeys = this.lastConflictKeys.get(instanceId) ?? new Set<string>();
    for (const key of keys) {
      if (!prevKeys.has(key)) {
        const w = byKey.get(key)!;
        this.events.log({
          type: 'warning',
          service: 'conflicts',
          source: `instance.${instanceId}`,
          message: `capacity conflict appeared on "${w.network}" (window ${w.start}-${w.stop}): ${w.detail}`,
        });
      }
    }
    for (const key of prevKeys) {
      if (!keys.has(key)) {
        this.events.log({
          type: 'normal',
          service: 'conflicts',
          source: `instance.${instanceId}`,
          message: `capacity conflict cleared on ${instanceId} (${key})`,
        });
      }
    }
    this.lastConflictKeys.set(instanceId, keys);
  }
}
