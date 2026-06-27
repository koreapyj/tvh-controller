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
  import type { InstanceOverview } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { conflictsByInstance, instances, recordingsTick, statusByInstance } from '../lib/stores.js';

  let overviews: Record<string, InstanceOverview> = $state({});
  let error = $state('');

  async function refresh(): Promise<void> {
    try {
      const list = $instances.length ? $instances : await api.instances();
      const results = await Promise.all(list.map((i) => api.overview(i.id).catch(() => null)));
      const next: Record<string, InstanceOverview> = {};
      list.forEach((inst, idx) => {
        const o = results[idx];
        if (o) next[inst.id] = o;
      });
      overviews = next;
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  $effect(() => {
    void $recordingsTick;
    void $instances;
    void refresh();
  });
</script>

<h1>Instances</h1>
{#if error}<div class="error-banner">{error}</div>{/if}

<div class="cards">
  {#each $instances as inst (inst.id)}
    {@const o = overviews[inst.id]}
    {@const live = $statusByInstance[inst.id]}
    {@const inputs = live?.inputs ?? o?.inputs ?? []}
    {@const subs = live?.subscriptions ?? o?.subscriptions ?? []}
    {@const conflicts = $conflictsByInstance[inst.id] ?? o?.conflicts ?? []}
    <div class="card">
      <h3>
        <a href="/instance/{inst.id}">{inst.name}</a>
        <span class="badge {inst.reachable ? 'ok' : 'bad'}">{inst.reachable ? 'online' : 'offline'}</span>
        {#if conflicts.some((c) => c.level === 'conflict')}
          <span class="badge bad">tuner conflict</span>
        {:else if conflicts.length}
          <span class="badge warn">low margin</span>
        {/if}
      </h3>
      <div class="muted small">{inst.url} {#if inst.version}· {inst.version}{/if}</div>
      {#if inst.error}<div class="small" style="color:var(--bad)">{inst.error}</div>{/if}

      {#if o}
        <div style="display:flex;gap:18px;margin:10px 0">
          <div><b>{o.counts.upcoming}</b> <span class="muted small">upcoming</span></div>
          <div><b>{o.counts.finished}</b> <span class="muted small">finished</span></div>
          <div style="color:{o.counts.failed ? 'var(--bad)' : 'inherit'}">
            <b>{o.counts.failed}</b> <span class="muted small">failed</span>
          </div>
          <div><b>{subs.length}</b> <span class="muted small">subs</span></div>
        </div>

        {#if inputs.length}
          <h2>Inputs</h2>
          <table>
            <tbody>
              {#each inputs as input (input.uuid)}
                <tr>
                  <td class="small">{input.input}{#if input.stream} · {input.stream}{/if}</td>
                  <td class="small muted">subs {input.subs ?? 0}</td>
                  <td class="small muted">
                    {#if input.snr}snr {(input.snr / (input.snr_scale === 2 ? 1000 : 1)).toFixed(1)}{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {:else}
        <div class="muted">loading…</div>
      {/if}
    </div>
  {/each}
</div>
