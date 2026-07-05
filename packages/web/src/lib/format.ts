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

const pad = (n: number): string => String(n).padStart(2, '0');

/** local-time `YYYY-MM-DD HH:mm:ss` (fixed format, no locale APIs) */
function formatLocal(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** full date+time as local `YYYY-MM-DD HH:mm:ss` (always 24h, with seconds) */
export function ts(epoch: number | undefined): string {
  if (!epoch) return '—';
  return formatLocal(new Date(epoch * 1000));
}

/** full date+time as local `YYYY-MM-DD HH:mm:ss` (always 24h, with seconds) */
export function dateTime(iso: string): string {
  return formatLocal(new Date(iso));
}

export function duration(startEpoch?: number, stopEpoch?: number): string {
  if (!startEpoch || !stopEpoch) return '—';
  const mins = Math.round((stopEpoch - startEpoch) / 60);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

export function pct(part: number, total: number | null | undefined): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((part / total) * 100));
}

/** tvheadend weekday numbering: 1 = Monday … 7 = Sunday */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdays(days: number[]): string {
  if (!days.length || days.length === 7) return 'Every day';
  return days.map((d) => WEEKDAY_LABELS[d - 1] ?? String(d)).join(', ');
}
