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
import { normalizeRule, payloadHash } from '../src/sync/normalize.js';
import { createTestDb } from './support/testDb.js';
import { fakePoller, fakeTvhClient, type FakePoller, type FakeTvhClient } from './support/fakePoller.js';
import {
  masterRulePayload,
  nameMaps,
  seedIgnoredOrphan,
  seedMasterRule,
  topologySnapshot,
  tvhAutorecRule,
} from './support/fixtures.js';

interface Harness {
  db: Kysely<Database>;
  destroy: () => Promise<void>;
  cache: InstanceCache;
  engine: SyncEngine;
  clients: Map<string, FakeTvhClient>;
  pollers: Map<string, FakePoller>;
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
    snap.topology = topologySnapshot();
    const client = fakeTvhClient();
    clients.set(id, client);
    const poller = fakePoller(cache, id, client);
    fakePollers.set(id, poller);
    enginePollers.set(id, poller as unknown as InstancePoller);
  }
  const engine = new SyncEngine(db, cache, enginePollers, bus);
  return { db, destroy, cache, engine, clients, pollers: fakePollers };
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
    // pushed_hash must come from the normalized READ-BACK, not the raw payload
    expect(binding!.pushed_hash).toBe(payloadHash(normalizeRule(stored, nameMaps())));

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
    expect(effClone.overlay).toEqual({ channel: 'MBC1' });
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
