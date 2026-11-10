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

import type { UploadJob } from '@tvhc/shared';
import { z } from 'zod';
import { p } from '../inject.js';
import { DESTRUCTIVE, READ, WRITE, instanceId, page, pageShape, tool, type ToolDef } from './common.js';

const uploadId = z.string().min(1).describe('upload job id (see list_uploads)');

export const uploadTools: ToolDef[] = [
  tool({
    name: 'list_uploads',
    description: 'Google Drive archive (rclone) upload jobs, optionally filtered by status.',
    input: {
      status: z
        .enum(['queued', 'dispatched', 'uploading', 'verifying', 'done', 'failed', 'cancelled', 'superseded'])
        .optional(),
      ...pageShape,
    },
    annotations: READ,
    run: async (a, api) =>
      page(
        await api<UploadJob[]>({ method: 'GET', url: '/api/uploads', query: { status: a.status } }),
        a.offset,
        a.limit,
      ),
  }),
  tool({
    name: 'enqueue_uploads',
    description:
      'Queue finished recordings of one instance for upload to the archive remote (rclone copy, overwrites the remote file). Requires an rclone rcd on that instance.',
    input: { instanceId, dvrUuids: z.array(z.string()).min(1) },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: '/api/uploads', body: a }),
  }),
  tool({
    name: 'retry_upload',
    description: 'Retry a failed/cancelled upload job.',
    input: { id: uploadId },
    annotations: WRITE,
    run: (a, api) => api({ method: 'POST', url: `/api/uploads/${p(a.id)}/retry` }),
  }),
  tool({
    name: 'cancel_upload',
    description: 'Cancel an in-progress upload job (stops the rclone job).',
    input: { id: uploadId },
    annotations: DESTRUCTIVE,
    run: (a, api) => api({ method: 'POST', url: `/api/uploads/${p(a.id)}/cancel` }),
  }),
];
