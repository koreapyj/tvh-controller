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

import { chanLabel, chanNumberOrder, type ChannelOption } from '@tvhc/shared';

export interface ChannelPick {
  name: string;
  number: string | null;
}

/**
 * Parse a channel-picker input string.
 *  - exact chanLabel match against the channel list -> that (name, number)
 *  - "N　Name" text (full-width space) -> parsed pair even when the channel
 *    is currently absent from the list (offline channel must not corrupt)
 *  - anything else -> bare name, number null
 */
export function parseChannelInput(raw: string, options: ChannelOption[]): ChannelPick {
  const exact = options.find((c) => chanLabel(c.name, c.number) === raw);
  if (exact) return { name: exact.name, number: exact.number };
  const m = /^(\d+(?:\.\d+)?)　(.+)$/.exec(raw);
  if (m) return { name: m[2]!, number: m[1]! };
  return { name: raw, number: null };
}

/** lowest-numbered channel with this name, or null when none carry a number */
export function lowestNumberFor(name: string, options: ChannelOption[]): string | null {
  const candidates = options.filter((c) => c.name === name && c.number !== null);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) =>
    chanNumberOrder(b.number) < chanNumberOrder(a.number) ? b : a,
  ).number;
}

/**
 * Resolve a picker input for SAVING: pinned pair as-is; bare name pinned to
 * the lowest number; returns null when the name matches nothing (caller must
 * block the save). Empty raw -> { name: '', number: null } (any channel).
 */
export function resolveChannelPick(raw: string, options: ChannelOption[]): ChannelPick | null {
  if (raw === '') return { name: '', number: null };
  const pick = parseChannelInput(raw, options);
  if (pick.number !== null) return pick;
  const candidates = options.filter((c) => c.name === pick.name);
  if (!candidates.length) return null;
  return { name: pick.name, number: lowestNumberFor(pick.name, options) };
}
