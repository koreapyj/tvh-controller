/*
 * UploadLedger tests over the hermetic in-memory SQLite harness.
 */

import { describe, expect, it } from 'vitest';
import type { TvhDvrEntry } from '@tvhc/shared';
import { UploadLedger } from '../src/uploads/ledger.js';
import { createTestDb } from './support/testDb.js';

function entry(over: Partial<TvhDvrEntry> = {}): TvhDvrEntry {
  return {
    uuid: 'dvr-1',
    channelname: 'KBS1',
    start: 1000,
    stop: 2000,
    disp_title: 'News',
    ...over,
  } as TvhDvrEntry;
}

async function makeLedger(overlapThreshold = 0.7) {
  const { db, destroy } = await createTestDb();
  const ledger = new UploadLedger(db, overlapThreshold);
  return { ledger, destroy };
}

describe('UploadLedger.claim', () => {
  it('claims a fresh identity', async () => {
    const { ledger, destroy } = await makeLedger();
    const res = await ledger.claim('tyo1', entry(), '/rec/a.ts', 'gdrive:arc/a.ts');
    expect(res.claimed).toBe(true);
    expect(res.upload?.status).toBe('queued');
    await destroy();
  });

  it('does not claim a duplicate (same channel + overlapping window) and returns the existing job', async () => {
    const { ledger, destroy } = await makeLedger();
    const first = await ledger.claim('tyo1', entry({ uuid: 'dvr-1' }), '/rec/a.ts', 'gdrive:arc/a.ts');
    expect(first.claimed).toBe(true);

    // second instance's copy of the same broadcast: different uuid, same
    // channel/near-identical window — must be recognized as a duplicate
    const second = await ledger.claim(
      'osk1',
      entry({ uuid: 'dvr-2', start: 1005, stop: 2005 }),
      '/rec/b.ts',
      'gdrive:arc/b.ts',
    );
    expect(second.claimed).toBe(false);
    expect(second.existing?.id).toBe(first.upload?.id);
    await destroy();
  });

  it('claims a non-overlapping broadcast on the same channel independently', async () => {
    const { ledger, destroy } = await makeLedger();
    await ledger.claim('tyo1', entry({ uuid: 'dvr-1', start: 1000, stop: 2000 }), '/rec/a.ts', 'gdrive:arc/a.ts');
    const res = await ledger.claim(
      'tyo1',
      entry({ uuid: 'dvr-3', start: 5000, stop: 6000 }),
      '/rec/c.ts',
      'gdrive:arc/c.ts',
    );
    expect(res.claimed).toBe(true);
    await destroy();
  });

  it('manual overwrite bypasses dedup entirely', async () => {
    const { ledger, destroy } = await makeLedger();
    await ledger.claim('tyo1', entry({ uuid: 'dvr-1' }), '/rec/a.ts', 'gdrive:arc/a.ts');
    const res = await ledger.claim('tyo1', entry({ uuid: 'dvr-1' }), '/rec/a2.ts', 'gdrive:arc/a.ts', {
      overwrite: true,
    });
    expect(res.claimed).toBe(true);
    await destroy();
  });
});

describe('UploadLedger.findAllByIdentity', () => {
  it('returns every row (any status) covering the broadcast', async () => {
    const { ledger, destroy } = await makeLedger();
    const claimed = await ledger.claim('tyo1', entry({ uuid: 'dvr-1' }), '/rec/a.ts', 'gdrive:arc/a.ts');
    await ledger.update(claimed.upload!.id, { status: 'failed', failure_kind: 'permanent' });

    const rows = await ledger.findAllByIdentity({ channelname: 'KBS1', start: 1000, stop: 2000, title: 'News' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(claimed.upload!.id);
    expect(rows[0]?.status).toBe('failed');
    await destroy();
  });

  it('excludes non-overlapping or different-channel rows', async () => {
    const { ledger, destroy } = await makeLedger();
    await ledger.claim('tyo1', entry({ uuid: 'dvr-1', channelname: 'MBC1' }), '/rec/a.ts', 'gdrive:arc/a.ts');
    const rows = await ledger.findAllByIdentity({ channelname: 'KBS1', start: 1000, stop: 2000 });
    expect(rows).toHaveLength(0);
    await destroy();
  });
});

describe('UploadLedger.listRetriable', () => {
  it('only returns failed + transient rows under the retry cap', async () => {
    const { ledger, destroy } = await makeLedger();

    const transientUnderCap = await ledger.claim(
      'tyo1',
      entry({ uuid: 'dvr-1' }),
      '/rec/a.ts',
      'gdrive:arc/a.ts',
    );
    await ledger.update(transientUnderCap.upload!.id, {
      status: 'failed',
      failure_kind: 'transient',
      auto_retries: 1,
    });

    const transientOverCap = await ledger.claim(
      'tyo1',
      entry({ uuid: 'dvr-2', start: 9000, stop: 9500 }),
      '/rec/b.ts',
      'gdrive:arc/b.ts',
    );
    await ledger.update(transientOverCap.upload!.id, {
      status: 'failed',
      failure_kind: 'transient',
      auto_retries: 3,
    });

    const permanent = await ledger.claim(
      'tyo1',
      entry({ uuid: 'dvr-3', start: 20000, stop: 20500 }),
      '/rec/c.ts',
      'gdrive:arc/c.ts',
    );
    await ledger.update(permanent.upload!.id, { status: 'failed', failure_kind: 'permanent', auto_retries: 0 });

    const stillQueued = await ledger.claim(
      'tyo1',
      entry({ uuid: 'dvr-4', start: 30000, stop: 30500 }),
      '/rec/d.ts',
      'gdrive:arc/d.ts',
    );
    void stillQueued;

    const retriable = await ledger.listRetriable(3);
    expect(retriable.map((r) => r.id)).toEqual([transientUnderCap.upload!.id]);
    await destroy();
  });
});

describe('UploadLedger.supersede', () => {
  it('marks a row superseded', async () => {
    const { ledger, destroy } = await makeLedger();
    const claimed = await ledger.claim('tyo1', entry({ uuid: 'dvr-1' }), '/rec/a.ts', 'gdrive:arc/a.ts');
    await ledger.supersede(claimed.upload!.id);
    const row = await ledger.get(claimed.upload!.id);
    expect(row?.status).toBe('superseded');
    await destroy();
  });
});
