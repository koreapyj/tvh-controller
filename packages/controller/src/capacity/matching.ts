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

import type { CapacityEntry, CapacityModel } from './model.js';

export interface FeasibilityResult {
  feasible: boolean;
  /** network uuid -> spare capacity after assignment (only networks in use) */
  spare: Map<string, number>;
  /** network that caused infeasibility (when feasible=false) */
  shortNetwork?: string;
  /** entries that could not be served */
  unservedEntries: CapacityEntry[];
  /** search bound was hit; result is best-effort, not exhaustive */
  approximate: boolean;
}

interface Demand {
  /** candidate mux uuids (deduped); one must be tuned to serve the demand */
  muxes: string[];
  entries: CapacityEntry[];
}

const MAX_BACKTRACK_STATES = 5000;

/**
 * Kuhn's augmenting-path bipartite matching. Each required tuning slot is
 * identified by the network it must be served on (a frontend can hold one
 * slot, and only on a network it can serve). Returns the matched count.
 */
function matchSlots(slotNetworks: string[], model: CapacityModel): number {
  const slotOf = new Map<number, number>(); // frontend index -> slot index

  const tryAssign = (slot: number, visited: Set<number>): boolean => {
    const net = slotNetworks[slot]!;
    for (let f = 0; f < model.frontends.length; f++) {
      if (visited.has(f) || !model.frontends[f]!.networks.has(net)) continue;
      visited.add(f);
      const current = slotOf.get(f);
      if (current === undefined || tryAssign(current, visited)) {
        slotOf.set(f, slot);
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (let s = 0; s < slotNetworks.length; s++) {
    if (tryAssign(s, new Set())) matched++;
  }
  return matched;
}

function slotNetworksFor(muxes: string[], model: CapacityModel): string[] {
  return muxes
    .map((m) => model.muxNetwork.get(m))
    .filter((n): n is string => n !== undefined);
}

/**
 * Feasibility of serving all entries in one overlap window.
 *
 * Demands = distinct channels (entries on the same channel share a mux and
 * therefore a tuner for free). Two demands may also share a mux when their
 * candidate sets intersect — handled by bounded backtracking over the
 * channel->mux choice, with bipartite matching (mux->frontend) at each leaf.
 * IPTV demands consume per-network stream slots instead of frontends.
 */
export function checkWindow(entries: CapacityEntry[], model: CapacityModel): FeasibilityResult {
  const byChannel = new Map<string, CapacityEntry[]>();
  for (const e of entries) {
    const list = byChannel.get(e.channelUuid) ?? [];
    list.push(e);
    byChannel.set(e.channelUuid, list);
  }

  const demands: Demand[] = [];
  const unservedEntries: CapacityEntry[] = [];
  const iptvUse = new Map<string, CapacityEntry[][]>(); // network -> channel groups

  for (const [channelUuid, chEntries] of byChannel) {
    const muxes = model.channelMuxes.get(channelUuid) ?? [];
    if (muxes.length === 0) {
      unservedEntries.push(...chEntries);
      continue;
    }
    const dvbMuxes = muxes.filter((m) => {
      const net = model.muxNetwork.get(m);
      return net !== undefined && !model.iptvMaxStreams.has(net);
    });
    const iptvNets = [
      ...new Set(
        muxes
          .map((m) => model.muxNetwork.get(m))
          .filter((n): n is string => n !== undefined && model.iptvMaxStreams.has(n)),
      ),
    ];
    if (dvbMuxes.length > 0) {
      demands.push({ muxes: [...new Set(dvbMuxes)], entries: chEntries });
    } else if (iptvNets.length > 0) {
      const net = iptvNets[0]!;
      const groups = iptvUse.get(net) ?? [];
      groups.push(chEntries);
      iptvUse.set(net, groups);
    }
  }

  const spare = new Map<string, number>();
  let shortNetwork: string | undefined;

  // IPTV capacity: distinct channels per network vs max_streams
  for (const [net, groups] of iptvUse) {
    const max = model.iptvMaxStreams.get(net) ?? 0;
    spare.set(net, Math.max(0, max - groups.length));
    if (groups.length > max) {
      shortNetwork = net;
      for (const g of groups.slice(max)) unservedEntries.push(...g);
    }
  }

  // DVB: backtrack over channel->mux choices; matching at each leaf
  let states = 0;
  let bestMatched = -1;
  let bestChoice: string[] = [];

  const search = (idx: number, chosen: string[]): boolean => {
    if (states++ > MAX_BACKTRACK_STATES) return false;
    if (idx === demands.length) {
      const distinct = [...new Set(chosen)];
      const matched = matchSlots(slotNetworksFor(distinct, model), model);
      if (matched > bestMatched) {
        bestMatched = matched;
        bestChoice = [...chosen];
      }
      return matched === distinct.length;
    }
    // prefer muxes already chosen (sharing) before new ones
    const cands = [...demands[idx]!.muxes].sort(
      (a, b) => Number(chosen.includes(b)) - Number(chosen.includes(a)),
    );
    for (const mux of cands) {
      chosen.push(mux);
      if (search(idx + 1, chosen)) return true;
      chosen.pop();
      if (states > MAX_BACKTRACK_STATES) return false;
    }
    return false;
  };

  const solved = demands.length === 0 ? true : search(0, []);
  const approximate = states > MAX_BACKTRACK_STATES;
  const distinctMuxes = [...new Set(bestChoice)];

  if (!solved && demands.length > 0) {
    const overflow = Math.max(0, distinctMuxes.length - Math.max(0, bestMatched));
    if (overflow > 0) {
      for (const d of demands.slice(demands.length - overflow)) {
        unservedEntries.push(...d.entries);
      }
    }
    const slotNets = slotNetworksFor(distinctMuxes, model);
    shortNetwork = shortNetwork ?? slotNets[slotNets.length - 1];
  }

  // spare per used DVB network: marginal test — can the solved assignment
  // plus one extra slot on this network still be matched? (correct even when
  // frontends serve multiple networks, unlike naive count subtraction)
  const slotNets = slotNetworksFor(distinctMuxes, model);
  const usedNetworks = new Set(slotNets);
  for (const net of usedNetworks) {
    let extra = 0;
    while (
      extra < 4 &&
      matchSlots([...slotNets, ...Array(extra + 1).fill(net)], model) ===
        slotNets.length + extra + 1
    ) {
      extra++;
    }
    spare.set(net, extra);
  }

  return {
    feasible: solved && unservedEntries.length === 0,
    spare,
    shortNetwork,
    unservedEntries,
    approximate,
  };
}
