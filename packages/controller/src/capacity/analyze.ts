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

import type { TvhDvrEntry } from '@tvhc/shared';
import type { CapacityEntry, CapacityModel, WindowReport } from './model.js';
import { checkWindow } from './matching.js';
import { overlapWindows } from './sweep.js';

export function toCapacityEntries(entries: TvhDvrEntry[]): CapacityEntry[] {
  return entries
    .filter((e) => e.enabled !== false && e.channel)
    .map((e) => ({
      uuid: e.uuid,
      channelUuid: e.channel!,
      title: e.disp_title ?? '',
      start: e.start_real ?? e.start,
      stop: e.stop_real ?? e.stop,
    }))
    .filter((e) => e.stop > e.start);
}

/** Full analysis: sweep upcoming entries, check each overlap window. */
export function analyze(entries: CapacityEntry[], model: CapacityModel): WindowReport[] {
  const reports: WindowReport[] = [];
  for (const window of overlapWindows(entries)) {
    const result = checkWindow(window.entries, model);
    if (!result.feasible) {
      const net = result.shortNetwork ?? '';
      reports.push({
        start: window.start,
        stop: window.stop,
        level: 'conflict',
        entryUuids: window.entries.map((e) => e.uuid),
        networkUuid: net,
        networkName: model.networkNames.get(net) ?? net,
        detail:
          result.unservedEntries.length > 0
            ? `not enough tuner slots: ${result.unservedEntries
                .map((e) => e.title || e.uuid)
                .join(', ')} cannot be recorded${result.approximate ? ' (approximate)' : ''}`
            : `no feasible tuner assignment${result.approximate ? ' (approximate)' : ''}`,
      });
      continue;
    }
    for (const [net, spareCount] of result.spare) {
      if (spareCount === 0) {
        reports.push({
          start: window.start,
          stop: window.stop,
          level: 'low-margin',
          entryUuids: window.entries.map((e) => e.uuid),
          networkUuid: net,
          networkName: model.networkNames.get(net) ?? net,
          detail: `all tuner slots on "${model.networkNames.get(net) ?? net}" in use — no margin for live TV or EPG scans`,
        });
        break;
      }
    }
  }
  return reports;
}
