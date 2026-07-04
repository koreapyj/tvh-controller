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
import {
  compareRecordings,
  type RecordingIdentity,
  type TvhDvrEntry,
  type UploadJob,
  type UploadOrigin,
  type UploadStatus,
} from '@tvhc/shared';
import type { Db } from '../db/db.js';

export interface ClaimResult {
  claimed: boolean;
  upload?: UploadJob;
  /** when not claimed: the existing upload that covers this content */
  existing?: UploadJob;
}

export interface ClaimOptions {
  origin?: UploadOrigin;
  incompletePick?: boolean;
  /**
   * channel number at claim time (e.g. "9.1"), resolved by the caller from
   * the instance's channel list via entry.channel (uuid) — never from the
   * channel name
   */
  channelNumber?: string | null;
  /** remote object replaced by this upload; deleted after this one verifies */
  supersedesPath?: string | null;
  /**
   * manual overwrite: skip duplicate detection and always insert a fresh row.
   * The caller (dispatcher.enqueue) is responsible for cancelling/superseding
   * the rows this one replaces.
   */
  overwrite?: boolean;
}

/** statuses that block a new claim for the same broadcast (superseded and failed do not) */
const ACTIVE_OR_DONE: UploadStatus[] = ['queued', 'dispatched', 'uploading', 'verifying', 'done'];

function rowToJob(r: {
  id: string;
  instance_id: string;
  dvr_uuid: string;
  title: string | null;
  channelname: string;
  channelnumber: string | null;
  start: number | string;
  stop: number | string;
  filesize: number | string | null;
  local_path: string;
  remote_path: string;
  status: string;
  progress: number | string;
  rclone_job_id: number | null;
  attempts: number;
  error: string | null;
  possible_duplicate: number;
  origin: string;
  incomplete_pick: number;
  supersedes_path: string | null;
  failure_kind: string | null;
  auto_retries: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}): UploadJob {
  return {
    id: r.id,
    instanceId: r.instance_id,
    dvrUuid: r.dvr_uuid,
    title: r.title,
    channelname: r.channelname,
    channelnumber: r.channelnumber,
    start: Number(r.start),
    stop: Number(r.stop),
    filesize: r.filesize === null ? null : Number(r.filesize),
    localPath: r.local_path,
    remotePath: r.remote_path,
    status: r.status as UploadStatus,
    progress: Number(r.progress),
    rcloneJobId: r.rclone_job_id,
    attempts: r.attempts,
    error: r.error,
    possibleDuplicate: !!r.possible_duplicate,
    origin: (r.origin === 'auto' ? 'auto' : 'manual') as UploadOrigin,
    incompletePick: !!r.incomplete_pick,
    supersedesPath: r.supersedes_path,
    failureKind:
      r.failure_kind === 'transient' || r.failure_kind === 'permanent' ? r.failure_kind : null,
    autoRetries: r.auto_retries,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
  };
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Upload ledger with cross-instance duplicate detection. Claims are
 * serialized through an in-process mutex (controller runs replicas:1) so the
 * overlap check + insert is race-free; duplicate detection is a channelname
 * + interval-overlap query (EIT EPG: titles/uuids are NOT comparable across
 * instances).
 */
export class UploadLedger {
  private claimChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly overlapThreshold: number,
  ) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.claimChain.then(fn, fn);
    this.claimChain = next.catch(() => {});
    return next;
  }

  claim(
    instanceId: string,
    entry: TvhDvrEntry,
    localPath: string,
    remotePath: string,
    opts: ClaimOptions = {},
  ): Promise<ClaimResult> {
    return this.serialize(async () => {
      const channelname = entry.channelname ?? '';
      const start = entry.start;
      const stop = entry.stop;

      // manual overwrite bypasses dedup entirely — the caller has already
      // cancelled/superseded whatever this row replaces
      if (!opts.overwrite) {
        const candidates = await this.db
          .selectFrom('uploads')
          .selectAll()
          .where('channelname', '=', channelname)
          .where('status', 'in', ACTIVE_OR_DONE)
          .where('start', '<', stop)
          .where('stop', '>', start)
          .execute();

        for (const c of candidates) {
          const verdict = compareRecordings(
            { channelname, start, stop, title: entry.disp_title },
            {
              channelname: c.channelname,
              start: Number(c.start),
              stop: Number(c.stop),
              title: c.title ?? undefined,
            },
            this.overlapThreshold,
          );
          if (verdict.isDuplicate) {
            return { claimed: false, existing: rowToJob(c) };
          }
        }
      }

      // advisory only: same title on the same channel within ±36h
      const possibleDuplicate = entry.disp_title
        ? (
            await this.db
              .selectFrom('uploads')
              .select('id')
              .where('channelname', '=', channelname)
              .where('title', '=', entry.disp_title)
              .where('status', 'in', ACTIVE_OR_DONE)
              .where('start', '>', start - 36 * 3600)
              .where('start', '<', start + 36 * 3600)
              .execute()
          ).length > 0
        : false;

      const id = randomUUID();
      await this.db
        .insertInto('uploads')
        .values({
          id,
          instance_id: instanceId,
          dvr_uuid: entry.uuid,
          title: entry.disp_title ?? null,
          channelname,
          channelnumber: opts.channelNumber ?? null,
          start,
          stop,
          filesize: entry.filesize ?? null,
          local_path: localPath,
          remote_path: remotePath,
          status: 'queued',
          rclone_job_id: null,
          error: null,
          possible_duplicate: possibleDuplicate ? 1 : 0,
          origin: opts.origin ?? 'manual',
          incomplete_pick: opts.incompletePick ? 1 : 0,
          supersedes_path: opts.supersedesPath ?? null,
          created_at: now(),
          updated_at: now(),
          completed_at: null,
        })
        .execute();
      const upload = await this.get(id);
      return { claimed: true, upload: upload ?? undefined };
    });
  }

  async get(id: string): Promise<UploadJob | null> {
    const row = await this.db
      .selectFrom('uploads')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToJob(row) : null;
  }

  async list(status?: UploadStatus): Promise<UploadJob[]> {
    let q = this.db.selectFrom('uploads').selectAll().orderBy('created_at', 'desc').limit(500);
    if (status) q = q.where('status', '=', status);
    return (await q.execute()).map(rowToJob);
  }

  async listByStatuses(statuses: UploadStatus[]): Promise<UploadJob[]> {
    if (statuses.length === 0) return [];
    const rows = await this.db
      .selectFrom('uploads')
      .selectAll()
      .where('status', 'in', statuses)
      .execute();
    return rows.map(rowToJob);
  }

  async update(
    id: string,
    patch: Partial<{
      status: UploadStatus;
      progress: number;
      rclone_job_id: number | null;
      error: string | null;
      attempts: number;
      completed_at: string | null;
      failure_kind: string | null;
      auto_retries: number;
    }>,
  ): Promise<void> {
    await this.db
      .updateTable('uploads')
      .set({ ...patch, updated_at: now() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Every upload row covering the broadcast (any status). The auto-uploader
   * uses this to advance to the next-best copy after a permanent failure:
   * each row records its (instanceId, dvrUuid), so already-tried copies are
   * excluded from the next pick.
   */
  async findAllByIdentity(identity: RecordingIdentity): Promise<UploadJob[]> {
    const candidates = await this.db
      .selectFrom('uploads')
      .selectAll()
      .where('channelname', '=', identity.channelname)
      .where('start', '<', identity.stop)
      .where('stop', '>', identity.start)
      .execute();
    return candidates
      .filter(
        (c) =>
          compareRecordings(
            identity,
            {
              channelname: c.channelname,
              start: Number(c.start),
              stop: Number(c.stop),
              title: c.title ?? undefined,
            },
            this.overlapThreshold,
          ).isDuplicate,
      )
      .map(rowToJob);
  }

  /**
   * Failed uploads eligible for an automatic retry: a transient failure that
   * has not yet exhausted its retry budget. The dispatcher applies the
   * per-row backoff window on `updatedAt`.
   */
  async listRetriable(maxRetries: number): Promise<UploadJob[]> {
    const rows = await this.db
      .selectFrom('uploads')
      .selectAll()
      .where('status', '=', 'failed')
      .where('failure_kind', '=', 'transient')
      .where('auto_retries', '<', maxRetries)
      .execute();
    return rows.map(rowToJob);
  }

  /** mark a row as replaced by a later upload of a better copy */
  async supersede(id: string): Promise<void> {
    await this.update(id, { status: 'superseded' });
  }

  /** done auto-uploads whose copy was picked while an instance was unreachable */
  async listIncompletePicks(): Promise<UploadJob[]> {
    const rows = await this.db
      .selectFrom('uploads')
      .selectAll()
      .where('incomplete_pick', '=', 1)
      .where('origin', '=', 'auto')
      .where('status', '=', 'done')
      .execute();
    return rows.map(rowToJob);
  }

  async clearIncompletePick(id: string): Promise<void> {
    await this.db
      .updateTable('uploads')
      .set({ incomplete_pick: 0, updated_at: now() })
      .where('id', '=', id)
      .execute();
  }

  /** uploads matching any state, for decorating recording lists */
  async allRecent(): Promise<UploadJob[]> {
    const rows = await this.db
      .selectFrom('uploads')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(2000)
      .execute();
    return rows.map(rowToJob);
  }
}
