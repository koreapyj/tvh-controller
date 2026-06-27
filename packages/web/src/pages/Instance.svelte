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
  import { ts } from '../lib/format.js';
  import { instances, recordingsTick, statusByInstance } from '../lib/stores.js';

  let { instanceId }: { instanceId: string } = $props();

  let overview: InstanceOverview | null = $state(null);
  let error = $state('');

  const inst = $derived($instances.find((i) => i.id === instanceId));

  async function refresh(): Promise<void> {
    try {
      overview = await api.overview(instanceId);
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  $effect(() => {
    void instanceId;
    if ($recordingsTick.n === 0 || $recordingsTick.instanceId === instanceId) {
      void refresh();
    }
  });

  function snr(v: number | undefined, scale: number | undefined): string {
    if (!v) return '';
    return (v / (scale === 2 ? 1000 : 1)).toFixed(1);
  }
</script>

<h1>{inst?.name ?? instanceId}</h1>
{#if error}<div class="error-banner">{error}</div>{/if}

{#if overview}
  {@const live = $statusByInstance[instanceId]}
  {@const inputs = live?.inputs ?? overview.inputs}
  {@const subs = live?.subscriptions ?? overview.subscriptions}
  <div class="toolbar">
    <span class="badge {overview.instance.reachable ? 'ok' : 'bad'}">
      {overview.instance.reachable ? 'online' : 'offline'}
    </span>
    <span class="muted small">{overview.instance.url}</span>
    {#if overview.instance.version}<span class="muted small">v{overview.instance.version}</span>{/if}
    {#if overview.instance.lastPollAt}
      <span class="muted small">polled {ts(Date.parse(overview.instance.lastPollAt) / 1000)}</span>
    {/if}
    <span class="spacer"></span>
    <a class="muted small" href="/recordings">
      {overview.counts.upcoming} upcoming · {overview.counts.finished} finished · {overview.counts.failed} failed
    </a>
  </div>

  {#if overview.instance.error}<div class="error-banner">{overview.instance.error}</div>{/if}

  {#if overview.conflicts.length}
    <div class="error-banner">
      {#each overview.conflicts as c}
        <div>
          <b>{c.level === 'conflict' ? 'CONFLICT' : 'Low margin'}</b>
          {ts(c.start)}–{ts(c.stop)} on {c.network}: {c.detail}
        </div>
      {/each}
    </div>
  {/if}

  <h2>Tuners / inputs</h2>
  {#if inputs.length}
    <table>
      <thead>
        <tr><th>Input</th><th>Stream</th><th>Subs</th><th>Weight</th><th>SNR</th><th>Signal</th></tr>
      </thead>
      <tbody>
        {#each inputs as input (input.uuid)}
          <tr>
            <td class="small">{input.input}</td>
            <td class="small muted">{input.stream ?? ''}</td>
            <td class="small muted">{input.subs ?? 0}</td>
            <td class="small muted">{input.weight ?? ''}</td>
            <td class="small muted">{snr(input.snr, input.snr_scale)}</td>
            <td class="small muted">{snr(input.signal, input.signal_scale)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <div class="muted">No active inputs.</div>
  {/if}

  <h2>Active subscriptions <span class="badge neutral">{subs.length}</span></h2>
  {#if subs.length}
    <table>
      <thead>
        <tr><th>Title</th><th>Channel</th><th>Client</th><th>State</th><th>Errors</th></tr>
      </thead>
      <tbody>
        {#each subs as s (s.id)}
          <tr>
            <td class="small">{s.title ?? ''}</td>
            <td class="small muted">{s.channel ?? s.service ?? ''}</td>
            <td class="small muted">{s.client ?? s.hostname ?? s.username ?? ''}</td>
            <td class="small muted">{s.state ?? ''}</td>
            <td class="small muted" style="color:{(s.errors ?? 0) > 0 ? 'var(--bad)' : 'inherit'}">
              {s.errors ?? 0}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <div class="muted">No active subscriptions.</div>
  {/if}
{:else}
  <div class="muted">loading…</div>
{/if}
