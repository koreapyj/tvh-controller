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
  import { errText } from './lib/fetchGuard.js';
  import { notify } from './lib/notifications.js';
  import { interceptLinkClicks, route } from './lib/router.js';
  import { channelOptions, instances, sseConnected } from './lib/stores.js';
  import Toasts from './components/Toasts.svelte';
  import EPG from './pages/EPG.svelte';
  import Instances from './pages/Instances.svelte';
  import Recordings from './pages/Recordings.svelte';
  import Instance from './pages/Instance.svelte';
  import Rules from './pages/Rules.svelte';
  import Drift from './pages/Drift.svelte';
  import Conflicts from './pages/Conflicts.svelte';
  import Uploads from './pages/Uploads.svelte';
  import Restreamer from './pages/Restreamer.svelte';
  import Events from './pages/Events.svelte';

  // channels need instance topology, which may lag right after a controller
  // restart — retry until available, then surface a banner instead of
  // silently leaving every channel filter empty
  async function loadChannels(): Promise<void> {
    notify.dismiss('boot');
    for (let i = 0; i < 10; i++) {
      const channels = await api.channels().catch(() => []);
      if (channels.length) {
        channelOptions.set(channels);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    notify.error(
      'Channel list unavailable — instance topology has not loaded. Channel filters and EIT time conversion are degraded.',
      { key: 'boot', action: { label: 'Retry', onclick: () => void loadChannels() } },
    );
  }

  onMount(async () => {
    try {
      instances.set(await api.instances());
    } catch (err) {
      notify.error(`Controller unreachable: ${errText(err)}`, {
        key: 'boot',
        action: { label: 'Retry', onclick: () => void loadChannels() },
      });
      return;
    }
    await loadChannels();
  });

  // mobile-only off-canvas drawer (the bar and backdrop are display:none on desktop)
  let navOpen = $state(false);
  $effect(() => {
    void $route;
    navOpen = false;
  });
</script>

<svelte:window onclick={interceptLinkClicks} />

<header class="mobile-bar">
  <button class="hamburger" aria-label="menu" onclick={() => (navOpen = !navOpen)}>☰</button>
  <span class="brand">tvh controller</span>
  {#if $sseConnected}<span class="badge ok">live</span>{:else}<span class="badge warn">reconnecting…</span>{/if}
</header>

{#if navOpen}
  <div class="nav-backdrop" role="presentation" onclick={() => (navOpen = false)}></div>
{/if}

<div class="layout">
  <nav class="sidebar" class:open={navOpen}>
    <div class="brand">tvh controller</div>
    <a href="/epg" class:active={$route.page === 'epg'}>EPG</a>
    <a
      href="/instances"
      class:active={$route.page === 'instances' || $route.page === 'instance'}>Instances</a
    >
    <a href="/restreamer" class:active={$route.page === 'restreamer'}>Restreamer</a>
    <a href="/recordings" class:active={$route.page === 'recordings'}>Recordings</a>
    <a href="/rules" class:active={$route.page === 'rules'}>Autorec Rules</a>
    <a href="/drift" class:active={$route.page === 'drift'}>Drift</a>
    <a href="/conflicts" class:active={$route.page === 'conflicts'}>Conflicts</a>
    <a href="/uploads" class:active={$route.page === 'uploads'}>Uploads</a>
    <a href="/events" class:active={$route.page === 'events'}>Events</a>
    <div style="flex:1"></div>
    <div class="section">
      {#if $sseConnected}<span class="badge ok">live</span>{:else}<span class="badge warn">reconnecting…</span>{/if}
    </div>
  </nav>

  <main>
    {#if $route.page === 'epg'}
      <EPG />
    {:else if $route.page === 'instances'}
      <Instances />
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
    {:else if $route.page === 'restreamer'}
      <Restreamer />
    {:else if $route.page === 'events'}
      <Events />
    {/if}
  </main>
</div>
<Toasts />
