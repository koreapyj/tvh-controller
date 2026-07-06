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

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { initDb } from './db/db.js';
import { ConflictService } from './capacity/service.js';
import { registerEpgRoutes } from './routes/epg.js';
import { registerEventRoutes } from './routes/events.js';
import { registerInstanceRoutes } from './routes/instances.js';
import { registerRecordingsRoutes } from './routes/recordings.js';
import { registerRestreamerRoutes } from './routes/restreamer.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerUnifiedRoutes } from './routes/unified.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { RestreamerClient, SwitcherClient } from './restreamer/client.js';
import { RestreamerPoller, SwitcherPoller } from './restreamer/poller.js';
import { RestreamerService, nodeKey } from './restreamer/service.js';
import type { AppContext } from './routes/context.js';
import { EventBus } from './state/events.js';
import { InstanceCache } from './state/instanceCache.js';
import { SyncEngine } from './sync/engine.js';
import { TvhClient } from './tvh/client.js';
import { InstancePoller } from './tvh/poller.js';
import { AutoUploader } from './uploads/autoUpload.js';
import { UploadDispatcher } from './uploads/dispatcher.js';
import { UploadLedger } from './uploads/ledger.js';

async function main(): Promise<void> {
  // a transient failure (database connection drop, unreachable instance)
  // must degrade, not kill the singleton controller
  process.on('unhandledRejection', (err) => {
    console.error('unhandled rejection (continuing):', err);
  });
  process.on('uncaughtException', (err) => {
    console.error('uncaught exception (continuing):', err);
  });

  const config = loadConfig();
  const db = config.databaseUrl ? await initDb(config.databaseUrl) : null;
  if (!db) {
    console.warn('no database configured — running without persistence: rule sync and uploads are disabled');
  }

  const cache = new InstanceCache();
  const bus = new EventBus();
  const conflicts = new ConflictService(cache, bus);
  const pollers = new Map<string, InstancePoller>();

  for (const inst of config.instances) {
    // tvh-less instances (url: null) get a cache snapshot — the UI needs them
    // — but NO tvheadend machinery: no poller, no comet, no conflict recompute
    cache.init(inst.id, inst.name, inst.url, inst.serverOffsetMinutes ?? null);
    if (inst.url === null) continue;
    const poller = new InstancePoller(inst, cache, bus, config.pollIntervals);
    poller.onCapacityInputsChanged = () => conflicts.recompute(inst.id);
    pollers.set(inst.id, poller);
  }

  // authenticated tvheadend HTTP clients for the logo proxy — same creds the
  // pollers use, independent of the database (works in overview-only mode)
  const tvhHttp = new Map<string, TvhClient>();
  for (const inst of config.instances) {
    if (inst.url === null) continue; // tvh-less: the logo proxy 404s on a missing entry
    tvhHttp.set(inst.id, new TvhClient(inst.url, inst.username, inst.password));
  }

  const sync = db ? new SyncEngine(db, cache, pollers, bus) : null;
  if (sync) {
    for (const [, poller] of pollers) {
      poller.onAutorecsChanged = () =>
        void sync.publishDrift().catch((err) => console.error('drift publish failed:', err));
    }
  }

  // restreamer clients exist regardless of DB (status-only mode keeps the
  // node overview working); the service — and thus pushes — needs the DB
  const restreamerClients = new Map<string, RestreamerClient>();
  for (const inst of config.instances) {
    for (const node of inst.restreamer?.nodes ?? []) {
      restreamerClients.set(nodeKey(inst.id, node.id), new RestreamerClient(node));
    }
  }
  const switcherClients = new Map<string, SwitcherClient>();
  for (const sw of config.restreamer?.switchers ?? []) {
    switcherClients.set(sw.id, new SwitcherClient(sw));
  }

  const restreamer = db
    ? new RestreamerService(db, cache, pollers, bus, config, restreamerClients, switcherClients)
    : null;
  if (restreamer) {
    // chain into the topology-change callback set above (fires after every
    // pollTopology, next to ConflictService.recompute) — the service
    // debounces and hash-skips, so extra invocations are cheap
    for (const inst of config.instances) {
      const poller = pollers.get(inst.id);
      if (!poller) continue; // tvh-less: no topology will ever change here
      const prev = poller.onCapacityInputsChanged;
      poller.onCapacityInputsChanged = () => {
        prev?.();
        restreamer.onTopologyChanged(inst.id);
      };
    }
  }

  const restreamerHooks = restreamer?.pollerHooks() ?? {};
  const restreamerPollers: RestreamerPoller[] = [];
  for (const inst of config.instances) {
    for (const node of inst.restreamer?.nodes ?? []) {
      // seed a reachable:false placeholder so /api/restreamer/nodes and the
      // service's status patches see every configured node before its first poll
      const snap = cache.get(inst.id);
      snap.restreamers = [
        ...snap.restreamers,
        {
          instanceId: inst.id,
          nodeId: node.id,
          url: node.url,
          serveUrl: node.serveUrl ?? null,
          reachable: false,
          error: null,
          lastPollAt: null,
          version: null,
          uptimeSec: null,
          apiVersionSupported: true,
          desiredRevision: null,
          pendingPush: false,
          sessions: [],
          sourcesHash: null,
          sources: null,
        },
      ];
      restreamerPollers.push(
        new RestreamerPoller(
          inst.id,
          node,
          restreamerClients.get(nodeKey(inst.id, node.id))!,
          cache,
          bus,
          config.pollIntervals.restreamer,
          restreamerHooks,
        ),
      );
    }
  }
  const switcherHooks = restreamer?.switcherPollerHooks() ?? {};
  const switcherPollers = (config.restreamer?.switchers ?? []).map(
    (sw) =>
      new SwitcherPoller(
        sw,
        switcherClients.get(sw.id)!,
        cache,
        bus,
        config.pollIntervals.restreamer,
        switcherHooks,
      ),
  );

  const ledger = db ? new UploadLedger(db, config.overlapThreshold) : null;
  const dispatcher = ledger ? new UploadDispatcher(config, ledger, bus) : null;
  const autoUploader =
    ledger && dispatcher && config.autoUpload.enabled
      ? new AutoUploader(config, cache, ledger, dispatcher, bus)
      : null;

  const ctx: AppContext = {
    config,
    db,
    cache,
    bus,
    pollers,
    tvhHttp,
    sync,
    ledger,
    dispatcher,
    restreamer,
    restreamerClients,
    restreamerPollers,
    switcherClients,
    switcherPollers,
  };

  // request logging is disabled: the dashboard polls several endpoints every
  // few seconds, which would drown real errors in noise
  const app = Fastify({ logger: true, disableRequestLogging: true });
  registerInstanceRoutes(app, ctx);
  registerEpgRoutes(app, ctx);
  registerUnifiedRoutes(app, ctx);
  registerRecordingsRoutes(app, ctx);
  registerRuleRoutes(app, ctx);
  registerUploadRoutes(app, ctx);
  registerRestreamerRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  app.get('/healthz', async () => ({ ok: true }));

  // serve the built SPA when present (single container, no CORS)
  const webDist =
    config.webDistDir ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    // wildcard mode resolves files at request time, so a rebuilt SPA with new
    // hashed asset names is served without restarting the controller
    // (missing files fall through to the not-found handler below)
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for client routes; real 404 for API and missing assets
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/assets/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }

  for (const [, poller] of pollers) poller.start();
  for (const poller of restreamerPollers) poller.start();
  for (const poller of switcherPollers) poller.start();
  restreamer?.startSweep();
  restreamer?.startRebalance();
  if (dispatcher) await dispatcher.resume();
  autoUploader?.start();

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return; // a second signal must not double-close app/db
    closing = true;
    // failsafe: a hung app.close()/db.destroy() must not block SIGTERM forever
    setTimeout(() => process.exit(1), 10_000).unref();
    try {
      autoUploader?.stop();
      for (const [, poller] of pollers) poller.stop();
      for (const poller of restreamerPollers) poller.stop();
      for (const poller of switcherPollers) poller.stop();
      restreamer?.stopSweep();
      restreamer?.stopRebalance();
      // give in-flight upload loops a bounded chance to checkpoint before the
      // database goes away; resume() recovers anything still unfinished
      await dispatcher?.stop();
      await app.close();
      await db?.destroy();
    } catch (err) {
      console.error('error during shutdown:', err);
      process.exit(1);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
