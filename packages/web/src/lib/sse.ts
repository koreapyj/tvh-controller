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
  ConflictWindow,
  DriftItem,
  InstanceSummary,
  RestreamChannelWithStatus,
  RestreamerNodeStatus,
  SwitcherNodeStatus,
  TvhInputStatus,
  TvhSubscription,
  UploadJob,
} from '@tvhc/shared';
import {
  applyRestreamChannel,
  applyRestreamerNode,
  applyRestreamerSwitcher,
  conflictsByInstance,
  driftItems,
  epgTick,
  instances,
  recordingsTick,
  sseConnected,
  statusByInstance,
  uploadEvent,
} from './stores.js';

let source: EventSource | null = null;

export function connectSse(): void {
  if (source) return;
  source = new EventSource('/api/events');

  source.onopen = () => sseConnected.set(true);
  source.onerror = () => sseConnected.set(false); // EventSource auto-reconnects

  source.addEventListener('instance-status', (e) => {
    const summary = JSON.parse(e.data) as InstanceSummary;
    instances.update((list) => {
      const idx = list.findIndex((i) => i.id === summary.id);
      if (idx === -1) return [...list, summary];
      const next = [...list];
      next[idx] = summary;
      return next;
    });
  });

  source.addEventListener('status', (e) => {
    const { instanceId, inputs, subscriptions } = JSON.parse(e.data) as {
      instanceId: string;
      inputs: TvhInputStatus[];
      subscriptions: TvhSubscription[];
    };
    statusByInstance.update((m) => ({ ...m, [instanceId]: { inputs, subscriptions } }));
  });

  source.addEventListener('recordings', (e) => {
    const { instanceId } = JSON.parse(e.data) as { instanceId: string };
    recordingsTick.update((t) => ({ instanceId, n: t.n + 1 }));
  });

  source.addEventListener('epg', () => {
    epgTick.update((n) => n + 1);
  });

  source.addEventListener('conflicts', (e) => {
    const { instanceId, windows } = JSON.parse(e.data) as {
      instanceId: string;
      windows: ConflictWindow[];
    };
    conflictsByInstance.update((m) => ({ ...m, [instanceId]: windows }));
  });

  source.addEventListener('drift', (e) => {
    const { items } = JSON.parse(e.data) as { items: DriftItem[] };
    driftItems.set(items);
  });

  source.addEventListener('upload-progress', (e) => {
    uploadEvent.set(JSON.parse(e.data) as UploadJob);
  });

  source.addEventListener('restreamer', (e) => {
    applyRestreamerNode(JSON.parse(e.data) as RestreamerNodeStatus);
  });

  source.addEventListener('restreamer-switcher', (e) => {
    applyRestreamerSwitcher(JSON.parse(e.data) as SwitcherNodeStatus);
  });

  source.addEventListener('restreamer-channel', (e) => {
    applyRestreamChannel(JSON.parse(e.data) as RestreamChannelWithStatus);
  });
}
