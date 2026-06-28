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

import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { MasterRulePayload, type ReconcileAction, type RuleInstances } from '@tvhc/shared';
import type { RuleInput } from '../sync/engine.js';
import { httpError, requireDb, type AppContext } from './context.js';

const PartialPayload = Type.Partial(MasterRulePayload);

function parsePayload(body: unknown): MasterRulePayload {
  const withDefaults = Value.Default(MasterRulePayload, Value.Clone(body)) as unknown;
  if (!Value.Check(MasterRulePayload, withDefaults)) {
    const first = [...Value.Errors(MasterRulePayload, withDefaults)][0];
    throw httpError(400, `invalid rule payload: ${first?.path ?? ''} ${first?.message ?? ''}`);
  }
  return withDefaults;
}

interface RuleBody {
  name?: string;
  instances?: RuleInstances;
  payload?: unknown;
  parentId?: string | null;
  overlay?: unknown;
}

function parseRuleInput(ctx: AppContext, body: RuleBody | undefined): RuleInput {
  if (!body) throw httpError(400, 'request body is required');
  const instances = body.instances ?? 'all';
  if (instances !== 'all') {
    if (!Array.isArray(instances) || instances.length === 0) {
      throw httpError(400, 'instances must be "all" or a non-empty array of instance ids');
    }
    for (const i of instances) {
      if (!ctx.cache.has(i)) throw httpError(400, `unknown instance "${i}"`);
    }
  }
  if (body.parentId) {
    const overlay = (body.overlay ?? {}) as unknown;
    if (!Value.Check(PartialPayload, overlay)) {
      const first = [...Value.Errors(PartialPayload, overlay)][0];
      throw httpError(400, `invalid overlay: ${first?.path ?? ''} ${first?.message ?? ''}`);
    }
    const name = body.name;
    if (!name) throw httpError(400, 'name is required');
    delete (overlay as Record<string, unknown>).name;
    return { name, instances, parentId: body.parentId, overlay };
  }
  const payload = parsePayload(body.payload ?? body);
  const name = body.name ?? payload.name;
  if (!name) throw httpError(400, 'name is required');
  return { name, instances, payload: { ...payload, name } };
}

export function registerRuleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const sync = (): NonNullable<AppContext['sync']> => requireDb(ctx.sync, 'rule sync');

  app.get('/api/rules', async () => sync().rulesWithStatus());

  app.post('/api/rules', async (req, reply) => {
    const rule = await sync().createRule(parseRuleInput(ctx, req.body as RuleBody));
    reply.code(201);
    return rule;
  });

  app.put<{ Params: { id: string } }>('/api/rules/:id', async (req) => {
    const existing = await sync().getRule(req.params.id);
    if (!existing) throw httpError(404, 'rule not found');
    await sync().updateRule(req.params.id, parseRuleInput(ctx, req.body as RuleBody));
    return sync().getRule(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { linked?: boolean; name?: string } }>(
    '/api/rules/:id/clone',
    async (req, reply) => {
      const { linked, name } = req.body ?? {};
      if (!name) throw httpError(400, 'name is required');
      const rule = await sync().createClone(req.params.id, !!linked, name);
      reply.code(201);
      return rule;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/rules/:id', async (req) => {
    await sync().deleteRule(req.params.id);
    return { ok: true };
  });

  app.get('/api/rules/deleted', async () => sync().listDeletedRules());

  app.post<{ Params: { id: string } }>('/api/rules/:id/restore', async (req) => {
    return sync().restoreRule(req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/rules/:id/purge', async (req) => {
    await sync().purgeRule(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/rules/:id/push', async (req) => {
    return sync().pushRule(req.params.id);
  });

  app.post<{
    Body: {
      action?: 'enable' | 'disable' | 'edit' | 'push';
      ids?: string[];
      patch?: unknown;
    };
  }>('/api/rules/batch', async (req) => {
    const { action, ids, patch } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) throw httpError(400, 'ids[] is required');
    switch (action) {
      case 'enable':
        return sync().batchSetEnabled(ids, true);
      case 'disable':
        return sync().batchSetEnabled(ids, false);
      case 'push':
        return sync().batchPush(ids);
      case 'edit': {
        const p = (patch ?? {}) as unknown;
        if (!Value.Check(PartialPayload, p)) {
          const first = [...Value.Errors(PartialPayload, p)][0];
          throw httpError(400, `invalid patch: ${first?.path ?? ''} ${first?.message ?? ''}`);
        }
        if (Object.keys(p as Record<string, unknown>).length === 0) {
          throw httpError(400, 'patch must contain at least one field');
        }
        return sync().batchEdit(ids, p as Partial<MasterRulePayload>);
      }
      default:
        throw httpError(400, `unknown action "${String(action)}"`);
    }
  });

  app.post('/api/sync/push', async () => sync().pushAll());

  app.get('/api/sync/drift', async () => sync().computeDrift());

  app.post<{ Body: { driftId: string; action: ReconcileAction } }>(
    '/api/sync/reconcile',
    async (req) => {
      const { driftId, action } = req.body ?? ({} as { driftId?: string; action?: ReconcileAction });
      if (!driftId || !action) {
        const err = new Error('driftId and action are required') as Error & { statusCode: number };
        err.statusCode = 400;
        throw err;
      }
      await sync().reconcile(driftId, action);
      return { ok: true };
    },
  );

  /** manual, baseline-free verification against fresh instance state */
  app.post('/api/sync/integrity', async () => sync().integrityCheck());

  app.get('/api/sync/ignored', async () => sync().listIgnoredOrphans());

  app.post<{ Body: { instanceId: string; tvhUuid: string } }>('/api/sync/unignore', async (req) => {
    const { instanceId, tvhUuid } = req.body ?? ({} as { instanceId?: string; tvhUuid?: string });
    if (!instanceId || !tvhUuid) {
      const err = new Error('instanceId and tvhUuid are required') as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
    await sync().unignoreOrphan(instanceId, tvhUuid);
    return { ok: true };
  });

  app.post<{ Querystring: { instance?: string } }>('/api/sync/import', async (req) => {
    const instance = req.query.instance;
    if (!instance || !ctx.cache.has(instance)) {
      const err = new Error('valid ?instance= is required') as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    return sync().importFromInstance(instance);
  });
}
