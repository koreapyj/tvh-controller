/*
 * Fakes at the same boundary as test/recordings.test.ts: SyncEngine only ever
 * calls poller.client.{autorecGrid,autorecCreate,idnodeSave,idnodeDelete} and
 * poller.{pollTopology,pollAutorecs}. These fakes implement exactly that
 * surface over a mutable in-memory TvhAutorecRule list — no network, no real
 * TvhClient.
 */

import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { TvhAutorecRule } from '@tvhc/shared';
import { TvhApiError } from '../../src/tvh/client.js';
import type { InstanceCache } from '../../src/state/instanceCache.js';

export interface FakeTvhClient {
  /** live backing store — mutate directly to simulate out-of-band instance changes */
  rules: TvhAutorecRule[];
  /** when set, idnodeDelete on this uuid throws a 404-shaped TvhApiError instead of deleting */
  failDeleteUuid: string | null;
  autorecGrid: ReturnType<typeof vi.fn<() => Promise<TvhAutorecRule[]>>>;
  autorecCreate: ReturnType<typeof vi.fn<(conf: object) => Promise<string>>>;
  idnodeSave: ReturnType<typeof vi.fn<(node: object) => Promise<void>>>;
  idnodeDelete: ReturnType<typeof vi.fn<(uuid: string | string[]) => Promise<void>>>;
}

/** fresh fake TvhClient over `initial` (copied, never mutated by the caller's array). */
export function fakeTvhClient(initial: TvhAutorecRule[] = []): FakeTvhClient {
  const client: FakeTvhClient = {
    rules: initial.map((r) => ({ ...r })),
    failDeleteUuid: null,
    autorecGrid: vi.fn(async () => client.rules.map((r) => ({ ...r }))),
    autorecCreate: vi.fn(async (conf: object) => {
      const uuid = randomUUID();
      client.rules.push({ ...(conf as TvhAutorecRule), uuid });
      return uuid;
    }),
    idnodeSave: vi.fn(async (node: object) => {
      const { uuid, ...rest } = node as { uuid: string } & Record<string, unknown>;
      const idx = client.rules.findIndex((r) => r.uuid === uuid);
      if (idx === -1) throw new TvhApiError(404, '/api/idnode/save', 'not found');
      const existing = client.rules[idx]!;
      client.rules[idx] = { ...existing, ...rest, uuid };
    }),
    idnodeDelete: vi.fn(async (uuid: string | string[]) => {
      const uuids = Array.isArray(uuid) ? uuid : [uuid];
      for (const u of uuids) {
        if (client.failDeleteUuid === u) {
          throw new TvhApiError(404, '/api/idnode/delete', `no such rule ${u}`);
        }
      }
      client.rules = client.rules.filter((r) => !uuids.includes(r.uuid));
    }),
  };
  return client;
}

export interface FakePoller {
  client: FakeTvhClient;
  pollTopology: ReturnType<typeof vi.fn<() => Promise<void>>>;
  pollAutorecs: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

/**
 * Poller stand-in shaped like what sync/engine.ts uses: `poller.client`,
 * `poller.pollTopology()`, `poller.pollAutorecs()`. `pollAutorecs` mirrors the
 * real InstancePoller by refreshing the cache snapshot from the client.
 */
export function fakePoller(cache: InstanceCache, instanceId: string, client: FakeTvhClient): FakePoller {
  return {
    client,
    pollTopology: vi.fn(async () => {}),
    pollAutorecs: vi.fn(async () => {
      cache.get(instanceId).autorecs = await client.autorecGrid();
    }),
  };
}
