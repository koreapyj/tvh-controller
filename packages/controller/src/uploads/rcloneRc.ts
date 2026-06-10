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

import type { RcCoreStats, RcJobStartResponse, RcJobStatus } from '@tvhc/shared';
import type { InstanceRcloneConfig } from '../config.js';

export class RcloneRcError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`rclone rc ${path} -> HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'RcloneRcError';
  }
}

/**
 * Client for one host's `rclone rcd` HTTP remote-control API.
 * Basic auth when credentials are configured; bare requests for
 * `rclone rcd --rc-no-auth`.
 */
export class RcloneRcClient {
  private readonly auth: string | null;

  constructor(
    private readonly cfg: InstanceRcloneConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.auth = cfg.user
      ? `Basic ${Buffer.from(`${cfg.user}:${cfg.pass ?? ''}`).toString('base64')}`
      : null;
  }

  private async call<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.rcUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.auth ? { authorization: this.auth } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new RcloneRcError(res.status, path, text);
    return (text === '' ? {} : JSON.parse(text)) as T;
  }

  /** rewrite tvheadend's filename to the path visible to this rcd */
  mapLocalPath(tvhPath: string): string {
    const prefix = this.cfg.recordingPathPrefix;
    if (prefix && tvhPath.startsWith(prefix.from)) {
      return prefix.to + tvhPath.slice(prefix.from.length);
    }
    return tvhPath;
  }

  private static splitPath(p: string): { dir: string; file: string } {
    const idx = p.lastIndexOf('/');
    return { dir: idx <= 0 ? '/' : p.slice(0, idx), file: p.slice(idx + 1) };
  }

  private static splitRemote(remotePath: string): { fs: string; remote: string } {
    // "gdrive:tvh-archive/Show/file.ts" -> fs "gdrive:tvh-archive", remote "Show/file.ts"
    const colon = remotePath.indexOf(':');
    const rest = remotePath.slice(colon + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) return { fs: remotePath, remote: '' };
    return {
      fs: remotePath.slice(0, colon + 1) + rest.slice(0, slash),
      remote: rest.slice(slash + 1),
    };
  }

  async version(): Promise<string> {
    const res = await this.call<{ version?: string }>('/core/version');
    return res.version ?? 'unknown';
  }

  /**
   * Local UTC offset of the host the rcd runs on, in minutes. rclone (Go)
   * formats ModTime as RFC3339 in the daemon's local zone, so a stat of "/"
   * exposes the host timezone. The rcd is guaranteed to run on the same
   * host as tvheadend, whose autorec times follow this zone.
   */
  async serverUtcOffsetMinutes(): Promise<number | null> {
    try {
      const res = await this.call<{ item?: { ModTime?: string } }>('/operations/stat', {
        fs: '/',
        remote: '',
      });
      const mod = res.item?.ModTime ?? '';
      if (/Z$/.test(mod)) return 0;
      const m = /([+-])(\d{2}):(\d{2})$/.exec(mod);
      if (!m) return null;
      const sign = m[1] === '-' ? -1 : 1;
      return sign * (Number(m[2]) * 60 + Number(m[3]));
    } catch {
      return null;
    }
  }

  /** start an async copy of one local file to the remote path; returns jobid */
  async startCopy(localPath: string, remotePath: string): Promise<number> {
    const { dir, file } = RcloneRcClient.splitPath(localPath);
    const dst = RcloneRcClient.splitRemote(remotePath);
    const res = await this.call<RcJobStartResponse>('/operations/copyfile', {
      srcFs: dir,
      srcRemote: file,
      dstFs: dst.fs,
      dstRemote: dst.remote,
      _async: true,
    });
    return res.jobid;
  }

  jobStatus(jobid: number): Promise<RcJobStatus> {
    return this.call<RcJobStatus>('/job/status', { jobid });
  }

  jobStats(jobid: number): Promise<RcCoreStats> {
    return this.call<RcCoreStats>('/core/stats', { group: `job/${jobid}` });
  }

  stopJob(jobid: number): Promise<void> {
    return this.call('/job/stop', { jobid }).then(() => undefined);
  }

  private async statSize(fs: string, remote: string): Promise<number | null> {
    const res = await this.call<{ item: { Size?: number } | null }>('/operations/stat', {
      fs,
      remote,
    });
    const size = res.item?.Size;
    return size === undefined || size < 0 ? null : size;
  }

  /** size of the local file, null when missing */
  localSize(localPath: string): Promise<number | null> {
    const { dir, file } = RcloneRcClient.splitPath(localPath);
    return this.statSize(dir, file);
  }

  /** size of the uploaded Drive object, null when missing */
  remoteSize(remotePath: string): Promise<number | null> {
    const dst = RcloneRcClient.splitRemote(remotePath);
    return this.statSize(dst.fs, dst.remote);
  }

  /** delete a remote object (used when a better copy supersedes an upload) */
  async deleteFile(remotePath: string): Promise<void> {
    const dst = RcloneRcClient.splitRemote(remotePath);
    await this.call('/operations/deletefile', { fs: dst.fs, remote: dst.remote });
  }
}
