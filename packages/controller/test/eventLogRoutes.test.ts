/*
 * event-log REST route tests: real Fastify app via inject(), hermetic
 * in-memory SQLite (createTestDb()), hand-built AppContext, a real EventLog
 * (no mocking of the service layer) — mirrors test/restreamerRoutes.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { EventLogEntry } from '@tvhc/shared';
import type { Database } from '../src/db/schema.js';
import { registerEventLogRoutes } from '../src/routes/eventLog.js';
import type { AppContext } from '../src/routes/context.js';
import { EventLog } from '../src/state/eventLog.js';
import { EventBus } from '../src/state/events.js';
import { createTestDb } from './support/testDb.js';

type Row = { type: 'normal' | 'warning'; service: string; source: string; message: string; created_at: string };

async function insertRow(db: Kysely<Database>, row: Row): Promise<void> {
  await db.insertInto('event_log').values(row).execute();
}

interface Harness {
  app: FastifyInstance;
  db: Kysely<Database>;
  close: () => Promise<void>;
}

async function setup(withDb = true): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const bus = new EventBus();
  const activeDb = withDb ? db : null;
  const eventLog = new EventLog(activeDb, bus);
  const ctx = { db: activeDb, eventLog } as unknown as AppContext;
  const app = Fastify();
  registerEventLogRoutes(app, ctx);
  await app.ready();
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await destroy();
    },
  };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function harness(withDb = true): Promise<Harness> {
  const h = await setup(withDb);
  closers.push(h.close);
  return h;
}

async function seed(db: Kysely<Database>): Promise<void> {
  await insertRow(db, {
    type: 'normal',
    service: 'restreamer',
    source: 'instance.tyo1',
    message: 'came online',
    created_at: '2026-01-01 00:00:00',
  });
  await insertRow(db, {
    type: 'warning',
    service: 'restreamer',
    source: 'node.tyo1.n1',
    message: 'went offline',
    created_at: '2026-01-01 00:00:10',
  });
  await insertRow(db, {
    type: 'normal',
    service: 'uploads',
    source: 'instance.osk1',
    message: 'upload done',
    created_at: '2026-01-01 00:00:20',
  });
}

describe('GET /api/event-log', () => {
  it('returns {items,total} with the full EventLogEntry shape', async () => {
    const { app, db } = await harness();
    await seed(db);
    const res = await app.inject({ method: 'GET', url: '/api/event-log' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: EventLogEntry[]; total: number };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    const first = body.items[0]!;
    expect(typeof first.id).toBe('number');
    expect(['normal', 'warning']).toContain(first.type);
    expect(typeof first.service).toBe('string');
    expect(typeof first.source).toBe('string');
    expect(typeof first.message).toBe('string');
    expect(typeof first.createdAt).toBe('string');
    // default sort is time desc
    expect(body.items.map((i) => i.message)).toEqual(['upload done', 'went offline', 'came online']);
  });

  it('parses `service` as a JSON-array param', async () => {
    const { app, db } = await harness();
    await seed(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/event-log?service=${encodeURIComponent(JSON.stringify(['uploads']))}`,
    });
    const body = res.json() as { items: EventLogEntry[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.service).toBe('uploads');
  });

  it('parses `source` as a JSON-array param, supporting multiple values', async () => {
    const { app, db } = await harness();
    await seed(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/event-log?source=${encodeURIComponent(JSON.stringify(['instance.tyo1', 'instance.osk1']))}`,
    });
    const body = res.json() as { items: EventLogEntry[]; total: number };
    expect(body.total).toBe(2);
  });

  it('falls back to no filter on malformed `service`/`source` JSON', async () => {
    const { app, db } = await harness();
    await seed(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/event-log?service=not-json&source=${encodeURIComponent('[')}`,
    });
    const body = res.json() as { items: EventLogEntry[]; total: number };
    expect(body.total).toBe(3);
  });

  it('falls back to no filter on an empty JSON array', async () => {
    const { app, db } = await harness();
    await seed(db);
    const res = await app.inject({ method: 'GET', url: '/api/event-log?service=%5B%5D' });
    const body = res.json() as { items: EventLogEntry[]; total: number };
    expect(body.total).toBe(3);
  });

  it('validates `type`, ignoring an unrecognized value', async () => {
    const { app, db } = await harness();
    await seed(db);
    const valid = await app.inject({ method: 'GET', url: '/api/event-log?type=warning' });
    expect((valid.json() as { total: number }).total).toBe(1);

    const invalid = await app.inject({ method: 'GET', url: '/api/event-log?type=bogus' });
    expect((invalid.json() as { total: number }).total).toBe(3);
  });

  it('validates `sort`, defaulting to time on an unrecognized value', async () => {
    const { app, db } = await harness();
    await seed(db);
    const bySer = await app.inject({ method: 'GET', url: '/api/event-log?sort=service&dir=asc' });
    expect((bySer.json() as { items: EventLogEntry[] }).items.map((i) => i.service)).toEqual([
      'restreamer',
      'restreamer',
      'uploads',
    ]);

    const bogus = await app.inject({ method: 'GET', url: '/api/event-log?sort=bogus&dir=asc' });
    // falls back to time asc
    expect((bogus.json() as { items: EventLogEntry[] }).items.map((i) => i.message)).toEqual([
      'came online',
      'went offline',
      'upload done',
    ]);
  });

  it('validates `dir`, defaulting to desc on anything other than "asc"', async () => {
    const { app, db } = await harness();
    await seed(db);
    const res = await app.inject({ method: 'GET', url: '/api/event-log?dir=bogus' });
    expect((res.json() as { items: EventLogEntry[] }).items.map((i) => i.message)).toEqual([
      'upload done',
      'went offline',
      'came online',
    ]);
  });

  it('clamps offset/limit', async () => {
    const { app, db } = await harness();
    await seed(db);
    // `Number(x) || 100` (matching epg.ts's convention) treats 0 as "unspecified",
    // so a negative value is what actually exercises the Math.max(1, ...) floor
    const res = await app.inject({ method: 'GET', url: '/api/event-log?limit=-5&offset=-5' });
    const body = res.json() as { items: EventLogEntry[]; total: number };
    expect(body.items).toHaveLength(1); // limit clamped up to 1
    expect(body.total).toBe(3); // offset clamp doesn't affect total
  });

  it('responds 503 without a database', async () => {
    const { app } = await harness(false);
    const res = await app.inject({ method: 'GET', url: '/api/event-log' });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /api/event-log/facets', () => {
  it('returns distinct, sorted services and sources', async () => {
    const { app, db } = await harness();
    await seed(db);
    const res = await app.inject({ method: 'GET', url: '/api/event-log/facets' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { services: string[]; sources: string[] };
    expect(body.services).toEqual(['restreamer', 'uploads']);
    expect(body.sources).toEqual(['instance.osk1', 'instance.tyo1', 'node.tyo1.n1']);
  });

  it('responds 503 without a database', async () => {
    const { app } = await harness(false);
    const res = await app.inject({ method: 'GET', url: '/api/event-log/facets' });
    expect(res.statusCode).toBe(503);
  });
});
