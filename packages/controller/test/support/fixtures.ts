import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { MasterRulePayload, TvhAutorecRule } from '@tvhc/shared';
import type { Database } from '../../src/db/schema.js';
import type { TopologySnapshot } from '../../src/state/instanceCache.js';
import { normalizePayload } from '../../src/sync/normalize.js';
import type { NameMaps } from '../../src/sync/normalize.js';

/** timestamp literal matching engine.ts's own now() format — never rely on column defaults */
export const TS = '2026-01-01 00:00:00';

export function masterRulePayload(overrides: Partial<MasterRulePayload> = {}): MasterRulePayload {
  return normalizePayload({
    name: 'Test Rule',
    channel: 'KBS1',
    ...overrides,
  } as MasterRulePayload);
}

export function tvhAutorecRule(overrides: Partial<TvhAutorecRule> = {}): TvhAutorecRule {
  return {
    uuid: randomUUID(),
    enabled: true,
    name: 'Test Rule',
    channel: 'ch-kbs1',
    ...overrides,
  };
}

/** the topology every test instance is seeded with: one channel/tag/dvr config */
export function topologySnapshot(overrides: Partial<TopologySnapshot> = {}): TopologySnapshot {
  return {
    channels: [
      { uuid: 'ch-kbs1', name: 'KBS1' },
      { uuid: 'ch-mbc1', name: 'MBC1' },
    ],
    tags: [{ uuid: 'tag-1', name: 'Terrestrial' }],
    dvrConfigs: [{ uuid: 'cfg-1', name: 'default profile' }],
    muxes: [],
    services: [],
    networks: [],
    hardware: [],
    frontendNetworks: new Map(),
    fetchedAt: Date.now(),
    ...overrides,
  };
}

/** NameMaps matching topologySnapshot() above, for computing expected hashes in assertions */
export function nameMaps(): NameMaps {
  return {
    channelsByUuid: new Map([
      ['ch-kbs1', 'KBS1'],
      ['ch-mbc1', 'MBC1'],
    ]),
    tagsByUuid: new Map([['tag-1', 'Terrestrial']]),
    dvrConfigsByUuid: new Map([['cfg-1', 'default profile']]),
  };
}

export async function seedMasterRule(
  db: Kysely<Database>,
  fields: Partial<{
    id: string;
    name: string;
    payload: MasterRulePayload;
    enabled: boolean;
    parentId: string | null;
    overlay: Partial<MasterRulePayload> | null;
    instances: string[] | null;
    deletedAt: string | null;
    updatedAt: string;
  }> = {},
): Promise<string> {
  const id = fields.id ?? randomUUID();
  const name = fields.name ?? 'Test Rule';
  await db
    .insertInto('master_rules')
    .values({
      id,
      name,
      payload: JSON.stringify(fields.payload ?? (fields.parentId ? {} : masterRulePayload({ name }))),
      enabled: fields.enabled === false ? 0 : 1,
      updated_at: fields.updatedAt ?? TS,
      parent_id: fields.parentId ?? null,
      overlay: fields.parentId ? JSON.stringify(fields.overlay ?? {}) : null,
      instances: fields.instances ? JSON.stringify(fields.instances) : null,
      deleted_at: fields.deletedAt ?? null,
    })
    .execute();
  return id;
}

export async function seedRuleBinding(
  db: Kysely<Database>,
  fields: {
    masterRuleId: string;
    instanceId: string;
    tvhUuid: string;
    masterHash: string;
    pushedHash: string;
    pushedAt?: string;
  },
): Promise<void> {
  await db
    .insertInto('rule_bindings')
    .values({
      master_rule_id: fields.masterRuleId,
      instance_id: fields.instanceId,
      tvh_uuid: fields.tvhUuid,
      master_hash: fields.masterHash,
      pushed_hash: fields.pushedHash,
      pushed_at: fields.pushedAt ?? TS,
    })
    .execute();
}

export async function seedIgnoredOrphan(
  db: Kysely<Database>,
  fields: { instanceId: string; tvhUuid: string; name?: string },
): Promise<void> {
  await db
    .insertInto('ignored_orphans')
    .values({
      instance_id: fields.instanceId,
      tvh_uuid: fields.tvhUuid,
      name: fields.name ?? '',
      ignored_at: TS,
    })
    .execute();
}
