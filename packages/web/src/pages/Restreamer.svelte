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
  import {
    chanLabel,
    type AribHlsParams,
    type RestreamChannelWithStatus,
    type RestreamPlaylist,
    type RestreamProfile,
  } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { lowestNumberFor } from '../lib/channelPick.js';
  import { errText } from '../lib/fetchGuard.js';
  import { dateTime } from '../lib/format.js';
  import { notify } from '../lib/notifications.js';
  import {
    CHANNEL_BATCH_FIELDS,
    compareChannels,
    sessionStateBadge,
    uptimeLabel,
  } from '../lib/restreamFields.js';
  import {
    channelOptions,
    instName,
    restreamerNodeKey,
    restreamerNodes,
    restreamerSwitchers,
    seedRestreamers,
  } from '../lib/stores.js';
  import BatchEditModal from '../components/BatchEditModal.svelte';
  import RestreamChannelModal from '../components/RestreamChannelModal.svelte';
  import RestreamProfileModal from '../components/RestreamProfileModal.svelte';

  let profiles: RestreamProfile[] = $state([]);
  let channels: RestreamChannelWithStatus[] = $state([]);
  let playlists: RestreamPlaylist[] = $state([]);
  let busy = $state(false);

  async function refreshAll(): Promise<void> {
    try {
      [profiles, channels, playlists] = await Promise.all([
        api.restreamProfiles(),
        api.restreamChannels(),
        api.restreamPlaylists(),
      ]);
      notify.dismiss('restreamer-load');
    } catch (err) {
      notify.error(errText(err), { key: 'restreamer-load' });
    }
  }

  async function seedNodes(): Promise<void> {
    try {
      const { nodes, switchers } = await api.restreamerNodes();
      seedRestreamers(nodes, switchers);
      notify.dismiss('restreamer-nodes');
    } catch (err) {
      notify.error(errText(err), { key: 'restreamer-nodes' });
    }
  }

  $effect(() => {
    void seedNodes();
    void refreshAll();
  });

  async function run(fn: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await fn();
      await refreshAll();
    } catch (err) {
      notify.error(errText(err));
    } finally {
      busy = false;
    }
  }

  // ---------- nodes / switchers ----------

  const nodeList = $derived(
    Object.values($restreamerNodes).sort((a, b) =>
      restreamerNodeKey(a).localeCompare(restreamerNodeKey(b)),
    ),
  );
  const switcherList = $derived(
    Object.values($restreamerSwitchers).sort((a, b) => a.switcherId.localeCompare(b.switcherId)),
  );

  /** placement id → "instance / node" (for switcher upstream display) */
  const placementNodeLabel = $derived.by(() => {
    const m = new Map<string, string>();
    for (const c of channels) {
      for (const p of c.placements) m.set(p.id, `${$instName(p.instanceId)} / ${p.nodeId}`);
    }
    return m;
  });

  function restartSession(instanceId: string, nodeId: string, name: string): void {
    if (!confirm(`Restart session "${name}" on ${nodeId}? Playback glitches briefly.`)) return;
    void run(() => api.restartRestreamSession(instanceId, nodeId, name));
  }

  // ---------- channels ----------

  const profileName = $derived(
    (id: string) => profiles.find((p) => p.id === id)?.name ?? id,
  );
  const playlistTitle = $derived(
    (id: string) => playlists.find((p) => p.id === id)?.title ?? id,
  );

  /** M3U playlist order: numeric channel number, null numbers last, then name */
  const orderedChannels = $derived([...channels].sort(compareChannels));

  let selected: Record<string, boolean> = $state({});
  const selectedIds = $derived(orderedChannels.filter((c) => selected[c.id]).map((c) => c.id));
  const allSelected = $derived(
    orderedChannels.length > 0 && orderedChannels.every((c) => selected[c.id]),
  );
  function toggleSelect(id: string, checked: boolean): void {
    selected = { ...selected, [id]: checked };
  }
  function toggleAll(checked: boolean): void {
    const next = { ...selected };
    for (const c of orderedChannels) next[c.id] = checked;
    selected = next;
  }

  let batchEditing = $state(false);
  let batchPlaylist = $state('');

  async function runChannelBatch(
    action: 'edit' | 'delete' | 'enable' | 'disable' | 'add-playlist' | 'remove-playlist',
    ids: string[],
    opts?: { patch?: Record<string, unknown>; playlistId?: string },
  ): Promise<void> {
    if (!ids.length) return;
    busy = true;
    try {
      const res = await api.batchRestreamChannels(action, ids, opts);
      const fails = res.filter((r) => !r.ok);
      if (fails.length) {
        notify.error(
          `${fails.length} of ${res.length} failed: ${fails.slice(0, 3).map((f) => f.error ?? 'failed').join('; ')}`,
        );
      }
      selected = {};
      await refreshAll();
    } catch (err) {
      notify.error(errText(err));
    } finally {
      busy = false;
    }
  }

  function batchDelete(): void {
    const ids = selectedIds;
    if (!ids.length) return;
    if (
      !confirm(
        `Delete ${ids.length} restream channel${ids.length === 1 ? '' : 's'}? ` +
          'Every node stops encoding them and their output directories are removed.',
      )
    )
      return;
    void runChannelBatch('delete', ids);
  }

  /** channel-edit modal: null = closed, channel null inside = create */
  let channelModal: { channel: RestreamChannelWithStatus | null } | null = $state(null);

  function removeChannel(c: RestreamChannelWithStatus): void {
    if (
      !confirm(
        `Delete restream channel "${c.slug}"? Every node stops encoding it and its output directory is removed.`,
      )
    )
      return;
    void run(() => api.deleteRestreamChannel(c.id));
  }

  function forceSwitch(c: RestreamChannelWithStatus, placementId: string, label: string): void {
    if (c.placements.filter((p) => p.enabled).length < 2) return; // not redundant — nothing to switch
    if (c.activePlacementId === placementId) return;
    if (!confirm(`Switch "${c.slug}" to ${label}? Viewers see one discontinuity.`)) return;
    void run(() => api.switchRestreamChannel(c.id, { placementId }));
  }

  /** undo manual switching: back to the highest-priority HEALTHY placement */
  function resetSwitch(c: RestreamChannelWithStatus): void {
    if (!confirm(`Reset "${c.slug}" to its highest-priority healthy placement? Viewers may see one discontinuity.`)) return;
    void run(async () => {
      const res = await api.switchRestreamChannel(c.id, { reset: true });
      if (res.already) notify.info(`"${c.slug}" is already on its priority upstream`);
      else notify.success(`"${c.slug}" reset to its priority upstream`);
    });
  }

  function placementTitle(
    c: RestreamChannelWithStatus,
    p: RestreamChannelWithStatus['placements'][number],
  ): string {
    const parts = [
      `${$instName(p.instanceId)} / ${p.nodeId} — ${p.session?.state ?? 'no session'}`,
    ];
    if (!p.enabled) parts.push('placement disabled');
    if (p.blockedReason) parts.push(`blocked: ${p.blockedReason}`);
    if (p.session?.lastError) parts.push(p.session.lastError);
    if (c.activePlacementId === p.id && c.placements.length > 1) {
      parts.push('ACTIVE — the switcher serves this placement');
    } else if (c.placements.filter((x) => x.enabled).length >= 2) {
      parts.push('click to force-switch here');
    }
    return parts.join(' · ');
  }

  // ---------- profiles ----------

  /** profile modal: null = closed, profile null inside = create */
  let profileModal: { profile: RestreamProfile | null } | null = $state(null);

  const profileUseCount = $derived(
    (id: string) => channels.filter((c) => c.profileId === id).length,
  );

  function profileSummary(p: RestreamProfile): string {
    const params = p.payload as AribHlsParams;
    const video = params.video.bitrate ?? '3M';
    const audio = params.audio
      .map((a, i) => a.bitrate ?? (i === 0 ? '128k' : '64k'))
      .join('+');
    return `${video} / ${audio}`;
  }

  function saveProfile(out: { name: string; payload: AribHlsParams }): void {
    const editing = profileModal?.profile ?? null;
    profileModal = null;
    void run(() =>
      editing
        ? api.updateRestreamProfile(editing.id, { name: out.name, payload: out.payload })
        : api.createRestreamProfile(out.name, out.payload),
    );
  }

  function removeProfile(p: RestreamProfile): void {
    if (!confirm(`Delete profile "${p.name}"?`)) return;
    void run(() => api.deleteRestreamProfile(p.id)); // 409 while referenced surfaces as a toast
  }

  // ---------- playlists ----------

  interface PlaylistForm {
    id: string | null;
    slug: string;
    title: string;
    epgUrl: string;
  }
  let playlistModal: PlaylistForm | null = $state(null);
  let playlistError = $state('');

  const playlistMemberCount = $derived(
    (id: string) => channels.filter((c) => c.playlistIds.includes(id)).length,
  );

  function m3uUrl(slug: string): string {
    return `${window.location.origin}/playlists/${slug}.m3u`;
  }

  async function copyM3u(slug: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(m3uUrl(slug));
      notify.success('M3U URL copied');
    } catch (err) {
      notify.error(`copy failed: ${errText(err)}`);
    }
  }

  function savePlaylist(): void {
    const f = playlistModal;
    if (!f) return;
    playlistError = '';
    if (!f.slug.trim() || !f.title.trim()) {
      playlistError = 'slug and title are required';
      return;
    }
    const body = {
      slug: f.slug.trim(),
      title: f.title.trim(),
      epgUrl: f.epgUrl.trim() || null,
    };
    playlistModal = null;
    void run(() =>
      f.id ? api.updateRestreamPlaylist(f.id, body) : api.createRestreamPlaylist(body),
    );
  }

  function removePlaylist(p: RestreamPlaylist): void {
    if (
      !confirm(
        `Delete playlist "${p.title}"? Its M3U URL stops working; member channels are untouched.`,
      )
    )
      return;
    void run(() => api.deleteRestreamPlaylist(p.id));
  }
</script>

<h1>Restreamer</h1>
<p class="muted small">
  One daemon per node encodes tvheadend channels to browser-playable HLS; a logical channel with
  placements on several instances is redundant — every placement encodes hot-hot and the switcher
  splices the active one. The controller pushes desired state and mirrors live status here.
</p>

<h2>Nodes</h2>
{#if nodeList.length === 0 && switcherList.length === 0}
  <p class="muted">No restreamer nodes configured — add a <code>restreamer:</code> block to an instance in config.yaml.</p>
{:else}
  <div class="cards">
    {#each nodeList as n (restreamerNodeKey(n))}
      <div class="card">
        <h3>
          {$instName(n.instanceId)} / {n.nodeId}
          {#if n.reachable}<span class="badge ok">reachable</span>{:else}<span class="badge bad">unreachable</span>{/if}
          {#if n.pendingPush}<span class="badge warn" title="the controller's desired doc is not confirmed pushed to this node">pending push</span>{/if}
          {#if !n.apiVersionSupported}<span class="badge bad" title="node reports an apiVersion the controller doesn't speak">api?</span>{/if}
        </h3>
        <div class="muted small">
          {n.url}
          {#if n.version}&nbsp;· v{n.version}{/if}
          {#if n.uptimeSec !== null}&nbsp;· up {uptimeLabel(n.uptimeSec)}{/if}
        </div>
        {#if n.error}<div class="small" style="color:var(--bad)">{n.error}</div>{/if}
        <div style="margin:8px 0">
          <button disabled={busy} onclick={() => run(() => api.pushRestreamerNode(n.instanceId, n.nodeId))}>
            Push now
          </button>
        </div>
        {#if n.sessions.length}
          <table>
            <thead>
              <tr><th>Session</th><th>State</th><th>Restarts</th><th>Lag</th><th></th></tr>
            </thead>
            <tbody>
              {#each n.sessions as s (s.name)}
                <tr>
                  <td class="small">
                    {#if n.serveUrl}
                      <a href="{n.serveUrl}/{s.name}/playlist.m3u8" target="_blank" title="open the HLS playlist">{s.name}</a>
                    {:else}{s.name}{/if}
                    {#if s.lastError}
                      <div class="small muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={s.lastError}>
                        {s.lastError}
                      </div>
                    {/if}
                  </td>
                  <td>
                    <span
                      class="badge {sessionStateBadge(s.state)}"
                      title={s.lastExit ? `last exit: ${s.lastExit.class} at ${dateTime(s.lastExit.at)}` : ''}
                    >
                      {s.state}
                    </span>
                  </td>
                  <td class="small">{s.restarts}</td>
                  <td class="small">
                    {#if s.playlistLagSec !== undefined}{Math.round(s.playlistLagSec)}s{:else}<span class="muted">—</span>{/if}
                  </td>
                  <td style="text-align:right">
                    <button
                      disabled={busy}
                      title="kill + respawn, reset backoff"
                      onclick={() => restartSession(n.instanceId, n.nodeId, s.name)}
                    >
                      Restart
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <div class="muted small">no sessions</div>
        {/if}
      </div>
    {/each}

    {#each switcherList as sw (sw.switcherId)}
      <div class="card">
        <h3>
          switcher {sw.switcherId}
          {#if sw.reachable}<span class="badge ok">reachable</span>{:else}<span class="badge bad">unreachable</span>{/if}
          {#if sw.pendingPush}<span class="badge warn" title="the controller's desired doc is not confirmed pushed to this switcher">pending push</span>{/if}
        </h3>
        <div class="muted small">
          {sw.url}
          {#if sw.version}&nbsp;· v{sw.version}{/if}
        </div>
        {#if sw.error}<div class="small" style="color:var(--bad)">{sw.error}</div>{/if}
        {#if sw.channels.length}
          <table>
            <thead>
              <tr><th>Channel</th><th>Active</th><th>Upstreams</th><th>Last switch</th></tr>
            </thead>
            <tbody>
              {#each sw.channels as c (c.slug)}
                <tr>
                  <td class="small">{c.slug}</td>
                  <td class="small">
                    {#if c.activeUpstreamId}
                      {placementNodeLabel.get(c.activeUpstreamId) ?? c.activeUpstreamId}
                    {:else}<span class="muted">none</span>{/if}
                  </td>
                  <td style="white-space:nowrap">
                    {#each c.upstreams as u (u.id)}
                      <span
                        class="rec-dot {u.healthy ? 'ok' : ''}"
                        title="{placementNodeLabel.get(u.id) ?? u.id} — {u.healthy ? 'healthy' : 'unhealthy'}{u.playlistLagSec !== undefined ? `, lag ${Math.round(u.playlistLagSec)}s` : ''}"
                      ></span>
                    {/each}
                  </td>
                  <td class="small muted">
                    {#if c.lastSwitch}
                      <span title="from {c.lastSwitch.from ? (placementNodeLabel.get(c.lastSwitch.from) ?? c.lastSwitch.from) : '(none)'} to {placementNodeLabel.get(c.lastSwitch.to) ?? c.lastSwitch.to}">
                        {c.lastSwitch.reason} · {dateTime(c.lastSwitch.at)}
                      </span>
                    {:else}—{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <div class="muted small">no redundant channels pushed</div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<h2>Channels</h2>
<div class="toolbar">
  <button class="primary" disabled={!profiles.length} title={profiles.length ? '' : 'create a profile first'} onclick={() => (channelModal = { channel: null })}>
    New channel
  </button>
</div>

{#if selectedIds.length}
  <div class="toolbar">
    <span class="muted small">{selectedIds.length} selected</span>
    <button disabled={busy} onclick={() => (batchEditing = true)}>Edit…</button>
    <button disabled={busy} onclick={() => runChannelBatch('enable', selectedIds)}>Enable</button>
    <button disabled={busy} onclick={() => runChannelBatch('disable', selectedIds)}>Disable</button>
    <button class="danger" disabled={busy} onclick={batchDelete}>Delete</button>
    <select style="width:auto" bind:value={batchPlaylist} aria-label="playlist for batch add/remove">
      <option value="" disabled>playlist…</option>
      {#each playlists as pl (pl.id)}
        <option value={pl.id}>{pl.title}</option>
      {/each}
    </select>
    <button
      disabled={busy || !batchPlaylist}
      onclick={() => runChannelBatch('add-playlist', selectedIds, { playlistId: batchPlaylist })}
    >
      Add to playlist
    </button>
    <button
      disabled={busy || !batchPlaylist}
      onclick={() => runChannelBatch('remove-playlist', selectedIds, { playlistId: batchPlaylist })}
    >
      Remove from playlist
    </button>
    <button onclick={() => (selected = {})}>Clear selection</button>
  </div>
{/if}

<table class="m-cards">
  <thead>
    <tr>
      <th style="width:28px">
        <input
          type="checkbox"
          checked={allSelected}
          onchange={(e) => toggleAll(e.currentTarget.checked)}
          title="select all"
        />
      </th>
      <th>Channel</th>
      <th>Slug</th>
      <th>Profile</th>
      <th>Enabled</th>
      <th>Playlists</th>
      <th>Placements</th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each orderedChannels as c (c.id)}
      <tr class="m-card">
        <td>
          <input
            type="checkbox"
            checked={selected[c.id] ?? false}
            onchange={(e) => toggleSelect(c.id, e.currentTarget.checked)}
            title="select"
          />
        </td>
        <td class="m-inline">
          {#if c.sourceType === 'external'}
            <span class="badge info" title="external source: {c.sourceKey}">ext</span>
            {c.channelName}
          {:else}
            {#if c.channelNumber == null}
              {@const n = lowestNumberFor(c.channelName, $channelOptions)}
              {#if n !== null}
                <span class="muted" title="not pinned — targets the lowest-numbered channel with this name">{n}　</span>
              {/if}
            {/if}
            {chanLabel(c.channelName, c.channelNumber)}
          {/if}
          {#if c.comment}<div class="muted small">{c.comment}</div>{/if}
        </td>
        <td class="small m-inline">
          {#if c.playbackUrl}
            <a href={c.playbackUrl} target="_blank" title="open the HLS playlist"><code>{c.slug}</code></a>
          {:else}
            <code>{c.slug}</code>
          {/if}
        </td>
        <td class="small m-inline">{c.profileName || profileName(c.profileId)}</td>
        <td class="m-inline">
          <input
            type="checkbox"
            checked={c.enabled}
            disabled={busy}
            title={c.enabled ? 'disable (stops every placement)' : 'enable'}
            onchange={(e) => {
              const on = e.currentTarget.checked;
              void run(() => api.updateRestreamChannel(c.id, { enabled: on }));
            }}
          />
        </td>
        <td class="m-inline">
          {#each c.playlistIds as pid (pid)}
            <span class="badge neutral">{playlistTitle(pid)}</span>
          {:else}
            <span class="muted small m-hide">—</span>
          {/each}
        </td>
        <td class="m-inline" style="white-space:nowrap">
          {#each [...c.placements].sort((a, b) => a.priority - b.priority) as p (p.id)}
            <button
              class="badge badge-button {p.enabled ? (p.session ? sessionStateBadge(p.session.state) : 'neutral') : 'neutral'}"
              title={placementTitle(c, p)}
              onclick={() => forceSwitch(c, p.id, `${$instName(p.instanceId)} / ${p.nodeId}`)}
            >
              {p.nodeId}{#if p.blockedReason}&nbsp;⚠{/if}
            </button>
            {#if c.activePlacementId === p.id && c.placements.length > 1}
              <span class="badge ok" title="the switcher currently serves this placement">active</span>
              <button
                disabled={busy}
                title="switch back to the highest-priority healthy placement"
                onclick={() => resetSwitch(c)}
              >
                Reset
              </button>
            {/if}
          {:else}
            <span class="muted small m-hide">no placements</span>
          {/each}
        </td>
        <td style="white-space:nowrap;text-align:right">
          <button disabled={busy} onclick={() => (channelModal = { channel: c })}>Edit</button>
          <button class="danger" disabled={busy} onclick={() => removeChannel(c)}>Delete</button>
        </td>
      </tr>
    {:else}
      <tr><td colspan="8" class="muted">No restream channels yet — create a profile, then a channel.</td></tr>
    {/each}
  </tbody>
</table>

<h2>Profiles</h2>
<div class="toolbar">
  <button class="primary" onclick={() => (profileModal = { profile: null })}>New profile</button>
</div>
<table>
  <thead>
    <tr><th>Name</th><th>Mode</th><th>Bitrates (video / audio)</th><th>In use</th><th></th></tr>
  </thead>
  <tbody>
    {#each profiles as p (p.id)}
      <tr>
        <td>{p.name}</td>
        <td class="small">{(p.payload as AribHlsParams).video.mode}</td>
        <td class="small">{profileSummary(p)}</td>
        <td class="small">
          {#if profileUseCount(p.id)}
            {profileUseCount(p.id)} channel{profileUseCount(p.id) === 1 ? '' : 's'}
          {:else}<span class="muted">unused</span>{/if}
        </td>
        <td style="white-space:nowrap;text-align:right">
          <button disabled={busy} onclick={() => (profileModal = { profile: p })}>Edit</button>
          <button class="danger" disabled={busy} onclick={() => removeProfile(p)}>Delete</button>
        </td>
      </tr>
    {:else}
      <tr><td colspan="5" class="muted">No encoding profiles yet.</td></tr>
    {/each}
  </tbody>
</table>

<h2>Playlists</h2>
<div class="toolbar">
  <button
    class="primary"
    onclick={() => {
      playlistError = '';
      playlistModal = { id: null, slug: '', title: '', epgUrl: '' };
    }}
  >
    New playlist
  </button>
</div>
<table>
  <thead>
    <tr><th>Title</th><th>Slug</th><th>EPG URL</th><th>Members</th><th>M3U</th><th></th></tr>
  </thead>
  <tbody>
    {#each playlists as p (p.id)}
      <tr>
        <td>{p.title}</td>
        <td class="small"><code>{p.slug}</code></td>
        <td class="small cell-clip" title={p.epgUrl ?? ''}>
          {#if p.epgUrl}{p.epgUrl}{:else}<span class="muted">—</span>{/if}
        </td>
        <td class="small">{playlistMemberCount(p.id)}</td>
        <td class="small" style="white-space:nowrap">
          <a href="/playlists/{p.slug}.m3u" target="_blank" title="lists this playlist's currently running channels">{m3uUrl(p.slug)}</a>
          <button title="copy the M3U URL" onclick={() => void copyM3u(p.slug)}>Copy</button>
        </td>
        <td style="white-space:nowrap;text-align:right">
          <button
            disabled={busy}
            onclick={() => {
              playlistError = '';
              playlistModal = { id: p.id, slug: p.slug, title: p.title, epgUrl: p.epgUrl ?? '' };
            }}
          >
            Edit
          </button>
          <button class="danger" disabled={busy} onclick={() => removePlaylist(p)}>Delete</button>
        </td>
      </tr>
    {:else}
      <tr><td colspan="6" class="muted">No playlists yet — create one and add channels to it.</td></tr>
    {/each}
  </tbody>
</table>

{#if channelModal}
  <RestreamChannelModal
    channel={channelModal.channel}
    {profiles}
    {playlists}
    onclose={() => {
      channelModal = null;
      void refreshAll();
    }}
  />
{/if}

{#if profileModal}
  <RestreamProfileModal
    profile={profileModal.profile}
    onsave={saveProfile}
    oncancel={() => (profileModal = null)}
  />
{/if}

{#if playlistModal}
  <div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && (playlistModal = null)}>
    <div
      class="modal"
      style="width:480px"
      role="dialog"
      aria-modal="true"
      aria-label={playlistModal.id ? 'Edit playlist' : 'New playlist'}
    >
      <h2 style="margin-top:0">{playlistModal.id ? 'Edit playlist' : 'New playlist'}</h2>
      {#if playlistError}<div class="error-banner">{playlistError}</div>{/if}
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <label for="pl-title">Title</label>
          <input id="pl-title" bind:value={playlistModal.title} />
        </div>
        <div>
          <label for="pl-slug">Slug</label>
          <input id="pl-slug" bind:value={playlistModal.slug} placeholder="channels" />
          <div class="muted small">URL path segment: /playlists/&lt;slug&gt;.m3u</div>
        </div>
        <div>
          <label for="pl-epg">EPG URL (url-tvg)</label>
          <input id="pl-epg" bind:value={playlistModal.epgUrl} placeholder="(none)" />
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button onclick={() => (playlistModal = null)}>Cancel</button>
        <button class="primary" disabled={busy} onclick={savePlaylist}>Save</button>
      </div>
    </div>
  </div>
{/if}

{#if batchEditing}
  <BatchEditModal
    title={`Edit ${selectedIds.length} channel${selectedIds.length === 1 ? '' : 's'}`}
    subtitle="Ticked fields are applied to every selected channel; affected nodes are re-pushed."
    fields={CHANNEL_BATCH_FIELDS(profiles)}
    onsave={(out) => {
      batchEditing = false;
      void runChannelBatch('edit', selectedIds, { patch: out.fields });
    }}
    oncancel={() => (batchEditing = false)}
  />
{/if}
