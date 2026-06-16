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
import type { UploadStatus } from '@tvhc/shared';
import { requireDb, type AppContext } from './context.js';

export function registerUploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ledger = (): NonNullable<AppContext['ledger']> => requireDb(ctx.ledger, 'uploads');
  const dispatcher = (): NonNullable<AppContext['dispatcher']> =>
    requireDb(ctx.dispatcher, 'uploads');

  app.get<{ Querystring: { status?: UploadStatus } }>('/api/uploads', async (req) =>
    ledger().list(req.query.status),
  );

  app.post<{ Body: { instanceId: string; dvrUuids: string[] } }>('/api/uploads', async (req) => {
    const { instanceId, dvrUuids } = req.body ?? ({} as { instanceId?: string; dvrUuids?: string[] });
    if (!instanceId || !ctx.cache.has(instanceId) || !Array.isArray(dvrUuids) || !dvrUuids.length) {
      const err = new Error('instanceId and dvrUuids[] are required') as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
    if (!dispatcher().hasClient(instanceId)) {
      const err = new Error(`instance "${instanceId}" has no rclone rcd configured`) as Error & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    }
    const snap = ctx.cache.get(instanceId);
    const storageRoots = (snap.topology?.dvrConfigs ?? [])
      .map((c) => c.storage)
      .filter((s): s is string => !!s);
    const results = [];
    for (const uuid of dvrUuids) {
      const entry = snap.finished.find((e) => e.uuid === uuid);
      if (!entry) {
        results.push({ dvrUuid: uuid, error: 'not a finished recording on this instance' });
        continue;
      }
      try {
        // a manual upload always overwrites any previous copy of this programme
        const r = await dispatcher().enqueue(instanceId, entry, storageRoots, {
          origin: 'manual',
          overwrite: true,
        });
        results.push({
          dvrUuid: uuid,
          jobId: r.job?.id,
          duplicateOf: r.duplicateOf
            ? { uploadId: r.duplicateOf.id, instanceId: r.duplicateOf.instanceId }
            : undefined,
        });
      } catch (err) {
        results.push({ dvrUuid: uuid, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return results;
  });

  app.post<{ Params: { id: string } }>('/api/uploads/:id/retry', async (req) => {
    await dispatcher().retry(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/uploads/:id/cancel', async (req) => {
    await dispatcher().cancel(req.params.id);
    return { ok: true };
  });
}
