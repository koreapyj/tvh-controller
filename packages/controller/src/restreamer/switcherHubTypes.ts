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

// Interface seam between the switcher WebSocket hub and the code that drives
// it (doc broadcast, switch commands) — consumers depend on this, not on the
// hub class, so the hub and its callers can evolve independently.

import type { SwitcherDesiredState } from '@tvhc/shared';

/** Synthetic cache.switchers key for the single aggregate replica-merged status entry. */
export const SWITCHER_CACHE_KEY = 'switcher';

/** One client playlist fetch observed by a switcher replica. */
export interface DemandEvent {
  slug: string;
  kind: 'master' | 'media';
  /** ISO timestamp of the most recent fetch (coalesced switcher-side). */
  at: string;
}

export interface SwitcherHubLike {
  /** Send the desired doc to every connected replica. */
  broadcastDoc(doc: SwitcherDesiredState): void;
  /** Send a switch command to every connected replica; returns how many received it. */
  broadcastSwitch(slug: string, upstreamId: string): number;
  connectedCount(): number;
}
