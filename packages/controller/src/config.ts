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
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

export interface InstanceRcloneConfig {
  rcUrl: string;
  /** absent when rcd runs with --rc-no-auth */
  user?: string;
  pass?: string;
  /** rewrite tvheadend's `filename` path to the path visible to rclone rcd */
  recordingPathPrefix?: { from: string; to: string };
}

export interface RestreamerNodeConfig {
  id: string;
  url: string;
  /** public HLS base for viewer-facing segment URLs; absent = node not directly serveable */
  serveUrl?: string;
  /** expected serving bandwidth budget (Mbps), used by the rebalancer */
  egressMbps?: number;
}

export interface InstanceConfig {
  id: string;
  name: string;
  /**
   * tvheadend base URL; an explicit `url: null` marks a tvh-less zone (no
   * tvheadend machinery is constructed — the instance exists purely to host
   * restreamer nodes fed by their m3u source catalogs)
   */
  url: string | null;
  /** absent when tvheadend allows anonymous access */
  username?: string;
  password?: string;
  /** UTC offset of the tvheadend host in minutes; overrides auto-detection via rclone rcd */
  serverOffsetMinutes?: number;
  rclone?: InstanceRcloneConfig;
  /** restreamer daemon nodes at this tvheadend location; absent = feature off here */
  restreamer?: { nodes: RestreamerNodeConfig[] };
}

/** standalone HLS switcher service (redundant-channel failover) */
export interface SwitcherConfig {
  id: string;
  url: string;
  /** viewer-facing base used for redundant-channel links in the M3U output */
  publicUrl: string;
}

export interface AppConfig {
  instances: InstanceConfig[];
  rclone: { remote: string };
  /** null = run without persistence: overview only, rule sync and uploads disabled */
  databaseUrl: string | null;
  port: number;
  pollIntervals: { dvr: number; autorec: number; topology: number; epg: number; restreamer: number };
  overlapThreshold: number;
  /** auto-archive every finished recording's best copy */
  autoUpload: { enabled: boolean; graceSeconds: number };
  /**
   * standalone switcher service(s) (absent block = redundancy feature off)
   * plus the controller's own viewer-facing base URL (`publicUrl`), used for
   * controller-hosted links in M3U output (logo proxy); when unset the base
   * is derived per request from X-Forwarded-Proto/Host or the request itself
   */
  restreamer?: { switchers: SwitcherConfig[]; publicUrl?: string };
  webDistDir?: string;
}

interface RawInstance extends Omit<InstanceConfig, 'url' | 'serverOffsetMinutes' | 'restreamer'> {
  /** required key: a string, or literal null for a tvh-less zone (absent = config error) */
  url?: string | null;
  /** "+09:00" style or minutes */
  serverOffset?: string | number;
  restreamer?: { nodes?: RestreamerNodeConfig[] };
}

interface RawConfig {
  port?: number;
  database?: string;
  instances: RawInstance[];
  rclone?: { remote?: string };
  autoUpload?: boolean | { enabled?: boolean; graceSeconds?: number };
  pollIntervals?: Partial<AppConfig['pollIntervals']>;
  overlapThreshold?: number;
  restreamer?: { switchers?: SwitcherConfig[]; publicUrl?: string };
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

function parseRestreamerNodes(
  instanceId: string,
  raw: { nodes?: RestreamerNodeConfig[] } | undefined,
): { nodes: RestreamerNodeConfig[] } | undefined {
  if (!raw) return undefined;
  const ids = new Set<string>();
  const nodes = (raw.nodes ?? []).map((n) => {
    if (!n.id) throw new Error(`instance "${instanceId}": restreamer node without an id`);
    if (!n.url) throw new Error(`instance "${instanceId}": restreamer node "${n.id}" has no url`);
    if (ids.has(n.id)) {
      throw new Error(`instance "${instanceId}": duplicate restreamer node id "${n.id}"`);
    }
    ids.add(n.id);
    return {
      id: n.id,
      url: n.url.replace(/\/+$/, ''),
      serveUrl: n.serveUrl?.replace(/\/+$/, ''),
      egressMbps: n.egressMbps,
    };
  });
  return { nodes };
}

function parseSwitchers(
  raw: { switchers?: SwitcherConfig[]; publicUrl?: string } | undefined,
): { switchers: SwitcherConfig[]; publicUrl?: string } | undefined {
  if (!raw) return undefined;
  const ids = new Set<string>();
  const switchers = (raw.switchers ?? []).map((s) => {
    if (!s.id) throw new Error('restreamer switcher without an id');
    if (!s.url) throw new Error(`restreamer switcher "${s.id}" has no url`);
    if (!s.publicUrl) throw new Error(`restreamer switcher "${s.id}" has no publicUrl`);
    if (ids.has(s.id)) throw new Error(`duplicate restreamer switcher id "${s.id}"`);
    ids.add(s.id);
    return {
      id: s.id,
      url: s.url.replace(/\/+$/, ''),
      publicUrl: s.publicUrl.replace(/\/+$/, ''),
    };
  });
  return { switchers, publicUrl: raw.publicUrl?.replace(/\/+$/, '') };
}

function defaultConfigPath(): string {
  if (process.env.TVHC_CONFIG) return process.env.TVHC_CONFIG;
  // walk up from the cwd so `pnpm dev` (run inside packages/controller) still
  // finds the repo-root config.yaml; fall back to the system path otherwise
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'config.yaml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '/etc/tvhc/config.yaml';
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
    if (i.url === undefined) {
      // absent url stays an error (catches typos); a tvh-less zone must say so explicitly
      throw new Error(`instance "${i.id}": url is required (use "url: null" for a tvh-less zone)`);
    }
    if (i.url === null) {
      // tvh-less zone: fields that only make sense with a tvheadend are rejected
      if (i.username !== undefined || i.password !== undefined) {
        throw new Error(`instance "${i.id}": username/password are meaningless with "url: null" (no tvheadend)`);
      }
      if (i.serverOffset !== undefined) {
        throw new Error(`instance "${i.id}": serverOffset is meaningless with "url: null" (no tvheadend)`);
      }
      if (i.rclone) {
        throw new Error(`instance "${i.id}": rclone is meaningless with "url: null" (no tvheadend DVR to upload from)`);
      }
    }
    if (i.username && !i.password) {
      throw new Error(`instance "${i.id}": username is set but password is missing`);
    }
    if (i.rclone?.user && !i.rclone.pass) {
      throw new Error(`instance "${i.id}": rclone.user is set but rclone.pass is missing`);
    }
    return {
      id: i.id,
      name: i.name ?? i.id,
      url: i.url === null ? null : i.url.replace(/\/+$/, ''),
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
      restreamer: parseRestreamerNodes(i.id, i.restreamer),
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
      // EPG refreshes via the comet `epg` push; this is only the slow fallback
      epg: raw.pollIntervals?.epg ?? 600_000,
      restreamer: raw.pollIntervals?.restreamer ?? 15_000,
    },
    overlapThreshold: raw.overlapThreshold ?? 0.7,
    autoUpload:
      typeof raw.autoUpload === 'object'
        ? { enabled: raw.autoUpload.enabled ?? true, graceSeconds: raw.autoUpload.graceSeconds ?? 120 }
        : { enabled: raw.autoUpload ?? false, graceSeconds: 120 },
    restreamer: parseSwitchers(raw.restreamer),
    webDistDir: process.env.WEB_DIST_DIR,
  };
}
