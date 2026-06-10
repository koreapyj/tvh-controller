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
  import { onMount } from 'svelte';
  import { api } from './lib/api.js';
  import { interceptLinkClicks, route } from './lib/router.js';
  import { channelOptions, instances, sseConnected } from './lib/stores.js';
  import Dashboard from './pages/Dashboard.svelte';
  import Recordings from './pages/Recordings.svelte';
  import Instance from './pages/Instance.svelte';
  import Rules from './pages/Rules.svelte';
  import Drift from './pages/Drift.svelte';
  import Conflicts from './pages/Conflicts.svelte';
  import Uploads from './pages/Uploads.svelte';

  onMount(async () => {
    instances.set(await api.instances());
    // channels need instance topology, which may lag right after a
    // controller restart — retry until available
    for (let i = 0; i < 10; i++) {
      const channels = await api.channels().catch(() => []);
      if (channels.length) {
        channelOptions.set(channels);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  });
</script>

<svelte:window onclick={interceptLinkClicks} />

<div class="layout">
  <nav class="sidebar">
    <div class="brand">tvh controller</div>
    <a href="/" class:active={$route.page === 'dashboard'}>Dashboard</a>
    <a href="/recordings" class:active={$route.page === 'recordings'}>Recordings</a>
    <a href="/rules" class:active={$route.page === 'rules'}>Autorec Rules</a>
    <a href="/drift" class:active={$route.page === 'drift'}>Drift</a>
    <a href="/conflicts" class:active={$route.page === 'conflicts'}>Conflicts</a>
    <a href="/uploads" class:active={$route.page === 'uploads'}>Uploads</a>
    <div class="section">Instances</div>
    {#each $instances as inst (inst.id)}
      <a
        href="/instance/{inst.id}"
        class:active={$route.page === 'instance' && $route.instanceId === inst.id}
      >
        {inst.name}
        <span class="badge {inst.reachable ? 'ok' : 'bad'}">{inst.reachable ? 'up' : 'down'}</span>
      </a>
    {/each}
    <div style="flex:1"></div>
    <div class="section">
      {#if $sseConnected}<span class="badge ok">live</span>{:else}<span class="badge warn">reconnecting…</span>{/if}
    </div>
  </nav>

  <main>
    {#if $route.page === 'dashboard'}
      <Dashboard />
    {:else if $route.page === 'recordings'}
      <Recordings />
    {:else if $route.page === 'instance' && $route.instanceId}
      <Instance instanceId={$route.instanceId} />
    {:else if $route.page === 'rules'}
      <Rules />
    {:else if $route.page === 'drift'}
      <Drift />
    {:else if $route.page === 'conflicts'}
      <Conflicts />
    {:else if $route.page === 'uploads'}
      <Uploads />
    {/if}
  </main>
</div>
