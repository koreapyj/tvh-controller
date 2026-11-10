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

import { z } from 'zod';
import { READ, tool, type ToolDef } from './common.js';

export const eventLogTools: ToolDef[] = [
  tool({
    name: 'query_event_log',
    description:
      'Persisted history of system/autonomous events (failovers, outages, drift, failed pushes, …). Newest first by default.',
    input: {
      service: z.array(z.string()).optional().describe('only these services (see get_event_log_facets)'),
      source: z.array(z.string()).optional().describe('only these sources (see get_event_log_facets)'),
      type: z.enum(['normal', 'warning']).optional(),
      sort: z.enum(['time', 'service', 'source', 'type']).optional().describe('default time'),
      dir: z.enum(['asc', 'desc']).optional().describe('default desc'),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional().describe('default 50, max 500'),
    },
    annotations: READ,
    run: (a, api) =>
      api({
        method: 'GET',
        url: '/api/event-log',
        query: {
          service: a.service ? JSON.stringify(a.service) : undefined,
          source: a.source ? JSON.stringify(a.source) : undefined,
          type: a.type,
          sort: a.sort,
          dir: a.dir,
          offset: a.offset,
          limit: a.limit ?? 50,
        },
      }),
  }),
  tool({
    name: 'get_event_log_facets',
    description: 'Distinct services and sources present in the event log (values for query_event_log filters).',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/event-log/facets' }),
  }),
];
