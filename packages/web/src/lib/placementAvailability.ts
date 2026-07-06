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

// Pure client-side mirror of the controller's write-time placement
// availability (restreamer/service.ts#placementAvailability), judged from the
// data the UI already holds: the merged tvh channel options and the target
// node's polled sources.m3u catalog. Each placement resolves its channel
// identity the same way the server does — tvheadend topology first, then
// (only on a tvh known-miss) the node's catalog by the same (name, number)
// identity rules. 'unknown' = cannot be judged yet — the controller allows
// such writes (lazy blocking covers them), so the UI shows a muted badge
// instead of a warning. No Svelte imports.

import type { ChannelOption, RestreamerNodeStatus } from '@tvhc/shared';

export type Availability = 'ok' | 'unavailable' | 'unknown';

/**
 * Availability of one placement's channel identity (name + STRING number,
 * "9.1" ≠ "9.10"; null number = unpinned — any same-name match qualifies, the
 * controller pins the lowest-numbered one at write time).
 *
 * tvh side: `options` empty (channel list never loaded) → 'unknown'; a
 * pinned/unpinned match on `instanceId` → 'ok'.
 *
 * Only on a tvh known-miss (options loaded, no match) does the node's
 * sources.m3u catalog get consulted: `node` missing or its `sources` never
 * fetched (null) → 'unknown'; a pinned/unpinned match by (name, chno) → 'ok';
 * a known catalog ([] included) without a match → 'unavailable'.
 */
export function placementAvailability(
  name: string,
  number: string | null,
  instanceId: string,
  nodeId: string,
  options: ChannelOption[],
  node: RestreamerNodeStatus | undefined,
): Availability {
  if (options.length === 0) return 'unknown';
  const tvhHit = options.some(
    (c) =>
      c.name === name &&
      (number === null || c.number === number) &&
      c.instances.includes(instanceId),
  );
  if (tvhHit) return 'ok';

  // tvh known-miss — fall back to the target node's local catalog.
  if (!node || node.nodeId !== nodeId || node.sources === null) return 'unknown';
  const catalogHit = node.sources.some(
    (e) => e.name === name && (number === null || e.chno === number),
  );
  return catalogHit ? 'ok' : 'unavailable';
}
