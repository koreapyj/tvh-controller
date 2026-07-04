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
import { parseListParam } from './query.js';

describe('parseListParam', () => {
  it('parses a valid JSON string array', () => {
    expect(parseListParam('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for valid JSON that is not an array', () => {
    expect(parseListParam('{"a":1}')).toEqual([]);
    expect(parseListParam('"just a string"')).toEqual([]);
    expect(parseListParam('42')).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseListParam('[a,b')).toEqual([]);
    expect(parseListParam('not json')).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(parseListParam(null)).toEqual([]);
  });

  it('returns [] for an empty string', () => {
    expect(parseListParam('')).toEqual([]);
  });

  it('coerces non-string array elements (e.g. numbers) to strings', () => {
    expect(parseListParam('[1,2,3]')).toEqual(['1', '2', '3']);
  });
});
