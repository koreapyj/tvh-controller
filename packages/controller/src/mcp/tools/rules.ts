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

import type { RuleWithStatus } from '@tvhc/shared';
import { z } from 'zod';
import { p } from '../inject.js';
import {
  DESTRUCTIVE,
  READ,
  READ_REMOTE,
  WRITE,
  WRITE_IDEMPOTENT,
  instanceId,
  page,
  pageShape,
  passthroughObject,
  tool,
  type ToolDef,
} from './common.js';

const ruleId = z.string().min(1).describe('master rule id (see list_rules)');

const ruleInstances = z
  .union([z.literal('all'), z.array(z.string()).min(1)])
  .describe('"all" (tracks instances added later) or an explicit list of instance ids');

const ruleBody = {
  name: z.string().min(1).describe('rule name'),
  instances: ruleInstances.optional().describe('default "all"'),
  payload: passthroughObject(
    'MasterRulePayload (autorec fields; channel/tag/profile referenced by name) — required unless parentId is set',
  ).optional(),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe('set to create/keep a LINKED CLONE of this parent rule; then only `overlay` is stored'),
  overlay: passthroughObject('linked clone only: partial MasterRulePayload overriding the parent').optional(),
};

export const ruleTools: ToolDef[] = [
  tool({
    name: 'list_rules',
    description:
      'Master autorec rules with per-instance sync state (synced/pending/blocked/drift…), linked-clone relations, effective payload and upcoming match counts (upcomingMatches 0 on an enabled rule = zero-match warning).',
    input: { ...pageShape },
    annotations: READ,
    run: async (a, api) =>
      page(await api<RuleWithStatus[]>({ method: 'GET', url: '/api/rules' }), a.offset, a.limit),
  }),
  tool({
    name: 'list_deleted_rules',
    description: 'Soft-deleted master rules (restorable with restore_rule, or removable with purge_rule).',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/rules/deleted' }),
  }),
  tool({
    name: 'create_rule',
    description:
      'Create a master autorec rule in the controller DB (not pushed yet — call push_rule afterwards). Pass `payload` for a plain rule or `parentId` + `overlay` for a linked clone.',
    input: ruleBody,
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: '/api/rules', body: a }),
  }),
  tool({
    name: 'update_rule',
    description:
      'Replace a master rule (same body as create_rule) and push it. Shrinking `instances` DELETES the autorec on removed instances, which cancels their scheduled entries.',
    input: { id: ruleId, ...ruleBody },
    annotations: DESTRUCTIVE,
    run: ({ id, ...body }, api) => api({ method: 'PUT', url: `/api/rules/${p(id)}`, body }),
  }),
  tool({
    name: 'clone_rule',
    description: 'Clone a rule. linked=true makes a linked clone that inherits the parent and stores only an overlay.',
    input: { id: ruleId, name: z.string().min(1), linked: z.boolean().optional() },
    annotations: WRITE,
    run: ({ id, ...body }, api) => api({ method: 'POST', url: `/api/rules/${p(id)}/clone`, body }),
  }),
  tool({
    name: 'delete_rule',
    description:
      'Soft-delete a rule: removes its autorec from every bound instance (tvheadend cancels scheduled entries) and parks the master in Deleted. Blocked while linked clones exist.',
    input: { id: ruleId },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'DELETE', url: `/api/rules/${p(a.id)}` }),
  }),
  tool({
    name: 'restore_rule',
    description: 'Restore a soft-deleted rule and push it back to its instances.',
    input: { id: ruleId },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: `/api/rules/${p(a.id)}/restore` }),
  }),
  tool({
    name: 'purge_rule',
    description: 'Permanently remove a soft-deleted rule from the controller DB. Irreversible.',
    input: { id: ruleId },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'DELETE', url: `/api/rules/${p(a.id)}/purge` }),
  }),
  tool({
    name: 'push_rule',
    description: 'Push one master rule to every in-scope instance (in-place idnode/save; scheduled entries survive).',
    input: { id: ruleId },
    annotations: WRITE_IDEMPOTENT,
    run: (a, api) => api({ method: 'POST', url: `/api/rules/${p(a.id)}/push` }),
  }),
  tool({
    name: 'batch_rules',
    description:
      'Apply one action to several rules. edit: `patch` (partial payload) and/or `instances` scope delta ({instanceId: true=add, false=remove — removal deletes the autorec there}). delete/purge are destructive as in delete_rule/purge_rule.',
    input: {
      action: z.enum(['edit', 'delete', 'push', 'restore', 'purge']),
      ids: z.array(z.string()).min(1),
      patch: passthroughObject('edit only: partial MasterRulePayload').optional(),
      instances: z.record(z.string(), z.boolean()).optional().describe('edit only: per-instance scope delta'),
    },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'POST', url: '/api/rules/batch', body: a }),
  }),
  tool({
    name: 'push_all_rules',
    description: 'Push EVERY master rule to every in-scope instance.',
    input: {},
    annotations: DESTRUCTIVE,
    run: (_a, api) => api({ method: 'POST', url: '/api/sync/push' }),
  }),
  tool({
    name: 'get_drift',
    description:
      'Drift between master rules and instance state: field-level diffs for bound rules changed on an instance, plus unmanaged (orphan) autorecs. Resolve each with reconcile_drift.',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/sync/drift' }),
  }),
  tool({
    name: 'reconcile_drift',
    description:
      'Resolve one drift item. overwrite-from-master / import-into-master / split-into-clone for changed rules; adopt-orphan / ignore-orphan / delete-from-instance for unmanaged autorecs; recreate-on-instance / delete-master for rules missing on an instance. delete-* actions are destructive.',
    input: {
      driftId: z.string().min(1).describe('id from get_drift'),
      action: z.enum([
        'overwrite-from-master',
        'import-into-master',
        'split-into-clone',
        'adopt-orphan',
        'ignore-orphan',
        'delete-from-instance',
        'recreate-on-instance',
        'delete-master',
      ]),
    },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'POST', url: '/api/sync/reconcile', body: a }),
  }),
  tool({
    name: 'run_integrity_check',
    description:
      'Baseline-free field-by-field comparison of every rule against FRESH instance state (issues tvheadend requests). Catches desync drift baselines tolerate, stale bindings, missing parents, unmanaged rules. Read-only.',
    input: {},
    annotations: READ_REMOTE,
    run: (_a, api) => api({ method: 'POST', url: '/api/sync/integrity' }),
  }),
  tool({
    name: 'list_ignored_orphans',
    description: 'Unmanaged instance autorecs that were marked ignored.',
    input: {},
    annotations: READ,
    run: (_a, api) => api({ method: 'GET', url: '/api/sync/ignored' }),
  }),
  tool({
    name: 'unignore_orphan',
    description: 'Un-ignore an unmanaged autorec so it shows up in drift again.',
    input: { instanceId, tvhUuid: z.string().min(1) },
    annotations: WRITE_IDEMPOTENT,
    run: (a, api) => api({ method: 'POST', url: '/api/sync/unignore', body: a }),
  }),
  tool({
    name: 'import_rules_from_instance',
    description:
      'Bootstrap import: adopt the autorec rule set of one instance as master rules and auto-bind matching rules on the other instances.',
    input: { instanceId },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: '/api/sync/import', query: { instance: a.instanceId } }),
  }),
];
