/*
 * SyncEngine tests over the hermetic in-memory SQLite harness (test/support/*).
 * No network, no real TvhClient, no mysql2 pool — everything here is either
 * the real InstanceCache/EventBus or a fake at the poller/client boundary
 * (mirrors the style of test/recordings.test.ts).
 */

import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../src/db/schema.js';
import type { InstancePoller } from '../src/tvh/poller.js';
import { SyncEngine } from '../src/sync/engine.js';
import { InstanceCache } from '../src/state/instanceCache.js';
import { EventBus } from '../src/state/events.js';
import { normalizePayload, normalizeRule, payloadHash } from '../src/sync/normalize.js';
import { createTestDb } from './support/testDb.js';
import { fakePoller, fakeTvhClient, type FakePoller, type FakeTvhClient } from './support/fakePoller.js';
import {
  TS,
  masterRulePayload,
  nameMaps,
  seedIgnoredOrphan,
  seedMasterRule,
  topologySnapshot,
  tvhAutorecRule,
} from './support/fixtures.js';

interface LoggedEvent {
  type: 'normal' | 'warning';
  service: string;
  source: string;
  message: string;
}

interface Harness {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
  cache: InstanceCache;
  engine: SyncEngine;
  clients: Map<string, FakeTvhClient>;
  pollers: Map<string, FakePoller>;
  logs: LoggedEvent[];
}

async function setup(instanceIds: string[] = ['tyo1', 'osk1']): Promise<Harness> {
  const { db, destroy } = await createTestDb();
  const cache = new InstanceCache();
  const bus = new EventBus();
  const enginePollers = new Map<string, InstancePoller>();
  const fakePollers = new Map<string, FakePoller>();
  const clients = new Map<string, FakeTvhClient>();
  for (const id of instanceIds) {
    cache.init(id, id, `http://${id}`);
    const snap = cache.get(id);
    snap.summary.reachable = true;
    snap.autorecsLoaded = true;
    snap.topology = topologySnapshot();
    const client = fakeTvhClient();
    clients.set(id, client);
    const poller = fakePoller(cache, id, client);
    fakePollers.set(id, poller);
    enginePollers.set(id, poller as unknown as InstancePoller);
  }
  const logs: LoggedEvent[] = [];
  const engine = new SyncEngine(db, cache, enginePollers, bus, { log: (e) => logs.push(e) });
  return { db, destroy, cache, engine, clients, pollers: fakePollers, logs };
}

async function getBinding(db: Kysely<Database>, masterRuleId: string, instanceId: string) {
  return db
    .selectFrom('rule_bindings')
    .selectAll()
    .where('master_rule_id', '=', masterRuleId)
    .where('instance_id', '=', instanceId)
    .executeTakeFirst();
}

// ---------- 1. push happy path ----------

describe('pushRule: happy path', () => {
  it('stores the master hash and a pushed hash computed from the normalized read-back, plus the binding row', async () => {
    const { db, destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', channel: 'KBS1', title: '^News' }),
    });

    const [result] = await engine.pushRule(rule.id);
    expect(result?.action).toBe('created');

    const client = clients.get('tyo1')!;
    expect(client.autorecCreate).toHaveBeenCalledTimes(1);
    expect(client.rules).toHaveLength(1);
    const stored = client.rules[0]!;

    const binding = await getBinding(db, rule.id, 'tyo1');
    expect(binding).toBeTruthy();
    expect(binding!.tvh_uuid).toBe(stored.uuid);
    expect(binding!.master_hash).toBe(payloadHash(rule.payload));
    // pushed_hash must come from the normalized READ-BACK, not the raw payload.
    // createRule's write-time normalization already pinned the null number to
    // KBS1's lowest-numbered channel (#1), so the read-back matches the master
    // directly — no channelNumberTolerated fold is needed here
    const readBack = normalizeRule(stored, nameMaps());
    expect(readBack.channel_number).toBe('1');
    expect(rule.payload.channel_number).toBe('1');
    expect(binding!.pushed_hash).toBe(payloadHash(readBack));

    await destroy();
  });
});

// ---------- 2. push idempotency ----------

describe('pushRule: idempotency', () => {
  it('a second push is skipped and makes no further tvh calls', async () => {
    const { destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    client.autorecCreate.mockClear();
    client.idnodeSave.mockClear();
    client.autorecGrid.mockClear();

    const [result] = await engine.pushRule(rule.id);
    expect(result?.action).toBe('skipped');
    expect(client.autorecCreate).not.toHaveBeenCalled();
    expect(client.idnodeSave).not.toHaveBeenCalled();
    expect(client.autorecGrid).not.toHaveBeenCalled();

    await destroy();
  });
});

// ---------- 3. push update path ----------

describe('pushRule: update path', () => {
  it('a changed payload calls idnodeSave (not autorecCreate); the composite-PK binding re-upsert persists', async () => {
    const { db, destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'v1' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const firstUuid = client.rules[0]!.uuid;

    await engine.updateRule(rule.id, {
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'v2' }),
    });
    const [result] = await engine.pushRule(rule.id);

    expect(result?.action).toBe('updated');
    expect(client.autorecCreate).toHaveBeenCalledTimes(1); // only the original create
    expect(client.idnodeSave).toHaveBeenCalledTimes(1);
    expect(client.rules).toHaveLength(1); // in-place update, no duplicate rule
    expect(client.rules[0]!.uuid).toBe(firstUuid);
    expect(client.rules[0]!.title).toBe('v2');

    // exactly one binding row: the onDuplicateKeyUpdate/ON CONFLICT upsert
    // must have updated in place rather than throwing a PK violation
    const rows = await db
      .selectFrom('rule_bindings')
      .selectAll()
      .where('master_rule_id', '=', rule.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tvh_uuid).toBe(firstUuid);

    await destroy();
  });
});

// ---------- 4. push blocked by unknown names ----------

describe('pushRule: blocked by unknown channel/tag/config_name', () => {
  it('short-circuits before any tvh call', async () => {
    const { destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'Ghost',
      instances: 'all',
      payload: masterRulePayload({ name: 'Ghost', channel: 'Nonexistent Channel' }),
    });

    const [result] = await engine.pushRule(rule.id);
    expect(result?.action).toBe('blocked');
    expect(result?.detail).toMatch(/not found/);

    const client = clients.get('tyo1')!;
    expect(client.autorecCreate).not.toHaveBeenCalled();
    expect(client.idnodeSave).not.toHaveBeenCalled();
    expect(client.autorecGrid).not.toHaveBeenCalled();

    await destroy();
  });
});

// ---------- 5. linked clone create + effective resolution ----------

describe('createClone: linked clone', () => {
  it('edits land in the overlay, not the payload; effective resolution merges parent + overlay', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const parent = await engine.createRule({
      name: 'Parent',
      instances: 'all',
      payload: masterRulePayload({ name: 'Parent', channel: 'KBS1', title: 'Parent Title', pri: 6 }),
    });

    const clone = await engine.createClone(parent.id, true, 'Clone A');
    expect(clone.parentId).toBe(parent.id);
    expect(clone.overlay).toEqual({});
    expect(clone.payload).toEqual({}); // placeholder — never the resolved payload

    await engine.updateRule(clone.id, {
      name: 'Clone A',
      instances: clone.instances,
      parentId: parent.id,
      overlay: { channel: 'MBC1' },
    });

    const resolved = await engine.listResolved();
    const effClone = resolved.find((r) => r.id === clone.id)!;
    expect(effClone.payload).toEqual({}); // payload still untouched
    // overlay overriding the channel with no explicit number is write-time
    // pinned to the lowest-numbered MBC1 channel (#2), same as a plain rule
    expect(effClone.overlay).toEqual({ channel: 'MBC1', channel_number: '2' });
    expect(effClone.effective?.channel).toBe('MBC1'); // overridden
    expect(effClone.effective?.title).toBe('Parent Title'); // inherited
    expect(effClone.effective?.pri).toBe(6); // inherited
    expect(effClone.effective?.name).toBe('Clone A');

    await destroy();
  });
});

// ---------- 6. clone-of-clone rejection ----------

describe('createClone: clone chains', () => {
  it('rejects cloning a linked clone', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const parent = await engine.createRule({
      name: 'Parent',
      instances: 'all',
      payload: masterRulePayload({ name: 'Parent' }),
    });
    const clone = await engine.createClone(parent.id, true, 'Clone A');

    await expect(engine.createClone(clone.id, true, 'Grandchild')).rejects.toThrow(
      /clone chains are not allowed/,
    );

    await destroy();
  });
});

// ---------- 7. drift: modified-on-instance ----------

describe('computeDrift: modified-on-instance', () => {
  it('reports the correct diffs against the pushed baseline', async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'Original' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const uuid = client.rules[0]!.uuid;

    // simulate an out-of-band edit made directly on the instance, then refresh
    // the cache exactly like a real poll would (InstancePoller.pollAutorecs)
    client.rules[0]!.title = 'Changed';
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'modified-on-instance' && i.tvhUuid === uuid);
    expect(item).toBeTruthy();
    expect(item!.masterRuleId).toBe(rule.id);
    expect(
      item!.diffs?.some((d) => d.field === 'title' && d.master === 'Original' && d.instance === 'Changed'),
    ).toBe(true);

    await destroy();
  });
});

// ---------- 8. drift: deleted-on-instance / orphan / ignored-orphan exclusion ----------

describe('computeDrift: deleted-on-instance / orphan / ignored-orphan', () => {
  it('deleted-on-instance: a bound rule removed on the instance', async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const uuid = client.rules[0]!.uuid;

    client.rules = client.rules.filter((r) => r.uuid !== uuid);
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'deleted-on-instance' && i.tvhUuid === uuid);
    expect(item).toBeTruthy();
    expect(item!.masterRuleId).toBe(rule.id);

    await destroy();
  });

  it('orphan: an unmanaged rule present on the instance', async () => {
    const { destroy, clients, pollers, engine } = await setup(['tyo1']);
    const client = clients.get('tyo1')!;
    const orphan = tvhAutorecRule({ name: 'Unmanaged' });
    client.rules.push(orphan);
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'orphan' && i.tvhUuid === orphan.uuid);
    expect(item).toBeTruthy();
    expect(item!.instanceRuleName).toBe('Unmanaged');

    await destroy();
  });

  it('ignored-orphan: an acknowledged orphan is excluded from drift', async () => {
    const { db, destroy, clients, pollers, engine } = await setup(['tyo1']);
    const client = clients.get('tyo1')!;
    const orphan = tvhAutorecRule({ name: 'Unmanaged' });
    client.rules.push(orphan);
    await pollers.get('tyo1')!.pollAutorecs();
    await seedIgnoredOrphan(db, { instanceId: 'tyo1', tvhUuid: orphan.uuid, name: 'Unmanaged' });

    const items = await engine.computeDrift();
    expect(items.some((i) => i.kind === 'orphan' && i.tvhUuid === orphan.uuid)).toBe(false);

    await destroy();
  });
});

// ---------- 9. reconcile('overwrite-from-master') incl. failure/rollback ----------

describe("reconcile('overwrite-from-master')", () => {
  it('force-repushes the master payload over an instance-side edit', async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'Original' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const uuid = client.rules[0]!.uuid;

    client.rules[0]!.title = 'Changed on instance';
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'modified-on-instance' && i.tvhUuid === uuid)!;
    expect(item).toBeTruthy();

    await engine.reconcile(item.id, 'overwrite-from-master');

    expect(client.rules[0]!.title).toBe('Original'); // forced back to the master's value
    const driftAfter = await engine.computeDrift();
    expect(driftAfter.some((i) => i.tvhUuid === uuid)).toBe(false);

    await destroy();
  });

  it('restores the previous master_hash (not the sentinel) when the forced push fails', async () => {
    const { db, destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'Original', channel: 'KBS1' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const uuid = client.rules[0]!.uuid;

    // instance-side edit — creates the modified-on-instance drift item
    client.rules[0]!.title = 'Changed on instance';
    await pollers.get('tyo1')!.pollAutorecs();

    const beforeBinding = await getBinding(db, rule.id, 'tyo1');
    const beforeHash = beforeBinding!.master_hash;
    expect(beforeHash).not.toBe('force-repush');

    // corrupt the master's channel directly (bypassing the engine) so the
    // forced re-push blocks on validateNames
    const master = await db.selectFrom('master_rules').selectAll().where('id', '=', rule.id).executeTakeFirstOrThrow();
    const brokenPayload = { ...(JSON.parse(master.payload) as Record<string, unknown>), channel: 'Ghost Channel' };
    await db
      .updateTable('master_rules')
      .set({ payload: JSON.stringify(brokenPayload) })
      .where('id', '=', rule.id)
      .execute();

    const driftId = `modified-on-instance:tyo1:${uuid}`;
    await expect(engine.reconcile(driftId, 'overwrite-from-master')).rejects.toThrow(/push failed/);

    const afterBinding = await getBinding(db, rule.id, 'tyo1');
    expect(afterBinding!.master_hash).toBe(beforeHash); // restored, not 'force-repush'
    expect(afterBinding!.master_hash).not.toBe('force-repush');

    await destroy();
  });
});

// ---------- 10. reconcile('split-into-clone') ----------

describe("reconcile('split-into-clone')", () => {
  it('narrows the master scope, creates a linked clone, and re-points the binding', async () => {
    const { db, destroy, engine, clients, pollers } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', channel: 'KBS1' }),
    });
    await engine.pushRule(rule.id);

    const tyoClient = clients.get('tyo1')!;
    const tyoUuid = tyoClient.rules[0]!.uuid;
    tyoClient.rules[0]!.channel = 'ch-mbc1'; // per-zone variant
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'modified-on-instance' && i.tvhUuid === tyoUuid)!;
    expect(item).toBeTruthy();

    await engine.reconcile(item.id, 'split-into-clone');

    const updatedMaster = await engine.getRule(rule.id);
    expect(updatedMaster?.instances).toEqual(['osk1']); // narrowed away from tyo1

    const rules = await engine.listRules();
    const clone = rules.find((r) => r.parentId === rule.id);
    expect(clone).toBeTruthy();
    expect(clone!.instances).toEqual(['tyo1']);
    expect(clone!.overlay).toMatchObject({ channel: 'MBC1' });

    const tyoBinding = await getBinding(db, clone!.id, 'tyo1');
    expect(tyoBinding).toBeTruthy(); // re-pointed to the clone
    expect(tyoBinding!.master_hash).toBe(tyoBinding!.pushed_hash);

    const staleBinding = await getBinding(db, rule.id, 'tyo1');
    expect(staleBinding).toBeFalsy(); // no longer bound to the original master

    const oskBinding = await getBinding(db, rule.id, 'osk1');
    expect(oskBinding).toBeTruthy(); // unaffected

    await destroy();
  });
});

// ---------- 11. reconcile('adopt-orphan') ----------

describe("reconcile('adopt-orphan')", () => {
  it('scopes the new master rule to the orphan instance only', async () => {
    const { db, destroy, engine, clients, pollers } = await setup(['tyo1', 'osk1']);
    const tyoClient = clients.get('tyo1')!;
    const orphan = tvhAutorecRule({ name: 'Manual News', channel: 'ch-mbc1' });
    tyoClient.rules.push(orphan);
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'orphan' && i.tvhUuid === orphan.uuid)!;
    expect(item).toBeTruthy();

    await engine.reconcile(item.id, 'adopt-orphan');

    const rules = await engine.listRules();
    const adopted = rules.find((r) => r.name === 'Manual News');
    expect(adopted).toBeTruthy();
    expect(adopted!.instances).toEqual(['tyo1']); // scoped to its own instance only

    const binding = await getBinding(db, adopted!.id, 'tyo1');
    expect(binding!.tvh_uuid).toBe(orphan.uuid);

    const oskBinding = await getBinding(db, adopted!.id, 'osk1');
    expect(oskBinding).toBeFalsy(); // never replicated to the other instance

    await destroy();
  });
});

// ---------- 12. delete-from-instance / recreate-on-instance / delete-master ----------

describe('reconcile: delete-from-instance / recreate-on-instance / delete-master', () => {
  it("delete-from-instance: removes an orphan directly from the instance", async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const client = clients.get('tyo1')!;
    const orphan = tvhAutorecRule({ name: 'Unmanaged' });
    client.rules.push(orphan);
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'orphan' && i.tvhUuid === orphan.uuid)!;

    await engine.reconcile(item.id, 'delete-from-instance');

    expect(client.idnodeDelete).toHaveBeenCalledWith(orphan.uuid);
    expect(client.rules.find((r) => r.uuid === orphan.uuid)).toBeUndefined();

    await destroy();
  });

  it('recreate-on-instance: drops the stale binding and re-pushes as a fresh rule', async () => {
    const { db, destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const oldUuid = client.rules[0]!.uuid;

    client.rules = client.rules.filter((r) => r.uuid !== oldUuid);
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'deleted-on-instance' && i.tvhUuid === oldUuid)!;
    expect(item).toBeTruthy();

    await engine.reconcile(item.id, 'recreate-on-instance');

    expect(client.autorecCreate).toHaveBeenCalledTimes(2); // original + recreate
    const binding = await getBinding(db, rule.id, 'tyo1');
    expect(binding).toBeTruthy();
    expect(binding!.tvh_uuid).not.toBe(oldUuid);
    expect(client.rules.some((r) => r.uuid === binding!.tvh_uuid)).toBe(true);

    await destroy();
  });

  it('delete-master: soft-deletes the master rule and tears down its bindings', async () => {
    const { db, destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'Original' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const uuid = client.rules[0]!.uuid;
    client.rules[0]!.title = 'Changed';
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'modified-on-instance' && i.tvhUuid === uuid)!;
    expect(item).toBeTruthy();

    await engine.reconcile(item.id, 'delete-master');

    const updated = await engine.getRule(rule.id);
    expect(updated?.deletedAt).toBeTruthy();
    const binding = await getBinding(db, rule.id, 'tyo1');
    expect(binding).toBeFalsy();
    expect(client.idnodeDelete).toHaveBeenCalledWith(uuid);

    await destroy();
  });
});

// ---------- 13. delete-parent blocked by an active clone; tolerant of a 404 ----------

describe('deleteRule: parent/clone guard and 404 tolerance', () => {
  it('blocks deleting a parent with an active linked clone (409), then succeeds after the clone is gone', async () => {
    const { db, destroy, engine, clients } = await setup(['tyo1']);
    const parent = await engine.createRule({
      name: 'Parent',
      instances: 'all',
      payload: masterRulePayload({ name: 'Parent' }),
    });
    await engine.pushRule(parent.id);
    const client = clients.get('tyo1')!;
    const uuid = client.rules[0]!.uuid;
    const clone = await engine.createClone(parent.id, true, 'Clone A');

    let err: unknown;
    try {
      await engine.deleteRule(parent.id);
    } catch (e) {
      err = e;
    }
    expect((err as { statusCode?: number } | undefined)?.statusCode).toBe(409);

    await engine.deleteRule(clone.id); // no binding — trivial

    client.idnodeDelete.mockRejectedValueOnce(
      Object.assign(new Error(`tvheadend /api/idnode/delete -> HTTP 404: gone`), {}),
    );
    await engine.deleteRule(parent.id); // tolerates the 404

    const updated = await engine.getRule(parent.id);
    expect(updated?.deletedAt).toBeTruthy();
    const binding = await getBinding(db, parent.id, 'tyo1');
    expect(binding).toBeFalsy();
    void uuid;

    await destroy();
  });
});

// ---------- 13b. batchRestore / batchPurge parent-clone ordering ----------

describe('batchRestore: parent/clone ordering', () => {
  it('restores parents before clones regardless of the requested order', async () => {
    const { db, destroy, engine } = await setup(['tyo1']);
    const parentId = await seedMasterRule(db, { name: 'Parent', deletedAt: TS });
    const cloneId = await seedMasterRule(db, { name: 'Clone A', parentId, deletedAt: TS });

    const results = await engine.batchRestore([cloneId, parentId]); // clone first on purpose
    expect(results.every((r) => r.ok)).toBe(true);

    const parent = await engine.getRule(parentId);
    const clone = await engine.getRule(cloneId);
    expect(parent?.deletedAt).toBeNull();
    expect(clone?.deletedAt).toBeNull();

    await destroy();
  });

  it('a clone alone fails while its parent is still deleted', async () => {
    const { db, destroy, engine } = await setup(['tyo1']);
    const parentId = await seedMasterRule(db, { name: 'Parent', deletedAt: TS });
    const cloneId = await seedMasterRule(db, { name: 'Clone A', parentId, deletedAt: TS });

    const results = await engine.batchRestore([cloneId]);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain('restore its parent first');

    await destroy();
  });
});

describe('batchPurge: parent/clone ordering', () => {
  it('purges clones before parents regardless of the requested order', async () => {
    const { db, destroy, engine } = await setup(['tyo1']);
    const parentId = await seedMasterRule(db, { name: 'Parent', deletedAt: TS });
    const cloneId = await seedMasterRule(db, { name: 'Clone A', parentId, deletedAt: TS });

    const results = await engine.batchPurge([parentId, cloneId]); // parent first on purpose
    expect(results.every((r) => r.ok)).toBe(true);

    const rows = await db
      .selectFrom('master_rules')
      .select('id')
      .where('id', 'in', [parentId, cloneId])
      .execute();
    expect(rows).toHaveLength(0);

    await destroy();
  });

  it('a parent alone fails while it still has clone rows', async () => {
    const { db, destroy, engine } = await setup(['tyo1']);
    const parentId = await seedMasterRule(db, { name: 'Parent', deletedAt: TS });
    await seedMasterRule(db, { name: 'Clone A', parentId, deletedAt: TS });

    const results = await engine.batchPurge([parentId]);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain('linked clones');

    await destroy();
  });
});

// ---------- 14. updateRule scope shrink ----------

describe('updateRule: scope shrink', () => {
  it('deletes the removed instance copy and drops its binding', async () => {
    const { db, destroy, engine, clients } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: ['tyo1', 'osk1'],
      payload: masterRulePayload({ name: 'News' }),
    });
    await engine.pushRule(rule.id);
    const oskClient = clients.get('osk1')!;
    const oskUuid = oskClient.rules[0]!.uuid;

    await engine.updateRule(rule.id, { name: 'News', instances: ['tyo1'] });

    expect(oskClient.idnodeDelete).toHaveBeenCalledWith(oskUuid);
    const oskBinding = await getBinding(db, rule.id, 'osk1');
    expect(oskBinding).toBeFalsy();
    const tyoBinding = await getBinding(db, rule.id, 'tyo1');
    expect(tyoBinding).toBeTruthy();
    const updated = await engine.getRule(rule.id);
    expect(updated?.instances).toEqual(['tyo1']);

    await destroy();
  });

  it('a failing instance delete aborts the update, leaving the binding intact', async () => {
    const { db, destroy, engine, clients } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'News2',
      instances: ['tyo1', 'osk1'],
      payload: masterRulePayload({ name: 'News2' }),
    });
    await engine.pushRule(rule.id);
    const oskClient = clients.get('osk1')!;
    oskClient.idnodeDelete.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(
      engine.updateRule(rule.id, { name: 'News2', instances: ['tyo1'] }),
    ).rejects.toThrow(/ECONNREFUSED/);

    const oskBinding = await getBinding(db, rule.id, 'osk1');
    expect(oskBinding).toBeTruthy(); // never dropped
    const updated = await engine.getRule(rule.id);
    expect(updated?.instances).toEqual(['tyo1', 'osk1']); // update never committed

    await destroy();
  });
});

// ---------- 15b. channel identity (name, number) pairing ----------

describe('pushRule: pinned channel number', () => {
  it('resolves the (name, number) pair to the instance-local uuid; channel_number never reaches tvheadend', async () => {
    const { destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News51',
      instances: 'all',
      payload: masterRulePayload({ name: 'News51', channel: 'KBS1', channel_number: '51' }),
    });

    const [result] = await engine.pushRule(rule.id);
    expect(result?.action).toBe('created');

    const client = clients.get('tyo1')!;
    const conf = client.autorecCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(conf.channel).toBe('ch-kbs51');
    expect('channel_number' in conf).toBe(false);

    await destroy();
  });

  it('legacy null channel_number: pushes the lowest-numbered same-name channel uuid', async () => {
    const { destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'NewsLegacy',
      instances: 'all',
      payload: masterRulePayload({ name: 'NewsLegacy', channel: 'KBS1', channel_number: null }),
    });

    await engine.pushRule(rule.id);

    const client = clients.get('tyo1')!;
    const conf = client.autorecCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(conf.channel).toBe('ch-kbs1'); // KBS1 #1, not KBS1 #51
    expect('channel_number' in conf).toBe(false);

    await destroy();
  });

  it('blocks when the pinned number has no matching channel on the instance', async () => {
    const { destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'GhostNumber',
      instances: 'all',
      payload: masterRulePayload({ name: 'GhostNumber', channel: 'KBS1', channel_number: '99' }),
    });

    const [result] = await engine.pushRule(rule.id);
    expect(result?.action).toBe('blocked');
    expect(result?.detail).toMatch(/#99 not found/);

    const client = clients.get('tyo1')!;
    expect(client.autorecCreate).not.toHaveBeenCalled();
    expect(client.idnodeSave).not.toHaveBeenCalled();

    await destroy();
  });

  it('drift: an instance-side channel change after a pinned push reports both channel fields', async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News51Drift',
      instances: 'all',
      payload: masterRulePayload({ name: 'News51Drift', channel: 'KBS1', channel_number: '51' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    const uuid = client.rules[0]!.uuid;

    // out-of-band: the instance rule is repointed to a different channel uuid
    client.rules[0]!.channel = 'ch-mbc1';
    await pollers.get('tyo1')!.pollAutorecs();

    const items = await engine.computeDrift();
    const item = items.find((i) => i.kind === 'modified-on-instance' && i.tvhUuid === uuid);
    expect(item).toBeTruthy();
    const fields = item!.diffs?.map((d) => d.field) ?? [];
    expect(fields).toContain('channel');
    expect(fields).toContain('channel_number');

    await destroy();
  });

  it('no false drift: a legacy (null) rule read back with a concrete instance number is not reported', async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'NewsNoFalseDrift',
      instances: 'all',
      payload: masterRulePayload({ name: 'NewsNoFalseDrift', channel: 'KBS1', channel_number: null }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;

    // simulate tvheadend reading the name back as its numbered channel uuid
    client.rules[0]!.channel = 'ch-kbs1';
    await pollers.get('tyo1')!.pollAutorecs();

    const drift = await engine.computeDrift();
    expect(drift.some((i) => i.tvhUuid === client.rules[0]!.uuid)).toBe(false);

    const issues = await engine.integrityCheck();
    expect(issues.some((i) => i.kind === 'content-mismatch' && i.masterRuleId === rule.id)).toBe(false);

    await destroy();
  });

  it('import: a rule bound to a numbered channel picks up channel_number on import', async () => {
    const { destroy, engine, clients } = await setup(['tyo1']);
    const client = clients.get('tyo1')!;
    client.rules.push(tvhAutorecRule({ name: 'Imported51', channel: 'ch-kbs51' }));

    await engine.importFromInstance('tyo1');

    const rules = await engine.listRules();
    const imported = rules.find((r) => r.name === 'Imported51');
    expect(imported).toBeTruthy();
    expect(imported!.payload.channel).toBe('KBS1');
    expect(imported!.payload.channel_number).toBe('51');

    await destroy();
  });
});

// ---------- 15. importFromInstance bootstrap ----------

describe('importFromInstance', () => {
  it('dedupes existing names, binds identical content by hash, and flags same-name/different-content as drift', async () => {
    const { db, destroy, engine, clients } = await setup(['tyo1', 'osk1']);
    await seedMasterRule(db, { name: 'Existing' });

    const tyo = clients.get('tyo1')!;
    const osk = clients.get('osk1')!;

    tyo.rules.push(
      tvhAutorecRule({ name: 'Existing', channel: 'ch-kbs1' }), // must be skipped (name collision)
      tvhAutorecRule({ name: 'HashMatch', channel: 'ch-kbs1', title: 't1' }),
      tvhAutorecRule({ name: 'NameOnly', channel: 'ch-kbs1', title: 't2' }),
    );
    osk.rules.push(
      tvhAutorecRule({ name: 'HashMatch', channel: 'ch-kbs1', title: 't1' }), // identical content
      tvhAutorecRule({ name: 'NameOnly', channel: 'ch-kbs1', title: 't2-different' }), // same name, differs
    );

    const { imported, bound } = await engine.importFromInstance('tyo1');
    expect(imported).toBe(2); // 'Existing' was skipped
    expect(bound).toBe(4); // 2 source bindings + 2 matched-on-osk1 bindings

    const rules = await engine.listRules();
    expect(rules.filter((r) => r.name === 'Existing')).toHaveLength(1); // not duplicated

    const hashMatch = rules.find((r) => r.name === 'HashMatch')!;
    const nameOnly = rules.find((r) => r.name === 'NameOnly')!;
    expect(hashMatch).toBeTruthy();
    expect(nameOnly).toBeTruthy();

    const hmOsk = await getBinding(db, hashMatch.id, 'osk1');
    expect(hmOsk).toBeTruthy();
    expect(hmOsk!.master_hash).toBe(hmOsk!.pushed_hash);

    const noOsk = await getBinding(db, nameOnly.id, 'osk1');
    expect(noOsk).toBeTruthy();
    expect(noOsk!.master_hash).toBe(noOsk!.pushed_hash); // bound with the MASTER hash...

    const drift = await engine.computeDrift();
    // ...which does not match the instance's actual content, so it surfaces as drift
    expect(
      drift.some((d) => d.kind === 'modified-on-instance' && d.masterRuleId === nameOnly.id && d.instanceId === 'osk1'),
    ).toBe(true);
    // the identical-content match must NOT show as drift
    expect(drift.some((d) => d.masterRuleId === hashMatch.id && d.instanceId === 'osk1')).toBe(false);

    await destroy();
  });
});

// ---------- 16. write-time channel_number pinning ----------

describe('write-time channel_number pinning (null -> lowest-numbered same-name channel)', () => {
  it('createRule: a null channel_number is pinned to the lowest-numbered same-name channel', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'Pin1',
      instances: 'all',
      payload: masterRulePayload({ name: 'Pin1', channel: 'KBS1', channel_number: null }),
    });

    expect(rule.payload.channel_number).toBe('1');
    const reloaded = await engine.getRule(rule.id);
    expect(reloaded!.payload.channel_number).toBe('1');

    await destroy();
  });

  it('createRule: an already-pinned channel_number is left untouched', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'Pin51',
      instances: 'all',
      payload: masterRulePayload({ name: 'Pin51', channel: 'KBS1', channel_number: '51' }),
    });

    expect(rule.payload.channel_number).toBe('51');

    await destroy();
  });

  it('createRule: an unresolvable channel name keeps a null channel_number', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'PinGhost',
      instances: 'all',
      payload: masterRulePayload({ name: 'PinGhost', channel: 'GHOST', channel_number: null }),
    });

    expect(rule.payload.channel_number).toBeNull();

    await destroy();
  });

  it('createRule: an empty channel keeps a null channel_number (no injection)', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'PinEmpty',
      instances: 'all',
      payload: masterRulePayload({ name: 'PinEmpty', channel: '', channel_number: null }),
    });

    expect(rule.payload.channel).toBe('');
    expect(rule.payload.channel_number).toBeNull();

    await destroy();
  });

  it('updateRule: flipping the channel name without a number resolves to the lowest-numbered match', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'PinFlip',
      instances: 'all',
      payload: masterRulePayload({ name: 'PinFlip', channel: 'MBC1', channel_number: null }),
    });
    expect(rule.payload.channel_number).toBe('2');

    await engine.updateRule(rule.id, {
      name: 'PinFlip',
      instances: 'all',
      payload: masterRulePayload({ name: 'PinFlip', channel: 'KBS1', channel_number: null }),
    });

    const updated = await engine.getRule(rule.id);
    expect(updated!.payload.channel).toBe('KBS1');
    expect(updated!.payload.channel_number).toBe('1');

    await destroy();
  });

  it('batchEdit: a channel-only patch resolves every affected rule to the lowest-numbered match', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule1 = await engine.createRule({
      name: 'Batch1',
      instances: 'all',
      payload: masterRulePayload({ name: 'Batch1', channel: 'MBC1' }),
    });
    const rule2 = await engine.createRule({
      name: 'Batch2',
      instances: 'all',
      payload: masterRulePayload({ name: 'Batch2', channel: 'MBC1' }),
    });

    const results = await engine.batchEdit([rule1.id, rule2.id], { channel: 'KBS1' });
    expect(results.every((r) => r.ok)).toBe(true);

    const updated1 = await engine.getRule(rule1.id);
    const updated2 = await engine.getRule(rule2.id);
    expect(updated1!.payload.channel_number).toBe('1');
    expect(updated2!.payload.channel_number).toBe('1');

    await destroy();
  });

  it('clone overlay: a channel-overriding overlay is pinned; an overlay leaving the channel alone is untouched', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const parent = await engine.createRule({
      name: 'PinParent',
      instances: 'all',
      payload: masterRulePayload({ name: 'PinParent', channel: 'MBC1' }),
    });
    const clone = await engine.createClone(parent.id, true, 'PinClone');

    await engine.updateRule(clone.id, {
      name: 'PinClone',
      instances: clone.instances,
      parentId: parent.id,
      overlay: { channel: 'KBS1' },
    });
    let reloaded = await engine.getRule(clone.id);
    expect(reloaded!.overlay).toEqual({ channel: 'KBS1', channel_number: '1' });

    // an overlay that does not override the channel must never have a
    // channel_number injected out of nowhere
    await engine.updateRule(clone.id, {
      name: 'PinClone',
      instances: clone.instances,
      parentId: parent.id,
      overlay: { title: 'Something' },
    });
    reloaded = await engine.getRule(clone.id);
    expect(reloaded!.overlay).toEqual({ title: 'Something' });

    await destroy();
  });
});

// ---------- 17. regression: batch patch with a non-integer string channel_number ----------

describe('batchEdit: non-integer string channel_number (regression)', () => {
  it('a batch patch carrying a string channel_number (e.g. "9.1") validates and stores it', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'MxRule',
      instances: 'all',
      payload: masterRulePayload({ name: 'MxRule', channel: 'TOKYO MX1' }),
    });

    // this is the exact shape rejected before the string schema fix:
    // {"channel":"ＴＯＫＹＯ　ＭＸ１","channel_number":"9.1"} used to fail with
    // "invalid patch: /channel_number Expected union value" because the
    // schema demanded a number.
    const results = await engine.batchEdit([rule.id], {
      channel: 'TOKYO MX1',
      channel_number: '9.1',
    });
    expect(results.every((r) => r.ok)).toBe(true);

    const reloaded = await engine.getRule(rule.id);
    expect(reloaded!.payload.channel).toBe('TOKYO MX1');
    expect(reloaded!.payload.channel_number).toBe('9.1');

    await destroy();
  });

  it('a batch patch with only the channel name (no channel_number) pins to the lowest-numbered match', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'MxRuleNoNumber',
      instances: 'all',
      payload: masterRulePayload({ name: 'MxRuleNoNumber', channel: 'KBS1' }),
    });

    const results = await engine.batchEdit([rule.id], { channel: 'TOKYO MX1' });
    expect(results.every((r) => r.ok)).toBe(true);

    const reloaded = await engine.getRule(rule.id);
    expect(reloaded!.payload.channel).toBe('TOKYO MX1');
    expect(reloaded!.payload.channel_number).toBe('9.1'); // only TOKYO MX1 channel on the topology fixture

    await destroy();
  });
});

// ---------- 17b. batchEdit: full field patch (batch-edit modal now exposes every payload field) ----------

describe('batchEdit: btype/content_type/mergetext/weekdays/directory patch', () => {
  it('merges the patch into a plain rule payload and a linked clone overlay; names untouched', async () => {
    const { destroy, engine } = await setup(['tyo1']);
    const plain = await engine.createRule({
      name: 'PatchPlain',
      instances: 'all',
      payload: masterRulePayload({ name: 'PatchPlain' }),
    });
    const parent = await engine.createRule({
      name: 'PatchParent',
      instances: 'all',
      payload: masterRulePayload({ name: 'PatchParent' }),
    });
    const clone = await engine.createClone(parent.id, true, 'PatchClone');

    const patch = { btype: 2, content_type: 16, mergetext: true, weekdays: [6, 7], directory: 'd' };
    const results = await engine.batchEdit([plain.id, clone.id], patch);
    expect(results.every((r) => r.ok)).toBe(true);

    const updatedPlain = await engine.getRule(plain.id);
    expect(updatedPlain!.payload).toMatchObject(patch);
    expect(updatedPlain!.payload.name).toBe('PatchPlain');
    expect(updatedPlain!.name).toBe('PatchPlain');

    const updatedClone = await engine.getRule(clone.id);
    expect(updatedClone!.overlay).toEqual(patch); // overlay only — payload stays a placeholder
    expect(updatedClone!.payload).toEqual({});
    expect(updatedClone!.name).toBe('PatchClone');

    await destroy();
  });
});

// ---------- 18. integrityCheck: "Any" time-window sentinel + unverifiable instances ----------

describe('integrityCheck: tvheadend "Any" start/start_window sentinel', () => {
  it('a rule pushed with no time restriction and read back as "Any" is not a content-mismatch (and not drift)', async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'AnyWindow',
      instances: 'all',
      payload: masterRulePayload({ name: 'AnyWindow', start: '', start_window: '' }),
    });
    await engine.pushRule(rule.id);

    // tvheadend reports an unrestricted time window as the literal "Any"
    const client = clients.get('tyo1')!;
    client.rules[0]!.start = 'Any';
    client.rules[0]!.start_window = 'Any';
    await pollers.get('tyo1')!.pollAutorecs();

    const drift = await engine.computeDrift();
    expect(drift).toHaveLength(0);

    const issues = await engine.integrityCheck();
    expect(issues.filter((i) => i.kind === 'content-mismatch')).toHaveLength(0);

    await destroy();
  });

  it('a genuinely different start time still reports a content-mismatch', async () => {
    const { destroy, engine, clients } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'RealWindowDiff',
      instances: 'all',
      payload: masterRulePayload({ name: 'RealWindowDiff', start: '', start_window: '' }),
    });
    await engine.pushRule(rule.id);

    const client = clients.get('tyo1')!;
    client.rules[0]!.start = '09:30';

    const issues = await engine.integrityCheck();
    const mismatch = issues.find((i) => i.kind === 'content-mismatch' && i.masterRuleId === rule.id);
    expect(mismatch).toBeTruthy();
    expect(mismatch!.diffs?.map((d) => d.field)).toEqual(['start']);

    await destroy();
  });

  it('a master payload carrying the legacy "Any" spelling hashes and compares as unrestricted', async () => {
    expect(payloadHash(normalizePayload(masterRulePayload({ start: 'Any', start_window: 'Any' })))).toBe(
      payloadHash(normalizePayload(masterRulePayload({ start: '', start_window: '' }))),
    );
  });
});

// ---------- 18b. sparse overlay: explicit '' / null / [] overrides (web UI writes these) ----------

describe('createClone: linked clone with an explicit-empty sparse overlay', () => {
  it("an overlay of '' / null / [] explicitly overrides (not inherits) parent fields, survives push, and the tvh 'Any' readback is not drift", async () => {
    const { destroy, engine, clients, pollers } = await setup(['tyo1']);
    const parent = await engine.createRule({
      name: 'NewsParent',
      instances: 'all',
      payload: masterRulePayload({
        name: 'NewsParent',
        title: '^News',
        start: '20:00',
        start_window: '22:00',
        channel: 'KBS1',
        channel_number: '1',
        weekdays: [6, 7],
      }),
    });

    const clone = await engine.createClone(parent.id, true, 'NewsClone');
    await engine.updateRule(clone.id, {
      name: 'NewsClone',
      instances: clone.instances,
      parentId: parent.id,
      overlay: {
        title: '',
        start: '',
        start_window: '',
        channel: '',
        channel_number: null,
        weekdays: [],
      },
    });

    const resolved = await engine.listResolved();
    const effClone = resolved.find((r) => r.id === clone.id)!;
    expect(effClone.effective?.title).toBe('');
    expect(effClone.effective?.start).toBe('');
    expect(effClone.effective?.start_window).toBe('');
    expect(effClone.effective?.channel).toBe('');
    expect(effClone.effective?.channel_number).toBeNull();
    // '' / null / [] are explicit overrides, not gaps — definedProps only strips
    // undefined/null, so the empty-string and empty-array overlay entries win
    // over the parent's '^News' / '20:00' / '22:00' / [6,7]; weekdays: [] is
    // then canonicalized to "every day" like any other empty selection
    expect(effClone.effective?.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const [result] = await engine.pushRule(clone.id);
    expect(result?.action).toBe('created');

    // tvheadend reports an unrestricted time window as the literal "Any"
    const client = clients.get('tyo1')!;
    client.rules[0]!.start = 'Any';
    client.rules[0]!.start_window = 'Any';
    await pollers.get('tyo1')!.pollAutorecs();

    const drift = await engine.computeDrift();
    expect(drift).toHaveLength(0);

    const issues = await engine.integrityCheck();
    expect(issues.some((i) => i.kind === 'content-mismatch' && i.masterRuleId === clone.id)).toBe(false);

    await destroy();
  });
});

describe('computeDrift: stale pushed_hash baseline', () => {
  it('a hash-only mismatch with zero field diffs against the master is not drift', async () => {
    const { db, destroy, engine } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'StaleBaseline',
      instances: 'all',
      payload: masterRulePayload({ name: 'StaleBaseline' }),
    });
    await engine.pushRule(rule.id);

    // simulate a baseline stored under older normalization rules: the hash no
    // longer matches, but the instance rule is field-identical to the master
    await db
      .updateTable('rule_bindings')
      .set({ pushed_hash: 'hash-from-an-older-normalization' })
      .where('master_rule_id', '=', rule.id)
      .execute();

    const items = await engine.computeDrift();
    expect(items).toHaveLength(0);

    // and the rule still reads as in-sync, not pending
    const [status] = await engine.rulesWithStatus();
    expect(status!.perInstance['tyo1']!.state).toBe('in-sync');

    await destroy();
  });
});

describe('integrityCheck: unverifiable instance', () => {
  it('an instance whose topology cannot be loaded is reported, not silently skipped', async () => {
    const { destroy, engine, cache } = await setup(['tyo1']);
    // fake pollTopology is a no-op, so a cleared snapshot stays unavailable
    cache.get('tyo1').topology = null;

    const issues = await engine.integrityCheck();
    const skipped = issues.find((i) => i.kind === 'missing-on-instance' && i.instanceId === 'tyo1');
    expect(skipped).toBeTruthy();
    expect(skipped!.detail).toMatch(/topology unavailable/);

    await destroy();
  });
});

// ---------- 19. batchEdit: per-instance scope delta ----------

describe('batchEdit: instance scope delta', () => {
  it('checking an instance grows a list scope without touching tvheadend; the new instance reads unpushed', async () => {
    const { destroy, engine, clients } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'GrowScope',
      instances: ['tyo1'],
      payload: masterRulePayload({ name: 'GrowScope' }),
    });

    const results = await engine.batchEdit([rule.id], {}, { osk1: true });
    expect(results).toEqual([{ id: rule.id, ok: true }]);

    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toEqual(['tyo1', 'osk1']);
    // growing the scope is master-only — no tvh call until push
    const oskClient = clients.get('osk1')!;
    expect(oskClient.autorecCreate).not.toHaveBeenCalled();
    expect(oskClient.idnodeSave).not.toHaveBeenCalled();
    const [status] = await engine.rulesWithStatus();
    expect(status!.perInstance['osk1']!.state).toBe('unpushed');

    await destroy();
  });

  it('unchecking an instance deletes the bound rule there and drops the binding', async () => {
    const { db, destroy, engine, clients } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'ShrinkScope',
      instances: ['tyo1', 'osk1'],
      payload: masterRulePayload({ name: 'ShrinkScope' }),
    });
    await engine.pushRule(rule.id);
    const oskClient = clients.get('osk1')!;
    const oskUuid = oskClient.rules[0]!.uuid;

    const results = await engine.batchEdit([rule.id], {}, { osk1: false });
    expect(results).toEqual([{ id: rule.id, ok: true }]);

    expect(oskClient.idnodeDelete).toHaveBeenCalledWith(oskUuid);
    expect(oskClient.rules).toHaveLength(0);
    expect(await getBinding(db, rule.id, 'osk1')).toBeFalsy();
    expect(await getBinding(db, rule.id, 'tyo1')).toBeTruthy();
    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toEqual(['tyo1']);

    await destroy();
  });

  it("a check-only delta keeps an 'all' scope as 'all' (never needlessly materialized)", async () => {
    const { destroy, engine } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'AllStaysAll',
      instances: 'all',
      payload: masterRulePayload({ name: 'AllStaysAll' }),
    });

    const results = await engine.batchEdit([rule.id], {}, { osk1: true });
    expect(results).toEqual([{ id: rule.id, ok: true }]);

    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toBe('all');

    await destroy();
  });

  it("unchecking one instance materializes an 'all' scope into the remaining instances", async () => {
    const { destroy, engine } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'AllMinusOne',
      instances: 'all',
      payload: masterRulePayload({ name: 'AllMinusOne' }),
    });

    const results = await engine.batchEdit([rule.id], {}, { osk1: false });
    expect(results).toEqual([{ id: rule.id, ok: true }]);

    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toEqual(['tyo1']);

    await destroy();
  });

  it('removing the last instance fails per-rule and leaves the rule unchanged', async () => {
    const { destroy, engine } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'LastOne',
      instances: ['tyo1'],
      payload: masterRulePayload({ name: 'LastOne' }),
    });

    const results = await engine.batchEdit([rule.id], {}, { tyo1: false });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toMatch(/cannot remove the last instance — delete the rule instead/);

    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toEqual(['tyo1']);

    await destroy();
  });

  it('a linked clone keeps its overlay when the scope changes with an empty patch', async () => {
    const { destroy, engine } = await setup(['tyo1', 'osk1']);
    const parent = await engine.createRule({
      name: 'ScopeParent',
      instances: 'all',
      payload: masterRulePayload({ name: 'ScopeParent', title: 'Parent Title' }),
    });
    const clone = await engine.createClone(parent.id, true, 'ScopeClone');
    await engine.updateRule(clone.id, {
      name: 'ScopeClone',
      instances: 'all',
      parentId: parent.id,
      overlay: { title: 'Override Title' },
    });

    const results = await engine.batchEdit([clone.id], {}, { osk1: false });
    expect(results).toEqual([{ id: clone.id, ok: true }]);

    const updated = await engine.getRule(clone.id);
    expect(updated!.instances).toEqual(['tyo1']);
    expect(updated!.overlay).toEqual({ title: 'Override Title' });
    expect(updated!.payload).toEqual({}); // still a placeholder, never resolved
    expect(updated!.parentId).toBe(parent.id);

    await destroy();
  });

  it('an unknown instance id in the delta is rejected upfront with a 400', async () => {
    const { destroy, engine } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'UnknownInst',
      instances: 'all',
      payload: masterRulePayload({ name: 'UnknownInst' }),
    });

    // rejected upfront (httpError 400), before anything enters the op chain
    expect(() => engine.batchEdit([rule.id], {}, { nrt9: true })).toThrow(
      /unknown instance "nrt9"/,
    );

    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toBe('all');

    await destroy();
  });

  it('an untouched delta with an empty patch is a no-op that still reports ok', async () => {
    const { destroy, engine, clients } = await setup(['tyo1', 'osk1']);
    const rule = await engine.createRule({
      name: 'NoopDelta',
      instances: ['tyo1'],
      payload: masterRulePayload({ name: 'NoopDelta' }),
    });
    const before = (await engine.getRule(rule.id))!.updatedAt;

    // tyo1 is already in scope: checking it again changes nothing
    const results = await engine.batchEdit([rule.id], {}, { tyo1: true });
    expect(results).toEqual([{ id: rule.id, ok: true }]);

    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toEqual(['tyo1']);
    expect(updated!.updatedAt).toBe(before); // update skipped entirely
    expect(clients.get('tyo1')!.idnodeDelete).not.toHaveBeenCalled();

    await destroy();
  });
});

// ---------- 20. tvh-less instances (config url: null) ----------

describe('tvh-less instances', () => {
  it("scope 'all' excludes a tvh-less instance from push targets and per-instance status", async () => {
    const { destroy, engine, cache } = await setup(['tyo1']);
    // tvh-less zone: cache snapshot exists (url null → hasTvh=false) but there
    // is NO poller and NO topology — exactly how main.ts wires it
    cache.init('ext1', 'ext1', null);

    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News' }),
    });
    const results = await engine.pushRule(rule.id);
    expect(results.map((r) => r.instanceId)).toEqual(['tyo1']);
    expect(results[0]?.action).toBe('created');

    const [status] = await engine.rulesWithStatus();
    expect(Object.keys(status!.perInstance)).toEqual(['tyo1']);

    await destroy();
  });

  it('an EXPLICIT scope listing a tvh-less instance is blocked there with a clear reason (no tvh calls)', async () => {
    const { destroy, engine, cache } = await setup(['tyo1']);
    cache.init('ext1', 'ext1', null);

    const rule = await engine.createRule({
      name: 'News',
      instances: ['tyo1', 'ext1'],
      payload: masterRulePayload({ name: 'News' }),
    });
    const results = await engine.pushRule(rule.id);
    const byInstance = new Map(results.map((r) => [r.instanceId, r]));
    expect(byInstance.get('tyo1')?.action).toBe('created');
    expect(byInstance.get('ext1')).toMatchObject({
      action: 'blocked',
      detail: 'instance has no tvheadend',
    });

    const [status] = await engine.rulesWithStatus();
    expect(status!.perInstance['ext1']).toMatchObject({
      state: 'blocked',
      blockedReason: 'instance has no tvheadend',
    });
    expect(status!.perInstance['tyo1']?.state).toBe('in-sync');

    await destroy();
  });

  it("batchEdit: checking a tvh-less instance under an 'all' scope materializes it into an explicit list", async () => {
    const { destroy, engine, cache } = await setup(['tyo1', 'osk1']);
    cache.init('ext1', 'ext1', null);

    const rule = await engine.createRule({
      name: 'Docs',
      instances: 'all',
      payload: masterRulePayload({ name: 'Docs' }),
    });
    const results = await engine.batchEdit([rule.id], {}, { ext1: true });
    expect(results).toEqual([{ id: rule.id, ok: true }]);

    // 'all' never covers ext1, so the check materialized the tvh-capable
    // instances and appended ext1 explicitly
    const updated = await engine.getRule(rule.id);
    expect(updated!.instances).toEqual(['tyo1', 'osk1', 'ext1']);

    await destroy();
  });
});

// ---------- event-log emission: drift (site #9) ----------

describe('SyncEngine: drift event-log emission (site #9)', () => {
  it('baseline: nothing logged on the first publishDrift even with pre-existing drift', async () => {
    const { destroy, engine, clients, pollers, logs } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'Original' }),
    });
    await engine.pushRule(rule.id);
    const client = clients.get('tyo1')!;
    client.rules[0]!.title = 'Changed'; // out-of-band edit BEFORE the controller ever looks
    await pollers.get('tyo1')!.pollAutorecs();

    // sanity: the drift genuinely exists
    const items = await engine.computeDrift();
    expect(items.some((i) => i.kind === 'modified-on-instance')).toBe(true);

    await engine.publishDrift(); // first pass — baseline guard, must not log
    expect(logs).toHaveLength(0);

    await destroy();
  });

  it('logs one warning when new drift appears after the baseline, and a normal when it clears', async () => {
    const { destroy, engine, clients, pollers, logs } = await setup(['tyo1']);
    const rule = await engine.createRule({
      name: 'News',
      instances: 'all',
      payload: masterRulePayload({ name: 'News', title: 'Original' }),
    });
    await engine.pushRule(rule.id);
    await engine.publishDrift(); // baseline — clean, nothing to seed
    expect(logs).toHaveLength(0);

    const client = clients.get('tyo1')!;
    client.rules[0]!.title = 'Changed';
    await pollers.get('tyo1')!.pollAutorecs();
    await engine.publishDrift(); // new drift appeared
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'warning', service: 'drift', source: 'instance.tyo1' });
    expect(logs[0]!.message).toContain('News');

    client.rules[0]!.title = 'Original'; // reverted — drift clears
    await pollers.get('tyo1')!.pollAutorecs();
    await engine.publishDrift();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ type: 'normal', service: 'drift', source: 'instance.tyo1' });
    expect(logs[1]!.message).toContain('News');

    await destroy();
  });

  it('per-instance baseline: an instance loading AFTER the first pass still seeds its pre-existing drift silently', async () => {
    const { destroy, cache, engine, clients, pollers, logs } = await setup(['tyo1', 'osk1']);
    // restart race: osk1's cache is not loaded when the first pass runs
    const osk = cache.get('osk1');
    osk.autorecsLoaded = false;
    const oskClient = clients.get('osk1')!;
    oskClient.rules.push(tvhAutorecRule({ name: 'Pre-existing Orphan' })); // standing drift on osk1

    await engine.publishDrift(); // first pass evaluates only tyo1
    expect(logs).toHaveLength(0);

    osk.summary.reachable = true;
    await pollers.get('osk1')!.pollAutorecs(); // osk1 loads — its standing orphan enters the pass
    await engine.publishDrift(); // osk1's first evaluated pass: seed, must NOT log "appeared"
    expect((await engine.computeDrift()).some((i) => i.kind === 'orphan')).toBe(true);
    expect(logs).toHaveLength(0);

    oskClient.rules.push(tvhAutorecRule({ name: 'Genuinely New' })); // real new drift afterwards
    await pollers.get('osk1')!.pollAutorecs();
    await engine.publishDrift();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'warning', service: 'drift', source: 'instance.osk1' });
    expect(logs[0]!.message).toContain('Genuinely New');

    await destroy();
  });
});

// ---------- event-log emission: rule push error/blocked (site #10) ----------

describe('SyncEngine: rule push error/blocked event-log emission (site #10)', () => {
  it('logs one warning when a push is blocked, and none on a repeated still-blocked push', async () => {
    const { destroy, engine, cache, logs } = await setup(['tyo1']);
    cache.init('ext1', 'ext1', null); // tvh-less instance — pushRuleToInstance blocks unconditionally

    const rule = await engine.createRule({
      name: 'News',
      instances: ['tyo1', 'ext1'],
      payload: masterRulePayload({ name: 'News' }),
    });
    await engine.pushRule(rule.id); // tyo1 created, ext1 blocked
    expect(logs.filter((l) => l.type === 'warning')).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'warning', service: 'rules', source: 'instance.ext1' });
    expect(logs[0]!.message).toContain('News');

    // a second push while still blocked (operator re-clicking "push", or
    // pushAll retrying the same rule) must not re-log the same problem
    await engine.pushRule(rule.id);
    expect(logs.filter((l) => l.type === 'warning')).toHaveLength(1);

    await destroy();
  });
});
