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

import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notify, toasts } from './notifications.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllTimers();
  toasts.set([]);
});

describe('notify', () => {
  it('auto-dismisses a success toast after 5000ms', () => {
    notify.success('saved');
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(get(toasts)).toHaveLength(0);
  });

  it('persists an error toast past 5000ms', () => {
    notify.error('boom');
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(100_000);
    expect(get(toasts)).toHaveLength(1);
  });

  it('replaces a toast with the same message instead of stacking, and restarts the timer', () => {
    notify.success('saved');
    vi.advanceTimersByTime(4000);
    const before = get(toasts);
    expect(before).toHaveLength(1);
    const id1 = before[0]?.id;

    notify.success('saved');
    const list = get(toasts);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).not.toBe(id1);

    // original timer should not fire at the 5000ms mark relative to the first push
    vi.advanceTimersByTime(1000);
    expect(get(toasts)).toHaveLength(1);

    // but the new timer fires 5000ms after the second push
    vi.advanceTimersByTime(4000);
    expect(get(toasts)).toHaveLength(0);
  });

  it('replaces a toast by explicit key, and dismiss(key) removes it', () => {
    notify.error('first message', { key: 'boot' });
    notify.error('second message', { key: 'boot' });

    const list = get(toasts);
    expect(list).toHaveLength(1);
    expect(list[0]?.message).toBe('second message');

    notify.dismiss('boot');
    expect(get(toasts)).toHaveLength(0);
  });

  it('caps the list at 5, dropping the oldest', () => {
    for (let i = 0; i < 6; i++) {
      notify.error(`error ${i}`);
    }
    const list = get(toasts);
    expect(list).toHaveLength(5);
    expect(list.map((t) => t.message)).toEqual([
      'error 1',
      'error 2',
      'error 3',
      'error 4',
      'error 5',
    ]);
  });

  it('is a no-op for an empty message', () => {
    const id = notify.error('');
    expect(id).toBe(0);
    expect(get(toasts)).toHaveLength(0);
  });
});
