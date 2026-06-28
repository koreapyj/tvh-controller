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
import Fastify, { type FastifyInstance } from 'fastify';
import type { RecordingBatchResult, TvhDvrEntry } from '@tvhc/shared';
import { registerRecordingsRoutes } from '../src/routes/recordings.js';
import type { AppContext } from '../src/routes/context.js';

function entry(uuid: string, over: Partial<TvhDvrEntry> = {}): TvhDvrEntry {
  return { uuid, start: 0, stop: 0, enabled: true, ...over };
}

interface FakeState {
  upcoming: TvhDvrEntry[];
  finished: TvhDvrEntry[];
  failed: TvhDvrEntry[];
}

function makeCtx(opts: {
  state: FakeState;
  onSave?: (node: { uuid: string[] } & Record<string, unknown>) => void;
  onDelete?: (uuids: string[]) => void;
  /** simulate tvheadend's effect (or lack thereof) — runs during pollDvrAndStatus read-back */
  applyOnPoll?: () => void;
}): { ctx: AppContext; idnodeSave: ReturnType<typeof vi.fn>; idnodeDelete: ReturnType<typeof vi.fn> } {
  const idnodeSave = vi.fn(async (node: { uuid: string[] } & Record<string, unknown>) => {
    opts.onSave?.(node);
  });
  const idnodeDelete = vi.fn(async (uuids: string[]) => {
    opts.onDelete?.(uuids);
  });
  const pollDvrAndStatus = vi.fn(async () => {
    opts.applyOnPoll?.();
  });
  const poller = { client: { idnodeSave, idnodeDelete }, pollDvrAndStatus };
  const pollers = new Map<string, unknown>([['n1', poller]]);
  const cache = { get: () => opts.state };
  const ctx = { cache, pollers } as unknown as AppContext;
  return { ctx, idnodeSave, idnodeDelete };
}

async function build(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify();
  registerRecordingsRoutes(app, ctx);
  await app.ready();
  return app;
}

async function postEdit(app: FastifyInstance, ops: unknown): Promise<{ status: number; body: RecordingBatchResult[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/recordings/edit',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ ops }),
  });
  return { status: res.statusCode, body: res.statusCode === 200 ? (res.json() as RecordingBatchResult[]) : [] };
}

describe('POST /api/recordings/edit', () => {
  it('rejects fields not on the allowlist', async () => {
    const state: FakeState = { upcoming: [entry('a')], finished: [], failed: [] };
    const { ctx } = makeCtx({ state });
    const app = await build(ctx);
    const res = await postEdit(app, [{ instanceId: 'n1', uuids: ['a'], fields: { title: 'hijack' } }]);
    expect(res.status).toBe(400);
    await app.close();
  });

  it('batches the uuids into a single idnodeSave and verifies via read-back', async () => {
    const state: FakeState = { upcoming: [entry('a'), entry('b')], finished: [], failed: [] };
    let saved: ({ uuid: string[] } & Record<string, unknown>) | null = null;
    const { ctx, idnodeSave } = makeCtx({
      state,
      onSave: (node) => {
        saved = node;
      },
      applyOnPoll: () => {
        state.upcoming = state.upcoming.map((e) => ({ ...e, enabled: false }));
      },
    });
    const app = await build(ctx);
    const res = await postEdit(app, [{ instanceId: 'n1', uuids: ['a', 'b'], fields: { enabled: false } }]);
    expect(idnodeSave).toHaveBeenCalledTimes(1);
    expect(Array.isArray(saved!.uuid)).toBe(true);
    expect(saved!.uuid).toEqual(['a', 'b']);
    expect(saved!.enabled).toBe(false);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((r) => r.ok)).toBe(true);
    await app.close();
  });

  it('reports a failure when the write does not actually take effect (no silent desync)', async () => {
    const state: FakeState = { upcoming: [entry('a')], finished: [], failed: [] };
    // idnodeSave resolves but tvheadend state never changes (applyOnPoll is a no-op)
    const { ctx } = makeCtx({ state, applyOnPoll: () => {} });
    const app = await build(ctx);
    const res = await postEdit(app, [{ instanceId: 'n1', uuids: ['a'], fields: { enabled: false } }]);
    expect(res.body[0].ok).toBe(false);
    expect(res.body[0].error).toMatch(/did not apply/);
    await app.close();
  });

  it('reports the real error when the instance write throws (e.g. unreachable host)', async () => {
    const state: FakeState = { upcoming: [entry('a')], finished: [], failed: [] };
    const { ctx } = makeCtx({
      state,
      onSave: () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const app = await build(ctx);
    const res = await postEdit(app, [{ instanceId: 'n1', uuids: ['a'], fields: { enabled: false } }]);
    expect(res.body[0].ok).toBe(false);
    expect(res.body[0].error).toMatch(/ECONNREFUSED/);
    await app.close();
  });

  it('flags uuids that do not exist on the instance', async () => {
    const state: FakeState = { upcoming: [entry('a')], finished: [], failed: [] };
    const { ctx, idnodeSave } = makeCtx({ state, applyOnPoll: () => {} });
    const app = await build(ctx);
    const res = await postEdit(app, [{ instanceId: 'n1', uuids: ['ghost'], fields: { enabled: false } }]);
    expect(idnodeSave).not.toHaveBeenCalled();
    expect(res.body[0]).toMatchObject({ uuid: 'ghost', ok: false });
    await app.close();
  });
});

describe('POST /api/recordings/delete', () => {
  async function postDelete(app: FastifyInstance, targets: unknown): Promise<RecordingBatchResult[]> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/recordings/delete',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ targets }),
    });
    return res.json() as RecordingBatchResult[];
  }

  it('deletes and confirms the entry is gone', async () => {
    const state: FakeState = { upcoming: [entry('a')], finished: [], failed: [] };
    const { ctx, idnodeDelete } = makeCtx({
      state,
      onDelete: (uuids) => {
        state.upcoming = state.upcoming.filter((e) => !uuids.includes(e.uuid));
      },
    });
    const app = await build(ctx);
    const body = await postDelete(app, [{ instanceId: 'n1', uuid: 'a' }]);
    expect(idnodeDelete).toHaveBeenCalledWith(['a']);
    expect(body[0].ok).toBe(true);
    await app.close();
  });

  it('reports failure when the entry is still present after delete (autorec re-created it)', async () => {
    const state: FakeState = { upcoming: [entry('a', { autorec: 'rule-1' })], finished: [], failed: [] };
    const { ctx } = makeCtx({ state, onDelete: () => {} }); // entry stays
    const app = await build(ctx);
    const body = await postDelete(app, [{ instanceId: 'n1', uuid: 'a' }]);
    expect(body[0].ok).toBe(false);
    expect(body[0].error).toMatch(/still present/);
    await app.close();
  });
});
