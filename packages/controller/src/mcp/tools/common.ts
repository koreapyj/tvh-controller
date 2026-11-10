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

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Api } from '../inject.js';

/**
 * One MCP tool. `input` is a zod raw shape describing the arguments; the
 * wrapped route stays the authority on validation (its 4xx comes back as an
 * isError result), so shapes here document rather than re-implement checks.
 */
export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>, api: Api) => Promise<unknown>;
}

/** typed helper so each tool's `run` sees its own inferred argument type */
export function tool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run: (args: z.infer<z.ZodObject<S>>, api: Api) => Promise<unknown>;
}): ToolDef {
  return def as unknown as ToolDef;
}

// MCP defaults destructiveHint to TRUE for non-read-only tools, so every
// write tool states it explicitly
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** read-only, but fetches fresh state from tvheadend / restreamer nodes */
export const READ_REMOTE: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const WRITE_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export const pageShape = {
  offset: z.number().int().min(0).optional().describe('items to skip (default 0)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`max items to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
};

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
}

export function page<T>(list: T[], offset?: number, limit?: number): Page<T> {
  const o = offset ?? 0;
  return { items: list.slice(o, o + (limit ?? DEFAULT_LIMIT)), total: list.length, offset: o };
}

/**
 * Channel identity is name + number, never name alone; numbers are STRINGS
 * compared with === ("9.1" !== "9.10"). null = number unknown.
 */
export const channelIdentity = z
  .object({
    name: z.string().min(1).describe('channel name, exact'),
    number: z
      .string()
      .nullable()
      .describe('channel number as a STRING exactly as tvheadend reports it (e.g. "9.1"); null = unknown number'),
  })
  .describe('channel identity: name AND number together (never name alone)');

export type ChannelIdentity = z.infer<typeof channelIdentity>;

export function sameChannel(
  id: ChannelIdentity,
  name: string,
  number: string | null | undefined,
): boolean {
  return id.name === name && id.number === (number ?? null);
}

export const instanceId = z.string().min(1).describe('controller instance id (see list_instances)');
export const nodeId = z.string().min(1).describe('restreamer node id within the instance (see list_restreamer_nodes)');

/** free-form JSON object passed through to the route, which validates it */
export function passthroughObject(description: string) {
  return z.record(z.string(), z.unknown()).describe(description);
}
