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

import type { TvhDvrEntry, UploadJob, UploadStatus } from '@tvhc/shared';
import type { AppConfig } from '../config.js';
import type { EventBus } from '../state/events.js';
import { RcloneRcClient, RcloneRcError } from './rcloneRc.js';
import { buildRemotePath } from './remotePath.js';
import type { ClaimOptions, UploadLedger } from './ledger.js';

const POLL_MS = 3000;
const MAX_ATTEMPTS = 3;
const VERIFY_RETRY_MIN_MS = 5_000;
const VERIFY_RETRY_MAX_MS = 300_000;
const MAX_AUTO_RETRIES = 5;
const RETRY_SWEEP_MS = 60_000;
const AUTO_RETRY_BACKOFF_BASE_MS = 60_000;
const AUTO_RETRY_BACKOFF_MAX_MS = 30 * 60_000;

const INFLIGHT_STATUSES: UploadStatus[] = ['queued', 'dispatched', 'uploading', 'verifying'];

/**
 * A failure is transient (worth auto-retrying) when the rcd was unreachable or
 * returned a server error: any non-HTTP throw is a network/connection failure,
 * and an `RcloneRcError` is transient only for status 0 / 5xx. A 4xx (bad path,
 * bad request) is a terminal, permanent failure.
 */
export function isTransientRcError(err: unknown): boolean {
  if (err instanceof RcloneRcError) return err.status === 0 || err.status >= 500;
  return true;
}

/**
 * Human-readable cause of an rc failure, reported AS-IS so a network/firewall
 * problem never masquerades as something else (e.g. "file not found"). Network
 * throws surface their syscall code (ECONNREFUSED, ETIMEDOUT, …).
 */
export function rcErrorText(err: unknown): string {
  if (err instanceof RcloneRcError) return err.message;
  const code =
    (err as { cause?: { code?: string }; code?: string })?.cause?.code ??
    (err as { code?: string })?.code;
  const msg = err instanceof Error ? err.message : String(err);
  return code ? `${msg} (${code})` : msg;
}

/** deterministic per-upload temp object, so it survives a controller restart */
export function tempRemotePath(job: Pick<UploadJob, 'id' | 'remotePath'>): string {
  return `${job.remotePath}.tvhc-part-${job.id.slice(0, 8)}`;
}

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
  private retrySweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly ledger: UploadLedger,
    private readonly bus: EventBus,
  ) {
    for (const inst of cfg.instances) {
      if (inst.rclone) this.clients.set(inst.id, new RcloneRcClient(inst.rclone));
    }
    // periodically re-drive transiently-failed uploads (rcd outages, remote
    // blips) with an exponential per-row backoff; permanent failures are left
    // terminal (manual retry only)
    this.retrySweepTimer = setInterval(() => void this.sweepRetries(), RETRY_SWEEP_MS);
    this.retrySweepTimer.unref?.();
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
    if (this.retrySweepTimer) clearInterval(this.retrySweepTimer);
    await Promise.race([
      Promise.allSettled([...this.instanceQueues.values()]),
      sleep(graceMs),
    ]);
  }

  /**
   * Re-drive transiently-failed uploads whose per-row backoff has elapsed.
   * Backoff grows with the number of automatic retries already spent and is
   * keyed on `updatedAt`; after MAX_AUTO_RETRIES a row stays failed.
   */
  private async sweepRetries(): Promise<void> {
    if (this.stopped) return;
    let rows: UploadJob[];
    try {
      rows = await this.ledger.listRetriable(MAX_AUTO_RETRIES);
    } catch (err) {
      console.error('auto-retry sweep failed:', err);
      return;
    }
    const nowMs = Date.now();
    for (const job of rows) {
      const backoff = Math.min(
        AUTO_RETRY_BACKOFF_BASE_MS * 2 ** job.autoRetries,
        AUTO_RETRY_BACKOFF_MAX_MS,
      );
      if (nowMs - new Date(job.updatedAt).getTime() < backoff) continue;
      // start at verify (like retry()): a transfer that actually completed
      // resolves to done without re-uploading
      await this.ledger.update(job.id, {
        status: 'verifying',
        error: null,
        attempts: 0,
        rclone_job_id: null,
        failure_kind: null,
        auto_retries: job.autoRetries + 1,
      });
      void this.drive(job.id, job.instanceId);
    }
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

    // manual overwrite: become the sole writer for this programme — stop any
    // in-flight transfer (deleting its temp) and supersede a completed copy
    // (whose object stays live until this new copy commits, Part 5)
    if (claimOpts.overwrite) {
      const existing = await this.ledger.findAllByIdentity({
        channelname: entry.channelname ?? '',
        start: entry.start,
        stop: entry.stop,
        title: entry.disp_title,
      });
      for (const row of existing) {
        if (INFLIGHT_STATUSES.includes(row.status)) await this.cancel(row.id);
        else if (row.status === 'done') await this.ledger.supersede(row.id);
      }
    }

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
      failure_kind: null,
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
    // drop the partial temp object — the cancelled transfer never reached the
    // final path, so the live copy (if any) is untouched
    if (client) await client.deleteFile(tempRemotePath(job)).catch(() => {});
    await this.ledger.update(uploadId, { status: 'cancelled' });
    await this.publish(uploadId);
  }

  private async publish(uploadId: string): Promise<void> {
    const job = await this.ledger.get(uploadId);
    if (job) this.bus.publish({ type: 'upload-progress', data: job });
  }

  /**
   * Record the real cause of a transient stall on the job (and publish it) so a
   * network/firewall block is reported as-is while the upload keeps retrying —
   * instead of silently sitting queued or, worse, a misleading "file not found".
   */
  private async noteTransient(uploadId: string, message: string): Promise<void> {
    await this.ledger.update(uploadId, { error: message });
    await this.publish(uploadId);
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
      // rejection would kill the process. transient causes are handled inline
      // in driveInner, so an escape here is treated as a permanent failure.
      try {
        await this.ledger.update(uploadId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          failure_kind: 'permanent',
        });
        const job = await this.ledger.get(uploadId);
        const client = job && this.clients.get(job.instanceId);
        if (job && client) await client.deleteFile(tempRemotePath(job)).catch(() => {});
        await this.publish(uploadId);
      } catch (inner) {
        console.error(`upload ${uploadId}: failed to record error state:`, inner);
      }
    } finally {
      this.watching.delete(uploadId);
    }
  }

  /** mark an upload done, then clear any superseded (different) old object */
  private async commitDone(
    uploadId: string,
    client: RcloneRcClient,
    job: UploadJob,
    size: number,
  ): Promise<void> {
    await this.ledger.update(uploadId, {
      status: 'done',
      progress: size,
      error: null, // clear any transient note recorded while retrying
      completed_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    // this upload replaced a previous copy of the same broadcast at a
    // DIFFERENT path (incomplete-pick supersede) — remove it now that the new
    // one verified. A same-path overwrite is already handled by the swap.
    const supersedes = job.supersedesPath;
    if (supersedes && supersedes !== job.remotePath) {
      await client.deleteFile(supersedes).catch((err) => {
        console.error(`upload ${uploadId}: superseded object not removed (${supersedes}):`, err);
      });
    }
    await this.publish(uploadId);
  }

  private async driveInner(uploadId: string): Promise<void> {
    let verifyRetryDelay = VERIFY_RETRY_MIN_MS;
    let transientDelay = VERIFY_RETRY_MIN_MS;
    let job = await this.ledger.get(uploadId);
    if (!job) return;
    const client = this.clients.get(job.instanceId);
    if (!client) {
      await this.ledger.update(uploadId, {
        status: 'failed',
        error: 'no rclone rcd configured',
        failure_kind: 'permanent',
      });
      await this.publish(uploadId);
      return;
    }
    // copy to a per-upload temp object and rename it onto the final path only
    // after verification — an overwrite never blanks the live copy, and the
    // final name never holds two same-name objects (Part 5)
    const tempPath = tempRemotePath(job);

    while (!this.stopped) {
      job = await this.ledger.get(uploadId);
      if (!job || job.status === 'cancelled') return;

      if (job.status === 'queued' || job.status === 'dispatched') {
        if (job.attempts >= MAX_ATTEMPTS) {
          // repeated rclone job failures are transient (remote blips/quota) —
          // the auto-retry sweep re-drives this row later with backoff
          await this.ledger.update(uploadId, {
            status: 'failed',
            error: 'max attempts exceeded',
            failure_kind: 'transient',
          });
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
          let localSize: number | null;
          try {
            localSize = await client.localSize(job.localPath);
          } catch (err) {
            // rcd unreachable — wait it out instead of failing (resume() and
            // the verify step share this "transient never fails" contract).
            // record the REAL cause so a network/firewall block is reported
            // as-is, not as a bogus "file not found".
            if (isTransientRcError(err)) {
              await this.noteTransient(uploadId, `rcd unreachable while checking the file: ${rcErrorText(err)}`);
              await sleep(transientDelay);
              transientDelay = Math.min(transientDelay * 2, VERIFY_RETRY_MAX_MS);
              continue;
            }
            throw err;
          }
          transientDelay = VERIFY_RETRY_MIN_MS;
          const tolerance = Math.max(2_000_000, job.filesize * 0.01);
          if (localSize === null) {
            await this.ledger.update(uploadId, {
              status: 'failed',
              error: `local file not found on the rcd host: ${job.localPath}`,
              failure_kind: 'permanent',
            });
            await this.publish(uploadId);
            return;
          }
          if (Math.abs(localSize - job.filesize) > tolerance) {
            await this.ledger.update(uploadId, {
              status: 'failed',
              error: `file on rcd host is ${localSize} bytes but the recording is ${job.filesize} — wrong host or stale path?`,
              failure_kind: 'permanent',
            });
            await this.publish(uploadId);
            return;
          }
        }
        let jobid: number;
        try {
          jobid = await client.startCopy(job.localPath, tempPath);
        } catch (err) {
          if (isTransientRcError(err)) {
            await this.noteTransient(uploadId, `rcd unreachable while starting the copy: ${rcErrorText(err)}`);
            await sleep(transientDelay);
            transientDelay = Math.min(transientDelay * 2, VERIFY_RETRY_MAX_MS);
            continue;
          }
          throw err;
        }
        transientDelay = VERIFY_RETRY_MIN_MS;
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
        // size comparison local vs the temp object on Drive. rclone already
        // checksum-verifies each transfer in flight, so a size match on the
        // finished temp means a verified upload; this also recovers jobs lost
        // to rcd/controller restarts without needing hashsum support.
        let localSize: number | null;
        let tempSize: number | null;
        try {
          [localSize, tempSize] = await Promise.all([
            client.localSize(job.localPath),
            client.remoteSize(tempPath),
          ]);
        } catch (err) {
          // transient rc error must not fail the upload — retry the verify
          // with backoff so an unreachable rcd doesn't hot-loop; report the
          // real cause meanwhile rather than leaving it blank
          await this.noteTransient(uploadId, `rcd unreachable while verifying: ${rcErrorText(err)}`);
          await sleep(verifyRetryDelay);
          verifyRetryDelay = Math.min(verifyRetryDelay * 2, VERIFY_RETRY_MAX_MS);
          continue;
        }
        verifyRetryDelay = VERIFY_RETRY_MIN_MS;
        if (localSize !== null && tempSize === localSize) {
          // commit: atomically replace the final object with the verified temp
          try {
            await client.deleteFile(job.remotePath).catch(() => {});
            await client.moveFile(tempPath, job.remotePath);
          } catch (err) {
            // the old object may already be gone; a transient swap failure
            // just retries — the live final object is only removed in the
            // same step that renames the verified temp in
            if (isTransientRcError(err)) {
              await this.noteTransient(uploadId, `rcd unreachable while committing the upload: ${rcErrorText(err)}`);
              await sleep(verifyRetryDelay);
              verifyRetryDelay = Math.min(verifyRetryDelay * 2, VERIFY_RETRY_MAX_MS);
              continue;
            }
            throw err;
          }
          await this.commitDone(uploadId, client, job, localSize);
          return;
        }
        if (localSize !== null && tempSize === null) {
          // temp gone — a previous run may have already swapped it onto the
          // final path (crash between move and status update); accept that
          let finalSize: number | null;
          try {
            finalSize = await client.remoteSize(job.remotePath);
          } catch {
            await sleep(verifyRetryDelay);
            verifyRetryDelay = Math.min(verifyRetryDelay * 2, VERIFY_RETRY_MAX_MS);
            continue;
          }
          if (finalSize === localSize) {
            await this.commitDone(uploadId, client, job, localSize);
            return;
          }
        }
        if (localSize === null) {
          await this.ledger.update(uploadId, {
            status: 'failed',
            error: `local file missing: ${job.localPath}`,
            failure_kind: 'permanent',
          });
          await client.deleteFile(tempPath).catch(() => {});
          await this.publish(uploadId);
          return;
        }
        if (job.attempts >= MAX_ATTEMPTS) {
          await this.ledger.update(uploadId, {
            status: 'failed',
            error: `size mismatch after upload (local ${localSize}, temp ${tempSize ?? 'missing'})`,
            failure_kind: 'permanent',
          });
          await client.deleteFile(tempPath).catch(() => {});
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
