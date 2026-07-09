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

import { describe, expect, it } from 'vitest';
import type { LogLine } from '@tvhc/shared';
import { appendLogLine, MAX_LOG_LINES, sessionLogStreamUrl } from './sessionLog.js';

function line(text: string): LogLine {
  return { ts: '2026-01-01T00:00:00.000Z', src: 'ffmpeg', line: text };
}

describe('appendLogLine', () => {
  it('appends without mutating the input array', () => {
    const lines = [line('a')];
    const next = appendLogLine(lines, line('b'));
    expect(lines).toEqual([line('a')]);
    expect(next).toEqual([line('a'), line('b')]);
    expect(next).not.toBe(lines);
  });

  it('caps the buffer at MAX_LOG_LINES, dropping from the front', () => {
    let lines: LogLine[] = [];
    for (let i = 0; i < MAX_LOG_LINES + 10; i++) {
      lines = appendLogLine(lines, line(String(i)));
    }
    expect(lines).toHaveLength(MAX_LOG_LINES);
    expect(lines[0]).toEqual(line('10')); // first 10 dropped
    expect(lines[lines.length - 1]).toEqual(line(String(MAX_LOG_LINES + 9)));
  });

  it('never exceeds the cap even appending one at a time past it', () => {
    let lines: LogLine[] = Array.from({ length: MAX_LOG_LINES }, (_, i) => line(String(i)));
    lines = appendLogLine(lines, line('new'));
    expect(lines).toHaveLength(MAX_LOG_LINES);
    expect(lines[0]).toEqual(line('1'));
    expect(lines[lines.length - 1]).toEqual(line('new'));
  });
});

describe('sessionLogStreamUrl', () => {
  it('builds the log stream path', () => {
    expect(sessionLogStreamUrl('tokyo', 'node-a', 'at-x')).toBe(
      '/api/restreamer/nodes/tokyo/node-a/sessions/at-x/log/stream',
    );
  });

  it('encodeURIComponent-escapes every segment', () => {
    expect(sessionLogStreamUrl('a/b', 'c d', 'e&f')).toBe(
      '/api/restreamer/nodes/a%2Fb/c%20d/sessions/e%26f/log/stream',
    );
  });
});
