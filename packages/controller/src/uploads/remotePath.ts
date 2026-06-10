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

/** characters not allowed (or awkward) in Drive names, plus path separators */
function sanitize(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function extension(filename: string | undefined): string {
  if (!filename) return '.ts';
  const m = /\.[A-Za-z0-9]+$/.exec(filename);
  return m ? m[0] : '.ts';
}

/**
 * Mirrors the local recording layout on the remote: the file's path relative
 * to the DVR profile's storage root is appended to the rclone remote. The
 * tvheadend pathname format (e.g. "%F/$c - $t$n.$x") already guarantees
 * uniqueness — including channel name and dedup numbering — so deliberate
 * duplicate recordings of the same show from different channels never
 * collide. The result is identical to the layout produced by a manual
 * `rclone copy <storage> <remote>`.
 *
 * Fallback (storage root unknown or filename outside it):
 * `<remote>/<autorec caption || Manual>/<date> <title>.<ext>`.
 */
export function buildRemotePath(
  remote: string,
  entry: TvhDvrEntry,
  storageRoots: string[] = [],
): string {
  if (entry.filename) {
    for (const root of storageRoots) {
      if (!root) continue;
      const prefix = root.endsWith('/') ? root : `${root}/`;
      if (entry.filename.startsWith(prefix)) {
        return `${remote}/${entry.filename.slice(prefix.length)}`;
      }
    }
  }
  const folder = sanitize(entry.autorec_caption || 'Manual');
  const date = new Date(entry.start * 1000).toISOString().slice(0, 10);
  const title = sanitize(entry.disp_title || 'Untitled');
  const subtitle = entry.disp_subtitle ? ` - ${sanitize(entry.disp_subtitle)}` : '';
  return `${remote}/${folder}/${date} ${title}${subtitle}${extension(entry.filename)}`;
}
