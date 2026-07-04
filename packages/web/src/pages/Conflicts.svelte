<!--
tvh-controller - Centralized tvheadend controller
Copyright (C) 2026 Yoonji Park

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
-->
<script lang="ts">
  import type { ConflictWindow } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { latestWins } from '../lib/fetchGuard.js';
  import { ts } from '../lib/format.js';
  import { notify } from '../lib/notifications.js';
  import { conflictsByInstance, instances } from '../lib/stores.js';

  let fetched: Record<string, ConflictWindow[]> = $state({});

  const guard = latestWins();
  $effect(() => {
    const list = $instances;
    void guard(
      async () => {
        const results = await Promise.all(list.map((i) => api.conflicts(i.id).catch(() => [])));
        const next: Record<string, ConflictWindow[]> = {};
        list.forEach((inst, idx) => (next[inst.id] = results[idx] ?? []));
        return next;
      },
      (next) => {
        fetched = next;
        notify.dismiss('conflicts-load');
      },
      (msg) => notify.error(msg, { key: 'conflicts-load' }),
    );
  });

  const merged = $derived(
    $instances.map((inst) => ({
      inst,
      windows: $conflictsByInstance[inst.id] ?? fetched[inst.id] ?? [],
    })),
  );
</script>

<h1>Tuner Conflicts</h1>
<p class="muted small">
  Predicted from upcoming recordings: channels are mapped to muxes and matched against available
  tuners per network. Recordings on the same mux share a tuner.
</p>

{#each merged as { inst, windows } (inst.id)}
  <div class="card" style="margin-bottom:12px">
    <h3>{inst.name}</h3>
    {#if windows.length === 0}
      <div class="muted">✓ No upcoming tuner shortages detected.</div>
    {:else}
      <table>
        <thead>
          <tr><th>Severity</th><th>Window</th><th>Network</th><th>Detail</th><th>Recordings</th></tr>
        </thead>
        <tbody>
          {#each windows as w}
            <tr>
              <td>
                <span class="badge {w.level === 'conflict' ? 'bad' : 'warn'}">
                  {w.level === 'conflict' ? 'conflict' : 'low margin'}
                </span>
              </td>
              <td class="small">{ts(w.start)} – {ts(w.stop)}</td>
              <td class="small">{w.network}</td>
              <td class="small muted">{w.detail}</td>
              <td class="small muted">{w.entryUuids.length}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/each}
