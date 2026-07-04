/*
 * loadConfig() validation via temp YAML files — never reads the repo's real
 * config.yaml (that points at production).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseOffset } from '../src/config.js';

describe('parseOffset', () => {
  it('parses "+HH:MM" and "-HH:MM" into minutes', () => {
    expect(parseOffset('+09:00')).toBe(540);
    expect(parseOffset('-05:30')).toBe(-330);
    expect(parseOffset('+00:00')).toBe(0);
  });

  it('passes a numeric minutes value through unchanged', () => {
    expect(parseOffset(540)).toBe(540);
    expect(parseOffset(0)).toBe(0);
  });

  it('returns undefined when absent', () => {
    expect(parseOffset(undefined)).toBeUndefined();
  });

  it('rejects a malformed offset string', () => {
    expect(() => parseOffset('nine hours')).toThrow(/invalid UTC offset/);
  });
});

describe('loadConfig', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    dir = mkdtempSync(join(tmpdir(), 'tvhc-config-test-'));
    const path = join(dir, 'config.yaml');
    writeFileSync(path, yaml, 'utf8');
    return path;
  }

  it('parses a minimal valid config', () => {
    const path = writeConfig(`
instances:
  - id: tyo1
    name: Tokyo
    url: http://tyo1.local:9981/
`);
    const cfg = loadConfig(path);
    expect(cfg.instances).toHaveLength(1);
    expect(cfg.instances[0]).toMatchObject({ id: 'tyo1', name: 'Tokyo', url: 'http://tyo1.local:9981' });
    expect(cfg.databaseUrl).toBeNull();
    expect(cfg.port).toBe(8080);
    expect(cfg.overlapThreshold).toBe(0.7);
    expect(cfg.autoUpload).toEqual({ enabled: false, graceSeconds: 120 });
  });

  it('rejects a config with no instances', () => {
    const path = writeConfig(`instances: []\n`);
    expect(() => loadConfig(path)).toThrow(/no instances defined/);
  });

  it('rejects duplicate instance ids', () => {
    const path = writeConfig(`
instances:
  - id: tyo1
    url: http://a.local
  - id: tyo1
    url: http://b.local
`);
    expect(() => loadConfig(path)).toThrow(/duplicate instance id "tyo1"/);
  });

  it('rejects a username without a password', () => {
    const path = writeConfig(`
instances:
  - id: tyo1
    url: http://a.local
    username: admin
`);
    expect(() => loadConfig(path)).toThrow(/username is set but password is missing/);
  });

  it('rejects rclone.user without rclone.pass', () => {
    const path = writeConfig(`
instances:
  - id: tyo1
    url: http://a.local
    rclone:
      rcUrl: http://a.local:5572
      user: rc
`);
    expect(() => loadConfig(path)).toThrow(/rclone.user is set but rclone.pass is missing/);
  });

  it('parses a "+HH:MM" serverOffset on an instance', () => {
    const path = writeConfig(`
instances:
  - id: tyo1
    url: http://a.local
    serverOffset: "+09:00"
`);
    const cfg = loadConfig(path);
    expect(cfg.instances[0]?.serverOffsetMinutes).toBe(540);
  });

  it('applies pollInterval/rclone/autoUpload defaults and overrides', () => {
    const path = writeConfig(`
instances:
  - id: tyo1
    url: http://a.local/
database: mysql://user:pass@host/db
port: 9000
rclone:
  remote: "gdrive:arc"
autoUpload:
  enabled: true
  graceSeconds: 30
pollIntervals:
  dvr: 5000
`);
    const cfg = loadConfig(path);
    expect(cfg.databaseUrl).toBe('mysql://user:pass@host/db');
    expect(cfg.port).toBe(9000);
    expect(cfg.rclone.remote).toBe('gdrive:arc');
    expect(cfg.autoUpload).toEqual({ enabled: true, graceSeconds: 30 });
    expect(cfg.pollIntervals.dvr).toBe(5000);
    expect(cfg.pollIntervals.autorec).toBe(60_000); // default, untouched
  });
});
