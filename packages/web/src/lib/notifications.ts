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

import { writable } from 'svelte/store';

export type ToastKind = 'error' | 'success' | 'info';

export interface Toast {
  id: number;
  key: string;
  kind: ToastKind;
  message: string;
  action?: { label: string; onclick: () => void };
}

export const toasts = writable<Toast[]>([]);

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

interface PushOptions {
  key?: string;
  action?: Toast['action'];
  timeoutMs?: number;
}

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(id);
  }
}

function push(kind: ToastKind, message: string, opts?: PushOptions): number {
  if (!message) return 0;

  const key = opts?.key ?? `${kind}|${message}`;
  const id = nextId++;
  const toast: Toast = { id, key, kind, message, action: opts?.action };

  let list: Toast[] = [];
  toasts.update((cur) => {
    const idx = cur.findIndex((t) => t.key === key);
    if (idx !== -1) {
      const existing = cur[idx];
      if (existing) clearTimer(existing.id);
      list = cur.slice();
      list[idx] = toast;
    } else {
      list = [...cur, toast];
      if (list.length > 5) {
        const dropped = list.shift();
        if (dropped) clearTimer(dropped.id);
      }
    }
    return list;
  });

  const ms = opts?.timeoutMs ?? (kind === 'error' ? 0 : 5000);
  if (ms > 0) {
    const timer = setTimeout(() => {
      timers.delete(id);
      toasts.update((cur) => cur.filter((t) => t.id !== id));
    }, ms);
    timers.set(id, timer);
  }

  return id;
}

function dismiss(idOrKey: number | string): void {
  toasts.update((cur) => {
    const idx =
      typeof idOrKey === 'number'
        ? cur.findIndex((t) => t.id === idOrKey)
        : cur.findIndex((t) => t.key === idOrKey);
    if (idx === -1) return cur;
    const existing = cur[idx];
    if (existing) clearTimer(existing.id);
    const list = cur.slice();
    list.splice(idx, 1);
    return list;
  });
}

export const notify = {
  error: (message: string, opts?: PushOptions) => push('error', message, opts),
  success: (message: string, opts?: PushOptions) => push('success', message, opts),
  info: (message: string, opts?: PushOptions) => push('info', message, opts),
  dismiss,
};
