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
  import { untrack } from 'svelte';
  import { chanLabel, type UploadJob } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { bytes, pct, ts } from '../lib/format.js';
  import { notify } from '../lib/notifications.js';
  import { instName, uploadEvent } from '../lib/stores.js';

  let jobs: UploadJob[] = $state([]);
  let busy = $state(false);

  async function refresh(): Promise<void> {
    try {
      jobs = await api.uploads();
      notify.dismiss('uploads-load');
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err), { key: 'uploads-load' });
    }
  }

  $effect(() => {
    void refresh();
  });

  $effect(() => {
    const ev = $uploadEvent;
    if (!ev) return;
    // untrack: this effect must depend ONLY on the incoming event — reading
    // `jobs` tracked would make every write retrigger the effect (infinite
    // update-depth loop)
    untrack(() => {
      const idx = jobs.findIndex((j) => j.id === ev.id);
      if (idx === -1) jobs = [ev, ...jobs];
      else jobs = jobs.map((j, i) => (i === idx ? ev : j));
    });
  });

  function statusBadge(s: string): string {
    switch (s) {
      case 'done': return 'ok';
      case 'failed': return 'bad';
      case 'cancelled': case 'superseded': return 'neutral';
      case 'uploading': case 'verifying': return 'info';
      default: return 'neutral';
    }
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await fn();
      await refresh();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }
</script>

<h1>Uploads</h1>
<p class="muted small">
  Uploads run via rclone rcd on each tvheadend host and are size-verified against Google Drive
  (rclone checksums each transfer in flight). The shared ledger prevents the same broadcast
  from being uploaded twice.
</p>

<table class="m-cards">
  <thead>
    <tr>
      <th>Recording</th>
      <th>Channel</th>
      <th>Instance</th>
      <th>Status</th>
      <th>Progress</th>
      <th>Remote path</th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each jobs as j (j.id)}
      <tr class="m-card">
        <td>
          {j.title ?? '—'}
          {#if j.origin === 'auto'}<span class="badge neutral" title="queued by auto-upload">auto</span>{/if}
          {#if j.possibleDuplicate}<span class="badge warn" title="similar title already uploaded">dup?</span>{/if}
          {#if j.incompletePick}
            <span
              class="badge warn"
              title="copy was picked while an instance was unreachable — re-evaluated automatically once all instances are back"
            >
              incomplete pick
            </span>
          {/if}
          <div class="muted small">{ts(j.start)}</div>
        </td>
        <td class="small m-inline">{chanLabel(j.channelname, j.channelnumber ?? null)}</td>
        <td class="small m-inline"><span class="m-only">from</span>{$instName(j.instanceId)}</td>
        <td class="m-inline">
          <span class="badge {statusBadge(j.status)}">{j.status}</span>
          {#if j.error}<div class="small" style="color:var(--bad)">{j.error}</div>{/if}
        </td>
        <td class="m-inline">
          {#if j.status === 'uploading' && j.filesize}
            <div class="progress"><div style="width:{pct(j.progress, j.filesize)}%"></div></div>
            <span class="muted small">{bytes(j.progress)} / {bytes(j.filesize)}</span>
          {:else if j.status === 'done'}
            <span class="muted small">{bytes(j.filesize)}</span>
          {/if}
        </td>
        <td class="small muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">
          {j.remotePath}
        </td>
        <td style="white-space:nowrap">
          {#if j.status === 'failed' || j.status === 'cancelled'}
            <button disabled={busy} onclick={() => run(() => api.retryUpload(j.id))}>Retry</button>
          {/if}
          {#if j.status === 'uploading' || j.status === 'queued' || j.status === 'dispatched'}
            <button class="danger" disabled={busy} onclick={() => run(() => api.cancelUpload(j.id))}>
              Cancel
            </button>
          {/if}
        </td>
      </tr>
    {:else}
      <tr><td colspan="7" class="muted">No uploads yet — start one from a finished recording.</td></tr>
    {/each}
  </tbody>
</table>
