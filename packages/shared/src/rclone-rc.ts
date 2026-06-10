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

/** Shapes of the rclone remote-control (rcd) HTTP API we use. */

export interface RcJobStartResponse {
  jobid: number;
}

export interface RcJobStatus {
  id: number;
  finished: boolean;
  success: boolean;
  error?: string;
  duration?: number;
  startTime?: string;
  endTime?: string;
  output?: Record<string, unknown>;
}

export interface RcCoreStats {
  bytes?: number;
  totalBytes?: number;
  speed?: number;
  errors?: number;
  transfers?: number;
  totalTransfers?: number;
  fatalError?: boolean;
  lastError?: string;
  transferring?: Array<{
    name?: string;
    size?: number;
    bytes?: number;
    speed?: number;
    percentage?: number;
  }>;
}

export interface RcHashsumResponse {
  hashType: string;
  hashes?: Record<string, string>;
}

export type UploadStatus =
  | 'queued'
  | 'dispatched'
  | 'uploading'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface UploadJob {
  id: string;
  instanceId: string;
  dvrUuid: string;
  title: string | null;
  channelname: string;
  start: number;
  stop: number;
  filesize: number | null;
  localPath: string;
  remotePath: string;
  status: UploadStatus;
  progress: number;
  rcloneJobId: number | null;
  attempts: number;
  error: string | null;
  /** advisory: a similar title was already uploaded around the same time */
  possibleDuplicate: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
