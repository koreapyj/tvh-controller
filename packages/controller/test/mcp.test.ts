/*
 * MCP endpoint tests: a real Fastify app listening on 127.0.0.1:0 with the
 * real /mcp route, driven by the SDK's own Client over Streamable HTTP.
 * Controller routes are a mix of the real event-log routes (hermetic
 * in-memory SQLite) and small stubs at the real paths, so the MCP layer —
 * inject plumbing, filtering, pagination, error mapping — is exercised
 * end to end without any tvheadend / restreamer / prod access.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UnifiedGroup } from '@tvhc/shared';
import { registerMcpRoutes } from '../src/mcp/route.js';
import { ALL_TOOLS } from '../src/mcp/server.js';
import { registerEventLogRoutes } from '../src/routes/eventLog.js';
import type { AppContext } from '../src/routes/context.js';
import { EventLog } from '../src/state/eventLog.js';
import { EventBus } from '../src/state/events.js';
import { createTestDb } from './support/testDb.js';

const item = (title: string, channelname: string, channelNumber: string | null, start: number) => ({
  title,
  channelname,
  channelNumber,
  start,
  stop: start + 1800,
  copies: [],
});

const GROUPS: UnifiedGroup[] = [
  {
    label: 'News',
    comment: '',
    items: [item('Morning News', 'NHK', '1.1', 1000), item('Evening News', 'NHK', '1.10', 5000)],
  },
  { label: 'Anime', comment: 'weekly', items: [item('Show A', 'TX', '7.1', 3000)] },
];

interface Harness {
  app: FastifyInstance;
  client: Client;
  seen: { method: string; url: string; body: unknown }[];
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function harness(): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const eventLog = new EventLog(db, new EventBus());
  const app = Fastify();
  const seen: Harness['seen'] = [];
  app.addHook('onRequest', async (req) => {
    seen.push({ method: req.method, url: req.url, body: undefined });
  });
  app.addHook('preHandler', async (req) => {
    const last = seen[seen.length - 1];
    if (last) last.body = req.body;
  });

  registerEventLogRoutes(app, { db, eventLog } as unknown as AppContext);
  app.get('/api/recordings', async () => GROUPS);
  app.post('/api/restreamer/channels/:id/switch', async (_req, reply) => {
    reply.code(409);
    return { error: 'requires-confirm', message: 'trigger still failing', triggerStillFailing: true };
  });
  app.delete('/api/rules/:id', async () => ({ ok: true }));
  registerMcpRoutes(app);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

  await db
    .insertInto('event_log')
    .values({ type: 'warning', service: 'restreamer', source: 'node.a', message: 'went offline', created_at: '2026-01-01 00:00:00' })
    .execute();

  closers.push(async () => {
    await client.close();
    await app.close();
    await destroy();
  });
  return { app, client, seen };
}

function parse(result: Awaited<ReturnType<Client['callTool']>>): any {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

describe('tool catalogue', () => {
  it('has unique names and explicit hints on every write tool', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) {
      if (t.annotations.readOnlyHint) continue;
      // MCP defaults destructiveHint to true; writes must state it explicitly
      expect(typeof t.annotations.destructiveHint, t.name).toBe('boolean');
    }
  });
});

describe('/mcp', () => {
  it('lists every tool with its annotations', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    expect(tools.find((t) => t.name === 'list_rules')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'delete_rule')?.annotations?.destructiveHint).toBe(true);
  });

  it('runs a real read route through inject', async () => {
    const { client } = await harness();
    const res = parse(await client.callTool({ name: 'query_event_log', arguments: { type: 'warning' } }));
    expect(res.total).toBe(1);
    expect(res.items[0].message).toBe('went offline');
  });

  it('filters unified recordings by exact name + string number identity', async () => {
    const { client } = await harness();
    const res = parse(
      await client.callTool({
        name: 'search_recordings',
        arguments: { channel: { name: 'NHK', number: '1.1' } },
      }),
    );
    // "1.10" must not match "1.1"
    expect(res.items.map((i: { title: string }) => i.title)).toEqual(['Morning News']);
    expect(res.items[0].rule).toBe('News');
  });

  it('paginates flattened results', async () => {
    const { client } = await harness();
    const res = parse(await client.callTool({ name: 'search_recordings', arguments: { offset: 1, limit: 1 } }));
    expect(res.total).toBe(3);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].title).toBe('Evening News');
  });

  it('maps a route 409 to isError with the route body intact', async () => {
    const { client } = await harness();
    const result = await client.callTool({ name: 'reset_restream_channel', arguments: { id: 'ch1' } });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ status: 409, error: 'requires-confirm', triggerStillFailing: true });
  });

  it('encodes path params and sends the right method', async () => {
    const { client, seen } = await harness();
    await client.callTool({ name: 'delete_rule', arguments: { id: 'a/b' } });
    expect(seen.some((s) => s.method === 'DELETE' && s.url === '/api/rules/a%2Fb')).toBe(true);
  });

  it('sends the reset body exactly as the route expects', async () => {
    const { client, seen } = await harness();
    await client.callTool({ name: 'reset_restream_channel', arguments: { id: 'ch1', force: true } });
    const call = seen.find((s) => s.url === '/api/restreamer/channels/ch1/switch');
    expect(call?.body).toEqual({ reset: true, force: true });
  });

  it('rejects GET on the stateless endpoint', async () => {
    const { app } = await harness();
    const res = await app.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(405);
  });
});
