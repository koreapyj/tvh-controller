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

import { describe, expect, it, vi } from 'vitest';
import type { TvhDvrEntry, UploadJob } from '@tvhc/shared';
import { EventBus } from '../src/state/events.js';
import { RcloneRcError } from '../src/uploads/rcloneRc.js';
import {
  UploadDispatcher,
  isTransientRcError,
  rcErrorText,
  tempRemotePath,
} from '../src/uploads/dispatcher.js';

describe('isTransientRcError', () => {
  it('treats network/non-HTTP throws and 5xx as transient', () => {
    expect(isTransientRcError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientRcError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientRcError(new RcloneRcError(0, '/x', 'no response'))).toBe(true);
    expect(isTransientRcError(new RcloneRcError(503, '/x', 'busy'))).toBe(true);
  });

  it('treats 4xx as terminal (bad path/request)', () => {
    expect(isTransientRcError(new RcloneRcError(400, '/x', 'bad'))).toBe(false);
    expect(isTransientRcError(new RcloneRcError(404, '/x', 'missing'))).toBe(false);
  });
});

describe('rcErrorText', () => {
  it('surfaces a network syscall code as-is', () => {
    const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(rcErrorText(e)).toContain('ECONNREFUSED');
  });
  it('uses the RcloneRcError message (with the failing path)', () => {
    expect(rcErrorText(new RcloneRcError(500, '/operations/stat', 'boom'))).toContain(
      'operations/stat',
    );
  });
});

describe('tempRemotePath', () => {
  it('derives a deterministic per-upload temp object from the final path', () => {
    const job = { id: 'abcdef12-3456', remotePath: 'gdrive:arc/Show/file.ts' };
    expect(tempRemotePath(job)).toBe('gdrive:arc/Show/file.ts.tvhc-part-abcdef12');
  });
});

// --- in-memory ledger + stub client to drive the state machine ---------------

const SNAKE_TO_CAMEL: Record<string, string> = {
  rclone_job_id: 'rcloneJobId',
  failure_kind: 'failureKind',
  auto_retries: 'autoRetries',
  completed_at: 'completedAt',
};

class FakeLedger {
  jobs = new Map<string, UploadJob>();
  preExisting: UploadJob[] = [];
  seenErrors: string[] = [];
  private seq = 0;

  async claim(
    instanceId: string,
    entry: TvhDvrEntry,
    localPath: string,
    remotePath: string,
    opts: { origin?: string; incompletePick?: boolean; supersedesPath?: string | null } = {},
  ) {
    const id = `job${++this.seq}`;
    const job = {
      id,
      instanceId,
      dvrUuid: entry.uuid,
      title: entry.disp_title ?? null,
      channelname: entry.channelname ?? '',
      start: entry.start,
      stop: entry.stop,
      filesize: entry.filesize ?? null,
      localPath,
      remotePath,
      status: 'queued',
      progress: 0,
      rcloneJobId: null,
      attempts: 0,
      error: null,
      possibleDuplicate: false,
      origin: opts.origin ?? 'manual',
      incompletePick: !!opts.incompletePick,
      supersedesPath: opts.supersedesPath ?? null,
      failureKind: null,
      autoRetries: 0,
      createdAt: '',
      updatedAt: new Date().toISOString(),
      completedAt: null,
    } as unknown as UploadJob;
    this.jobs.set(id, job);
    return { claimed: true as const, upload: job };
  }

  async get(id: string) {
    return this.jobs.get(id) ?? null;
  }

  async update(id: string, patch: Record<string, unknown>) {
    if (typeof patch.error === 'string') this.seenErrors.push(patch.error);
    const j = this.jobs.get(id) as unknown as Record<string, unknown> | undefined;
    if (!j) return;
    for (const [k, v] of Object.entries(patch)) j[SNAKE_TO_CAMEL[k] ?? k] = v;
    j.updatedAt = new Date().toISOString();
  }

  async listByStatuses(s: string[]) {
    return [...this.jobs.values()].filter((j) => s.includes(j.status));
  }

  async listRetriable(max: number) {
    return [...this.jobs.values()].filter(
      (j) => j.status === 'failed' && j.failureKind === 'transient' && j.autoRetries < max,
    );
  }

  async findAllByIdentity() {
    return this.preExisting;
  }

  async supersede(id: string) {
    await this.update(id, { status: 'superseded' });
  }
}

function entry(over: Partial<TvhDvrEntry> = {}): TvhDvrEntry {
  return {
    uuid: 'a1',
    channelname: 'ch',
    start: 1000,
    stop: 2800,
    disp_title: 'Show',
    filename: '/rec/show.ts',
    filesize: 100,
    errors: 0,
    data_errors: 0,
    ...over,
  } as TvhDvrEntry;
}

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

function makeDispatcher(ledger: FakeLedger, logs?: LoggedEvent[]) {
  const cfg = {
    instances: [{ id: 'tyo1', rclone: { rcUrl: 'http://x' } }],
    rclone: { remote: 'gdrive:arc' },
  } as never;
  const events = logs ? { log: (e: LoggedEvent) => logs.push(e) } : undefined;
  const dispatcher = new UploadDispatcher(cfg, ledger as never, new EventBus(), events);
  return dispatcher;
}

/** stub rclone client whose temp object verifies as soon as the copy finishes */
function makeClient(order: string[]) {
  return {
    mapLocalPath: (p: string) => p,
    localSize: vi.fn(async () => 100),
    remoteSize: vi.fn(async (p: string) => (p.includes('.tvhc-part-') ? 100 : null)),
    startCopy: vi.fn(async () => 1),
    jobStatus: vi.fn(async () => ({ finished: true, success: true, error: null })),
    jobStats: vi.fn(async () => ({})),
    stopJob: vi.fn(async () => {}),
    deleteFile: vi.fn(async (p: string) => {
      order.push(`delete:${p.includes('.tvhc-part-') ? 'temp' : 'final'}`);
    }),
    moveFile: vi.fn(async () => {
      order.push('move');
    }),
  };
}

describe('UploadDispatcher temp-then-swap commit (Part 5)', () => {
  it('copies to a temp object, then on verify deletes the final and moves temp in', async () => {
    const ledger = new FakeLedger();
    const dispatcher = makeDispatcher(ledger);
    const order: string[] = [];
    const client = makeClient(order);
    (dispatcher as unknown as { clients: Map<string, unknown> }).clients.set('tyo1', client);

    const { job } = await dispatcher.enqueue('tyo1', entry(), []);
    await (dispatcher as unknown as { instanceQueues: Map<string, Promise<void>> }).instanceQueues.get(
      'tyo1',
    );

    const tempArg = client.startCopy.mock.calls[0]![1] as string;
    expect(tempArg).toContain('.tvhc-part-');
    // commit order: drop the old final object, then rename the verified temp in
    expect(order).toEqual(['delete:final', 'move']);
    expect(client.moveFile).toHaveBeenCalledWith(tempArg, expect.not.stringContaining('.tvhc-part-'));
    expect(ledger.jobs.get(job!.id)!.status).toBe('done');
    await dispatcher.stop(0);
  });
});

describe('UploadDispatcher manual overwrite (Part 4)', () => {
  it('cancels an in-flight copy and supersedes a done copy of the same programme', async () => {
    const ledger = new FakeLedger();
    const done = {
      id: 'old-done',
      instanceId: 'tyo1',
      dvrUuid: 'old1',
      status: 'done',
      remotePath: 'gdrive:arc/Show/old.ts',
    } as unknown as UploadJob;
    const inflight = {
      id: 'old-inflight',
      instanceId: 'tyo1',
      dvrUuid: 'old2',
      status: 'uploading',
      rcloneJobId: 5,
      remotePath: 'gdrive:arc/Show/old.ts',
    } as unknown as UploadJob;
    ledger.jobs.set(done.id, done);
    ledger.jobs.set(inflight.id, inflight);
    ledger.preExisting = [done, inflight];

    const dispatcher = makeDispatcher(ledger);
    const client = makeClient([]);
    (dispatcher as unknown as { clients: Map<string, unknown> }).clients.set('tyo1', client);

    const { job } = await dispatcher.enqueue('tyo1', entry({ uuid: 'new1' }), [], {
      origin: 'manual',
      overwrite: true,
    });
    await (dispatcher as unknown as { instanceQueues: Map<string, Promise<void>> }).instanceQueues.get(
      'tyo1',
    );

    expect(ledger.jobs.get('old-done')!.status).toBe('superseded');
    expect(ledger.jobs.get('old-inflight')!.status).toBe('cancelled');
    expect(client.stopJob).toHaveBeenCalledWith(5);
    expect(job!.id).not.toBe('old-inflight');
    await dispatcher.stop(0);
  });
});

describe('UploadDispatcher transient-error reporting', () => {
  it('reports a connection failure as-is (not "file not found") and retries to success', async () => {
    vi.useFakeTimers();
    try {
      const ledger = new FakeLedger();
      const dispatcher = makeDispatcher(ledger);
      const order: string[] = [];
      const client = makeClient(order);
      let calls = 0;
      client.localSize = vi.fn(async () => {
        // first reachability check fails as if the rcd were firewalled off
        if (++calls === 1) {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }
        return 100;
      });
      (dispatcher as unknown as { clients: Map<string, unknown> }).clients.set('tyo1', client);

      const { job } = await dispatcher.enqueue('tyo1', entry(), []);
      await vi.advanceTimersByTimeAsync(6_000); // let the transient backoff elapse
      await (dispatcher as unknown as { instanceQueues: Map<string, Promise<void>> }).instanceQueues.get('tyo1');

      // the real cause was surfaced, the misleading message never was
      expect(ledger.seenErrors.some((e) => e.includes('ECONNREFUSED'))).toBe(true);
      expect(ledger.seenErrors.some((e) => /file not found/i.test(e))).toBe(false);
      // and once the rcd was reachable again it completed without manual help
      expect(ledger.jobs.get(job!.id)!.status).toBe('done');
      await dispatcher.stop(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UploadDispatcher auto-retry sweep (Part 2b)', () => {
  it('re-drives a transient failure past its backoff and never a permanent one', async () => {
    const ledger = new FakeLedger();
    const base = {
      instanceId: 'tyo1',
      remotePath: 'gdrive:arc/Show/f.ts',
      localPath: '/rec/show.ts',
      filesize: 100,
      attempts: 0,
      autoRetries: 0,
    };
    const transient = {
      ...base,
      id: 't1',
      status: 'failed',
      failureKind: 'transient',
      updatedAt: new Date(0).toISOString(),
    } as unknown as UploadJob;
    const permanent = {
      ...base,
      id: 'p1',
      status: 'failed',
      failureKind: 'permanent',
      updatedAt: new Date(0).toISOString(),
    } as unknown as UploadJob;
    ledger.jobs.set('t1', transient);
    ledger.jobs.set('p1', permanent);

    const dispatcher = makeDispatcher(ledger);
    const client = makeClient([]);
    (dispatcher as unknown as { clients: Map<string, unknown> }).clients.set('tyo1', client);

    await (dispatcher as unknown as { sweepRetries: () => Promise<void> }).sweepRetries();
    await (dispatcher as unknown as { instanceQueues: Map<string, Promise<void>> }).instanceQueues.get(
      'tyo1',
    );

    // the transient row was re-driven (auto_retries bumped, drove to done)
    expect(ledger.jobs.get('t1')!.autoRetries).toBe(1);
    expect(ledger.jobs.get('t1')!.status).toBe('done');
    // the permanent row was untouched
    expect(ledger.jobs.get('p1')!.status).toBe('failed');
    await dispatcher.stop(0);
  });
});

describe('UploadDispatcher event-log emission (site #12)', () => {
  /** drives the private publish() choke point directly against a synthetic ledger row */
  async function publishJob(dispatcher: UploadDispatcher, ledger: FakeLedger, j: Partial<UploadJob>): Promise<void> {
    const merged = { ...(ledger.jobs.get(j.id as string) ?? {}), ...j } as UploadJob;
    ledger.jobs.set(merged.id, merged);
    await (dispatcher as unknown as { publish: (id: string) => Promise<void> }).publish(merged.id);
  }

  it('logs exactly one warning on the transition into failed, and nothing for repeated progress publishes', async () => {
    const ledger = new FakeLedger();
    const logs: LoggedEvent[] = [];
    const dispatcher = makeDispatcher(ledger, logs);

    await publishJob(dispatcher, ledger, { id: 'u1', instanceId: 'tyo1', title: 'Show', status: 'uploading', progress: 10 });
    await publishJob(dispatcher, ledger, { id: 'u1', status: 'uploading', progress: 50 }); // progress-only
    await publishJob(dispatcher, ledger, { id: 'u1', status: 'uploading', progress: 90 }); // progress-only
    expect(logs).toHaveLength(0);

    await publishJob(dispatcher, ledger, {
      id: 'u1',
      status: 'failed',
      failureKind: 'permanent',
      error: 'size mismatch',
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'warning', service: 'uploads', source: 'instance.tyo1' });
    expect(logs[0]!.message).toContain('Show');
    expect(logs[0]!.message).toContain('size mismatch');

    // a duplicate publish while still failed must not re-log
    await publishJob(dispatcher, ledger, { id: 'u1', status: 'failed', failureKind: 'permanent', error: 'size mismatch' });
    expect(logs).toHaveLength(1);

    await dispatcher.stop(0);
  });

  it('logs a normal on done', async () => {
    const ledger = new FakeLedger();
    const logs: LoggedEvent[] = [];
    const dispatcher = makeDispatcher(ledger, logs);

    await publishJob(dispatcher, ledger, { id: 'u2', instanceId: 'tyo1', title: 'Show', status: 'uploading' });
    await publishJob(dispatcher, ledger, { id: 'u2', status: 'verifying' });
    await publishJob(dispatcher, ledger, { id: 'u2', status: 'done' });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'normal', service: 'uploads', source: 'instance.tyo1' });
    expect(logs[0]!.message).toContain('Show');
    expect(logs[0]!.message).toMatch(/done/);

    await dispatcher.stop(0);
  });

  it('logs a normal on auto-retry (failed -> verifying with autoRetries bumped) via the REAL sweepRetries() path, but not on a manual retry (autoRetries unchanged)', async () => {
    const ledger = new FakeLedger();
    const logs: LoggedEvent[] = [];
    const dispatcher = makeDispatcher(ledger, logs);
    const client = makeClient([]);
    (dispatcher as unknown as { clients: Map<string, unknown> }).clients.set('tyo1', client);

    await publishJob(dispatcher, ledger, {
      id: 'u3',
      instanceId: 'tyo1',
      title: 'Show',
      status: 'failed',
      failureKind: 'transient',
      error: 'rcd unreachable',
      autoRetries: 0,
    });
    expect(logs).toHaveLength(1); // the initial failure warning

    // manual retry(): status -> verifying, autoRetries untouched — must NOT log
    await publishJob(dispatcher, ledger, { id: 'u3', status: 'verifying', autoRetries: 0 });
    expect(logs).toHaveLength(1);

    // fail again with the backoff already elapsed (updatedAt far in the
    // past) — a retriable row for the REAL sweepRetries() path below
    await publishJob(dispatcher, ledger, {
      id: 'u3',
      instanceId: 'tyo1',
      localPath: '/rec/show.ts',
      remotePath: 'gdrive:arc/Show/f.ts',
      filesize: 100,
      status: 'failed',
      failureKind: 'transient',
      error: 'rcd unreachable',
      autoRetries: 0,
      updatedAt: new Date(0).toISOString(),
    });
    expect(logs).toHaveLength(2);

    // exercise the production sweep path directly (private-access pattern
    // already used elsewhere in this file) instead of hand-publishing the
    // 'verifying' transition — this is the exact path that used to bypass
    // publish() and so never emitted the site #12 event
    await (dispatcher as unknown as { sweepRetries: () => Promise<void> }).sweepRetries();
    await (dispatcher as unknown as { instanceQueues: Map<string, Promise<void>> }).instanceQueues.get(
      'tyo1',
    );

    expect(ledger.jobs.get('u3')!.autoRetries).toBe(1);
    const autoRetryLogs = logs.filter((l) => l.message.includes('auto-retry'));
    expect(autoRetryLogs).toHaveLength(1);
    expect(autoRetryLogs[0]).toMatchObject({ type: 'normal', service: 'uploads', source: 'instance.tyo1' });

    await dispatcher.stop(0);
  });
});
