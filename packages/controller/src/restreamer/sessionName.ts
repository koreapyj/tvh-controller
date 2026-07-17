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
 * The session name — and, equivalently, the serve-URL path segment — a
 * placement is addressed by: an on-demand row's activation_uuid when the
 * placement IS that row's current to_placement_id, else the placement's own
 * id. Every other placement (including a hot-failover row's from placement,
 * which never equals to_placement_id) keeps its own id unchanged.
 */
export function sessionNameFor(
  placementId: string,
  row: { activation_uuid: string | null; to_placement_id: string | null } | null | undefined,
): string {
  if (row?.activation_uuid && row.to_placement_id === placementId) return row.activation_uuid;
  return placementId;
}
