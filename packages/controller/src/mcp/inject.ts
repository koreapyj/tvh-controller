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

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiCall {
  method: HttpMethod;
  /** path WITHOUT query string; path params must already be encoded (see `p`) */
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** a non-2xx route response, carrying the route's own error body verbatim */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${status}`,
    );
  }
}

export type Api = <T = unknown>(call: ApiCall) => Promise<T>;

/** encode one path segment (ids, slugs, session names) */
export function p(segment: string | number): string {
  return encodeURIComponent(String(segment));
}

/**
 * Calls an existing controller route in-process via Fastify inject, so MCP
 * tools reuse the routes' validation, error mapping and handlers verbatim —
 * no parallel implementation of any controller logic lives in the MCP layer.
 */
export function createApi(app: FastifyInstance): Api {
  return async <T>(call: ApiCall): Promise<T> => {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(call.query ?? {})) {
      if (v !== undefined) query[k] = String(v);
    }
    const res = await app.inject({
      method: call.method,
      url: call.url,
      query,
      ...(call.body !== undefined ? { payload: call.body as object } : {}),
    });
    const text = res.body;
    let data: unknown = text;
    if (text.length > 0 && (res.headers['content-type'] ?? '').toString().includes('json')) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } else if (text.length === 0) {
      data = null;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) throw new ApiError(res.statusCode, data);
    return data as T;
  };
}
