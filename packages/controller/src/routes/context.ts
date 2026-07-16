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

import type { AppConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { RestreamerClient } from '../restreamer/client.js';
import type { RestreamerPoller } from '../restreamer/poller.js';
import type { RestreamerService } from '../restreamer/service.js';
import type { EventLog } from '../state/eventLog.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import type { SyncEngine } from '../sync/engine.js';
import type { TvhClient } from '../tvh/client.js';
import type { InstancePoller } from '../tvh/poller.js';
import type { UploadDispatcher } from '../uploads/dispatcher.js';
import type { UploadLedger } from '../uploads/ledger.js';
import { httpError } from '../util/httpError.js';

export interface AppContext {
  config: AppConfig;
  /** null when running without a database (overview-only mode) */
  db: Db | null;
  cache: InstanceCache;
  bus: EventBus;
  eventLog: EventLog;
  pollers: Map<string, InstancePoller>;
  /** one authenticated HTTP client per configured tvheadend instance (logo proxy) */
  tvhHttp: Map<string, TvhClient>;
  sync: SyncEngine | null;
  ledger: UploadLedger | null;
  dispatcher: UploadDispatcher | null;
  /** null without a database — node status stays visible, mutations 503 */
  restreamer: RestreamerService | null;
  /** keyed by nodeKey(instanceId, nodeId); empty when no nodes are configured */
  restreamerClients: Map<string, RestreamerClient>;
  restreamerPollers: RestreamerPoller[];
}

// Re-exported so existing route handlers can keep importing httpError from
// './context.js'; the implementation lives in util/httpError.ts (a neutral
// location) so non-routes layers like sync/engine.ts can use it too.
export { httpError };

export function requireDb<T>(value: T | null, feature: string): T {
  if (value === null) {
    throw httpError(503, `${feature} requires a database — set "database" in config.yaml`);
  }
  return value;
}
