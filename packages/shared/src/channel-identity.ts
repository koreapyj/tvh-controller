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

/**
 * Channel identity: name + number. Subchannels (e.g. 5.1/5.2/5.3 sharing one
 * name) differ only by number, and different channels can share a number
 * (e.g. 3.1 on two regional broadcasters) - so neither alone is unique.
 *
 * The output format `${name} ${number ?? ''}` is wire-visible: the web EPG
 * page sends these strings in the /api/epg `channels` filter param and the
 * server compares them. Numbers may be strings (EPG events, e.g. "5.1") or
 * numbers (channel grid); interpolation keeps both stable and `??` folds
 * null/undefined identically. Do NOT normalize, trim, or reformat.
 */
export function chanKey(name: string, number: string | number | null | undefined): string {
  return `${name} ${number ?? ''}`;
}

/**
 * Human-readable channel label: number first, separated by a FULL-WIDTH space
 * (U+3000), e.g. "2.1　ABC"; plain name when the number is unknown. Numbers
 * may be strings (EPG channels, e.g. "5.1") or numbers (rule payloads).
 */
export function chanLabel(name: string, number: string | number | null | undefined): string {
  return number == null ? name : `${number}　${name}`;
}

/**
 * Ordering key for picking the LOWEST-numbered channel: parseFloat of the
 * label ("9.1" < "10"), unknown/unparsable last. Ordering only - identity
 * comparisons must use exact string equality (parseFloat conflates
 * "9.1"/"9.10").
 */
export function chanNumberOrder(number: string | number | null | undefined): number {
  if (number == null) return Infinity;
  const n = Number.parseFloat(String(number));
  return Number.isNaN(n) ? Infinity : n;
}
