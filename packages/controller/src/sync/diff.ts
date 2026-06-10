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

export function diffPayloads(master: MasterRulePayload, instance: MasterRulePayload): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const keys = new Set([...Object.keys(master), ...Object.keys(instance)]) as Set<
    keyof MasterRulePayload
  >;
  for (const key of keys) {
    const m = master[key];
    const i = instance[key];
    const same = Array.isArray(m) && Array.isArray(i)
      ? m.length === i.length && m.every((v, idx) => v === i[idx])
      : m === i;
    if (!same) diffs.push({ field: key, master: m, instance: i });
  }
  return diffs;
}
