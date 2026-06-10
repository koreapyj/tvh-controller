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
import type { TvhDvrEntry } from '@tvhc/shared';
import { buildRemotePath } from '../src/uploads/remotePath.js';

const entry: TvhDvrEntry = {
  uuid: 'u1',
  start: 1750000000, // 2025-06-15 UTC
  stop: 1750003600,
  disp_title: 'News 9',
  disp_subtitle: 'Episode: 1/2',
  autorec_caption: 'Evening News',
  filename: '/recordings/news9.mkv',
};

describe('buildRemotePath', () => {
  it('mirrors the local layout relative to the storage root', () => {
    const e = {
      ...entry,
      filename: '/mnt/media/recordings/2026-06-10/ＡＴ－Ｘ - 魔物喰らいの冒険者.ts',
    };
    expect(buildRemotePath('gd:recordings', e, ['/mnt/media/recordings'])).toBe(
      'gd:recordings/2026-06-10/ＡＴ－Ｘ - 魔物喰らいの冒険者.ts',
    );
  });

  it('keeps channel-distinguished filenames distinct (deliberate dup recordings)', () => {
    const a = { ...entry, filename: '/rec/2026-06-10/ＡＴ－Ｘ - Show.ts' };
    const b = { ...entry, filename: '/rec/2026-06-10/ＴＯＫＹＯ　ＭＸ１ - Show.ts' };
    expect(buildRemotePath('gd:r', a, ['/rec'])).not.toBe(buildRemotePath('gd:r', b, ['/rec']));
  });

  it('falls back to caption/date-title scheme when outside known roots', () => {
    expect(buildRemotePath('gdrive:tvh-archive', entry, ['/other/root'])).toBe(
      'gdrive:tvh-archive/Evening News/2025-06-15 News 9 - Episode_ 1_2.mkv',
    );
  });

  it('falls back when no storage roots are known', () => {
    expect(buildRemotePath('gdrive:tvh-archive', entry)).toBe(
      'gdrive:tvh-archive/Evening News/2025-06-15 News 9 - Episode_ 1_2.mkv',
    );
  });

  it('falls back to Manual for non-autorec recordings', () => {
    const manual = { ...entry, autorec_caption: undefined };
    expect(buildRemotePath('gdrive:tvh-archive', manual)).toContain('/Manual/');
  });

  it('sanitizes Drive-illegal characters and keeps the extension', () => {
    const nasty = { ...entry, disp_title: 'a/b\\c:d*e?f"g<h>i|j', filename: '/r/x.ts' };
    const p = buildRemotePath('gd:arc', nasty);
    expect(p.endsWith('.ts')).toBe(true);
    // everything after the remote prefix must be free of illegal characters
    expect(p.slice('gd:arc/'.length)).not.toMatch(/[\\:*?"<>|]/);
  });

  it('defaults the extension when filename is missing', () => {
    const noFile = { ...entry, filename: undefined };
    expect(buildRemotePath('gd:arc', noFile).endsWith('.ts')).toBe(true);
  });
});
