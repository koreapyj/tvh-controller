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

import type {
  TvhAutorecRule,
  TvhChannel,
  TvhChannelTag,
  TvhDvrConfig,
  TvhDvrEntry,
  TvhEpgEvent,
  TvhHardwareNode,
  TvhInputStatus,
  TvhMux,
  TvhNetwork,
  TvhService,
  TvhSubscription,
  ConflictWindow,
  InstanceSummary,
} from '@tvhc/shared';

export interface TopologySnapshot {
  channels: TvhChannel[];
  tags: TvhChannelTag[];
  dvrConfigs: TvhDvrConfig[];
  muxes: TvhMux[];
  services: TvhService[];
  networks: TvhNetwork[];
  hardware: TvhHardwareNode[];
  /** frontend uuid -> network uuids it can serve */
  frontendNetworks: Map<string, string[]>;
  fetchedAt: number;
}

export interface InstanceSnapshot {
  summary: InstanceSummary;
  upcoming: TvhDvrEntry[];
  finished: TvhDvrEntry[];
  failed: TvhDvrEntry[];
  /** upcoming EPG broadcasts (bounded window), refreshed via comet push + slow poll */
  epg: TvhEpgEvent[];
  inputs: TvhInputStatus[];
  subscriptions: TvhSubscription[];
  autorecs: TvhAutorecRule[];
  topology: TopologySnapshot | null;
  conflicts: ConflictWindow[];
}

export function emptySnapshot(
  id: string,
  name: string,
  url: string,
  serverOffsetMinutes: number | null = null,
): InstanceSnapshot {
  return {
    summary: {
      id,
      name,
      url,
      reachable: false,
      version: null,
      lastPollAt: null,
      error: null,
      serverOffsetMinutes,
    },
    upcoming: [],
    finished: [],
    failed: [],
    epg: [],
    inputs: [],
    subscriptions: [],
    autorecs: [],
    topology: null,
    conflicts: [],
  };
}

export class InstanceCache {
  private readonly snapshots = new Map<string, InstanceSnapshot>();

  init(id: string, name: string, url: string, serverOffsetMinutes: number | null = null): void {
    this.snapshots.set(id, emptySnapshot(id, name, url, serverOffsetMinutes));
  }

  get(id: string): InstanceSnapshot {
    const snap = this.snapshots.get(id);
    if (!snap) throw new Error(`unknown instance "${id}"`);
    return snap;
  }

  has(id: string): boolean {
    return this.snapshots.has(id);
  }

  all(): InstanceSnapshot[] {
    return [...this.snapshots.values()];
  }

  ids(): string[] {
    return [...this.snapshots.keys()];
  }
}
