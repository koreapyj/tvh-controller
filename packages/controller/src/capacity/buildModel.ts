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

import type { TopologySnapshot } from '../state/instanceCache.js';
import type { CapacityModel } from './model.js';

/**
 * Instance topology snapshot -> pure CapacityModel.
 * channel -> services (channel grid `services`), service -> mux
 * (`multiplex_uuid`), mux -> network, frontend -> serveable networks
 * (input/network_list), IPTV networks -> max_streams.
 */
export function buildModel(topo: TopologySnapshot): CapacityModel {
  const serviceMux = new Map<string, string>();
  for (const s of topo.services) {
    const mux = s.multiplex_uuid ?? s.multiplex;
    if (mux) serviceMux.set(s.uuid, mux);
  }

  const channelMuxes = new Map<string, string[]>();
  for (const ch of topo.channels) {
    const muxes = [
      ...new Set(
        (ch.services ?? [])
          .map((svc) => serviceMux.get(svc))
          .filter((m): m is string => m !== undefined),
      ),
    ];
    channelMuxes.set(ch.uuid, muxes);
  }

  const muxNetwork = new Map<string, string>();
  for (const m of topo.muxes) {
    const net = m.network_uuid ?? m.network;
    if (net) muxNetwork.set(m.uuid, net);
  }

  const networkNames = new Map<string, string>();
  const iptvMaxStreams = new Map<string, number>();
  for (const n of topo.networks) {
    networkNames.set(n.uuid, n.networkname ?? n.uuid);
    if (typeof n.max_streams === 'number' && n.max_streams > 0) {
      iptvMaxStreams.set(n.uuid, n.max_streams);
    }
  }

  const frontends = [...topo.frontendNetworks.entries()]
    .filter(([, nets]) => nets.length > 0)
    .map(([uuid, nets]) => ({
      uuid,
      networks: new Set(nets.filter((n) => !iptvMaxStreams.has(n))),
    }))
    .filter((f) => f.networks.size > 0);

  return { channelMuxes, muxNetwork, networkNames, frontends, iptvMaxStreams };
}
