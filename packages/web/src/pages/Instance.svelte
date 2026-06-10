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
  import type { DvrState, InstanceOverview, RecordingGroup } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { bytes, duration, ts } from '../lib/format.js';
  import { instances, recordingsTick, statusByInstance } from '../lib/stores.js';

  let { instanceId }: { instanceId: string } = $props();

  let tab: DvrState = $state('upcoming');
  let groups: RecordingGroup[] = $state([]);
  let overview: InstanceOverview | null = $state(null);
  let error = $state('');
  let busy = $state(false);
  let notice = $state('');

  const inst = $derived($instances.find((i) => i.id === instanceId));

  async function refresh(): Promise<void> {
    try {
      [overview, groups] = await Promise.all([
        api.overview(instanceId),
        api.recordings(instanceId, tab),
      ]);
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  $effect(() => {
    void instanceId;
    void tab;
    if ($recordingsTick.n === 0 || $recordingsTick.instanceId === instanceId) {
      void refresh();
    }
  });

  async function upload(dvrUuid: string): Promise<void> {
    busy = true;
    notice = '';
    try {
      const results = await api.startUploads(instanceId, [dvrUuid]);
      const r = results[0];
      if (r?.error) notice = `Upload not started: ${r.error}`;
      else if (r?.duplicateOf) notice = 'Already uploaded (or uploading) from another instance.';
      else notice = 'Upload queued.';
      await refresh();
    } catch (err) {
      notice = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<h1>{inst?.name ?? instanceId}</h1>
{#if error}<div class="error-banner">{error}</div>{/if}
{#if notice}<div class="card" style="margin-bottom:12px">{notice}</div>{/if}

{#if overview}
  <div class="toolbar">
    <span class="badge {overview.instance.reachable ? 'ok' : 'bad'}">
      {overview.instance.reachable ? 'online' : 'offline'}
    </span>
    <span class="muted small">{overview.instance.url}</span>
    {#if overview.instance.version}<span class="muted small">v{overview.instance.version}</span>{/if}
    <span class="spacer"></span>
    <span class="muted small">
      {($statusByInstance[instanceId]?.subscriptions ?? overview.subscriptions).length} active subscriptions
    </span>
  </div>

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
{/if}

<div class="tabs">
  {#each ['upcoming', 'finished', 'failed'] as t}
    <button class:active={tab === t} onclick={() => (tab = t as DvrState)}>
      {t}
      {#if overview}({overview.counts[t as DvrState]}){/if}
    </button>
  {/each}
</div>

{#each groups as group (group.label)}
  <details class="group" open>
    <summary>
      <b>{group.label}</b>
      <span class="badge neutral">{group.entries.length}</span>
      {#if group.masterRuleId}<span class="badge info">managed</span>{/if}
    </summary>
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Channel</th>
          <th>Time</th>
          <th>Duration</th>
          {#if tab === 'finished'}<th>Size</th><th>Errors</th><th></th>{/if}
          {#if tab === 'failed'}<th>Status</th>{/if}
          {#if tab === 'upcoming'}<th></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each group.entries as e (e.uuid)}
          <tr>
            <td>
              {e.disp_title}
              {#if e.disp_subtitle}<span class="muted small"> · {e.disp_subtitle}</span>{/if}
            </td>
            <td class="small">{e.channelname}</td>
            <td class="small muted">{ts(e.start_real ?? e.start)}</td>
            <td class="small muted">{duration(e.start, e.stop)}</td>
            {#if tab === 'finished'}
              <td class="small muted">{bytes(e.filesize)}</td>
              <td style="white-space:nowrap">
                {#if (e.errors ?? 0) === 0 && (e.data_errors ?? 0) === 0}
                  <span class="badge ok">clean</span>
                {:else}
                  <span
                    class="badge {(e.errors ?? 0) > 0 ? 'bad' : 'warn'}"
                    title="{e.errors ?? 0} stream errors, {e.data_errors ?? 0} data (TS) errors"
                  >
                    {e.errors ?? 0} err · {e.data_errors ?? 0} data
                  </span>
                {/if}
              </td>
              <td>
                {#if e.upload}
                  <span class="badge {e.upload.status === 'done' ? 'ok' : 'info'}">
                    {e.upload.status === 'done' ? 'uploaded' : e.upload.status}
                    {#if e.upload.byInstanceId !== instanceId}(by {e.upload.byInstanceId}){/if}
                  </span>
                {:else}
                  <button disabled={busy} onclick={() => upload(e.uuid)}>Upload</button>
                {/if}
              </td>
            {/if}
            {#if tab === 'failed'}
              <td style="white-space:nowrap"><span class="badge bad">{e.status ?? 'failed'}</span>
                {#if e.errors || e.data_errors}
                  <span class="muted small" title="{e.errors ?? 0} stream errors, {e.data_errors ?? 0} data (TS) errors">
                    {e.errors ?? 0} err · {e.data_errors ?? 0} data
                  </span>
                {/if}
              </td>
            {/if}
            {#if tab === 'upcoming'}
              <td>
                {#if e.conflictLevel === 'conflict'}<span class="badge bad">conflict</span>
                {:else if e.conflictLevel === 'low-margin'}<span class="badge warn">low margin</span>{/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </details>
{:else}
  <div class="muted">No {tab} recordings.</div>
{/each}
