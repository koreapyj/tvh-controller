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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { ApiError, createApi, type Api } from './inject.js';
import type { ToolDef } from './tools/common.js';
import { eventLogTools } from './tools/eventLog.js';
import { instanceTools } from './tools/instances.js';
import { recordingTools } from './tools/recordings.js';
import { restreamerTools } from './tools/restreamer.js';
import { ruleTools } from './tools/rules.js';
import { uploadTools } from './tools/uploads.js';

export const ALL_TOOLS: ToolDef[] = [
  ...instanceTools,
  ...recordingTools,
  ...ruleTools,
  ...uploadTools,
  ...eventLogTools,
  ...restreamerTools,
];

const INSTRUCTIONS = `tvh-controller: central controller for several tvheadend instances (zones) —
autorec master rules pushed to instances, unified recordings/EPG, Google Drive archiving, and the
restreamer (HLS encoding nodes + failover switcher).
Channel identity is ALWAYS name + number together; numbers are strings ("9.1" != "9.10").
Tool results are the controller API's JSON. A route error comes back as isError with its HTTP
status and error body (409s carry details such as \`unavailable\` or \`triggerStillFailing\`).`;

function text(value: unknown): CallToolResult['content'] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

export async function runTool(def: ToolDef, args: Record<string, unknown>, api: Api): Promise<CallToolResult> {
  try {
    const result = await def.run(args, api);
    return { content: text(result ?? { ok: true }) };
  } catch (err) {
    if (err instanceof ApiError) {
      const body = typeof err.body === 'object' && err.body !== null ? err.body : { error: err.body };
      return { isError: true, content: text({ status: err.status, ...body }) };
    }
    return { isError: true, content: text({ error: err instanceof Error ? err.message : String(err) }) };
  }
}

/** a fresh server per request (stateless Streamable HTTP); tools call routes via inject */
export function createMcpServer(app: FastifyInstance): McpServer {
  const server = new McpServer(
    { name: 'tvh-controller', version: process.env.npm_package_version ?? '0.0.0' },
    { instructions: INSTRUCTIONS },
  );
  const api = createApi(app);
  for (const def of ALL_TOOLS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input, annotations: def.annotations },
      (args: Record<string, unknown>) => runTool(def, args, api),
    );
  }
  return server;
}
