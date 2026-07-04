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

/** message text for a caught unknown */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Latest-wins guard for page fetches (the EPG token pattern, extracted):
 * only the most recent call's result or error is applied, so an out-of-order
 * response from a fast tab/route switch never overwrites current data.
 */
export function latestWins(): <T>(
  work: () => Promise<T>,
  apply: (value: T) => void,
  onError?: (message: string) => void,
) => Promise<void> {
  let token = 0;
  return async (work, apply, onError) => {
    const my = ++token;
    try {
      const v = await work();
      if (my === token) apply(v);
    } catch (err) {
      if (my === token) onError?.(errText(err));
    }
  };
}
