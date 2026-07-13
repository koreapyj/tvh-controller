/*
 * EventLog tests over the hermetic in-memory SQLite harness (test/support/*).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { EventLogEntry } from '@tvhc/shared';
import type { Database } from '../src/db/schema.js';
import { EventLog } from '../src/state/eventLog.js';
import { EventBus } from '../src/state/events.js';
import { createTestDb } from './support/testDb.js';

type Row = { type: 'normal' | 'warning'; service: string; source: string; message: string; created_at: string };

async function insertRow(db: Kysely<Database>, row: Row): Promise<number> {
  const result = await db.insertInto('event_log').values(row).executeTakeFirstOrThrow();
  return Number(result.insertId);
}

async function setup() {
  const { db, destroy } = await createTestDb();
  const bus = new EventBus();
  const eventLog = new EventLog(db, bus);
  return { db, bus, eventLog, destroy };
}

/** resolves with the next 'event-log' bus publish (log() is fire-and-forget) */
function waitForLog(bus: EventBus): Promise<EventLogEntry> {
  return new Promise((resolve) => {
    const unsubscribe = bus.subscribe((e) => {
      if (e.type === 'event-log') {
        unsubscribe();
        resolve(e.data);
      }
    });
  });
}

describe('EventLog.log / list round-trip', () => {
  it('persists a row that list() returns, with created_at revived to an ISO string, and a plain-number id', async () => {
    const { eventLog, bus, destroy } = await setup();
    const published = waitForLog(bus);
    eventLog.log({ type: 'normal', service: 'restreamer', source: 'instance.tyo1', message: 'came online' });
    const entry = await published;
    expect(typeof entry.id).toBe('number');
    expect(entry).toMatchObject({
      type: 'normal',
      service: 'restreamer',
      source: 'instance.tyo1',
      message: 'came online',
    });
    expect(() => new Date(entry.createdAt).toISOString()).not.toThrow();

    const { items, total } = await eventLog.list({});
    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(entry);
    await destroy();
  });

  it('log() is a silent no-op when constructed without a database', async () => {
    const bus = new EventBus();
    const eventLog = new EventLog(null, bus);
    const seen: unknown[] = [];
    bus.subscribe((e) => seen.push(e));
    expect(() =>
      eventLog.log({ type: 'warning', service: 'x', source: 'y', message: 'z' }),
    ).not.toThrow();
    // give any (incorrectly) scheduled async work a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(0);
    await expect(eventLog.list({})).resolves.toEqual({ items: [], total: 0 });
    await expect(eventLog.facets()).resolves.toEqual({ services: [], sources: [] });
  });
});

describe('EventLog.log insert ordering (serialized chain)', () => {
  it('five synchronous log() calls without awaiting still insert in strict emission order', async () => {
    const { eventLog, destroy } = await setup();

    for (let i = 0; i < 5; i++) {
      eventLog.log({ type: 'normal', service: 's', source: 'x', message: `m${i}` });
    }
    // flush the serialized insert chain (log() never returns a promise itself)
    await (eventLog as unknown as { chain: Promise<void> }).chain;

    const { items } = await eventLog.list({ sort: 'time', dir: 'asc' });
    expect(items.map((i) => i.message)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]!);

    await destroy();
  });
});

describe('EventLog.list filters', () => {
  async function seedFiltered(db: Kysely<Database>): Promise<void> {
    await insertRow(db, {
      type: 'normal',
      service: 'restreamer',
      source: 'instance.tyo1',
      message: 'a',
      created_at: '2026-01-01 00:00:00',
    });
    await insertRow(db, {
      type: 'warning',
      service: 'restreamer',
      source: 'node.tyo1.n1',
      message: 'b',
      created_at: '2026-01-01 00:00:01',
    });
    await insertRow(db, {
      type: 'normal',
      service: 'uploads',
      source: 'instance.osk1',
      message: 'c',
      created_at: '2026-01-01 00:00:02',
    });
  }

  it('filters by a single service', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedFiltered(db);
    const { items, total } = await eventLog.list({ service: ['uploads'] });
    expect(total).toBe(1);
    expect(items.map((i) => i.message)).toEqual(['c']);
    await destroy();
  });

  it('filters by multiple services (IN)', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedFiltered(db);
    const { items, total } = await eventLog.list({ service: ['restreamer', 'uploads'] });
    expect(total).toBe(3);
    expect(items).toHaveLength(3);
    await destroy();
  });

  it('filters by a single source', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedFiltered(db);
    const { items, total } = await eventLog.list({ source: ['node.tyo1.n1'] });
    expect(total).toBe(1);
    expect(items.map((i) => i.message)).toEqual(['b']);
    await destroy();
  });

  it('filters by multiple sources (IN)', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedFiltered(db);
    const { items, total } = await eventLog.list({ source: ['instance.tyo1', 'instance.osk1'] });
    expect(total).toBe(2);
    await destroy();
  });

  it('filters by type', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedFiltered(db);
    const { items, total } = await eventLog.list({ type: 'warning' });
    expect(total).toBe(1);
    expect(items.map((i) => i.message)).toEqual(['b']);
    await destroy();
  });

  it('combines filters (service + type)', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedFiltered(db);
    const { items, total } = await eventLog.list({ service: ['restreamer'], type: 'normal' });
    expect(total).toBe(1);
    expect(items.map((i) => i.message)).toEqual(['a']);
    await destroy();
  });
});

describe('EventLog.list sort', () => {
  async function seedSortable(db: Kysely<Database>): Promise<{ r1: number; r2: number; r3: number }> {
    const r1 = await insertRow(db, {
      type: 'normal',
      service: 'alpha',
      source: 'src-a',
      message: 'm1',
      created_at: '2026-01-01 00:00:00',
    });
    const r2 = await insertRow(db, {
      type: 'warning',
      service: 'beta',
      source: 'src-b',
      message: 'm2',
      created_at: '2026-01-01 00:00:10',
    });
    const r3 = await insertRow(db, {
      type: 'normal',
      service: 'gamma',
      source: 'src-c',
      message: 'm3',
      created_at: '2026-01-01 00:00:20',
    });
    return { r1, r2, r3 };
  }

  it('sorts by time asc/desc', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedSortable(db);
    const asc = await eventLog.list({ sort: 'time', dir: 'asc' });
    expect(asc.items.map((i) => i.message)).toEqual(['m1', 'm2', 'm3']);
    const desc = await eventLog.list({ sort: 'time', dir: 'desc' });
    expect(desc.items.map((i) => i.message)).toEqual(['m3', 'm2', 'm1']);
    await destroy();
  });

  it('sorts by service asc/desc', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedSortable(db);
    const asc = await eventLog.list({ sort: 'service', dir: 'asc' });
    expect(asc.items.map((i) => i.service)).toEqual(['alpha', 'beta', 'gamma']);
    const desc = await eventLog.list({ sort: 'service', dir: 'desc' });
    expect(desc.items.map((i) => i.service)).toEqual(['gamma', 'beta', 'alpha']);
    await destroy();
  });

  it('sorts by source asc/desc', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedSortable(db);
    const asc = await eventLog.list({ sort: 'source', dir: 'asc' });
    expect(asc.items.map((i) => i.source)).toEqual(['src-a', 'src-b', 'src-c']);
    const desc = await eventLog.list({ sort: 'source', dir: 'desc' });
    expect(desc.items.map((i) => i.source)).toEqual(['src-c', 'src-b', 'src-a']);
    await destroy();
  });

  it('sorts by type asc/desc, id-tiebreaking rows sharing a type', async () => {
    const { db, eventLog, destroy } = await setup();
    // r1 and r3 are both 'normal' (a tie); r2 is the lone 'warning'
    await seedSortable(db);
    const asc = await eventLog.list({ sort: 'type', dir: 'asc' });
    expect(asc.items.map((i) => i.message)).toEqual(['m1', 'm3', 'm2']);
    const desc = await eventLog.list({ sort: 'type', dir: 'desc' });
    expect(desc.items.map((i) => i.message)).toEqual(['m2', 'm3', 'm1']);
    await destroy();
  });
});

describe('EventLog.list same-second burst determinism', () => {
  it('id-tiebreaks identical created_at values (time-desc -> id-descending)', async () => {
    const { db, eventLog, destroy } = await setup();
    const sameTs = '2026-03-01 12:00:00';
    const id1 = await insertRow(db, { type: 'normal', service: 's', source: 'x', message: 'first', created_at: sameTs });
    const id2 = await insertRow(db, { type: 'normal', service: 's', source: 'x', message: 'second', created_at: sameTs });
    const id3 = await insertRow(db, { type: 'normal', service: 's', source: 'x', message: 'third', created_at: sameTs });
    expect(id1).toBeLessThan(id2);
    expect(id2).toBeLessThan(id3);

    const desc = await eventLog.list({ sort: 'time', dir: 'desc' });
    expect(desc.items.map((i) => i.id)).toEqual([id3, id2, id1]);

    const asc = await eventLog.list({ sort: 'time', dir: 'asc' });
    expect(asc.items.map((i) => i.id)).toEqual([id1, id2, id3]);
    await destroy();
  });
});

describe('EventLog.list pagination', () => {
  async function seedMany(db: Kysely<Database>, n: number, service = 's'): Promise<void> {
    for (let i = 0; i < n; i++) {
      await insertRow(db, {
        type: 'normal',
        service,
        source: 'x',
        message: `m${i}`,
        created_at: `2026-01-01 00:00:${String(i).padStart(2, '0')}`,
      });
    }
  }

  it('paginates with offset/limit, and total reflects the filter, not the page size', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedMany(db, 5, 'match');
    await seedMany(db, 2, 'other');

    const page1 = await eventLog.list({ service: ['match'], sort: 'time', dir: 'asc', limit: 2, offset: 0 });
    expect(page1.items.map((i) => i.message)).toEqual(['m0', 'm1']);
    expect(page1.total).toBe(5);

    const page2 = await eventLog.list({ service: ['match'], sort: 'time', dir: 'asc', limit: 2, offset: 2 });
    expect(page2.items.map((i) => i.message)).toEqual(['m2', 'm3']);
    expect(page2.total).toBe(5);

    const page3 = await eventLog.list({ service: ['match'], sort: 'time', dir: 'asc', limit: 2, offset: 4 });
    expect(page3.items.map((i) => i.message)).toEqual(['m4']);
    expect(page3.total).toBe(5);
    await destroy();
  });

  it('clamps limit to [1, 500] and offset to >= 0', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedMany(db, 3);

    const overLimit = await eventLog.list({ limit: 10_000 });
    expect(overLimit.items).toHaveLength(3); // only 3 rows exist, well under the 500 cap

    const zeroLimit = await eventLog.list({ limit: 0 });
    expect(zeroLimit.items).toHaveLength(1); // clamped up to 1

    const negativeOffset = await eventLog.list({ offset: -5 });
    expect(negativeOffset.total).toBe(3); // clamped to 0, unaffected total
    await destroy();
  });

  it('defaults to limit 100 / offset 0 when unspecified', async () => {
    const { db, eventLog, destroy } = await setup();
    await seedMany(db, 3);
    const { items, total } = await eventLog.list({});
    expect(items).toHaveLength(3);
    expect(total).toBe(3);
    await destroy();
  });
});

describe('EventLog.facets', () => {
  it('returns distinct, sorted services and sources', async () => {
    const { db, eventLog, destroy } = await setup();
    await insertRow(db, { type: 'normal', service: 'b-svc', source: 'y-src', message: '1', created_at: '2026-01-01 00:00:00' });
    await insertRow(db, { type: 'normal', service: 'a-svc', source: 'x-src', message: '2', created_at: '2026-01-01 00:00:01' });
    await insertRow(db, { type: 'normal', service: 'a-svc', source: 'y-src', message: '3', created_at: '2026-01-01 00:00:02' });

    const { services, sources } = await eventLog.facets();
    expect(services).toEqual(['a-svc', 'b-svc']);
    expect(sources).toEqual(['x-src', 'y-src']);
    await destroy();
  });

  it('returns empty arrays when the table is empty', async () => {
    const { eventLog, destroy } = await setup();
    expect(await eventLog.facets()).toEqual({ services: [], sources: [] });
    await destroy();
  });
});

describe('EventLog retention', () => {
  it('prune deletes rows older than the cutoff and keeps newer ones', async () => {
    const { db, eventLog, destroy } = await setup();
    await insertRow(db, {
      type: 'normal',
      service: 's',
      source: 'x',
      message: 'ancient',
      created_at: '2020-01-01 00:00:00',
    });
    const recentTs = new Date(Date.now() - 24 * 60 * 60 * 1000) // 1 day ago
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    await insertRow(db, { type: 'normal', service: 's', source: 'x', message: 'recent', created_at: recentTs });

    // prune() is private; retention prune is only reachable via startRetention
    // (immediate run) or the private method itself — reach it directly for a
    // deterministic assertion, mirroring the private-field-access pattern used
    // elsewhere in this suite (e.g. test/dispatcher.test.ts's instanceQueues).
    await (eventLog as unknown as { prune: (days: number) => Promise<void> }).prune(30);

    const { items } = await eventLog.list({});
    expect(items.map((i) => i.message)).toEqual(['recent']);
    await destroy();
  });

  it('startRetention is idempotent and no-ops without a database; stopRetention clears it', async () => {
    const { eventLog, destroy } = await setup();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    eventLog.startRetention(30);
    eventLog.startRetention(30); // second call must not schedule a second timer
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    eventLog.stopRetention();

    const noDbLog = new EventLog(null, new EventBus());
    expect(() => noDbLog.startRetention(30)).not.toThrow();
    expect(() => noDbLog.stopRetention()).not.toThrow();

    // let the immediate prune() triggered by the first startRetention() settle
    // before the db closes, so a stray unhandled rejection doesn't log noise
    await new Promise((r) => setTimeout(r, 20));
    setIntervalSpy.mockRestore();
    await destroy();
  });
});
