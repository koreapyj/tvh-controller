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
    type NodeProbeSettings,
    type NodeSettings,
    type RestreamChannelWithStatus,
    type RestreamPlaylist,
    type RestreamProfile,
    type RestreamerNodeStatus,
  } from '@tvhc/shared';
  import { api, classifyResetError } from '../lib/api.js';
  import { lowestNumberFor } from '../lib/channelPick.js';
  import { errText } from '../lib/fetchGuard.js';
  import { dateTime } from '../lib/format.js';
  import {
    channelHasFailoverState,
    placementBadgeClass,
    resetUnavailableReason,
    showActiveCheck,
  } from '../lib/failoverIndicator.js';
  import { configuredHotCount, isOverCapacity } from '../lib/nodeCapacity.js';
  import { notify } from '../lib/notifications.js';
  import {
    CHANNEL_BATCH_FIELDS,
    compareChannels,
    failingProbeBadges,
    probeMeasurementLabel,
    sessionStateBadge,
    uptimeLabel,
  } from '../lib/restreamFields.js';
  import {
    channelOptions,
    clearRestreamChannelLive,
    instName,
    restreamChannelLive,
    restreamerNodeKey,
    restreamerNodes,
    restreamerSwitchers,
    seedRestreamers,
  } from '../lib/stores.js';
  import BatchEditModal from '../components/BatchEditModal.svelte';
  import ProbeConfigModal from '../components/ProbeConfigModal.svelte';
  import RestreamChannelModal from '../components/RestreamChannelModal.svelte';
  import RestreamProfileModal from '../components/RestreamProfileModal.svelte';
  import SessionModal from '../components/SessionModal.svelte';

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
      // a REST refetch is always fresher than any buffered SSE overlay
      clearRestreamChannelLive();
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
      for (const p of c.placements) m.set(p.id, `${p.nodeId}`);
    }
    return m;
  });

  /** REST channel list with the SSE live overlay applied — the freshest view for capacity counting */
  const mergedChannels = $derived(channels.map((c) => $restreamChannelLive[c.id] ?? c));

  /** node keys (restreamerNodeKey) whose configured hot load exceeds their maxSessions cap */
  const overCapacityNodeKeys = $derived.by(() => {
    const set = new Set<string>();
    for (const n of Object.values($restreamerNodes)) {
      const configured = configuredHotCount(mergedChannels, n.instanceId, n.nodeId);
      if (isOverCapacity(n.maxSessions, configured)) set.add(restreamerNodeKey(n));
    }
    return set;
  });

  /** node card muted line: version / uptime / last measurement / capacity, in order, only the pieces we have */
  function nodeMutedLine(n: RestreamerNodeStatus, configured: number): string {
    const parts: string[] = [];
    if (n.version) parts.push(`v${n.version}`);
    if (n.uptimeSec !== null) parts.push(`up ${uptimeLabel(n.uptimeSec)}`);
    const measured = probeMeasurementLabel(n);
    if (measured) parts.push(measured);
    if (n.maxSessions !== null) parts.push(`${configured}/${n.maxSessions} hot configured`);
    return parts.join(' · ');
  }

  // ---------- per-node settings (probes + capacity) ----------

  let settingsModal: {
    instanceId: string;
    nodeId: string;
    nodeLabel: string;
    initial: NodeProbeSettings;
    initialSettings: NodeSettings;
  } | null = $state(null);

  async function openSettingsModal(n: RestreamerNodeStatus): Promise<void> {
    try {
      const [initial, initialSettings] = await Promise.all([
        api.restreamerNodeProbes(n.instanceId, n.nodeId),
        api.getNodeSettings(n.instanceId, n.nodeId),
      ]);
      settingsModal = { instanceId: n.instanceId, nodeId: n.nodeId, nodeLabel: n.nodeId, initial, initialSettings };
    } catch (err) {
      notify.error(errText(err));
    }
  }

  async function saveSettings(payload: { probes: NodeProbeSettings; settings: NodeSettings }): Promise<void> {
    const m = settingsModal;
    if (!m) return;
    settingsModal = null;
    try {
      await Promise.all([
        api.updateRestreamerNodeProbes(m.instanceId, m.nodeId, payload.probes),
        api.putNodeSettings(m.instanceId, m.nodeId, payload.settings),
      ]);
      notify.success(`Settings saved for ${m.nodeLabel}`);
    } catch (err) {
      notify.error(errText(err));
    }
  }

  // ---------- session detail modal ----------

  let sessionModal: { instanceId: string; nodeId: string; name: string } | null = $state(null);

  const sessionModalNode = $derived(
    sessionModal ? $restreamerNodes[restreamerNodeKey(sessionModal)] : undefined,
  );
  const sessionModalSession = $derived(
    sessionModal ? sessionModalNode?.sessions.find((s) => s.name === sessionModal!.name) : undefined,
  );

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

  /** dismiss the ⚠ blocked badge: stops showing a past attempt's reason, does not retry */
  function dismissBlocked(c: RestreamChannelWithStatus): void {
    void run(() => api.clearRestreamFailoverBlocked(c.id));
  }

  function forceSwitch(c: RestreamChannelWithStatus, placementId: string, label: string): void {
    if (c.placements.filter((p) => p.enabled).length < 2) return; // not redundant — nothing to switch
    if (c.activePlacementId === placementId) return;
    if (!confirm(`Switch "${c.slug}" to ${label}? Viewers see one discontinuity.`)) return;
    void run(async () => {
      const res = await api.switchRestreamChannel(c.id, { placementId });
      if (res.queued) notify.info(`Switch to ${label} queued`);
      else if (res.already) notify.info(`"${c.slug}" is already on ${label}`);
    });
  }

  /** undo manual switching: back to the highest-priority HEALTHY placement */
  function resetSwitch(c: RestreamChannelWithStatus): void {
    if (!confirm(`Reset "${c.slug}" to its highest-priority healthy placement? Viewers may see one discontinuity.`)) return;
    void doResetSwitch(c, false);
  }

  async function doResetSwitch(c: RestreamChannelWithStatus, force: boolean): Promise<void> {
    busy = true;
    try {
      const res = await api.switchRestreamChannel(c.id, force ? { reset: true, force: true } : { reset: true });
      if (res.cleared) notify.success(`"${c.slug}" failover state cleared`);
      else if (res.already) notify.info(`"${c.slug}" is already on its priority upstream`);
      else if (res.aborted) notify.success(`"${c.slug}" failover procedure reverted`);
      else if (res.queued) notify.success(`"${c.slug}" reset queued`);
      else notify.success(`"${c.slug}" reset to its priority upstream`);
      await refreshAll();
    } catch (err) {
      const cls = classifyResetError(err);
      if (cls?.kind === 'rejected-mid-procedure') {
        alert(cls.message);
      } else if (cls?.kind === 'requires-confirm') {
        if (confirm(`${cls.message} Reset anyway?`)) {
          await doResetSwitch(c, true);
          return;
        }
      } else {
        notify.error(errText(err));
      }
    } finally {
      busy = false;
    }
  }

  function placementTitle(
    c: RestreamChannelWithStatus,
    p: RestreamChannelWithStatus['placements'][number],
  ): string {
    const parts = [
      `${p.nodeId} — ${p.session?.state ?? 'no session'}`,
    ];
    if (!p.enabled) parts.push('placement disabled');
    if (p.indicator && p.indicator !== 'idle') parts.push(`failover: ${p.indicator}`);
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

  // in use as a channel default or as a per-placement override
  const profileUseCount = $derived(
    (id: string) =>
      channels.filter(
        (c) => c.profileId === id || c.placements.some((p) => p.profileId === id),
      ).length,
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

  interface ProfileCloneState {
    source: RestreamProfile;
    name: string;
  }
  let profileCloning: ProfileCloneState | null = $state(null);

  function openProfileClone(p: RestreamProfile): void {
    profileCloning = { source: p, name: `${p.name} (copy)` };
  }

  async function doProfileClone(): Promise<void> {
    const c = profileCloning;
    if (!c) return;
    profileCloning = null;
    await run(async () => {
      await api.cloneRestreamProfile(c.source.id, c.name.trim());
      notify.success(`Cloned profile "${c.source.name}"`);
    });
  }

  // ---------- playlists ----------

  interface PlaylistForm {
    id: string | null;
    slug: string;
    title: string;
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

    {#each nodeList as n (restreamerNodeKey(n))}
      {@const configured = configuredHotCount(mergedChannels, n.instanceId, n.nodeId)}
      <div class="card">
        <h3>
          {n.nodeId}
          {#if n.reachable}<span class="badge ok">reachable</span>{:else}<span class="badge bad">unreachable</span>{/if}
          {#if n.pendingPush}<span class="badge warn" title="the controller's desired doc is not confirmed pushed to this node">pending push</span>{/if}
          {#if !n.apiVersionSupported}<span class="badge bad" title="node reports an apiVersion the controller doesn't speak">api?</span>{/if}
          {#if overCapacityNodeKeys.has(restreamerNodeKey(n))}
            <span
              class="badge warn"
              title="configured hot placements ({configured}) exceed this node's max sessions ({n.maxSessions}) — encodes are still pushed; reduce placements or raise the cap"
            >over capacity</span>
          {/if}
        </h3>
        {#if failingProbeBadges(n).length}
          <div style="margin:4px 0">
            {#each failingProbeBadges(n) as fb (fb.name)}
              <span class="badge warn">{fb.name}:{fb.count}</span>
            {/each}
          </div>
        {/if}
        <div class="muted small">{nodeMutedLine(n, configured)}</div>
        {#if n.error}<div class="small" style="color:var(--bad)">{n.error}</div>{/if}
        <div style="margin:8px 0;display:flex;gap:8px">
          <button disabled={busy} onclick={() => run(() => api.pushRestreamerNode(n.instanceId, n.nodeId))}>
            Push now
          </button>
          <button disabled={busy} onclick={() => openSettingsModal(n)}>Settings…</button>
        </div>
        {#if n.sessions.length}
          <table>
            <thead>
              <tr><th>Session</th><th>State</th><th>Restarts</th><th>Lag</th></tr>
            </thead>
            <tbody>
              {#each n.sessions as s (s.name)}
                <tr>
                  <td class="small">
                    <button
                      class="linklike"
                      title={s.name}
                      onclick={() => (sessionModal = { instanceId: n.instanceId, nodeId: n.nodeId, name: s.name })}
                    >
                      {#if s.channelSlug}
                        {s.channelSlug}<span class="muted"> · {s.name.slice(0, 8)}</span>
                      {:else}
                        {s.name}
                      {/if}
                    </button>
                  </td>
                  <td>
                    <span
                      class="badge {sessionStateBadge(s.state)}"
                      title={s.lastExit ? `last exit: ${s.lastExit.class} at ${dateTime(s.lastExit.at)}` : ''}
                    >
                      {s.state}
                    </span>
                    {#if s.lagProbe?.consecutiveFailures}
                      <span class="badge warn" title="channel-level lag probe failing">lag:{s.lagProbe.consecutiveFailures}</span>
                    {/if}
                  </td>
                  <td class="small">
                    <span
                      title={s.lastError ? s.lastError : ''}
                    >
                      {s.restarts}
                    </span>
                  </td>
                  <td class="small">
                    {#if s.playlistLagSec !== undefined}{Math.round(s.playlistLagSec)}s{:else}<span class="muted">—</span>{/if}
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
    <button class="danger" disabled={busy} onclick={batchDelete}>Delete</button>
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
      {@const live = $restreamChannelLive[c.id] ?? c}
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
          {#if c.channelNumber == null}
            {@const n = lowestNumberFor(c.channelName, $channelOptions)}
            {#if n !== null}
              <span class="muted" title="not pinned — targets the lowest-numbered channel with this name">{n}　</span>
            {/if}
          {/if}
          {chanLabel(c.channelName, c.channelNumber)}
          {#if live.failoverBlocked}
            <span class="badge warn" title="failover blocked: {live.failoverBlocked}">blocked</span>
            <button
              class="linklike muted"
              disabled={busy}
              aria-label="dismiss blocked reason"
              title="dismiss — clears the badge without retrying the failover"
              onclick={() => dismissBlocked(c)}
            >×</button>
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
          {#each [...live.placements].sort((a, b) => a.priority - b.priority) as p (p.id)}
            {@const cls = placementBadgeClass(p.indicator, { enabled: p.enabled, sessionState: p.session?.state ?? null })}
            {@const redundant = live.placements.filter((x) => x.enabled).length > 1}
            {@const showCheck = showActiveCheck(p.indicator, live.activePlacementId === p.id, redundant)}
            {@const nodeOverCap = overCapacityNodeKeys.has(restreamerNodeKey(p))}
            <button
              class="badge badge-button {cls}"
              title={placementTitle(live, p)}
              onclick={() => forceSwitch(live, p.id, `${$instName(p.instanceId)} / ${p.nodeId}`)}
            >
              {#if showCheck}✓&nbsp;{/if}{p.nodeId}{#if p.blockedReason}&nbsp;⚠{/if}
            </button>
            {#if nodeOverCap}
              <span
                class="rec-dot warn"
                title="{p.nodeId} is over capacity: configured hot placements exceed its max sessions — encodes are still pushed; reduce placements or raise the cap"
              ></span>
            {/if}
          {:else}
            <span class="muted small m-hide">no placements</span>
          {/each}
        </td>
        <td style="white-space:nowrap;text-align:right">
          {#if channelHasFailoverState(live.failover)}
            {@const resetBlocked = resetUnavailableReason(live.failover)}
            <button
              disabled={busy || resetBlocked !== null}
              title={resetBlocked ?? 'fail back to the natural placement (first hot)'}
              onclick={() => resetSwitch(live)}
            >
              Reset
            </button>
          {/if}
          <button disabled={busy} onclick={() => (channelModal = { channel: live })}>Edit</button>
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
          <button disabled={busy} onclick={() => openProfileClone(p)}>Clone</button>
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
      playlistModal = { id: null, slug: '', title: '' };
    }}
  >
    New playlist
  </button>
</div>
<table>
  <thead>
    <tr><th>Title</th><th>Slug</th><th>Members</th><th>M3U</th><th></th></tr>
  </thead>
  <tbody>
    {#each playlists as p (p.id)}
      <tr>
        <td>{p.title}</td>
        <td class="small"><code>{p.slug}</code></td>
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
              playlistModal = { id: p.id, slug: p.slug, title: p.title };
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
    {channels}
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

{#if profileCloning}
  <div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && (profileCloning = null)}>
    <div class="modal" style="width:480px" role="dialog" aria-modal="true" aria-label={`Clone ${profileCloning.source.name}`}>
      <h2 style="margin-top:0">Clone profile: {profileCloning.source.name}</h2>
      <div>
        <label for="profile-clone-name">Name</label>
        <input id="profile-clone-name" bind:value={profileCloning.name} />
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button onclick={() => (profileCloning = null)}>Cancel</button>
        <button class="primary" disabled={!profileCloning.name.trim() || busy} onclick={doProfileClone}>Create</button>
      </div>
    </div>
  </div>
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
    fields={CHANNEL_BATCH_FIELDS(profiles, playlists)}
    onsave={(out) => {
      batchEditing = false;
      void runChannelBatch('edit', selectedIds, { patch: out.fields });
    }}
    oncancel={() => (batchEditing = false)}
  />
{/if}

{#if settingsModal}
  <ProbeConfigModal
    nodeLabel={settingsModal.nodeLabel}
    initial={settingsModal.initial}
    initialSettings={settingsModal.initialSettings}
    onsave={saveSettings}
    oncancel={() => (settingsModal = null)}
  />
{/if}

{#if sessionModal && sessionModalSession}
  <SessionModal
    instanceId={sessionModal.instanceId}
    nodeId={sessionModal.nodeId}
    session={sessionModalSession}
    serveUrl={sessionModalNode?.serveUrl ?? null}
    onclose={() => (sessionModal = null)}
  />
{/if}
