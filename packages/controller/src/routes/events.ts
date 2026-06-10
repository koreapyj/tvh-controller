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

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';

/**
 * SSE endpoint. On connect, replays the current snapshot (instance status,
 * live inputs/subscriptions, conflicts) so a fresh client is consistent,
 * then streams bus events.
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    // every exit path (client close, write error, publisher error) must run
    // the same cleanup, or keepalive intervals and bus listeners leak
    let unsubscribe: (() => void) | null = null;
    let keepalive: NodeJS.Timeout | null = null;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      unsubscribe?.();
      reply.raw.end();
    };

    const send = (type: string, data: unknown): void => {
      if (closed) return;
      try {
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        cleanup();
      }
    };

    try {
      for (const snap of ctx.cache.all()) {
        send('instance-status', snap.summary);
        send('status', {
          instanceId: snap.summary.id,
          inputs: snap.inputs,
          subscriptions: snap.subscriptions,
        });
        send('conflicts', { instanceId: snap.summary.id, windows: snap.conflicts });
      }

      unsubscribe = ctx.bus.subscribe((event) => send(event.type, event.data));
      keepalive = setInterval(() => {
        if (closed) return;
        try {
          reply.raw.write(': keepalive\n\n');
        } catch {
          cleanup();
        }
      }, 25_000);

      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);
    } catch {
      cleanup();
    }
  });
}
