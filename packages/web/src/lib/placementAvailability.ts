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
// data the UI already holds: the merged channel options for tvh channels and
// the polled node statuses for external sources. 'unknown' = cannot be judged
// yet — the controller allows such writes (lazy blocking covers them), so the
// UI shows a muted badge instead of a warning. No Svelte imports.

import type { ChannelOption, RestreamerNodeStatus } from '@tvhc/shared';

export type Availability = 'ok' | 'unavailable' | 'unknown';

/**
 * Availability of a tvh channel identity on one instance. Channel identity is
 * name + NUMBER where the number is exact STRING equality ("9.1" ≠ "9.10");
 * a null number is the unpinned form — any same-name channel on the instance
 * qualifies (the controller pins the lowest-numbered one at write time).
 * Empty `options` = the channel list has not loaded → 'unknown'.
 */
export function tvhAvailability(
  name: string,
  number: string | null,
  instanceId: string,
  options: ChannelOption[],
): Availability {
  if (options.length === 0) return 'unknown';
  const match = options.some(
    (c) =>
      c.name === name &&
      (number === null || c.number === number) &&
      c.instances.includes(instanceId),
  );
  return match ? 'ok' : 'unavailable';
}

/**
 * Availability of an external catalog entry on one restreamer node. Node
 * status missing or `sources` null = the catalog was never fetched (old
 * daemon / not polled yet) → 'unknown'; a known catalog ([] included) that
 * lacks the entry → 'unavailable'.
 */
export function externalAvailability(
  sourceKey: string,
  node: RestreamerNodeStatus | undefined,
): Availability {
  if (!node || node.sources === null) return 'unknown';
  return node.sources.some((e) => e.id === sourceKey) ? 'ok' : 'unavailable';
}
