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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { InstanceSummary, RestreamChannelWithStatus, RestreamerNodeStatus, SwitcherNodeStatus } from '@tvhc/shared';
import {
  applyRestreamChannel,
  applyRestreamerNode,
  applyRestreamerSwitcher,
  clearRestreamChannelLive,
  instances,
  restreamChannelLive,
  restreamerNodeKey,
  restreamerNodes,
  restreamerSwitchers,
  seedRestreamers,
  tvhInstances,
} from './stores.js';

function node(over: Partial<RestreamerNodeStatus> = {}): RestreamerNodeStatus {
  return {
    instanceId: 'tokyo',
    nodeId: 'node-a',
    url: 'http://node-a:5580',
    serveUrl: null,
    reachable: true,
    error: null,
    lastPollAt: null,
    version: '1.0.0',
    uptimeSec: 60,
    apiVersionSupported: true,
    desiredRevision: null,
    pendingPush: false,
    probes: null,
    sessions: [],
    sourcesHash: null,
    sources: null,
    capabilities: null,
    templates: null,
    maxSessions: null,
    ...over,
  };
}

function switcher(over: Partial<SwitcherNodeStatus> = {}): SwitcherNodeStatus {
  return {
    switcherId: 'sw1',
    url: 'http://sw1:5581',
    publicUrl: 'https://tv.example',
    reachable: true,
    error: null,
    lastPollAt: null,
    version: '1.0.0',
    pendingPush: false,
    channels: [],
    ...over,
  };
}

beforeEach(() => {
  restreamerNodes.set({});
  restreamerSwitchers.set({});
});

describe('restreamerNodeKey', () => {
  it('is instanceId/nodeId (the controller nodeKey shape)', () => {
    expect(restreamerNodeKey({ instanceId: 'tokyo', nodeId: 'node-a' })).toBe('tokyo/node-a');
  });
});

describe('restreamer store event merge', () => {
  it('an SSE node event inserts under its key and a later one replaces it', () => {
    applyRestreamerNode(node());
    applyRestreamerNode(node({ instanceId: 'osaka' }));
    expect(Object.keys(get(restreamerNodes)).sort()).toEqual(['osaka/node-a', 'tokyo/node-a']);

    applyRestreamerNode(node({ reachable: false, error: 'boom' }));
    const m = get(restreamerNodes);
    expect(Object.keys(m)).toHaveLength(2);
    expect(m['tokyo/node-a']).toMatchObject({ reachable: false, error: 'boom' });
    expect(m['osaka/node-a']).toMatchObject({ reachable: true });
  });

  it('same instance, different node ids stay distinct entries', () => {
    applyRestreamerNode(node({ nodeId: 'node-a' }));
    applyRestreamerNode(node({ nodeId: 'node-b' }));
    expect(Object.keys(get(restreamerNodes)).sort()).toEqual(['tokyo/node-a', 'tokyo/node-b']);
  });

  it('switcher events merge by switcherId', () => {
    applyRestreamerSwitcher(switcher());
    applyRestreamerSwitcher(switcher({ switcherId: 'sw2' }));
    applyRestreamerSwitcher(switcher({ pendingPush: true }));
    const m = get(restreamerSwitchers);
    expect(Object.keys(m).sort()).toEqual(['sw1', 'sw2']);
    expect(m.sw1).toMatchObject({ pendingPush: true });
    expect(m.sw2).toMatchObject({ pendingPush: false });
  });

  it('seedRestreamers replaces both maps wholesale (page-load fetch)', () => {
    applyRestreamerNode(node({ instanceId: 'stale' }));
    applyRestreamerSwitcher(switcher({ switcherId: 'stale' }));
    seedRestreamers([node(), node({ nodeId: 'node-b' })], [switcher()]);
    expect(Object.keys(get(restreamerNodes)).sort()).toEqual(['tokyo/node-a', 'tokyo/node-b']);
    expect(Object.keys(get(restreamerSwitchers))).toEqual(['sw1']);
  });
});

function channel(over: Partial<RestreamChannelWithStatus> = {}): RestreamChannelWithStatus {
  return {
    id: 'ch1',
    slug: 'at-x',
    channelName: 'AT-X',
    channelNumber: '9.1',
    profileId: 'p1',
    enabled: true,
    comment: null,
    playlistIds: [],
    updatedAt: '',
    profileName: 'hevc-3M',
    placements: [],
    failover: null,
    failoverBlocked: null,
    activePlacementId: null,
    lastSwitch: null,
    playbackUrl: null,
    onDemandStopAt: null,
    ...over,
  };
}

describe('restreamChannelLive', () => {
  beforeEach(() => {
    restreamChannelLive.set({});
  });

  it('an SSE channel event inserts under its id and a later one replaces it', () => {
    applyRestreamChannel(channel({ id: 'ch1' }));
    applyRestreamChannel(channel({ id: 'ch2' }));
    expect(Object.keys(get(restreamChannelLive)).sort()).toEqual(['ch1', 'ch2']);

    applyRestreamChannel(channel({ id: 'ch1', enabled: false }));
    const m = get(restreamChannelLive);
    expect(Object.keys(m)).toHaveLength(2);
    expect(m.ch1).toMatchObject({ enabled: false });
    expect(m.ch2).toMatchObject({ enabled: true });
  });

  it('clearRestreamChannelLive drops every live overlay', () => {
    applyRestreamChannel(channel({ id: 'ch1' }));
    applyRestreamChannel(channel({ id: 'ch2' }));
    clearRestreamChannelLive();
    expect(get(restreamChannelLive)).toEqual({});
  });
});

function instance(over: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    id: 'tyo1',
    name: 'Tokyo 1',
    url: 'http://tyo1',
    hasTvh: true,
    reachable: true,
    version: '4.3',
    lastPollAt: null,
    error: null,
    serverOffsetMinutes: null,
    ...over,
  };
}

describe('tvhInstances', () => {
  afterEach(() => {
    instances.set([]);
  });

  it('filters out instances with hasTvh: false', () => {
    instances.set([
      instance({ id: 'tyo1', hasTvh: true }),
      instance({ id: 'rs1', hasTvh: false, url: null }),
      instance({ id: 'osk1', hasTvh: true }),
    ]);
    expect(get(tvhInstances).map((i) => i.id)).toEqual(['tyo1', 'osk1']);
  });

  it('is reactive to instances.set()', () => {
    instances.set([instance({ id: 'tyo1', hasTvh: true })]);
    expect(get(tvhInstances).map((i) => i.id)).toEqual(['tyo1']);

    instances.set([
      instance({ id: 'tyo1', hasTvh: true }),
      instance({ id: 'rs1', hasTvh: false, url: null }),
    ]);
    expect(get(tvhInstances).map((i) => i.id)).toEqual(['tyo1']);
  });
});
