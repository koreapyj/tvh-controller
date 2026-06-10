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

/** Pure data model for tuner capacity analysis. No I/O in this module. */

export interface CapacityModel {
  /** channel uuid -> candidate mux uuids (any service of the channel) */
  channelMuxes: Map<string, string[]>;
  /** mux uuid -> network uuid */
  muxNetwork: Map<string, string>;
  /** network uuid -> display name */
  networkNames: Map<string, string>;
  /** DVB frontends; each can tune one mux at a time on its serveable networks */
  frontends: Array<{ uuid: string; networks: Set<string> }>;
  /** IPTV networks: capacity = max_streams, no physical frontends involved */
  iptvMaxStreams: Map<string, number>;
}

export interface CapacityEntry {
  uuid: string;
  channelUuid: string;
  title: string;
  /** start including pre-padding (start_real) */
  start: number;
  /** stop including post-padding (stop_real) */
  stop: number;
}

export interface WindowReport {
  start: number;
  stop: number;
  level: 'conflict' | 'low-margin';
  entryUuids: string[];
  /** network short on capacity */
  networkUuid: string;
  networkName: string;
  detail: string;
}
