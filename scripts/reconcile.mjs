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

// CLI helper: node scripts/reconcile.mjs <driftId> <action>
const [driftId, action] = process.argv.slice(2);
const res = await fetch('http://localhost:8090/api/sync/reconcile', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ driftId, action }),
});
console.log(res.status, await res.text());
