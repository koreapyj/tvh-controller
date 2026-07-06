/*
 * Migration 008_restreamer smoke test: every new table accepts an insert and
 * reads back, and the declared FKs behave (placements/playlist members
 * cascade, profiles referenced by channels restrict). Hermetic — in-memory
 * SQLite via createTestDb().
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './support/testDb.js';

const NOW = '2026-07-06 00:00:00';

describe('migration 008_restreamer', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.destroy();
  });

  async function seed() {
    await t.db
      .insertInto('restream_profiles')
      .values({
        id: 'prof-1',
        name: 'default-3M',
        payload: JSON.stringify({ template: 'arib-hls', templateVersion: 1 }),
        updated_at: NOW,
      })
      .execute();
    await t.db
      .insertInto('restream_channels')
      .values({
        id: 'chan-1',
        slug: 'at-x',
        channel_name: 'AT-X',
        channel_number: '9.1',
        profile_id: 'prof-1',
        enabled: 1,
        comment: null,
        updated_at: NOW,
      })
      .execute();
    await t.db
      .insertInto('restream_placements')
      .values({
        id: 'plc-1',
        channel_id: 'chan-1',
        instance_id: 'tyo1',
        node_id: 'node1',
        priority: 0,
        enabled: 1,
        weight: null,
        program_number: null,
        updated_at: NOW,
      })
      .execute();
    await t.db
      .insertInto('restream_playlists')
      .values({ id: 'pl-1', slug: 'anime', title: 'Anime', epg_url: null, updated_at: NOW })
      .execute();
    await t.db
      .insertInto('restream_playlist_members')
      .values({ playlist_id: 'pl-1', channel_id: 'chan-1' })
      .execute();
    await t.db
      .insertInto('restream_node_state')
      .values({ instance_id: 'tyo1', node_id: 'node1', pushed_hash: 'abc', pushed_at: NOW })
      .execute();
    await t.db
      .insertInto('restream_switcher_state')
      .values({ switcher_id: 'main', pushed_hash: 'def', pushed_at: NOW })
      .execute();
  }

  it('inserts and reads back one row per table', async () => {
    await seed();

    const profile = await t.db
      .selectFrom('restream_profiles')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(profile.name).toBe('default-3M');
    expect(JSON.parse(profile.payload)).toEqual({ template: 'arib-hls', templateVersion: 1 });
    expect(profile.updated_at).toBeInstanceOf(Date);

    const channel = await t.db
      .selectFrom('restream_channels')
      .selectAll()
      .executeTakeFirstOrThrow();
    // channel number is a STRING identity, exactly as stored
    expect(channel.channel_number).toBe('9.1');
    expect(channel.profile_id).toBe('prof-1');
    expect(channel.enabled).toBe(1);

    const placement = await t.db
      .selectFrom('restream_placements')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(placement).toMatchObject({
      channel_id: 'chan-1',
      instance_id: 'tyo1',
      node_id: 'node1',
      priority: 0,
      weight: null,
      program_number: null,
    });

    const playlist = await t.db
      .selectFrom('restream_playlists')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(playlist).toMatchObject({ slug: 'anime', title: 'Anime', epg_url: null });

    const member = await t.db
      .selectFrom('restream_playlist_members')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ playlist_id: 'pl-1', channel_id: 'chan-1' });

    const nodeState = await t.db
      .selectFrom('restream_node_state')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(nodeState.pushed_hash).toBe('abc');
    expect(nodeState.pushed_at).toBeInstanceOf(Date);

    const switcherState = await t.db
      .selectFrom('restream_switcher_state')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(switcherState).toMatchObject({ switcher_id: 'main', pushed_hash: 'def' });
  });

  it('cascades channel deletion to placements and playlist members', async () => {
    await seed();
    await t.db.deleteFrom('restream_channels').where('id', '=', 'chan-1').execute();
    expect(await t.db.selectFrom('restream_placements').selectAll().execute()).toHaveLength(0);
    expect(
      await t.db.selectFrom('restream_playlist_members').selectAll().execute(),
    ).toHaveLength(0);
    // playlist itself survives
    expect(await t.db.selectFrom('restream_playlists').selectAll().execute()).toHaveLength(1);
  });

  it('restricts deleting a profile still referenced by a channel', async () => {
    await seed();
    await expect(
      t.db.deleteFrom('restream_profiles').where('id', '=', 'prof-1').execute(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  describe('010_drop_external_source_columns', () => {
    it('a plain channel row no longer carries source_type/source_key', async () => {
      await seed();
      const channel = await t.db
        .selectFrom('restream_channels')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(channel).not.toHaveProperty('source_type');
      expect(channel).not.toHaveProperty('source_key');
    });

    it('inserting a channel row works with just (channel_name, channel_number)', async () => {
      await seed();
      await t.db
        .insertInto('restream_channels')
        .values({
          id: 'chan-2',
          slug: 'bs11',
          channel_name: 'BS11',
          channel_number: '11',
          profile_id: 'prof-1',
          enabled: 1,
          comment: null,
          updated_at: NOW,
        })
        .execute();
      const row = await t.db
        .selectFrom('restream_channels')
        .selectAll()
        .where('id', '=', 'chan-2')
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ channel_name: 'BS11', channel_number: '11' });
    });
  });

  it('enforces UNIQUE(channel_id, instance_id, node_id) on placements', async () => {
    await seed();
    await expect(
      t.db
        .insertInto('restream_placements')
        .values({
          id: 'plc-2',
          channel_id: 'chan-1',
          instance_id: 'tyo1',
          node_id: 'node1',
          priority: 1,
          enabled: 1,
          weight: null,
          program_number: null,
          updated_at: NOW,
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
