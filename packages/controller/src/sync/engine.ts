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

import { randomUUID } from 'node:crypto';
import type {
  DriftItem,
  IntegrityIssue,
  MasterRule,
  MasterRulePayload,
  ReconcileAction,
  RuleInstances,
  RuleWithStatus,
  SyncState,
  TvhAutorecRule,
} from '@tvhc/shared';
import { chanLabel, chanNumberOrder } from '@tvhc/shared';
import type { Db } from '../db/db.js';
import type { EventBus } from '../state/events.js';
import type { InstanceCache } from '../state/instanceCache.js';
import type { InstancePoller } from '../tvh/poller.js';
import { httpError } from '../util/httpError.js';
import { channelNumberTolerated, diffPayloads } from './diff.js';
import { normalizePayload, normalizeRule, payloadHash, type NameMaps } from './normalize.js';
import { channelSetterValue, inScope, materializeScope, resolveEffective } from './resolve.js';

export interface PushResult {
  masterRuleId: string;
  instanceId: string;
  action: 'created' | 'updated' | 'skipped' | 'blocked' | 'error';
  detail?: string;
}

/** create/update input; plain rules carry payload, linked clones parentId+overlay */
export interface RuleInput {
  name: string;
  instances: RuleInstances;
  payload?: MasterRulePayload;
  parentId?: string | null;
  overlay?: Partial<MasterRulePayload> | null;
}

/** per-rule outcome of a batch operation (enable/disable/edit/push) */
export interface RuleBatchResult {
  id: string;
  ok: boolean;
  error?: string;
}

interface BindingRow {
  master_rule_id: string;
  instance_id: string;
  tvh_uuid: string;
  master_hash: string;
  pushed_hash: string;
}

interface ResolvedRule extends MasterRule {
  /** payload after parent+overlay resolution; null when the parent is missing */
  effective: MasterRulePayload | null;
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export class SyncEngine {
  /**
   * All mutating operations are serialized through this chain: concurrent
   * pushes/reconciles for the same rule would otherwise race on bindings
   * (last write wins, corrupting the drift baseline). Public mutators wrap
   * their private *Inner implementation; internal cross-calls use the inner
   * forms directly so a wrapped operation never waits on itself.
   */
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly cache: InstanceCache,
    private readonly pollers: Map<string, InstancePoller>,
    private readonly bus: EventBus,
  ) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => {});
    return next;
  }

  // ---------- topology helpers ----------

  private async ensureTopology(instanceId: string): Promise<NameMaps> {
    const snap = this.cache.get(instanceId);
    if (!snap.topology) {
      const poller = this.pollers.get(instanceId);
      if (!poller) throw new Error(`no poller for instance "${instanceId}"`);
      await poller.pollTopology();
    }
    const topo = this.cache.get(instanceId).topology;
    if (!topo) throw new Error(`topology unavailable for instance "${instanceId}"`);
    return {
      channelsByUuid: new Map(
        topo.channels.map((c) => [c.uuid, { name: c.name, number: c.number ?? null }]),
      ),
      tagsByUuid: new Map(topo.tags.map((t) => [t.uuid, t.name])),
      dvrConfigsByUuid: new Map(topo.dvrConfigs.map((d) => [d.uuid, d.name])),
    };
  }

  /**
   * Pre-push validation. Tvheadend SILENTLY CLEARS an unknown channel/tag
   * name (rule would become all-channels), so a missing name must block.
   * A pinned number additionally requires a channel matching BOTH name and
   * number on the instance.
   */
  private validateNames(instanceId: string, payload: MasterRulePayload): string | null {
    const topo = this.cache.get(instanceId).topology;
    if (!topo) return 'topology not loaded';
    if (payload.channel) {
      const matches = topo.channels.filter((c) => c.name === payload.channel);
      if (payload.channel_number != null) {
        if (!matches.some((c) => (c.number ?? null) === payload.channel_number)) {
          return `channel "${payload.channel}" #${payload.channel_number} not found on instance`;
        }
      } else if (matches.length === 0) {
        return `channel "${payload.channel}" not found on instance`;
      }
    }
    if (payload.tag && !topo.tags.some((t) => t.name === payload.tag)) {
      return `channel tag "${payload.tag}" not found on instance`;
    }
    if (payload.config_name && !topo.dvrConfigs.some((d) => d.name === payload.config_name)) {
      return `DVR profile "${payload.config_name}" not found on instance`;
    }
    return null;
  }

  /**
   * Write-time normalization: a non-empty channel with a null number is pinned
   * to the lowest-numbered channel with that name across the rule's in-scope
   * instances (mirrors channelSetterValue's push-time resolution). Unresolvable
   * names keep null - push falls back to lowest-at-push and validateNames
   * reports the missing channel.
   */
  private pinLowestChannelNumber<T extends { channel?: string; channel_number?: string | null }>(
    payload: T,
    instances: RuleInstances,
  ): T {
    if (!payload.channel || payload.channel_number != null) return payload;
    const ids = instances === 'all' ? this.cache.ids() : instances;
    let lowest: string | null = null;
    for (const id of ids) {
      if (!this.cache.has(id)) continue;
      const topo = this.cache.get(id).topology;
      if (!topo) continue;
      for (const c of topo.channels) {
        if (
          c.name === payload.channel &&
          c.number != null &&
          (lowest == null || chanNumberOrder(c.number) < chanNumberOrder(lowest))
        ) {
          lowest = c.number;
        }
      }
    }
    return lowest == null ? payload : { ...payload, channel_number: lowest };
  }

  // ---------- master rule CRUD ----------

  private rowToRule(r: {
    id: string;
    name: string;
    payload: string;
    enabled: number;
    updated_at: Date;
    parent_id: string | null;
    overlay: string | null;
    instances: string | null;
    deleted_at: Date | null;
  }): MasterRule {
    return {
      id: r.id,
      name: r.name,
      payload: JSON.parse(r.payload) as MasterRulePayload,
      enabled: !!r.enabled,
      updatedAt: new Date(r.updated_at).toISOString(),
      parentId: r.parent_id,
      overlay: r.overlay ? (JSON.parse(r.overlay) as Partial<MasterRulePayload>) : null,
      instances: r.instances ? (JSON.parse(r.instances) as string[]) : 'all',
      deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
    };
  }

  /** active (non-deleted) rules */
  async listRules(): Promise<MasterRule[]> {
    const rows = await this.db
      .selectFrom('master_rules')
      .selectAll()
      .where('deleted_at', 'is', null)
      .orderBy('name')
      .execute();
    return rows.map((r) => this.rowToRule(r));
  }

  async listDeletedRules(): Promise<MasterRule[]> {
    const rows = await this.db
      .selectFrom('master_rules')
      .selectAll()
      .where('deleted_at', 'is not', null)
      .orderBy('name')
      .execute();
    return rows.map((r) => this.rowToRule(r));
  }

  /** every rule name, including deleted ones (name stays reserved) */
  private async allNames(): Promise<Set<string>> {
    const rows = await this.db.selectFrom('master_rules').select('name').execute();
    return new Set(rows.map((r) => r.name));
  }

  /** rules with effective payloads (parent + overlay applied) */
  async listResolved(): Promise<ResolvedRule[]> {
    const rules = await this.listRules();
    const byId = new Map(rules.map((r) => [r.id, r]));
    return rules.map((r) => {
      let effective: MasterRulePayload | null = null;
      try {
        effective = resolveEffective(r, r.parentId ? byId.get(r.parentId) : null);
      } catch {
        // missing parent — surfaced as 'blocked' in rulesWithStatus
      }
      return { ...r, effective };
    });
  }

  async getRule(id: string): Promise<MasterRule | null> {
    const r = await this.db
      .selectFrom('master_rules')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? this.rowToRule(r) : null;
  }

  private async getResolved(id: string): Promise<ResolvedRule | null> {
    const rule = await this.getRule(id);
    if (!rule) return null;
    const parent = rule.parentId ? await this.getRule(rule.parentId) : null;
    let effective: MasterRulePayload | null = null;
    try {
      effective = resolveEffective(rule, parent);
    } catch {
      // missing parent
    }
    return { ...rule, effective };
  }

  private async assertValidParent(parentId: string): Promise<MasterRule> {
    const parent = await this.getRule(parentId);
    if (!parent) throw new Error(`parent rule ${parentId} not found`);
    if (parent.parentId) {
      throw new Error(`"${parent.name}" is itself a linked clone — clone chains are not allowed`);
    }
    return parent;
  }

  createRule(input: RuleInput): Promise<MasterRule> {
    return this.serialize(() => this.createRuleInner(input));
  }

  private async createRuleInner(input: RuleInput): Promise<MasterRule> {
    const taken = await this.allNames();
    if (taken.has(input.name)) {
      throw httpError(
        409,
        `a rule named "${input.name}" already exists (possibly in the Deleted tab — restore or purge it)`,
      );
    }
    const id = randomUUID();
    let payloadJson: string;
    let overlayJson: string | null = null;
    let enabled: boolean;
    if (input.parentId) {
      const parent = await this.assertValidParent(input.parentId);
      const overlay = this.pinLowestChannelNumber(input.overlay ?? {}, input.instances);
      payloadJson = JSON.stringify({});
      overlayJson = JSON.stringify(overlay);
      const effective = resolveEffective(
        { name: input.name, payload: {} as MasterRulePayload, parentId: input.parentId, overlay },
        parent,
      );
      enabled = effective.enabled;
    } else {
      const normalized = normalizePayload({ ...(input.payload as MasterRulePayload), name: input.name });
      const pinned = this.pinLowestChannelNumber(normalized, input.instances);
      payloadJson = JSON.stringify(pinned);
      enabled = pinned.enabled;
    }
    await this.db
      .insertInto('master_rules')
      .values({
        id,
        name: input.name,
        payload: payloadJson,
        enabled: enabled ? 1 : 0,
        updated_at: now(),
        parent_id: input.parentId ?? null,
        overlay: overlayJson,
        instances: input.instances === 'all' ? null : JSON.stringify(input.instances),
      })
      .execute();
    return (await this.getRule(id))!;
  }

  /**
   * Update a rule. When the instance scope shrinks, the rule is DELETED from
   * the removed instances first (cancels its scheduled entries there — the UI
   * confirms before calling); a failed instance delete aborts the update.
   */
  updateRule(id: string, input: RuleInput): Promise<void> {
    return this.serialize(() => this.updateRuleInner(id, input));
  }

  private async updateRuleInner(id: string, input: RuleInput): Promise<void> {
    const existing = await this.getRule(id);
    if (!existing) throw new Error(`rule ${id} not found`);
    if (input.parentId && input.parentId !== existing.parentId) {
      await this.assertValidParent(input.parentId);
    }

    // scope shrink: remove from instances that are no longer targeted
    const allIds = this.cache.ids();
    const oldScope = materializeScope(existing.instances, allIds);
    const newScope = input.instances === 'all' ? allIds : input.instances;
    const removed = oldScope.filter((i) => !newScope.includes(i));
    if (removed.length) {
      const bindings = await this.db
        .selectFrom('rule_bindings')
        .selectAll()
        .where('master_rule_id', '=', id)
        .where('instance_id', 'in', removed)
        .execute();
      for (const b of bindings) {
        const poller = this.pollers.get(b.instance_id);
        if (poller) {
          try {
            await poller.client.idnodeDelete(b.tvh_uuid);
          } catch (err) {
            if (!(err instanceof Error && err.message.includes('404'))) throw err;
          }
          await poller.pollAutorecs().catch(() => {});
        }
        await this.db
          .deleteFrom('rule_bindings')
          .where('master_rule_id', '=', id)
          .where('instance_id', '=', b.instance_id)
          .execute();
      }
    }

    const isClone = !!(input.parentId ?? existing.parentId);
    let payloadJson: string | undefined;
    let overlayJson: string | null = null;
    let enabled: boolean;
    if (isClone) {
      const parent = await this.getRule(input.parentId ?? existing.parentId!);
      const overlay = this.pinLowestChannelNumber(
        input.overlay ?? existing.overlay ?? {},
        input.instances,
      );
      overlayJson = JSON.stringify(overlay);
      const effective = resolveEffective(
        {
          name: input.name,
          payload: {} as MasterRulePayload,
          parentId: input.parentId ?? existing.parentId,
          overlay,
        },
        parent,
      );
      enabled = effective.enabled;
    } else {
      const normalized = normalizePayload({ ...(input.payload as MasterRulePayload), name: input.name });
      const pinned = this.pinLowestChannelNumber(normalized, input.instances);
      payloadJson = JSON.stringify(pinned);
      enabled = pinned.enabled;
    }

    await this.db
      .updateTable('master_rules')
      .set({
        name: input.name,
        ...(payloadJson !== undefined ? { payload: payloadJson } : {}),
        enabled: enabled ? 1 : 0,
        updated_at: now(),
        parent_id: input.parentId ?? existing.parentId,
        overlay: isClone ? overlayJson : null,
        instances: input.instances === 'all' ? null : JSON.stringify(input.instances),
      })
      .where('id', '=', id)
      .execute();
  }

  // ---------- batch operations ----------

  /**
   * Apply a field change to one rule, writing to the payload (plain rule) or the
   * overlay (linked clone) so plain/clone semantics match a single edit exactly.
   * Master only — like single edit, the change is left pending until pushed.
   */
  private async applyRuleChangeInner(id: string, change: Partial<MasterRulePayload>): Promise<void> {
    const existing = await this.getRule(id);
    if (!existing) throw new Error(`rule ${id} not found`);
    if (existing.deletedAt) throw new Error(`rule "${existing.name}" is deleted — restore it first`);
    // channel identity is a (name, number) pair: a change that sets the name
    // without an explicit number must not inherit the previous pin
    if ('channel' in change && !('channel_number' in change)) {
      change = { ...change, channel_number: null };
    }
    // a channel change with no pinned number resolves to the lowest-numbered
    // same-name channel across the rule's own instance scope (write-time
    // normalization mirrors channelSetterValue's push-time fallback)
    if ('channel' in change) {
      change = this.pinLowestChannelNumber(change, existing.instances);
    }
    const input: RuleInput = existing.parentId
      ? {
          name: existing.name,
          instances: existing.instances,
          parentId: existing.parentId,
          overlay: { ...(existing.overlay ?? {}), ...change },
        }
      : {
          name: existing.name,
          instances: existing.instances,
          payload: { ...existing.payload, ...change } as MasterRulePayload,
        };
    await this.updateRuleInner(id, input);
  }

  private async runBatch(
    ids: string[],
    fn: (id: string) => Promise<void>,
  ): Promise<RuleBatchResult[]> {
    const out: RuleBatchResult[] = [];
    for (const id of ids) {
      try {
        await fn(id);
        out.push({ id, ok: true });
      } catch (err) {
        out.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }

  /**
   * Soft-delete many rules (removes them from their instances, cancelling the
   * scheduled recordings there, but keeps them restorable in the Deleted tab).
   * Clones are deleted before parents — deleteRuleInner refuses a parent that
   * still has active linked clones.
   */
  batchDelete(ids: string[]): Promise<RuleBatchResult[]> {
    return this.serialize(async () => {
      const meta = await Promise.all(
        ids.map(async (id) => ({ id, isClone: !!(await this.getRule(id))?.parentId })),
      );
      const order = meta
        .slice()
        .sort((a, b) => Number(b.isClone) - Number(a.isClone))
        .map((m) => m.id);
      return this.runBatch(order, (id) => this.deleteRuleInner(id));
    });
  }

  /** merge a field patch into many rules (master only — left pending until pushed) */
  batchEdit(ids: string[], patch: Partial<MasterRulePayload>): Promise<RuleBatchResult[]> {
    const clean = { ...patch };
    delete (clean as Record<string, unknown>).name; // names stay per-rule unique
    return this.serialize(() => this.runBatch(ids, (id) => this.applyRuleChangeInner(id, clean)));
  }

  /** push many rules to their targeted instances */
  batchPush(ids: string[]): Promise<RuleBatchResult[]> {
    return this.serialize(() =>
      this.runBatch(ids, async (id) => {
        await this.pushRuleInner(id);
      }),
    );
  }

  /** clone a rule: plain copy of its effective payload, or a linked clone with an empty overlay */
  createClone(sourceId: string, linked: boolean, name: string): Promise<MasterRule> {
    return this.serialize(async () => {
      const source = await this.getResolved(sourceId);
      if (!source) throw new Error(`rule ${sourceId} not found`);
      if (linked) {
        if (source.parentId) {
          throw new Error(`"${source.name}" is itself a linked clone — clone chains are not allowed`);
        }
        return this.createRuleInner({ name, instances: source.instances, parentId: source.id, overlay: {} });
      }
      if (!source.effective) throw new Error(`cannot resolve "${source.name}" (missing parent)`);
      return this.createRuleInner({
        name,
        instances: source.instances,
        payload: { ...source.effective, name },
      });
    });
  }

  /**
   * Soft-deletes the master rule: the bound rules on every instance ARE
   * deleted (cancels their scheduled entries) and bindings dropped, but the
   * master row is only marked deleted — restorable from the Deleted tab.
   * Blocked while ACTIVE linked clones reference it.
   */
  deleteRule(id: string): Promise<void> {
    return this.serialize(() => this.deleteRuleInner(id));
  }

  private async deleteRuleInner(id: string): Promise<void> {
    const children = await this.db
      .selectFrom('master_rules')
      .select('name')
      .where('parent_id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();
    if (children.length) {
      throw httpError(
        409,
        `rule has linked clones: ${children.map((c) => `"${c.name}"`).join(', ')} — delete or detach them first`,
      );
    }
    const bindings = await this.db
      .selectFrom('rule_bindings')
      .selectAll()
      .where('master_rule_id', '=', id)
      .execute();
    for (const b of bindings) {
      const poller = this.pollers.get(b.instance_id);
      if (!poller) continue;
      try {
        await poller.client.idnodeDelete(b.tvh_uuid);
      } catch (err) {
        // rule may already be gone on the instance; deletion of master proceeds
        if (!(err instanceof Error && err.message.includes('404'))) throw err;
      }
      await poller.pollAutorecs().catch(() => {});
    }
    await this.db.deleteFrom('rule_bindings').where('master_rule_id', '=', id).execute();
    await this.db
      .updateTable('master_rules')
      .set({ deleted_at: now(), updated_at: now() })
      .where('id', '=', id)
      .execute();
  }

  /** restore a soft-deleted rule and push it back to its scoped instances */
  restoreRule(id: string): Promise<PushResult[]> {
    return this.serialize(async () => {
      const rule = await this.getRule(id);
      if (!rule) throw new Error(`rule ${id} not found`);
      if (!rule.deletedAt) throw new Error(`rule "${rule.name}" is not deleted`);
      if (rule.parentId) {
        const parent = await this.getRule(rule.parentId);
        if (!parent || parent.deletedAt) {
          throw httpError(409, `cannot restore linked clone "${rule.name}" — restore its parent first`);
        }
      }
      await this.db
        .updateTable('master_rules')
        .set({ deleted_at: null, updated_at: now() })
        .where('id', '=', id)
        .execute();
      return this.pushRuleInner(id);
    });
  }

  /** permanently remove a soft-deleted rule (no instance-side effect — that happened at delete time) */
  purgeRule(id: string): Promise<void> {
    return this.serialize(async () => {
      const rule = await this.getRule(id);
      if (!rule) throw new Error(`rule ${id} not found`);
      if (!rule.deletedAt) throw new Error(`rule "${rule.name}" is not deleted — delete it first`);
      const children = await this.db
        .selectFrom('master_rules')
        .select('name')
        .where('parent_id', '=', id)
        .execute();
      if (children.length) {
        throw httpError(
          409,
          `rule still has linked clones (${children.map((c) => `"${c.name}"`).join(', ')}) — purge them first`,
        );
      }
      await this.db.deleteFrom('master_rules').where('id', '=', id).execute();
    });
  }

  // ---------- push ----------

  pushRule(ruleId: string, instanceIds?: string[]): Promise<PushResult[]> {
    return this.serialize(() => this.pushRuleInner(ruleId, instanceIds));
  }

  private async pushRuleInner(ruleId: string, instanceIds?: string[]): Promise<PushResult[]> {
    const rule = await this.getResolved(ruleId);
    if (!rule) throw new Error(`master rule ${ruleId} not found`);
    if (rule.deletedAt) throw new Error(`rule "${rule.name}" is deleted — restore it first`);
    const targets = (instanceIds ?? this.cache.ids()).filter((i) => inScope(rule.instances, i));
    const results: PushResult[] = [];
    for (const instanceId of targets) {
      results.push(await this.pushRuleToInstance(rule, instanceId));
    }
    return results;
  }

  pushAll(): Promise<PushResult[]> {
    return this.serialize(async () => {
      const rules = await this.listResolved();
      const results: PushResult[] = [];
      for (const rule of rules) {
        for (const instanceId of this.cache.ids()) {
          if (!inScope(rule.instances, instanceId)) continue;
          results.push(await this.pushRuleToInstance(rule, instanceId));
        }
      }
      return results;
    });
  }

  private async pushRuleToInstance(rule: ResolvedRule, instanceId: string): Promise<PushResult> {
    const base: Omit<PushResult, 'action'> = { masterRuleId: rule.id, instanceId };
    try {
      if (!rule.effective) {
        return { ...base, action: 'error', detail: 'linked clone has a missing parent rule' };
      }
      const maps = await this.ensureTopology(instanceId);
      const poller = this.pollers.get(instanceId);
      if (!poller) return { ...base, action: 'error', detail: 'no poller' };

      const masterHash = payloadHash(rule.effective);
      const binding = await this.db
        .selectFrom('rule_bindings')
        .selectAll()
        .where('master_rule_id', '=', rule.id)
        .where('instance_id', '=', instanceId)
        .executeTakeFirst();

      if (binding && binding.master_hash === masterHash) {
        return { ...base, action: 'skipped', detail: 'already up to date' };
      }

      const blocked = this.validateNames(instanceId, rule.effective);
      if (blocked) return { ...base, action: 'blocked', detail: blocked };

      const conf: Record<string, unknown> = { ...rule.effective };
      delete conf.channel_number; // controller-only field - must not leak to tvheadend
      conf.channel = channelSetterValue(
        this.cache.get(instanceId).topology!.channels,
        rule.effective.channel,
        rule.effective.channel_number,
      );
      let tvhUuid: string;
      if (binding) {
        await poller.client.idnodeSave({ uuid: binding.tvh_uuid, ...conf });
        tvhUuid = binding.tvh_uuid;
      } else {
        tvhUuid = await poller.client.autorecCreate(conf);
      }

      // read back what tvheadend actually stored: the drift baseline must
      // reflect tvh's own value coercion, not our payload
      const rules = await poller.client.autorecGrid();
      const stored = rules.find((r) => r.uuid === tvhUuid);
      if (!stored) return { ...base, action: 'error', detail: 'rule vanished after push' };
      const readBack = normalizeRule(stored, maps);
      // fold a tolerated channel_number the same way diffPayloads does: a
      // legacy (null) rule whose read-back resolved to a concrete channel
      // uuid must not perpetually hash-mismatch its own pushed baseline
      const pushedHash = payloadHash(
        channelNumberTolerated(rule.effective, readBack)
          ? { ...readBack, channel_number: rule.effective.channel_number }
          : readBack,
      );

      await this.db
        .insertInto('rule_bindings')
        .values({
          master_rule_id: rule.id,
          instance_id: instanceId,
          tvh_uuid: tvhUuid,
          master_hash: masterHash,
          pushed_hash: pushedHash,
          pushed_at: now(),
        })
        .onDuplicateKeyUpdate({
          tvh_uuid: tvhUuid,
          master_hash: masterHash,
          pushed_hash: pushedHash,
          pushed_at: now(),
        })
        .execute();

      this.cache.get(instanceId).autorecs = rules;
      return { ...base, action: binding ? 'updated' : 'created' };
    } catch (err) {
      return { ...base, action: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------- drift ----------

  async computeDrift(): Promise<DriftItem[]> {
    const items: DriftItem[] = [];
    const rules = await this.listResolved();
    const rulesById = new Map(rules.map((r) => [r.id, r]));
    const bindings = (await this.db
      .selectFrom('rule_bindings')
      .selectAll()
      .execute()) as BindingRow[];
    const ignored = new Set(
      (await this.db.selectFrom('ignored_orphans').select(['instance_id', 'tvh_uuid']).execute()).map(
        (r) => `${r.instance_id}:${r.tvh_uuid}`,
      ),
    );

    for (const instanceId of this.cache.ids()) {
      const snap = this.cache.get(instanceId);
      if (!snap.summary.reachable && snap.autorecs.length === 0) continue;
      let maps: NameMaps;
      try {
        maps = await this.ensureTopology(instanceId);
      } catch {
        continue;
      }
      const instanceRules = new Map(snap.autorecs.map((r) => [r.uuid, r]));
      const boundUuids = new Set<string>();

      for (const b of bindings.filter((b) => b.instance_id === instanceId)) {
        const master = rulesById.get(b.master_rule_id);
        if (!master || !master.effective) continue;
        const instanceRule = instanceRules.get(b.tvh_uuid);
        boundUuids.add(b.tvh_uuid);
        if (!instanceRule) {
          items.push({
            id: `deleted-on-instance:${instanceId}:${b.master_rule_id}`,
            kind: 'deleted-on-instance',
            instanceId,
            masterRuleId: b.master_rule_id,
            masterRuleName: master.name,
            tvhUuid: b.tvh_uuid,
            masterPayload: master.effective,
          });
          continue;
        }
        const normalized = normalizeRule(instanceRule, maps);
        // same fold as at push time: compare against the tolerant baseline,
        // not the raw read-back, or a legacy rule would show perpetual
        // false drift purely from tvheadend's internal uuid resolution
        const canonical = channelNumberTolerated(master.effective, normalized)
          ? { ...normalized, channel_number: master.effective.channel_number }
          : normalized;
        if (payloadHash(canonical) !== b.pushed_hash) {
          items.push({
            id: `modified-on-instance:${instanceId}:${b.tvh_uuid}`,
            kind: 'modified-on-instance',
            instanceId,
            masterRuleId: b.master_rule_id,
            masterRuleName: master.name,
            tvhUuid: b.tvh_uuid,
            instanceRuleName: instanceRule.name,
            diffs: diffPayloads(master.effective, normalized),
            instancePayload: normalized,
            masterPayload: master.effective,
          });
        }
      }

      for (const rule of snap.autorecs) {
        if (boundUuids.has(rule.uuid)) continue;
        if (ignored.has(`${instanceId}:${rule.uuid}`)) continue;
        items.push({
          id: `orphan:${instanceId}:${rule.uuid}`,
          kind: 'orphan',
          instanceId,
          tvhUuid: rule.uuid,
          instanceRuleName: rule.name,
          instancePayload: normalizeRule(rule, maps),
        });
      }
    }
    return items;
  }

  async publishDrift(): Promise<void> {
    const items = await this.computeDrift();
    this.bus.publish({ type: 'drift', data: { items } });
  }

  // ---------- manual integrity check ----------

  /**
   * Baseline-free verification: refresh every instance's autorec grid, then
   * compare the controller's effective rules field by field (name included)
   * against what is actually configured. Reports ANY divergence — including
   * ones the drift baseline deliberately tolerates (e.g. renames pending
   * after a split) and structural problems (broken parents, stale bindings).
   */
  async integrityCheck(): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    const rules = await this.listResolved();
    const rulesById = new Map(rules.map((r) => [r.id, r]));
    const bindings = (await this.db
      .selectFrom('rule_bindings')
      .selectAll()
      .execute()) as BindingRow[];
    const ignored = new Set(
      (await this.db.selectFrom('ignored_orphans').select(['instance_id', 'tvh_uuid']).execute()).map(
        (r) => `${r.instance_id}:${r.tvh_uuid}`,
      ),
    );

    for (const rule of rules) {
      if (rule.parentId && !rulesById.has(rule.parentId)) {
        issues.push({
          kind: 'missing-parent',
          masterRuleId: rule.id,
          masterRuleName: rule.name,
          detail: `linked clone "${rule.name}" references a parent rule that no longer exists`,
        });
      }
    }

    for (const instanceId of this.cache.ids()) {
      const poller = this.pollers.get(instanceId);
      if (!poller) continue;
      // a manual check must judge fresh state, not the cache
      try {
        await poller.pollAutorecs();
      } catch (err) {
        issues.push({
          kind: 'missing-on-instance',
          instanceId,
          detail: `instance unreachable — could not verify: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      let maps: NameMaps;
      try {
        maps = await this.ensureTopology(instanceId);
      } catch {
        continue;
      }
      const snap = this.cache.get(instanceId);
      const instanceRules = new Map(snap.autorecs.map((r) => [r.uuid, r]));
      const boundUuids = new Set<string>();

      for (const b of bindings.filter((b) => b.instance_id === instanceId)) {
        const master = rulesById.get(b.master_rule_id);
        if (!master) continue; // FK cascade makes this unreachable, but stay safe
        boundUuids.add(b.tvh_uuid);

        if (!inScope(master.instances, instanceId)) {
          issues.push({
            kind: 'out-of-scope-binding',
            instanceId,
            masterRuleId: master.id,
            masterRuleName: master.name,
            tvhUuid: b.tvh_uuid,
            detail: `"${master.name}" no longer targets ${instanceId} but a bound rule still exists there`,
          });
        }

        const instanceRule = instanceRules.get(b.tvh_uuid);
        if (!instanceRule) {
          issues.push({
            kind: 'missing-on-instance',
            instanceId,
            masterRuleId: master.id,
            masterRuleName: master.name,
            tvhUuid: b.tvh_uuid,
            detail: `bound rule for "${master.name}" does not exist on ${instanceId}`,
          });
          continue;
        }
        if (!master.effective) continue; // reported as missing-parent above
        const diffs = diffPayloads(master.effective, normalizeRule(instanceRule, maps));
        if (diffs.length) {
          issues.push({
            kind: 'content-mismatch',
            instanceId,
            masterRuleId: master.id,
            masterRuleName: master.name,
            tvhUuid: b.tvh_uuid,
            instanceRuleName: instanceRule.name,
            diffs,
            detail: `"${master.name}" differs on ${instanceId}: ${diffs.map((d) => d.field).join(', ')}`,
          });
        }
      }

      for (const rule of rules) {
        if (!inScope(rule.instances, instanceId)) continue;
        if (!bindings.some((b) => b.master_rule_id === rule.id && b.instance_id === instanceId)) {
          issues.push({
            kind: 'unpushed',
            instanceId,
            masterRuleId: rule.id,
            masterRuleName: rule.name,
            detail: `"${rule.name}" targets ${instanceId} but has never been pushed there`,
          });
        }
      }

      for (const rule of snap.autorecs) {
        if (boundUuids.has(rule.uuid)) continue;
        const isIgnored = ignored.has(`${instanceId}:${rule.uuid}`);
        issues.push({
          kind: 'orphan-rule',
          instanceId,
          tvhUuid: rule.uuid,
          instanceRuleName: rule.name,
          detail: `"${rule.name ?? rule.uuid}" exists on ${instanceId} but is not managed by the controller${isIgnored ? ' (acknowledged via ignore)' : ''}`,
        });
      }
    }
    return issues;
  }

  // ---------- reconcile ----------

  private async uniqueRuleName(base: string, hint?: string): Promise<string> {
    const taken = await this.allNames();
    if (!taken.has(base)) return base;
    let candidate = hint ? `${base} (${hint})` : `${base} (2)`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base} (${n})`;
    return candidate;
  }

  reconcile(driftId: string, action: ReconcileAction): Promise<void> {
    return this.serialize(() => this.reconcileInner(driftId, action));
  }

  private async reconcileInner(driftId: string, action: ReconcileAction): Promise<void> {
    const items = await this.computeDrift();
    const item = items.find((i) => i.id === driftId);
    if (!item) throw new Error(`drift item ${driftId} no longer exists`);
    const poller = this.pollers.get(item.instanceId);
    if (!poller) throw new Error(`no poller for instance "${item.instanceId}"`);

    switch (action) {
      case 'overwrite-from-master': {
        if (!item.masterRuleId) throw new Error('not a bound drift item');
        await this.pushWithForce(item.masterRuleId, item.instanceId);
        break;
      }
      case 'import-into-master': {
        if (!item.masterRuleId || !item.instancePayload) throw new Error('not importable');
        const master = await this.getRule(item.masterRuleId);
        if (!master) throw new Error('master rule vanished');
        if (master.parentId) {
          throw new Error('cannot import into a linked clone — edit its overlay instead');
        }
        await this.updateRuleInner(item.masterRuleId, {
          name: master.name,
          instances: master.instances,
          payload: item.instancePayload,
        });
        await this.pushRuleInner(item.masterRuleId);
        break;
      }
      case 'split-into-clone': {
        // intentional per-zone variant: narrow the master's scope away from
        // this instance and capture the difference as a linked clone bound
        // to the instance's EXISTING rule — zero tvheadend writes
        if (item.kind !== 'modified-on-instance') throw new Error('only modified rules can be split');
        if (!item.masterRuleId || !item.instancePayload || !item.tvhUuid || !item.masterPayload) {
          throw new Error('drift item is missing data for a split');
        }
        const master = await this.getRule(item.masterRuleId);
        if (!master) throw new Error('master rule vanished');
        if (master.parentId) throw new Error('cannot split a linked clone');

        const allIds = this.cache.ids();
        const newScope = materializeScope(master.instances, allIds).filter(
          (i) => i !== item.instanceId,
        );
        await this.db
          .updateTable('master_rules')
          .set({ instances: JSON.stringify(newScope), updated_at: now() })
          .where('id', '=', master.id)
          .execute();

        const overlay: Partial<MasterRulePayload> = {};
        for (const d of diffPayloads(item.masterPayload, item.instancePayload)) {
          if (d.field === 'name') continue; // name comes from the clone itself
          (overlay as Record<string, unknown>)[d.field] = d.instance;
        }
        const cloneName = await this.uniqueRuleName(
          master.name,
          item.instancePayload.channel
            ? chanLabel(item.instancePayload.channel, item.instancePayload.channel_number ?? null)
            : item.instanceId,
        );
        const clone = await this.createRuleInner({
          name: cloneName,
          instances: [item.instanceId],
          parentId: master.id,
          overlay,
        });

        // re-point the existing binding. BOTH hashes are the instance's
        // actual state: the clone's unique NAME still differs from the rule
        // name on the instance, so the clone honestly shows 'pending' until
        // the next push of this rule (an in-place save that preserves its
        // scheduled entries).
        const instanceHash = payloadHash(normalizePayload(item.instancePayload));
        await this.db
          .updateTable('rule_bindings')
          .set({ master_rule_id: clone.id, master_hash: instanceHash, pushed_hash: instanceHash })
          .where('master_rule_id', '=', master.id)
          .where('instance_id', '=', item.instanceId)
          .execute();
        break;
      }
      case 'adopt-orphan': {
        if (!item.instancePayload || !item.tvhUuid) throw new Error('not an orphan');
        // baseline of what is ACTUALLY on the instance right now — must be
        // computed before any rename, or the binding would register false
        // drift (and the rename push would be skipped as "up to date")
        const instanceHash = payloadHash(normalizePayload(item.instancePayload));
        const name = await this.uniqueRuleName(
          item.instancePayload.name,
          item.instancePayload.channel
            ? chanLabel(item.instancePayload.channel, item.instancePayload.channel_number ?? null)
            : undefined,
        );
        // scoped to its own instance: adopting must not replicate the rule
        // to other zones — widen the scope explicitly if that is wanted
        const rule = await this.createRuleInner({
          name,
          instances: [item.instanceId],
          payload: { ...item.instancePayload, name },
        });
        await this.db
          .insertInto('rule_bindings')
          .values({
            master_rule_id: rule.id,
            instance_id: item.instanceId,
            tvh_uuid: item.tvhUuid,
            master_hash: instanceHash,
            pushed_hash: instanceHash,
            pushed_at: now(),
          })
          .execute();
        // if the rule was renamed, master hash differs from the baseline and
        // this push renames it in-place on the source instance
        await this.pushRuleInner(rule.id);
        break;
      }
      case 'ignore-orphan': {
        if (item.kind !== 'orphan' || !item.tvhUuid) throw new Error('not an orphan');
        // acknowledged instance-local rule: stays on the instance untouched
        // and is no longer reported as drift
        await this.db
          .insertInto('ignored_orphans')
          .values({
            instance_id: item.instanceId,
            tvh_uuid: item.tvhUuid,
            name: item.instanceRuleName ?? '',
          })
          .onDuplicateKeyUpdate({ name: item.instanceRuleName ?? '' })
          .execute();
        break;
      }
      case 'delete-from-instance': {
        if (!item.tvhUuid) throw new Error('no instance rule to delete');
        await poller.client.idnodeDelete(item.tvhUuid);
        if (item.masterRuleId) {
          await this.db
            .deleteFrom('rule_bindings')
            .where('master_rule_id', '=', item.masterRuleId)
            .where('instance_id', '=', item.instanceId)
            .execute();
        }
        await poller.pollAutorecs();
        break;
      }
      case 'recreate-on-instance': {
        if (!item.masterRuleId) throw new Error('not a bound drift item');
        await this.db
          .deleteFrom('rule_bindings')
          .where('master_rule_id', '=', item.masterRuleId)
          .where('instance_id', '=', item.instanceId)
          .execute();
        await this.pushRuleInner(item.masterRuleId, [item.instanceId]);
        break;
      }
      case 'delete-master': {
        if (!item.masterRuleId) throw new Error('not a bound drift item');
        await this.deleteRuleInner(item.masterRuleId);
        break;
      }
    }
    await this.publishDrift();
  }

  /** force a push even when master_hash matches (used by overwrite-from-master) */
  private async pushWithForce(ruleId: string, instanceId: string): Promise<void> {
    const binding = await this.db
      .selectFrom('rule_bindings')
      .select(['master_hash'])
      .where('master_rule_id', '=', ruleId)
      .where('instance_id', '=', instanceId)
      .executeTakeFirst();
    await this.db
      .updateTable('rule_bindings')
      .set({ master_hash: 'force-repush' })
      .where('master_rule_id', '=', ruleId)
      .where('instance_id', '=', instanceId)
      .execute();
    const results = await this.pushRuleInner(ruleId, [instanceId]);
    const failed = results.find((r) => r.action === 'error' || r.action === 'blocked');
    if (failed) {
      // a failed push never reached the binding update — restore the real
      // hash so the sentinel doesn't leave the rule permanently "pending"
      if (binding) {
        await this.db
          .updateTable('rule_bindings')
          .set({ master_hash: binding.master_hash })
          .where('master_rule_id', '=', ruleId)
          .where('instance_id', '=', instanceId)
          .execute();
      }
      throw new Error(`push failed: ${failed.detail}`);
    }
  }

  async listIgnoredOrphans(): Promise<
    Array<{ instanceId: string; tvhUuid: string; name: string; ignoredAt: string }>
  > {
    const rows = await this.db.selectFrom('ignored_orphans').selectAll().execute();
    return rows.map((r) => ({
      instanceId: r.instance_id,
      tvhUuid: r.tvh_uuid,
      name: r.name,
      ignoredAt: new Date(r.ignored_at).toISOString(),
    }));
  }

  async unignoreOrphan(instanceId: string, tvhUuid: string): Promise<void> {
    await this.db
      .deleteFrom('ignored_orphans')
      .where('instance_id', '=', instanceId)
      .where('tvh_uuid', '=', tvhUuid)
      .execute();
    await this.publishDrift();
  }

  // ---------- bootstrap import ----------

  /**
   * Imports all rules from one instance as master rules, then binds matching
   * rules on the other instances by normalized hash (fallback: name) so the
   * pre-existing identical rule sets don't need manual reconciliation.
   */
  importFromInstance(sourceInstanceId: string): Promise<{ imported: number; bound: number }> {
    return this.serialize(() => this.importFromInstanceInner(sourceInstanceId));
  }

  private async importFromInstanceInner(
    sourceInstanceId: string,
  ): Promise<{ imported: number; bound: number }> {
    const sourceMaps = await this.ensureTopology(sourceInstanceId);
    const poller = this.pollers.get(sourceInstanceId);
    if (!poller) throw new Error(`no poller for instance "${sourceInstanceId}"`);
    await poller.pollAutorecs();
    const sourceRules = this.cache.get(sourceInstanceId).autorecs;

    let imported = 0;
    let bound = 0;
    const existingNames = await this.allNames();

    for (const tvhRule of sourceRules) {
      const payload = normalizeRule(tvhRule, sourceMaps);
      if (!payload.name) payload.name = tvhRule.title || tvhRule.uuid;
      if (existingNames.has(payload.name)) continue;
      existingNames.add(payload.name);

      const rule = await this.createRuleInner({ name: payload.name, instances: 'all', payload });
      imported++;
      const masterHash = payloadHash(normalizePayload(rule.payload));

      await this.db
        .insertInto('rule_bindings')
        .values({
          master_rule_id: rule.id,
          instance_id: sourceInstanceId,
          tvh_uuid: tvhRule.uuid,
          master_hash: masterHash,
          pushed_hash: payloadHash(payload),
          pushed_at: now(),
        })
        .execute();
      bound++;

      // bind matching rules on other instances without touching tvheadend
      for (const otherId of this.cache.ids()) {
        if (otherId === sourceInstanceId) continue;
        let otherMaps: NameMaps;
        try {
          otherMaps = await this.ensureTopology(otherId);
        } catch {
          continue;
        }
        const otherPoller = this.pollers.get(otherId);
        if (otherPoller && this.cache.get(otherId).autorecs.length === 0) {
          await otherPoller.pollAutorecs().catch(() => {});
        }
        const candidates = this.cache.get(otherId).autorecs;
        const boundUuids = new Set(
          (
            await this.db
              .selectFrom('rule_bindings')
              .select('tvh_uuid')
              .where('instance_id', '=', otherId)
              .execute()
          ).map((r) => r.tvh_uuid),
        );
        const match = this.matchRule(payload, candidates, otherMaps, boundUuids);
        if (match) {
          // baseline is the MASTER hash: a name-matched rule whose content
          // differs (e.g. a per-zone channel variant) must surface as
          // modified-on-instance drift — resolvable via split-into-clone —
          // never silently bind as in-sync
          await this.db
            .insertInto('rule_bindings')
            .values({
              master_rule_id: rule.id,
              instance_id: otherId,
              tvh_uuid: match.uuid,
              master_hash: masterHash,
              pushed_hash: masterHash,
              pushed_at: now(),
            })
            .execute();
          bound++;
        }
      }
    }
    await this.publishDrift();
    return { imported, bound };
  }

  private matchRule(
    payload: MasterRulePayload,
    candidates: TvhAutorecRule[],
    maps: NameMaps,
    alreadyBound: Set<string>,
  ): TvhAutorecRule | null {
    const targetHash = payloadHash(payload);
    for (const c of candidates) {
      if (alreadyBound.has(c.uuid)) continue;
      if (payloadHash(normalizeRule(c, maps)) === targetHash) return c;
    }
    return candidates.find((c) => !alreadyBound.has(c.uuid) && c.name === payload.name) ?? null;
  }

  // ---------- per-instance status ----------

  async rulesWithStatus(): Promise<RuleWithStatus[]> {
    const rules = await this.listResolved();
    const rulesById = new Map(rules.map((r) => [r.id, r]));
    const bindings = (await this.db
      .selectFrom('rule_bindings')
      .selectAll()
      .execute()) as BindingRow[];
    const drift = await this.computeDrift();
    const driftByBinding = new Map(
      drift
        .filter((d) => d.masterRuleId)
        .map((d) => [`${d.masterRuleId}:${d.instanceId}`, d.kind] as const),
    );

    // upcoming entries per autorec uuid, from the cached grids — costs zero
    // additional tvheadend requests
    const matchCounts = new Map<string, number>();
    for (const instanceId of this.cache.ids()) {
      for (const e of this.cache.get(instanceId).upcoming) {
        if (!e.autorec || e.enabled === false) continue;
        const key = `${instanceId}:${e.autorec}`;
        matchCounts.set(key, (matchCounts.get(key) ?? 0) + 1);
      }
    }

    return rules.map((rule) => {
      const perInstance: RuleWithStatus['perInstance'] = {};
      let upcomingMatches = 0;
      for (const instanceId of this.cache.ids()) {
        if (!inScope(rule.instances, instanceId)) continue;
        const b = bindings.find(
          (x) => x.master_rule_id === rule.id && x.instance_id === instanceId,
        );
        let state: SyncState;
        let blockedReason: string | undefined;
        if (!rule.effective) {
          state = 'blocked';
          blockedReason = 'parent rule is missing';
        } else if (!b) {
          const blocked = this.validateNames(instanceId, rule.effective);
          state = blocked ? 'blocked' : 'unpushed';
          blockedReason = blocked ?? undefined;
        } else if (driftByBinding.has(`${rule.id}:${instanceId}`)) {
          state = 'drift';
        } else if (b.master_hash !== payloadHash(rule.effective)) {
          const blocked = this.validateNames(instanceId, rule.effective);
          state = blocked ? 'blocked' : 'pending';
          blockedReason = blocked ?? undefined;
        } else {
          state = 'in-sync';
        }
        const matches = b ? (matchCounts.get(`${instanceId}:${b.tvh_uuid}`) ?? 0) : 0;
        upcomingMatches += matches;
        perInstance[instanceId] = {
          state,
          tvhUuid: b?.tvh_uuid,
          blockedReason,
          upcomingMatches: matches,
        };
      }
      return {
        id: rule.id,
        name: rule.name,
        enabled: rule.effective?.enabled ?? rule.enabled,
        updatedAt: rule.updatedAt,
        payload: rule.payload,
        effectivePayload: rule.effective ?? normalizePayload({ ...rule.payload, name: rule.name }),
        parentId: rule.parentId,
        parentName: rule.parentId ? (rulesById.get(rule.parentId)?.name ?? null) : null,
        overlay: rule.overlay,
        instances: rule.instances,
        perInstance,
        upcomingMatches,
      };
    });
  }
}
