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
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import { analyze, toCapacityEntries } from './analyze.js';
import { buildModel } from './buildModel.js';

/** Recomputes conflict windows for an instance when its inputs change. */
export class ConflictService {
  constructor(
    private readonly cache: InstanceCache,
    private readonly bus: EventBus,
  ) {}

  recompute(instanceId: string): void {
    const snap = this.cache.get(instanceId);
    if (!snap.topology) return;
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
  }
}
