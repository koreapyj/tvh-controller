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

import { describe, expect, it, vi } from 'vitest';
import { errText, latestWins } from './fetchGuard.js';

/** a deferred promise so the test controls resolution order explicitly */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('errText', () => {
  it('extracts the message from an Error', () => {
    expect(errText(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errText('plain string')).toBe('plain string');
    expect(errText(42)).toBe('42');
    expect(errText(null)).toBe('null');
  });
});

describe('latestWins', () => {
  it('applies only the latest call, dropping a stale result resolved after it', async () => {
    const guard = latestWins();
    const apply = vi.fn();
    const first = deferred<string>();
    const second = deferred<string>();

    const call1 = guard(() => first.promise, apply);
    const call2 = guard(() => second.promise, apply);

    // resolve the newer call first, then the older (stale) one
    second.resolve('second');
    await call2;
    first.resolve('first');
    await call1;

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('second');
  });

  it('drops an error from a stale call', async () => {
    const guard = latestWins();
    const apply = vi.fn();
    const onError = vi.fn();
    const first = deferred<string>();
    const second = deferred<string>();

    const call1 = guard(() => first.promise, apply, onError);
    const call2 = guard(() => second.promise, apply, onError);

    second.resolve('second');
    await call2;
    first.reject(new Error('stale failure'));
    await call1;

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('second');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports an error from the latest call', async () => {
    const guard = latestWins();
    const apply = vi.fn();
    const onError = vi.fn();
    const first = deferred<string>();
    const second = deferred<string>();

    const call1 = guard(() => first.promise, apply, onError);
    const call2 = guard(() => second.promise, apply, onError);

    first.resolve('first');
    await call1;
    second.reject(new Error('latest failure'));
    await call2;

    expect(apply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('latest failure');
  });
});
