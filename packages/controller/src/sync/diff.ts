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

import type { FieldDiff, MasterRulePayload } from '@tvhc/shared';

/**
 * True when a divergent instance channel_number is tolerated: master's number
 * is unpinned and the channel NAME still matches. An unpinned push targets
 * the lowest-numbered same-name channel (see channelSetterValue), so the
 * read-back always carries a concrete number — that is not drift. Shared by
 * diffPayloads (field-level reporting) and the sync engine's hash baselines
 * (sync/engine.ts), which must fold the same way or a legacy rule would
 * perpetually hash-mismatch its own pushed baseline.
 */
export function channelNumberTolerated(master: MasterRulePayload, instance: MasterRulePayload): boolean {
  return master.channel_number == null && master.channel === instance.channel;
}

export function diffPayloads(master: MasterRulePayload, instance: MasterRulePayload): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const keys = new Set([...Object.keys(master), ...Object.keys(instance)]) as Set<
    keyof MasterRulePayload
  >;
  for (const key of keys) {
    // if the name changed too, report both fields so split-into-clone captures the pair
    if (key === 'channel_number' && channelNumberTolerated(master, instance)) continue;
    const m = master[key];
    const i = instance[key];
    const same = Array.isArray(m) && Array.isArray(i)
      ? m.length === i.length && m.every((v, idx) => v === i[idx])
      : m === i;
    if (!same) diffs.push({ field: key, master: m, instance: i });
  }
  return diffs;
}
