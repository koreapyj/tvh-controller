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

import type { TvhDvrEntry, UploadJob } from '@tvhc/shared';
import type { AppConfig } from '../config.js';
import type { EventBus } from '../state/events.js';
import { RcloneRcClient } from './rcloneRc.js';
import { buildRemotePath } from './remotePath.js';
import type { ClaimOptions, UploadLedger } from './ledger.js';

const POLL_MS = 3000;
const MAX_ATTEMPTS = 3;
const VERIFY_RETRY_MIN_MS = 5_000;
const VERIFY_RETRY_MAX_MS = 300_000;

export class UploadDispatcher {
  private readonly clients = new Map<string, RcloneRcClient>();
  private readonly watching = new Set<string>();
  /**
   * per-instance serialization: rcd's --transfers flag only limits WITHIN a
   * job, and every operations/copyfile is its own job — so without this
   * queue, N queued uploads would transfer N files concurrently per host
   */
  private readonly instanceQueues = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly ledger: UploadLedger,
    private readonly bus: EventBus,
  ) {
    for (const inst of cfg.instances) {
      if (inst.rclone) this.clients.set(inst.id, new RcloneRcClient(inst.rclone));
    }
  }

  hasClient(instanceId: string): boolean {
    return this.clients.has(instanceId);
  }

  /** resume tracking of in-flight uploads after a controller restart */
  async resume(): Promise<void> {
    const inflight = await this.ledger.listByStatuses([
      'queued',
      'dispatched',
      'uploading',
      'verifying',
    ]);
    for (const job of inflight) {
      void this.drive(job.id, job.instanceId);
    }
  }

  /**
   * Flags all drive loops to exit, then waits briefly so in-flight
   * iterations can checkpoint their ledger state; anything still running
   * after the grace period is recovered by resume() on the next start.
   */
  async stop(graceMs = 5_000): Promise<void> {
    this.stopped = true;
    await Promise.race([
      Promise.allSettled([...this.instanceQueues.values()]),
      sleep(graceMs),
    ]);
  }

  /** queue an upload for a finished DVR entry; returns the job or the existing duplicate */
  async enqueue(
    instanceId: string,
    entry: TvhDvrEntry,
    storageRoots: string[] = [],
    claimOpts: ClaimOptions = {},
  ): Promise<{ job?: UploadJob; duplicateOf?: UploadJob }> {
    const client = this.clients.get(instanceId);
    if (!client) throw new Error(`instance "${instanceId}" has no rclone rcd configured`);
    if (!entry.filename) throw new Error(`recording ${entry.uuid} has no file`);

    const localPath = client.mapLocalPath(entry.filename);
    const remotePath = buildRemotePath(this.cfg.rclone.remote, entry, storageRoots);
    const result = await this.ledger.claim(instanceId, entry, localPath, remotePath, claimOpts);
    if (!result.claimed) return { duplicateOf: result.existing };

    void this.drive(result.upload!.id, instanceId);
    return { job: result.upload };
  }

  async retry(uploadId: string): Promise<void> {
    const job = await this.ledger.get(uploadId);
    if (!job) throw new Error(`upload ${uploadId} not found`);
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new Error(`upload ${uploadId} is ${job.status}, not retryable`);
    }
    // a previous transfer may still be running on the rcd — stop it before
    // clearing the job id, or the retry would race it on the remote path
    const client = this.clients.get(job.instanceId);
    if (client && job.rcloneJobId !== null) {
      await client.stopJob(job.rcloneJobId).catch(() => {});
    }
    // start at verify: when the old transfer actually completed (e.g. the
    // failure was a verify-step bug or restart), this resolves to done
    // without re-uploading anything
    await this.ledger.update(uploadId, {
      status: 'verifying',
      error: null,
      attempts: 0,
      rclone_job_id: null,
    });
    void this.drive(uploadId, job.instanceId);
  }

  async cancel(uploadId: string): Promise<void> {
    const job = await this.ledger.get(uploadId);
    if (!job) throw new Error(`upload ${uploadId} not found`);
    const client = this.clients.get(job.instanceId);
    if (client && job.status === 'uploading' && job.rcloneJobId !== null) {
      await client.stopJob(job.rcloneJobId).catch(() => {});
    }
    await this.ledger.update(uploadId, { status: 'cancelled' });
    await this.publish(uploadId);
  }

  private async publish(uploadId: string): Promise<void> {
    const job = await this.ledger.get(uploadId);
    if (job) this.bus.publish({ type: 'upload-progress', data: job });
  }

  /** queue an upload's state machine behind others on the same instance */
  private drive(uploadId: string, instanceId?: string): Promise<void> {
    const key = instanceId ?? '';
    const prev = this.instanceQueues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.driveSerialized(uploadId));
    this.instanceQueues.set(key, next.catch(() => {}));
    return next;
  }

  /** state machine driving one upload to completion */
  private async driveSerialized(uploadId: string): Promise<void> {
    if (this.watching.has(uploadId)) return;
    this.watching.add(uploadId);
    try {
      await this.driveInner(uploadId);
    } catch (err) {
      // the failure handler itself may throw (e.g. database briefly down) —
      // it must never escape: drive() is fired void and an unhandled
      // rejection would kill the process
      try {
        await this.ledger.update(uploadId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        await this.publish(uploadId);
      } catch (inner) {
        console.error(`upload ${uploadId}: failed to record error state:`, inner);
      }
    } finally {
      this.watching.delete(uploadId);
    }
  }

  private async driveInner(uploadId: string): Promise<void> {
    let verifyRetryDelay = VERIFY_RETRY_MIN_MS;
    let job = await this.ledger.get(uploadId);
    if (!job) return;
    const client = this.clients.get(job.instanceId);
    if (!client) {
      await this.ledger.update(uploadId, { status: 'failed', error: 'no rclone rcd configured' });
      await this.publish(uploadId);
      return;
    }

    while (!this.stopped) {
      job = await this.ledger.get(uploadId);
      if (!job || job.status === 'cancelled') return;

      if (job.status === 'queued' || job.status === 'dispatched') {
        if (job.attempts >= MAX_ATTEMPTS) {
          await this.ledger.update(uploadId, { status: 'failed', error: 'max attempts exceeded' });
          await this.publish(uploadId);
          return;
        }
        // never leave an abandoned transfer running — duplicate copies of
        // the same file would race on the remote path and split bandwidth
        if (job.rcloneJobId !== null) {
          await client.stopJob(job.rcloneJobId).catch(() => {});
        }
        // wrong-host / stale-path guard: the file the rcd sees must match
        // the recording's size. tvheadend's filesize field drifts a little
        // from the final file, so allow a tolerance — but a large mismatch
        // means the rcd would upload a DIFFERENT file (e.g. another zone's
        // copy at the same path on a misconfigured host).
        if (job.filesize !== null) {
          const localSize = await client.localSize(job.localPath).catch(() => null);
          const tolerance = Math.max(2_000_000, job.filesize * 0.01);
          if (localSize === null || Math.abs(localSize - job.filesize) > tolerance) {
            await this.ledger.update(uploadId, {
              status: 'failed',
              error:
                localSize === null
                  ? `local file not found on the rcd host: ${job.localPath}`
                  : `file on rcd host is ${localSize} bytes but the recording is ${job.filesize} — wrong host or stale path?`,
            });
            await this.publish(uploadId);
            return;
          }
        }
        const jobid = await client.startCopy(job.localPath, job.remotePath);
        await this.ledger.update(uploadId, {
          status: 'uploading',
          rclone_job_id: jobid,
          attempts: job.attempts + 1,
          error: null,
        });
        await this.publish(uploadId);
        continue;
      }

      if (job.status === 'uploading') {
        const raw = job.rcloneJobId;
        if (raw === null) {
          await this.ledger.update(uploadId, { status: 'verifying' });
          continue;
        }
        let finished = false;
        let success = false;
        let errMsg = '';
        try {
          const status = await client.jobStatus(raw);
          finished = status.finished;
          success = status.success;
          errMsg = status.error ?? '';
          if (!finished) {
            const stats = await client.jobStats(raw).catch(() => null);
            if (stats?.bytes !== undefined) {
              // a transfer that is actively progressing has no current error;
              // clear leftover text from earlier attempts
              await this.ledger.update(uploadId, { progress: stats.bytes, error: null });
              await this.publish(uploadId);
            }
          }
        } catch {
          // rcd restarted and lost the job — fall through to checksum verify
          await this.ledger.update(uploadId, { status: 'verifying', rclone_job_id: null });
          continue;
        }
        if (!finished) {
          await sleep(POLL_MS);
          continue;
        }
        if (success) {
          await this.ledger.update(uploadId, { status: 'verifying' });
        } else {
          await this.ledger.update(uploadId, { status: 'queued', error: errMsg || 'rclone job failed' });
          await this.publish(uploadId);
          await sleep(POLL_MS * (job.attempts + 1));
        }
        continue;
      }

      if (job.status === 'verifying') {
        // size comparison local vs Drive. rclone already checksum-verifies
        // each transfer in flight, so a size match on a finished copy means
        // a verified upload; this also recovers jobs lost to rcd/controller
        // restarts without needing hashsum support on the rcd.
        let localSize: number | null;
        let remoteSize: number | null;
        try {
          [localSize, remoteSize] = await Promise.all([
            client.localSize(job.localPath),
            client.remoteSize(job.remotePath),
          ]);
        } catch {
          // transient rc error must not fail the upload — retry the verify
          // with backoff so an unreachable rcd doesn't hot-loop
          await sleep(verifyRetryDelay);
          verifyRetryDelay = Math.min(verifyRetryDelay * 2, VERIFY_RETRY_MAX_MS);
          continue;
        }
        verifyRetryDelay = VERIFY_RETRY_MIN_MS;
        if (localSize !== null && remoteSize !== null && localSize === remoteSize) {
          await this.ledger.update(uploadId, {
            status: 'done',
            progress: localSize,
            completed_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
          });
          // this upload replaced a previous copy of the same broadcast —
          // remove the old remote object only now that the new one verified
          const supersedes = job.supersedesPath;
          if (supersedes && supersedes !== job.remotePath) {
            await client.deleteFile(supersedes).catch((err) => {
              console.error(`upload ${uploadId}: superseded object not removed (${supersedes}):`, err);
            });
          }
          await this.publish(uploadId);
          return;
        }
        if (localSize === null) {
          await this.ledger.update(uploadId, {
            status: 'failed',
            error: `local file missing: ${job.localPath}`,
          });
          await this.publish(uploadId);
          return;
        }
        if (job.attempts >= MAX_ATTEMPTS) {
          await this.ledger.update(uploadId, {
            status: 'failed',
            error: `size mismatch after upload (local ${localSize}, remote ${remoteSize ?? 'missing'})`,
          });
          await this.publish(uploadId);
          return;
        }
        await this.ledger.update(uploadId, { status: 'queued' });
        continue;
      }

      return; // done/failed reached by another path
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
