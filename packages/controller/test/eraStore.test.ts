/*
 * EraStore tests over the hermetic in-memory SQLite harness: ensureEra
 * idempotency/increment/era-0-null-splice/prune, and recordOffsets
 * first-write-wins/conflict/regression semantics.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/schema.js';
import { EraStore } from '../src/restreamer/eraStore.js';
import { createTestDb } from './support/testDb.js';

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

async function seedChannel(db: Kysely<Database>): Promise<string> {
  const profileId = randomUUID();
  await db
    .insertInto('restream_profiles')
    .values({
      id: profileId,
      name: `p-${profileId}`,
      payload: '{}',
      updated_at: '2026-01-01 00:00:00',
    })
    .execute();
  const channelId = randomUUID();
  await db
    .insertInto('restream_channels')
    .values({
      id: channelId,
      slug: `chan-${channelId}`,
      channel_name: 'Test Channel',
      channel_number: '9.1',
      profile_id: profileId,
      enabled: 1,
      comment: null,
      updated_at: '2026-01-01 00:00:00',
    })
    .execute();
  return channelId;
}

async function makeHarness() {
  const { db, destroy } = await createTestDb();
  const logs: LoggedEvent[] = [];
  const store = new EraStore(db, { log: (e) => logs.push(e) });
  const channelId = await seedChannel(db);
  return { db, destroy, store, logs, channelId };
}

describe('EraStore.ensureEra', () => {
  it('returns the existing era unchanged when the latest era already targets the placement', async () => {
    const { store, channelId, destroy } = await makeHarness();
    const first = await store.ensureEra(channelId, 'placement-a', null);
    expect(first).toEqual({ eraIndex: 0, upstreamId: 'placement-a', splicePdtMs: null, offsets: {} });

    // repeat stamp with a DIFFERENT splicePdtMs — must be ignored since the
    // placement is unchanged (idempotent, no churn)
    const again = await store.ensureEra(channelId, 'placement-a', 999_000);
    expect(again).toEqual(first);

    const rows = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(rows).toHaveLength(1);
    await destroy();
  });

  it('mints a new era (index + 1) when the placement changes', async () => {
    const { store, channelId, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null);
    const second = await store.ensureEra(channelId, 'placement-b', 1_000);
    expect(second).toEqual({ eraIndex: 1, upstreamId: 'placement-b', splicePdtMs: 1_000, offsets: {} });

    const third = await store.ensureEra(channelId, 'placement-c', 2_000);
    expect(third.eraIndex).toBe(2);
    expect(third.splicePdtMs).toBe(2_000);
    await destroy();
  });

  it('forces splicePdtMs to null for era 0 regardless of what the caller passes', async () => {
    const { store, channelId, destroy } = await makeHarness();
    const first = await store.ensureEra(channelId, 'placement-a', 12345);
    expect(first.eraIndex).toBe(0);
    expect(first.splicePdtMs).toBeNull();
    await destroy();
  });

  it('prunes to the newest 20 eras per channel on insert', async () => {
    const { store, channelId, destroy } = await makeHarness();
    const base = Date.now();
    for (let i = 0; i < 25; i++) {
      await store.ensureEra(channelId, `placement-${i}`, i === 0 ? null : base + i * 1000);
    }
    // huge drainGraceMs + a nowMs right after the last splice: every
    // surviving row's successor splice is well within the horizon
    const kept = await store.recentEras(channelId, 3_600_000_000, 100, base + 25_000);
    expect(kept).toHaveLength(20);
    // oldest 5 eras (index 0..4) pruned; newest kept, in ascending order
    expect(kept[0]!.eraIndex).toBe(5);
    expect(kept[kept.length - 1]!.eraIndex).toBe(24);
    await destroy();
  });
});

describe('EraStore.recordOffsets', () => {
  it('first-write-wins: a fresh variant key persists on first report', async () => {
    const { store, channelId, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null);
    await store.recordOffsets(channelId, 0, { v0: 100 });
    const [era] = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(era!.offsets).toEqual({ v0: 100 });
    await destroy();
  });

  it('a later conflicting report for an already-persisted key does not overwrite, and logs a warning', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null);
    await store.recordOffsets(channelId, 0, { v0: 100 });
    await store.recordOffsets(channelId, 0, { v0: 200 }); // disagreeing later report

    const [era] = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(era!.offsets).toEqual({ v0: 100 }); // unchanged — first write is authoritative

    const warnings = logs.filter((l) => l.type === 'warning' && l.message.includes('conflict'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ service: 'restreamer', source: 'switcher' });
    expect(warnings[0]!.message).toContain('v0');
    await destroy();
  });

  it('an identical repeat report for an already-persisted key is a silent no-op (no log)', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null);
    await store.recordOffsets(channelId, 0, { v0: 100 });
    await store.recordOffsets(channelId, 0, { v0: 100 });
    expect(logs).toHaveLength(0);
    await destroy();
  });

  it('rejects and logs a regression: a new variant value lower than the preceding era value is not persisted', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null); // era 0
    await store.recordOffsets(channelId, 0, { v0: 500 });
    await store.ensureEra(channelId, 'placement-b', 1_000); // era 1

    await store.recordOffsets(channelId, 1, { v0: 100 }); // regression vs era 0's 500
    const eras = await store.recentEras(channelId, 3600_000, 8, Date.now());
    const era1 = eras.find((e) => e.eraIndex === 1)!;
    expect(era1.offsets).toEqual({}); // rejected, not persisted

    const warnings = logs.filter((l) => l.type === 'warning' && l.message.includes('regression'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('v0');
    await destroy();
  });

  it('accepts a new variant value that is >= the preceding era value', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null); // era 0
    await store.recordOffsets(channelId, 0, { v0: 500 });
    await store.ensureEra(channelId, 'placement-b', 1_000); // era 1

    await store.recordOffsets(channelId, 1, { v0: 600 });
    const eras = await store.recentEras(channelId, 3600_000, 8, Date.now());
    const era1 = eras.find((e) => e.eraIndex === 1)!;
    expect(era1.offsets).toEqual({ v0: 600 });
    expect(logs).toHaveLength(0);
    await destroy();
  });

  it('a report for a non-existent era is a silent no-op', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null);
    await store.recordOffsets(channelId, 99, { v0: 1 }); // era 99 does not exist
    expect(logs).toHaveLength(0);
    const eras = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(eras).toHaveLength(1);
    await destroy();
  });

  it('an empty offsets object is a no-op', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null);
    await store.recordOffsets(channelId, 0, {});
    expect(logs).toHaveLength(0);
    await destroy();
  });

  it('is race-safe under concurrent (interleaved) calls for the same channel', async () => {
    const { store, channelId, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', null);
    // fire concurrently — the in-process serialize() chain must linearize them
    await Promise.all([
      store.recordOffsets(channelId, 0, { v0: 100 }),
      store.recordOffsets(channelId, 0, { v1: 200 }),
      store.recordOffsets(channelId, 0, { v0: 999 }), // conflicting, should lose to whichever v0 write landed first
    ]);
    const [era] = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(era!.offsets.v0).toBe(100); // first-write-wins, deterministic under serialization
    expect(era!.offsets.v1).toBe(200);
    await destroy();
  });
});
