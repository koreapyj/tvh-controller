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

// Pure staging model for RestreamChannelModal's placement editor: the modal
// no longer hits a live per-placement endpoint on every add/reorder/edit —
// every interaction mutates a local array of StagedPlacement rows (form
// strings, like the ruleFields/restreamFields pattern), and Save submits the
// FULL desired set in one shot to the channel apply endpoint. No Svelte
// imports — everything here is node-testable.

import type { RestreamPlacement } from '@tvhc/shared';

/** one staged placement row — form strings ('' = unset/null), array order = priority */
export interface StagedPlacement {
  /** absent = a new placement (not yet created); present = edits an existing one */
  id?: string;
  instanceId: string;
  nodeId: string;
  mode: 'hot' | 'cold';
  /** '' = null (derived program number) */
  programNumber: string;
  /** '' = null (inherit the channel's profile); non-empty = per-placement profile override */
  profileId: string;
  enabled: boolean;
}

/** POST .../channels/:id/apply and POST .../channels body shape for one placement */
export interface StagedPlacementInput {
  id?: string;
  instanceId: string;
  nodeId: string;
  mode: 'hot' | 'cold';
  programNumber: number | null;
  profileId: string | null;
  enabled: boolean;
}

/**
 * seed the staging array from a channel's current placements, in priority
 * order — cutover-owned transient clones are never user-created and are
 * excluded from manual editing entirely; they come and go on their own
 * lifecycle (createCutoverClone / markCutoverComplete / drain-expiry)
 */
export function seedStagedPlacements(placements: RestreamPlacement[]): StagedPlacement[] {
  return placements
    .filter((p) => !p.transient)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      instanceId: p.instanceId,
      nodeId: p.nodeId,
      mode: p.mode,
      programNumber: p.programNumber === null ? '' : String(p.programNumber),
      profileId: p.profileId ?? '',
      enabled: p.enabled,
    }));
}

export type BuildPlacementsResult =
  | { ok: true; placements: StagedPlacementInput[] }
  | { ok: false; error: string };

/** '' -> null; a positive integer string -> that number; anything else -> undefined (error) */
export function parsePositiveInt(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * Fold the staged rows into the apply/create endpoint's `placements` array.
 * Order is preserved (array order = priority, 1-based on the server side);
 * `id` absent means "create", present means "update this placement" — the
 * caller (removedPlacementIds) separately reports ids present in the
 * original set but missing here, so the server can delete them.
 */
export function buildPlacementsPayload(staged: StagedPlacement[]): BuildPlacementsResult {
  const placements: StagedPlacementInput[] = [];
  for (const p of staged) {
    const label = `${p.instanceId}/${p.nodeId}`;
    const programNumber = parsePositiveInt(p.programNumber);
    if (programNumber === undefined) {
      return { ok: false, error: `${label}: program number must be a positive integer, or blank` };
    }
    placements.push({
      ...(p.id !== undefined ? { id: p.id } : {}),
      instanceId: p.instanceId,
      nodeId: p.nodeId,
      mode: p.mode,
      programNumber,
      profileId: p.profileId === '' ? null : p.profileId,
      enabled: p.enabled,
    });
  }
  return { ok: true, placements };
}

/**
 * ids present in the original placement set but no longer in the staged rows
 * (server deletes these). Transient clones are excluded up front — they were
 * never seeded into the staging rows in the first place (seedStagedPlacements
 * filters them too), so without this filter every one would look "removed"
 * and the apply call would ask the server to delete a cutover-owned clone
 * out from under an in-flight procedure.
 */
export function removedPlacementIds(original: RestreamPlacement[], staged: StagedPlacement[]): string[] {
  const stagedIds = new Set(staged.map((p) => p.id).filter((id): id is string => id !== undefined));
  return original
    .filter((p) => !p.transient)
    .filter((p) => !stagedIds.has(p.id))
    .map((p) => p.id);
}
