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

import type { CapacityEntry } from './model.js';

export interface OverlapWindow {
  start: number;
  stop: number;
  entries: CapacityEntry[];
}

/**
 * Sweep over event boundaries: every maximal window between consecutive
 * start/stop boundaries with at least 2 concurrently active entries.
 */
export function overlapWindows(entries: CapacityEntry[]): OverlapWindow[] {
  const bounds = [...new Set(entries.flatMap((e) => [e.start, e.stop]))].sort((a, b) => a - b);
  const windows: OverlapWindow[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const stop = bounds[i + 1]!;
    const active = entries.filter((e) => e.start < stop && e.stop > start);
    if (active.length >= 2) {
      windows.push({ start, stop, entries: active });
    }
  }
  // merge adjacent windows with the identical active-entry set
  const merged: OverlapWindow[] = [];
  for (const w of windows) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.stop === w.start &&
      prev.entries.length === w.entries.length &&
      prev.entries.every((e, i) => e.uuid === w.entries[i]!.uuid)
    ) {
      prev.stop = w.stop;
    } else {
      merged.push({ ...w, entries: [...w.entries] });
    }
  }
  return merged;
}
