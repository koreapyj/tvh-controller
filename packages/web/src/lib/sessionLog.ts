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

// Pure helpers for the SessionModal's live log pane: a capped in-memory ring
// (SessionModal drops the one-shot REST seed entirely — the SSE-style log
// stream replays its own ring tail on connect) and the stream URL builder.
// No Svelte/DOM imports.

import type { LogLine } from '@tvhc/shared';

/** cap on buffered log lines shown in the pane — oldest lines drop off the front */
export const MAX_LOG_LINES = 2000;

/** append one line, capping the buffer from the front; always returns a new array */
export function appendLogLine(lines: LogLine[], line: LogLine): LogLine[] {
  const next = [...lines, line];
  if (next.length <= MAX_LOG_LINES) return next;
  return next.slice(next.length - MAX_LOG_LINES);
}

/** EventSource URL for a session's live log tail (GET .../log/stream) */
export function sessionLogStreamUrl(instanceId: string, nodeId: string, name: string): string {
  return (
    `/api/restreamer/nodes/${encodeURIComponent(instanceId)}/${encodeURIComponent(nodeId)}` +
    `/sessions/${encodeURIComponent(name)}/log/stream`
  );
}

/** EventSource URL for the daemon's own live log tail (GET .../log/stream), not any one session */
export function nodeLogStreamUrl(instanceId: string, nodeId: string): string {
  return (
    `/api/restreamer/nodes/${encodeURIComponent(instanceId)}/${encodeURIComponent(nodeId)}/log/stream`
  );
}
