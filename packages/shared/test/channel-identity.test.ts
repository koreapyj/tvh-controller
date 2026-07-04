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
import { chanKey, chanLabel, chanNumberOrder } from '../src/channel-identity.js';

describe('chanKey', () => {
  it('passes a string number through', () => {
    expect(chanKey('KBS1', '5.1')).toBe('KBS1 5.1');
  });

  it('passes a numeric number through', () => {
    expect(chanKey('KBS1', 5.1)).toBe('KBS1 5.1');
  });

  it('folds null to the empty suffix', () => {
    expect(chanKey('KBS1', null)).toBe('KBS1 ');
  });

  it('folds undefined to the empty suffix', () => {
    expect(chanKey('KBS1', undefined)).toBe('KBS1 ');
  });

  it('treats 0 as a real number, not folded like null/undefined', () => {
    expect(chanKey('KBS1', 0)).toBe('KBS1 0');
  });

  it('distinguishes same name with different numbers', () => {
    expect(chanKey('KBS1', 1)).not.toBe(chanKey('KBS1', 2));
  });

  it('distinguishes same number with different names', () => {
    expect(chanKey('KBS1', 1)).not.toBe(chanKey('MBC', 1));
  });
});

describe('chanLabel', () => {
  it('prefixes the number, separated by a full-width space', () => {
    expect(chanLabel('KBS1', 51)).toBe('51　KBS1');
  });

  it('accepts string numbers (EPG channels)', () => {
    expect(chanLabel('ABC', '2.1')).toBe('2.1　ABC');
  });

  it('falls back to the plain name when the number is null', () => {
    expect(chanLabel('KBS1', null)).toBe('KBS1');
  });

  it('treats 0 as a real number, not folded like null', () => {
    expect(chanLabel('KBS1', 0)).toBe('0　KBS1');
  });
});

describe('chanNumberOrder', () => {
  it('orders numeric labels by value', () => {
    expect(chanNumberOrder('9.1')).toBeLessThan(chanNumberOrder('10'));
    expect(chanNumberOrder(2)).toBeLessThan(chanNumberOrder('51'));
  });

  it('unknown or unparsable sorts last', () => {
    expect(chanNumberOrder(null)).toBe(Infinity);
    expect(chanNumberOrder('weird')).toBe(Infinity);
  });
});
