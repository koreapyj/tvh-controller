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

import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface InstanceRcloneConfig {
  rcUrl: string;
  /** absent when rcd runs with --rc-no-auth */
  user?: string;
  pass?: string;
  /** rewrite tvheadend's `filename` path to the path visible to rclone rcd */
  recordingPathPrefix?: { from: string; to: string };
}

export interface InstanceConfig {
  id: string;
  name: string;
  url: string;
  /** absent when tvheadend allows anonymous access */
  username?: string;
  password?: string;
  /** UTC offset of the tvheadend host in minutes; overrides auto-detection via rclone rcd */
  serverOffsetMinutes?: number;
  rclone?: InstanceRcloneConfig;
}

export interface AppConfig {
  instances: InstanceConfig[];
  rclone: { remote: string };
  /** null = run without persistence: overview only, rule sync and uploads disabled */
  databaseUrl: string | null;
  port: number;
  pollIntervals: { dvr: number; autorec: number; topology: number };
  overlapThreshold: number;
  /** auto-archive every finished recording's best copy */
  autoUpload: { enabled: boolean; graceSeconds: number };
  webDistDir?: string;
}

interface RawInstance extends Omit<InstanceConfig, 'serverOffsetMinutes'> {
  /** "+09:00" style or minutes */
  serverOffset?: string | number;
}

interface RawConfig {
  port?: number;
  database?: string;
  instances: RawInstance[];
  rclone?: { remote?: string };
  autoUpload?: boolean | { enabled?: boolean; graceSeconds?: number };
  pollIntervals?: Partial<AppConfig['pollIntervals']>;
  overlapThreshold?: number;
}

/** "+09:00" / "-05:30" / minutes number -> minutes */
export function parseOffset(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  const m = /^([+-]?)(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) throw new Error(`invalid UTC offset "${v}" — expected "+HH:MM" or minutes`);
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function defaultConfigPath(): string {
  if (process.env.TVHC_CONFIG) return process.env.TVHC_CONFIG;
  return existsSync('./config.yaml') ? './config.yaml' : '/etc/tvhc/config.yaml';
}

export function loadConfig(path = defaultConfigPath()): AppConfig {
  const raw = parse(readFileSync(path, 'utf8')) as RawConfig;
  if (!raw?.instances?.length) {
    throw new Error(`no instances defined in ${path}`);
  }
  const ids = new Set<string>();
  const instances: InstanceConfig[] = raw.instances.map((i) => {
    if (ids.has(i.id)) throw new Error(`duplicate instance id "${i.id}"`);
    ids.add(i.id);
    if (i.username && !i.password) {
      throw new Error(`instance "${i.id}": username is set but password is missing`);
    }
    if (i.rclone?.user && !i.rclone.pass) {
      throw new Error(`instance "${i.id}": rclone.user is set but rclone.pass is missing`);
    }
    return {
      id: i.id,
      name: i.name ?? i.id,
      url: i.url.replace(/\/+$/, ''),
      username: i.username,
      password: i.password,
      serverOffsetMinutes: parseOffset(i.serverOffset),
      rclone: i.rclone
        ? {
            rcUrl: i.rclone.rcUrl.replace(/\/+$/, ''),
            user: i.rclone.user,
            pass: i.rclone.pass,
            recordingPathPrefix: i.rclone.recordingPathPrefix,
          }
        : undefined,
    };
  });
  return {
    instances,
    rclone: { remote: raw.rclone?.remote ?? '' },
    databaseUrl: raw.database || null,
    port: raw.port ?? 8080,
    pollIntervals: {
      dvr: raw.pollIntervals?.dvr ?? 15_000,
      autorec: raw.pollIntervals?.autorec ?? 60_000,
      topology: raw.pollIntervals?.topology ?? 600_000,
    },
    overlapThreshold: raw.overlapThreshold ?? 0.7,
    autoUpload:
      typeof raw.autoUpload === 'object'
        ? { enabled: raw.autoUpload.enabled ?? true, graceSeconds: raw.autoUpload.graceSeconds ?? 120 }
        : { enabled: raw.autoUpload ?? false, graceSeconds: 120 },
    webDistDir: process.env.WEB_DIST_DIR,
  };
}
