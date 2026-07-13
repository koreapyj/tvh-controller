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
import type { EventLogFilters } from '../state/eventLog.js';
import { requireDb, type AppContext } from './context.js';

const SORT_KEYS = new Set(['time', 'service', 'source', 'type']);

/** JSON-array string param -> string[] | undefined, same convention as routes/epg.ts `channels` */
function parseArrayParam(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  } catch {
    /* ignore malformed filter */
  }
  return undefined;
}

function parseFilters(query: {
  service?: string;
  source?: string;
  type?: string;
  sort?: string;
  dir?: string;
  offset?: string;
  limit?: string;
}): EventLogFilters {
  return {
    service: parseArrayParam(query.service),
    source: parseArrayParam(query.source),
    type: query.type === 'normal' || query.type === 'warning' ? query.type : undefined,
    sort: (SORT_KEYS.has(query.sort ?? '') ? query.sort : 'time') as EventLogFilters['sort'],
    dir: query.dir === 'asc' ? 'asc' : 'desc',
    offset: Math.max(0, Number(query.offset) || 0),
    limit: Math.min(500, Math.max(1, Number(query.limit) || 100)),
  };
}

export function registerEventLogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Querystring: {
      service?: string;
      source?: string;
      type?: string;
      sort?: string;
      dir?: string;
      offset?: string;
      limit?: string;
    };
  }>('/api/event-log', async (req) => {
    requireDb(ctx.db, 'event log');
    return ctx.eventLog.list(parseFilters(req.query));
  });

  app.get('/api/event-log/facets', async () => {
    requireDb(ctx.db, 'event log');
    return ctx.eventLog.facets();
  });
}
