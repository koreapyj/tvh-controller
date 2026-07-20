/*
 * In-memory switcher hub at the SwitcherHubLike boundary SwitcherSync and
 * FailoverSync use. No network: records every broadcast doc and switch
 * command, with a settable connected-replica count (0 = no replica receives
 * a switch). seedReplicaStatus writes a well-formed aggregate status entry
 * at SWITCHER_CACHE_KEY, standing in for the real hub's status merge.
 */

import type {
  EraAnchor,
  SwitchReason,
  SwitcherChannelStatus,
  SwitcherDesiredState,
  SwitcherNodeStatus,
} from '@tvhc/shared';
import { SWITCHER_CACHE_KEY, type SwitcherHubLike } from '../../src/restreamer/switcherHubTypes.js';
import type { InstanceCache } from '../../src/state/instanceCache.js';

export class FakeSwitcherHub implements SwitcherHubLike {
  docs: SwitcherDesiredState[] = [];
  switches: Array<{ slug: string; upstreamId: string; era?: EraAnchor; reason?: SwitchReason }> = [];
  connected = 1;

  broadcastDoc(doc: SwitcherDesiredState): void {
    this.docs.push(structuredClone(doc));
  }

  broadcastSwitch(
    slug: string,
    upstreamId: string,
    opts?: { era?: EraAnchor; reason?: SwitchReason },
  ): number {
    if (this.connected === 0) return 0;
    this.switches.push({ slug, upstreamId, era: opts?.era, reason: opts?.reason });
    return this.connected;
  }

  connectedCount(): number {
    return this.connected;
  }

  lastDoc(): SwitcherDesiredState | null {
    return this.docs[this.docs.length - 1] ?? null;
  }
}

/**
 * Seed (or merge into) the aggregate switcher status entry. Channels merge
 * by slug — a re-seed of an existing slug replaces that channel's entry,
 * keeping the rest.
 */
export function seedReplicaStatus(
  cache: InstanceCache,
  opts: {
    channels: SwitcherChannelStatus[];
    publicUrl?: string;
    reachable?: boolean;
    replicaCount?: number;
  },
): void {
  const existing = cache.switchers.get(SWITCHER_CACHE_KEY);
  const merged = new Map<string, SwitcherChannelStatus>(
    (existing?.channels ?? []).map((c) => [c.slug, c]),
  );
  for (const c of opts.channels) merged.set(c.slug, c);
  const reachable = opts.reachable ?? true;
  const status: SwitcherNodeStatus = {
    switcherId: SWITCHER_CACHE_KEY,
    url: 'ws',
    publicUrl: opts.publicUrl ?? existing?.publicUrl ?? 'https://tv.example',
    reachable,
    error: reachable ? null : 'no switcher replicas connected',
    lastPollAt: new Date().toISOString(),
    version: '1.0.0',
    pendingPush: false,
    channels: [...merged.values()],
    replicaCount: opts.replicaCount ?? (reachable ? 1 : 0),
  };
  cache.switchers.set(SWITCHER_CACHE_KEY, status);
}
