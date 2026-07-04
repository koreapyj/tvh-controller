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
  DvrState,
  TvhDvrEntry,
  TvhEpgEvent,
  TvhHardwareNode,
  TvhInputStatus,
  TvhSubscription,
} from '@tvhc/shared';
import type { InstanceConfig, AppConfig } from '../config.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache, TopologySnapshot } from '../state/instanceCache.js';
import { RcloneRcClient } from '../uploads/rcloneRc.js';
import { TvhClient } from './client.js';
import { CometClient, type CometNotification } from './comet.js';

function dvrChanged(prev: TvhDvrEntry[], next: TvhDvrEntry[]): boolean {
  if (prev.length !== next.length) return true;
  const prevByUuid = new Map(prev.map((e) => [e.uuid, e]));
  return next.some((e) => {
    const p = prevByUuid.get(e.uuid);
    return (
      !p ||
      p.status !== e.status ||
      p.sched_status !== e.sched_status ||
      p.start_real !== e.start_real ||
      p.stop_real !== e.stop_real ||
      p.filesize !== e.filesize ||
      p.errors !== e.errors
    );
  });
}

/** meaningful EPG change for the guide view (ignores churn like description edits) */
function epgChanged(prev: TvhEpgEvent[], next: TvhEpgEvent[]): boolean {
  if (prev.length !== next.length) return true;
  const prevById = new Map(prev.map((e) => [e.eventId, e]));
  return next.some((e) => {
    const p = prevById.get(e.eventId);
    return (
      !p ||
      p.start !== e.start ||
      p.stop !== e.stop ||
      p.title !== e.title ||
      p.dvrUuid !== e.dvrUuid ||
      p.dvrState !== e.dvrState
    );
  });
}


export class InstancePoller {
  readonly client: TvhClient;
  /** one live handle per loop/trigger, overwritten on reschedule (never grows) */
  private timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private lastStatusKey = '';
  private comet: CometClient | null = null;
  private statusPublishTimer: NodeJS.Timeout | null = null;
  private dvrPollPending = false;
  private autorecPollPending = false;
  private epgPollPending = false;
  /** subscribers notified when upcoming entries or topology changed */
  onCapacityInputsChanged: (() => void) | null = null;
  onAutorecsChanged: (() => void) | null = null;

  private readonly rclone: RcloneRcClient | null;

  constructor(
    readonly instance: InstanceConfig,
    private readonly cache: InstanceCache,
    private readonly bus: EventBus,
    private readonly intervals: AppConfig['pollIntervals'],
  ) {
    this.client = new TvhClient(instance.url, instance.username, instance.password);
    this.rclone = instance.rclone ? new RcloneRcClient(instance.rclone) : null;
  }

  /**
   * Detect the tvheadend host's UTC offset via the co-located rclone rcd
   * (autorec times are interpreted in the SERVER's zone, which can differ
   * from the broadcast EIT zone). A configured serverOffset wins.
   */
  private async detectServerOffset(): Promise<void> {
    if (this.instance.serverOffsetMinutes !== undefined || !this.rclone) return;
    const offset = await this.rclone.serverUtcOffsetMinutes();
    if (offset === null) return;
    const snap = this.cache.get(this.instance.id);
    if (snap.summary.serverOffsetMinutes !== offset) {
      snap.summary.serverOffsetMinutes = offset;
      this.bus.publish({ type: 'instance-status', data: { ...snap.summary } });
    }
  }

  start(): void {
    const jitter = Math.random() * 2000;
    this.schedule('dvr', () => this.pollDvrAndStatus(), this.intervals.dvr, jitter);
    this.schedule('autorec', () => this.pollAutorecs(), this.intervals.autorec, jitter + 500);
    this.schedule('topology', () => this.pollTopology(), this.intervals.topology, jitter + 1000);
    this.schedule('epg', () => this.pollEpg(), this.intervals.epg, jitter + 1500);

    // comet push (same channel the tvheadend web UI uses) drives sub-second
    // input/subscription updates and triggers DVR/autorec/EPG refreshes;
    // periodic polling stays only as the fallback/consistency pass. The comet
    // upgrade is authenticated (Basic→Digest) so it works for all instances.
    this.comet = new CometClient(
      this.instance.url,
      (n) => this.handleComet(n),
      undefined,
      this.instance.username,
      this.instance.password,
    );
    this.comet.start();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.comet?.stop();
    if (this.statusPublishTimer) clearTimeout(this.statusPublishTimer);
  }

  // ---------- comet push handling ----------

  private handleComet(n: CometNotification): void {
    const cls = n.notificationClass;
    if (cls === 'input_status') {
      this.mergeInput(n);
    } else if (cls === 'subscriptions') {
      this.mergeSubscription(n);
    } else if (cls === 'dvrentry') {
      this.triggerDvrPoll();
      // a new/removed recording also flips an EPG event's dvrState
      this.triggerEpgPoll();
    } else if (cls.includes('autorec')) {
      this.triggerAutorecPoll();
    } else if (cls === 'epg') {
      this.triggerEpgPoll();
    }
  }

  /** input_status fires once per second per active input with a full entry */
  private mergeInput(n: CometNotification): void {
    const entry = n as unknown as TvhInputStatus;
    if (!entry.uuid) return;
    const snap = this.cache.get(this.instance.id);
    const idx = snap.inputs.findIndex((i) => i.uuid === entry.uuid);
    if (idx === -1) snap.inputs = [...snap.inputs, entry];
    else snap.inputs = snap.inputs.map((i, x) => (x === idx ? entry : i));
    this.scheduleStatusPublish();
  }

  private mergeSubscription(n: CometNotification): void {
    const entry = n as unknown as TvhSubscription;
    if (entry.id === undefined) return;
    const snap = this.cache.get(this.instance.id);
    const idx = snap.subscriptions.findIndex((s) => s.id === entry.id);
    if (idx === -1) snap.subscriptions = [...snap.subscriptions, entry];
    else snap.subscriptions = snap.subscriptions.map((s, x) => (x === idx ? entry : s));
    this.scheduleStatusPublish();
  }

  /** batch the per-second comet updates into one SSE event per second */
  private scheduleStatusPublish(): void {
    if (this.statusPublishTimer || this.stopped) return;
    this.statusPublishTimer = setTimeout(() => {
      this.statusPublishTimer = null;
      const snap = this.cache.get(this.instance.id);
      this.lastStatusKey = JSON.stringify([snap.inputs, snap.subscriptions]);
      this.bus.publish({
        type: 'status',
        data: {
          instanceId: this.instance.id,
          inputs: snap.inputs,
          subscriptions: snap.subscriptions,
        },
      });
    }, 1000);
  }

  /** re-poll DVR grids shortly after a dvrentry notification (coalesced) */
  private triggerDvrPoll(): void {
    if (this.dvrPollPending || this.stopped) return;
    this.dvrPollPending = true;
    this.timers.set(
      'dvr-trigger',
      setTimeout(() => {
        this.dvrPollPending = false;
        void this.pollDvrAndStatus().catch(() => {});
      }, 1500),
    );
  }

  private triggerAutorecPoll(): void {
    if (this.autorecPollPending || this.stopped) return;
    this.autorecPollPending = true;
    this.timers.set(
      'autorec-trigger',
      setTimeout(() => {
        this.autorecPollPending = false;
        void this.pollAutorecs().catch(() => {});
      }, 1500),
    );
  }

  /** re-poll the EPG grid shortly after a comet `epg`/`dvrentry` notification */
  private triggerEpgPoll(): void {
    if (this.epgPollPending || this.stopped) return;
    this.epgPollPending = true;
    this.timers.set(
      'epg-trigger',
      setTimeout(() => {
        this.epgPollPending = false;
        void this.pollEpg().catch(() => {});
      }, 1500),
    );
  }

  private schedule(
    key: string,
    fn: () => Promise<void>,
    interval: number,
    initialDelay: number,
  ): void {
    const run = async () => {
      if (this.stopped) return;
      try {
        await fn();
        this.markReachable(null);
      } catch (err) {
        this.markReachable(err instanceof Error ? err.message : String(err));
      }
      if (!this.stopped) {
        this.timers.set(key, setTimeout(run, interval));
      }
    };
    this.timers.set(key, setTimeout(run, initialDelay));
  }

  private markReachable(error: string | null): void {
    const snap = this.cache.get(this.instance.id);
    const wasReachable = snap.summary.reachable;
    snap.summary.reachable = error === null;
    snap.summary.error = error;
    snap.summary.lastPollAt = new Date().toISOString();
    if (wasReachable !== snap.summary.reachable) {
      this.bus.publish({ type: 'instance-status', data: { ...snap.summary } });
    }
  }

  async pollDvrAndStatus(): Promise<void> {
    const snap = this.cache.get(this.instance.id);
    const [upcoming, finished, failed, inputs, subscriptions] = await Promise.all([
      this.client.dvrUpcoming(),
      this.client.dvrFinished(),
      this.client.dvrFailed(),
      this.client.statusInputs(),
      this.client.statusSubscriptions(),
    ]);

    if (snap.summary.version === null) {
      try {
        const info = await this.client.serverInfo();
        snap.summary.version = info.sw_version ?? null;
      } catch {
        // serverinfo is best-effort; older versions may not expose it
      }
    }

    const changed: DvrState[] = [];
    if (dvrChanged(snap.upcoming, upcoming)) changed.push('upcoming');
    if (dvrChanged(snap.finished, finished)) changed.push('finished');
    if (dvrChanged(snap.failed, failed)) changed.push('failed');

    const statusKey = JSON.stringify([inputs, subscriptions]);
    const statusChanged = statusKey !== this.lastStatusKey;
    this.lastStatusKey = statusKey;

    const upcomingChanged = changed.includes('upcoming');
    snap.upcoming = upcoming;
    snap.finished = finished;
    snap.failed = failed;
    snap.inputs = inputs;
    snap.subscriptions = subscriptions;

    for (const state of changed) {
      this.bus.publish({ type: 'recordings', data: { instanceId: this.instance.id, state } });
    }
    if (statusChanged) {
      this.bus.publish({
        type: 'status',
        data: { instanceId: this.instance.id, inputs, subscriptions },
      });
    }
    if (upcomingChanged) this.onCapacityInputsChanged?.();
  }

  async pollAutorecs(): Promise<void> {
    const snap = this.cache.get(this.instance.id);
    const autorecs = await this.client.autorecGrid();
    const prevKey = JSON.stringify(snap.autorecs);
    snap.autorecs = autorecs;
    if (prevKey !== JSON.stringify(autorecs)) {
      this.onAutorecsChanged?.();
    }
  }

  /** refresh the EPG cache; comet `epg` push drives this between polls */
  async pollEpg(): Promise<void> {
    const snap = this.cache.get(this.instance.id);
    const now = Math.floor(Date.now() / 1000);
    // server-side filter to currently-airing + future events so we don't fetch
    // broadcasts that already ended; no forward date window and no count cap —
    // page through everything tvheadend holds
    const epg = await this.client.epgEventsAll({
      filter: [{ field: 'stop', type: 'numeric', comparison: 'gt', value: now }],
    });
    const changed = epgChanged(snap.epg, epg);
    snap.epg = epg;
    if (changed) this.bus.publish({ type: 'epg', data: { instanceId: this.instance.id } });
  }

  /** the tree endpoint returns one level per call — walk it breadth-first */
  private async fetchHardwareTree(): Promise<TvhHardwareNode[]> {
    const walk = async (uuid: string, depth: number): Promise<TvhHardwareNode[]> => {
      if (depth > 4) return [];
      const nodes = await this.client.hardwareTreeLevel(uuid);
      for (const node of nodes) {
        const isLeaf = node.leaf === true || node.leaf === 1;
        if (!isLeaf && node.uuid) {
          node.children = await walk(node.uuid, depth + 1);
        }
      }
      return nodes;
    };
    return walk('root', 0);
  }

  async pollTopology(): Promise<void> {
    const snap = this.cache.get(this.instance.id);
    void this.detectServerOffset();
    const [channels, tags, dvrConfigs, muxes, services, networks, hardware] = await Promise.all([
      this.client.channelGrid(),
      this.client.channelTagGrid(),
      this.client.dvrConfigGrid(),
      this.client.muxGrid(),
      this.client.serviceGrid(),
      this.client.networkGrid(),
      this.fetchHardwareTree().catch(() => []),
    ]);

    const frontendNetworks = new Map<string, string[]>();
    const collectFrontends = (nodes: typeof hardware): void => {
      for (const node of nodes) {
        const disabled = node.params?.some((p) => p.id === 'enabled' && p.value === false);
        if (!disabled && (node.class?.includes('frontend') || node.class?.includes('input'))) {
          frontendNetworks.set(node.uuid, []);
        }
        if (node.children) collectFrontends(node.children);
      }
    };
    collectFrontends(hardware);
    await Promise.all(
      [...frontendNetworks.keys()].map(async (uuid) => {
        try {
          const nets = await this.client.inputNetworkList(uuid);
          frontendNetworks.set(uuid, nets.map((n) => n.key));
        } catch {
          frontendNetworks.delete(uuid);
        }
      }),
    );

    // defensive: normalize channel numbers to strings at the single ingestion
    // choke point — older tvheadend variants (and our mock) may still emit
    // numerics even though real tvheadend reports them as strings (e.g. "9.1")
    const normalizedChannels = channels.map((c) => ({
      ...c,
      number: c.number == null ? undefined : String(c.number),
    }));

    const topology: TopologySnapshot = {
      channels: normalizedChannels,
      tags,
      dvrConfigs,
      muxes,
      services,
      networks,
      hardware,
      frontendNetworks,
      fetchedAt: Date.now(),
    };
    snap.topology = topology;
    this.onCapacityInputsChanged?.();
  }
}
