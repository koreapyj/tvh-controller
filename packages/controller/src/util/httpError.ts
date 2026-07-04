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

/**
 * Neutral (non-routes-layer) home for httpError so lower layers such as
 * sync/engine.ts can throw HTTP-flavored errors without importing the
 * routes layer (which would be a backwards dependency). Re-exported from
 * routes/context.ts for existing route handlers.
 */
export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}
