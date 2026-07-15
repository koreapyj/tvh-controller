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
 * Pure parsing/classification for tvheadend's comet `logmessage`
 * notifications. tvheadend only ever sends
 * `{ notificationClass: 'logmessage', logtxt }` — no severity metadata reaches
 * the client (tvheadend pre-filters to INFO+ before pushing). `logtxt` is
 * `"YYYY-MM-DD HH:MM:SS[.mmm] <subsystem>: <message>"`, occasionally prefixed
 * with `tid N: ` when the server logs thread ids.
 *
 * Extracted out of tvh/poller.ts so it is directly testable without a live
 * poller/comet connection.
 */

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})? /;
const TID_RE = /^tid \d+: /;
const SUBSYSTEM_RE = /^([A-Za-z0-9_-]+):/;

/**
 * Subsystems whose log lines are dropped outright — tunable. Defaults chosen
 * for tvheadend subsystems known to spew routine chatter (subscription
 * start/stop, EPG grabber housekeeping, HTSP client churn, web UI polling,
 * mDNS advertisement).
 */
export const NOISY_SUBSYSTEMS = new Set([
  'subscription',
  'epggrab',
  'htsp',
  'webui',
  'avahi',
  'bonjour',
]);

/** case-insensitive error-keyword regex driving the normal/warning split — tunable */
export const ERROR_KEYWORD_RE =
  /error|fail|unable|invalid|timeout|no signal|scrambl|continuity|corrupt|denied|full|expired/i;

export interface ParsedLogMessage {
  /** null when the line doesn't match the "subsystem:" prefix shape */
  subsystem: string | null;
  /** logtxt with the leading timestamp (and thread-id prefix, if present) stripped */
  message: string;
}

/** strip the leading timestamp and an optional `tid N: ` prefix; extract the subsystem */
export function parseLogMessage(logtxt: string): ParsedLogMessage {
  const rest = logtxt.replace(TIMESTAMP_RE, '').replace(TID_RE, '');
  const m = SUBSYSTEM_RE.exec(rest);
  return { subsystem: m ? m[1]! : null, message: rest };
}

export function isNoisySubsystem(subsystem: string | null): boolean {
  return subsystem !== null && NOISY_SUBSYSTEMS.has(subsystem);
}

/** 'warning' when the message matches a known error keyword, else 'normal' */
export function classifyLogMessage(message: string): 'normal' | 'warning' {
  return ERROR_KEYWORD_RE.test(message) ? 'warning' : 'normal';
}
