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
 * Cross-instance duplicate detection for recordings.
 *
 * EPG is over-the-air EIT: the two instances may hold different EPG versions,
 * so titles and even start times can differ slightly, and programme/channel
 * uuids never match across instances. Identity is therefore based on the
 * channel NAME plus programme time overlap; titles are advisory only.
 */

export interface RecordingIdentity {
  channelname: string;
  /** programme start (NOT start_real, which includes per-instance padding) */
  start: number;
  stop: number;
  title?: string;
}

export interface DuplicateVerdict {
  isDuplicate: boolean;
  overlapRatio: number;
  titleSimilar: boolean;
}

export const DEFAULT_OVERLAP_THRESHOLD = 0.7;

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function intervalOverlapRatio(a: RecordingIdentity, b: RecordingIdentity): number {
  const overlap = Math.min(a.stop, b.stop) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.stop - a.start, b.stop - b.start);
  if (shorter <= 0) return 0;
  return overlap / shorter;
}

export function compareRecordings(
  a: RecordingIdentity,
  b: RecordingIdentity,
  overlapThreshold = DEFAULT_OVERLAP_THRESHOLD,
): DuplicateVerdict {
  const sameChannel = a.channelname !== '' && a.channelname === b.channelname;
  const overlapRatio = sameChannel ? intervalOverlapRatio(a, b) : 0;
  const titleSimilar =
    !!a.title && !!b.title && normalizeTitle(a.title) === normalizeTitle(b.title);
  return {
    isDuplicate: sameChannel && overlapRatio >= overlapThreshold,
    overlapRatio,
    titleSimilar,
  };
}
