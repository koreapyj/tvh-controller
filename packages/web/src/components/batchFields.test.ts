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
import { RECORDING_FIELDS, RULE_FIELDS } from './batchFields.js';

// Mirrors ALLOWED_FIELDS in packages/controller/src/routes/recordings.ts (the
// server rejects any batch-edit field not in this set with a 400). Keep in
// sync by hand; there is no runtime import across the client/server boundary.
const SERVER_ALLOWED_RECORDING_FIELDS = new Set([
  'enabled',
  'comment',
  'pri',
  'start_extra',
  'stop_extra',
  'removal',
  'retention',
]);

function keysOf(fields: { key: string }[]): string[] {
  return fields.map((f) => f.key);
}

describe('RECORDING_FIELDS', () => {
  it('has unique keys', () => {
    const keys = keysOf(RECORDING_FIELDS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is a subset of the server-side ALLOWED_FIELDS allowlist', () => {
    for (const key of keysOf(RECORDING_FIELDS)) {
      expect(SERVER_ALLOWED_RECORDING_FIELDS.has(key)).toBe(true);
    }
  });
});

describe('RULE_FIELDS', () => {
  it('has unique keys', () => {
    const keys = keysOf(RULE_FIELDS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
