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

import { chanNumberOrder, type ChannelOption, type InstanceSummary } from '@tvhc/shared';

/**
 * Autorec time windows are interpreted by tvheadend in the SERVER's local
 * timezone, which can differ from the broadcast network's EIT zone (e.g.
 * UTC servers recording JST broadcasts). The EIT zone comes from tvheadend
 * itself: each network's "EIT time offset" setting, resolved per channel
 * (channel → service → mux → network) by the /api/channels endpoint.
 */

export interface EitConversion {
  serverOffsetMinutes: number;
  eitOffsetMinutes: number;
  /** minutes to ADD to a server-local wall time to get EIT wall time */
  deltaMinutes: number;
}

function serverOffset(instances: InstanceSummary[]): number | null {
  return instances.find((i) => i.serverOffsetMinutes !== null)?.serverOffsetMinutes ?? null;
}

/** the single EIT offset shared by every channel, or null when mixed/unknown */
export function commonEitOffset(channels: ChannelOption[]): number | null {
  const distinct = new Set(
    channels.map((c) => c.eitOffsetMinutes).filter((v): v is number => v !== null),
  );
  return distinct.size === 1 ? [...distinct][0]! : null;
}

/**
 * Conversion for a rule, resolved per channel. Three modes:
 *  - no channel name: the common offset when every known channel agrees;
 *  - channel name + a pinned number: that exact (name, number) channel's
 *    offset, falling back to the common offset when the pair isn't found;
 *  - channel name, no number pinned: the LOWEST-numbered same-name channel's
 *    offset (the channel an unpinned rule targets — see channelSetterValue),
 *    falling back to the common offset when it is unknown.
 * null = no conversion (zones match, or not enough information).
 */
export function conversionFor(
  channelName: string,
  channelNumber: string | null,
  channels: ChannelOption[],
  instances: InstanceSummary[],
): EitConversion | null {
  const server = serverOffset(instances);
  if (server === null) return null;
  let eit: number | null;
  if (!channelName) {
    eit = commonEitOffset(channels);
  } else if (channelNumber != null) {
    eit =
      channels.find((c) => c.name === channelName && c.number === channelNumber)
        ?.eitOffsetMinutes ?? commonEitOffset(channels);
  } else {
    const named = channels.filter((c) => c.name === channelName);
    const lowest = named.length
      ? named.reduce((a, b) => (chanNumberOrder(b.number) < chanNumberOrder(a.number) ? b : a))
      : undefined;
    eit = lowest?.eitOffsetMinutes ?? commonEitOffset(channels);
  }
  if (eit === null) return null;
  const delta = eit - server;
  if (delta === 0) return null;
  return { serverOffsetMinutes: server, eitOffsetMinutes: eit, deltaMinutes: delta };
}

export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export interface EitTime {
  /**
   * EIT wall time in TV-schedule notation: hours run past 24 for times that
   * fall on the next server-local day (e.g. "27:30" = 03:30 next day)
   */
  time: string;
}

/** convert a server-local "HH:MM" rule time to EIT wall time */
export function toEitTime(hhmm: string, conv: EitConversion): EitTime | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  let total = Number(m[1]) * 60 + Number(m[2]) + conv.deltaMinutes;
  if (total < 0) total += 1440; // negative deltas wrap to the previous day
  return {
    time: `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`,
  };
}
