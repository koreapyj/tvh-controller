/*
 * EraStore tests over the hermetic in-memory SQLite harness: session-aware
 * era minting, retention, and first-write-wins offset persistence.
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
    .values({ id: profileId, name: `p-${profileId}`, payload: '{}', updated_at: '2026-01-01 00:00:00' })
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
  it('is idempotent only for the same latest placement and session identity', async () => {
    const { db, store, channelId, destroy } = await makeHarness();
    const first = await store.ensureEra(channelId, 'placement-a', 'session-a', 100_000);
    const again = await store.ensureEra(channelId, 'placement-a', 'session-a', 999_000);
    expect(again).toEqual(first);

    const rows = await db
      .selectFrom('restream_switcher_eras')
      .select(['placement_id', 'session_key'])
      .where('channel_id', '=', channelId)
      .execute();
    expect(rows).toEqual([{ placement_id: 'placement-a', session_key: 'session-a' }]);
    await destroy();
  });

  it('mints a new era for a session change on the same placement', async () => {
    const { store, channelId, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', 'session-a', 100);
    const second = await store.ensureEra(channelId, 'placement-a', 'session-b', 200);
    expect(second).toMatchObject({ eraIndex: 1, upstreamId: 'placement-a', splicePdtMs: 200 });
    await destroy();
  });

  it('mints a new era for a placement change even when the session key is reused', async () => {
    const { store, channelId, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', 'shared-session', 100);
    const second = await store.ensureEra(channelId, 'placement-b', 'shared-session', 200);
    expect(second).toMatchObject({ eraIndex: 1, upstreamId: 'placement-b', splicePdtMs: 200 });
    await destroy();
  });

  it('does not treat a seeded null legacy session key as a wildcard match', async () => {
    const { db, store, channelId, destroy } = await makeHarness();
    await db
      .insertInto('restream_switcher_eras')
      .values({
        id: randomUUID(),
        channel_id: channelId,
        era_index: 0,
        placement_id: 'placement-a',
        session_key: null,
        splice_pdt_ms: null,
        offsets: '{}',
        created_at: '2026-01-01 00:00:00',
      })
      .execute();

    const corrective = await store.ensureEra(channelId, 'placement-a', 'placement-a', 200);
    expect(corrective.eraIndex).toBe(1);
    const rows = await db
      .selectFrom('restream_switcher_eras')
      .select(['era_index', 'session_key'])
      .where('channel_id', '=', channelId)
      .orderBy('era_index')
      .execute();
    expect(rows).toEqual([
      { era_index: 0, session_key: null },
      { era_index: 1, session_key: 'placement-a' },
    ]);
    await destroy();
  });

  it('stamps era 0 and persists its session key', async () => {
    const { db, store, channelId, destroy } = await makeHarness();
    const first = await store.ensureEra(channelId, 'placement-a', 'activation-uuid', 12345);
    expect(first).toEqual({ eraIndex: 0, upstreamId: 'placement-a', splicePdtMs: 12345, offsets: {} });
    const row = await db
      .selectFrom('restream_switcher_eras')
      .select(['session_key', 'splice_pdt_ms'])
      .where('channel_id', '=', channelId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ session_key: 'activation-uuid', splice_pdt_ms: 12345 });
    await destroy();
  });

  it('prunes to the newest 20 eras per channel on insert', async () => {
    const { store, channelId, destroy } = await makeHarness();
    const base = Date.now();
    for (let i = 0; i < 25; i++) {
      await store.ensureEra(channelId, `placement-${i}`, `session-${i}`, base + i * 1000);
    }
    const kept = await store.recentEras(channelId, 3_600_000_000, 100, base + 25_000);
    expect(kept).toHaveLength(20);
    expect(kept[0]!.eraIndex).toBe(5);
    expect(kept.at(-1)!.eraIndex).toBe(24);
    await destroy();
  });
});

describe('EraStore.recordOffsets', () => {
  it('returns true only when at least one previously unknown key is persisted', async () => {
    const { store, channelId, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', 'placement-a', null);
    expect(await store.recordOffsets(channelId, 0, {})).toBe(false);
    expect(await store.recordOffsets(channelId, 99, { v0: 1 })).toBe(false);
    expect(await store.recordOffsets(channelId, 0, { v0: 100 })).toBe(true);
    expect(await store.recordOffsets(channelId, 0, { v0: 100 })).toBe(false);
    expect(await store.recordOffsets(channelId, 0, { v0: 100, v1: 200 })).toBe(true);
    await destroy();
  });

  it('accepts lower chain constants in a newer era', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', 'session-a', null);
    await store.recordOffsets(channelId, 0, { v0: 500 });
    await store.ensureEra(channelId, 'placement-b', 'session-b', 1_000);

    expect(await store.recordOffsets(channelId, 1, { v0: 100 })).toBe(true);
    const eras = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(eras.find((era) => era.eraIndex === 1)!.offsets).toEqual({ v0: 100 });
    expect(logs).toHaveLength(0);
    await destroy();
  });

  it('keeps the first conflicting report, returns false, and logs a warning', async () => {
    const { store, channelId, logs, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', 'placement-a', null);
    expect(await store.recordOffsets(channelId, 0, { v0: 100 })).toBe(true);
    expect(await store.recordOffsets(channelId, 0, { v0: 200 })).toBe(false);

    const [era] = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(era!.offsets).toEqual({ v0: 100 });
    expect(logs.filter((event) => event.type === 'warning' && event.message.includes('conflict'))).toHaveLength(1);
    await destroy();
  });

  it('is race-safe under concurrent reports for the same channel', async () => {
    const { store, channelId, destroy } = await makeHarness();
    await store.ensureEra(channelId, 'placement-a', 'placement-a', null);
    const results = await Promise.all([
      store.recordOffsets(channelId, 0, { v0: 100 }),
      store.recordOffsets(channelId, 0, { v1: 200 }),
      store.recordOffsets(channelId, 0, { v0: 999 }),
    ]);
    expect(results).toEqual([true, true, false]);
    const [era] = await store.recentEras(channelId, 3600_000, 8, Date.now());
    expect(era!.offsets).toEqual({ v0: 100, v1: 200 });
    await destroy();
  });
});
