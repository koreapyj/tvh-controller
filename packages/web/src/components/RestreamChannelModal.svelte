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
    chanKey,
    chanLabel,
    type RestreamChannelWithStatus,
    type RestreamPlaylist,
    type RestreamProfile,
  } from '@tvhc/shared';
  import { api, unavailableDetail, type RestreamChannelPatch } from '../lib/api.js';
  import { lowestNumberFor, parseChannelInput } from '../lib/channelPick.js';
  import { errText } from '../lib/fetchGuard.js';
  import { placementAvailability } from '../lib/placementAvailability.js';
  import {
    buildPlacementsPayload,
    removedPlacementIds,
    seedStagedPlacements,
    type StagedPlacement,
  } from '../lib/placementStaging.js';
  import PlacementEditModal from './PlacementEditModal.svelte';
  import { deriveSlug, placementModeBadge, sessionStateBadge, SLUG_PATTERN } from '../lib/restreamFields.js';
  import { channelOptions, instName, restreamerNodeKey, restreamerNodes } from '../lib/stores.js';

  // Logical restream channel editor. Channel identity follows the controller
  // rules: the number is a STRING pinned alongside the name; blank = null =
  // the LOWEST-numbered channel with that name on each placement's instance.
  // Each placement resolves this identity independently — tvheadend topology
  // first, then (automatically, no separate UI concept) a node's local
  // sources.m3u catalog by the same (name, number) rules.
  //
  // Placements are staged locally (StagedPlacement rows) and applied together
  // with the channel fields in ONE atomic write on Save (POST .../apply for an
  // edit, the `placements` field of POST .../channels for a create) — there is
  // no more live per-placement endpoint hit on every add/reorder/edit.

  let {
    channel = null,
    profiles,
    playlists,
    onclose,
  }: {
    /** null = create */
    channel?: RestreamChannelWithStatus | null;
    profiles: RestreamProfile[];
    playlists: RestreamPlaylist[];
    /** called after the modal is done (page refetches the channel list) */
    onclose: () => void;
  } = $props();

  let channelInput = $state(channel ? channel.channelName : '');
  let numberVal = $state(channel?.channelNumber ?? '');
  let slugVal = $state(channel?.slug ?? '');
  let profileId = $state(channel?.profileId ?? profiles[0]?.id ?? '');
  let comment = $state(channel?.comment ?? '');
  let enabled = $state(channel?.enabled ?? true);
  let selectedPlaylists: string[] = $state(channel ? [...channel.playlistIds] : []);
  let busy = $state(false);
  let formError = $state('');
  /** "save anyway" pre-provisioning consent — sends force: true on writes */
  let forceSave = $state(false);

  let stagedPlacements: StagedPlacement[] = $state(seedStagedPlacements(channel?.placements ?? []));

  // ---------- channel identity ----------

  /** one node's catalog entry not already covered by a tvh (name, chno) pair */
  interface CatalogPick {
    name: string;
    number: string;
    /** datalist option text: chanLabel + a catalog-only marker */
    label: string;
  }

  /**
   * catalog entries merged into the picker, deduped by (name, chno) against
   * both the tvh channel list and each other (several nodes may carry the
   * same entry). Numbers matter now — catalog matching is identity-based —
   * so picking one of these also pins the number (see onChannelInput).
   */
  const catalogOnlyOptions = $derived.by((): CatalogPick[] => {
    const tvhKeys = new Set($channelOptions.map((c) => chanKey(c.name, c.number)));
    const seen = new Set<string>();
    const out: CatalogPick[] = [];
    for (const node of Object.values($restreamerNodes)) {
      for (const e of node.sources ?? []) {
        const key = chanKey(e.name, e.chno);
        if (tvhKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({ name: e.name, number: e.chno, label: `${chanLabel(e.name, e.chno)} (catalog)` });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });

  /** parse the picker input against tvh options first, then catalog-only entries */
  function parsePick(raw: string): { name: string; number: string | null } {
    const catalogHit = catalogOnlyOptions.find((c) => c.label === raw);
    if (catalogHit) return { name: catalogHit.name, number: catalogHit.number };
    return parseChannelInput(raw, $channelOptions);
  }

  const pick = $derived(parsePick(channelInput.trim()));
  /** picking a "N　Name" (or catalog) option from the datalist also fills the number pin */
  function onChannelInput(): void {
    const p = parsePick(channelInput.trim());
    if (p.number !== null) numberVal = p.number;
  }
  const lowest = $derived(pick.name ? lowestNumberFor(pick.name, $channelOptions) : null);
  const knownChannel = $derived($channelOptions.some((c) => c.name === pick.name));

  const effName = $derived(pick.name);
  const slugPreview = $derived(effName ? deriveSlug(effName) : '');

  // ---------- write-time availability (mirrors the controller's 409 rule) ----------
  // Mirrors both resolution paths the controller uses at write time: tvheadend
  // topology (channelOptions) first, then — only on a tvh known-miss — the
  // target node's sources.m3u catalog.

  /** availability of the CURRENT form identity on one placement's node */
  function availability(instanceId: string, nodeId: string): 'ok' | 'unavailable' | 'unknown' {
    const node = $restreamerNodes[restreamerNodeKey({ instanceId, nodeId })];
    return placementAvailability(
      effName,
      numberVal.trim() || null,
      instanceId,
      nodeId,
      $channelOptions,
      node,
    );
  }

  /** 409 `unavailable` payload → per-node reasons (fallback when the badges were stale) */
  function availabilityText(err: unknown): string | null {
    const detail = unavailableDetail(err);
    if (!detail) return null;
    const lines = detail.map((u) => `${$instName(u.instanceId)} / ${u.nodeId}: ${u.reason}`);
    return `${lines.join('; ')} — tick "anyway" below to pre-provision`;
  }

  function togglePlaylist(id: string): void {
    selectedPlaylists = selectedPlaylists.includes(id)
      ? selectedPlaylists.filter((x) => x !== id)
      : [...selectedPlaylists, id];
  }

  // ---------- placements: node options from the restreamer store ----------

  const nodesByInstance = $derived.by(() => {
    const m = new Map<string, string[]>();
    for (const key of Object.keys($restreamerNodes).sort()) {
      const n = $restreamerNodes[key]!;
      m.set(n.instanceId, [...(m.get(n.instanceId) ?? []), n.nodeId]);
    }
    return m;
  });
  const nodeInstanceIds = $derived([...nodesByInstance.keys()]);

  let addInstance = $state('');
  let addNode = $state('');
  let addMode: 'hot' | 'cold' = $state('hot');
  $effect(() => {
    if (!addInstance && nodeInstanceIds.length) addInstance = nodeInstanceIds[0]!;
  });
  $effect(() => {
    const nodes = nodesByInstance.get(addInstance) ?? [];
    if (!nodes.includes(addNode)) addNode = nodes[0] ?? '';
  });

  const existingPlacementKeys = $derived(
    new Set(stagedPlacements.map((p) => `${p.instanceId}/${p.nodeId}`)),
  );
  const addDisabled = $derived(
    busy || !addNode || existingPlacementKeys.has(`${addInstance}/${addNode}`),
  );

  /** any staged row's target node KNOWN unable to serve the form's identity → offer force */
  const anyUnavailable = $derived(
    stagedPlacements.some((p) => availability(p.instanceId, p.nodeId) === 'unavailable'),
  );

  function addPlacement(): void {
    stagedPlacements = [
      ...stagedPlacements,
      { instanceId: addInstance, nodeId: addNode, mode: addMode, programNumber: '', profileId: '', enabled: true },
    ];
  }

  /** priority reorder: swap with the neighbor */
  function move(index: number, delta: -1 | 1): void {
    const other = index + delta;
    if (other < 0 || other >= stagedPlacements.length) return;
    const next = [...stagedPlacements];
    [next[index], next[other]] = [next[other]!, next[index]!];
    stagedPlacements = next;
  }

  function removePlacement(index: number): void {
    stagedPlacements = stagedPlacements.filter((_, i) => i !== index);
  }

  /** the live (session/blockedReason/resolvedVia) record for a staged row that already has an id */
  function liveFor(p: StagedPlacement): RestreamChannelWithStatus['placements'][number] | null {
    if (p.id === undefined || !channel) return null;
    return channel.placements.find((x) => x.id === p.id) ?? null;
  }

  /** per-placement profile-override editor (program # + profile), stacked on top of this modal */
  let placementEdit: { index: number } | null = $state(null);

  /** profile name for a per-placement override id (falls back to the raw id if unknown) */
  function profileName(id: string): string {
    return profiles.find((p) => p.id === id)?.name ?? id;
  }

  // ---------- save ----------

  async function save(): Promise<void> {
    formError = '';
    const name = effName;
    if (!name) {
      formError = 'channel is required — pick one from the list';
      return;
    }
    if (!profileId) {
      formError = 'profile is required — create one in the Profiles section first';
      return;
    }
    const slug = slugVal.trim();
    if (slug && !SLUG_PATTERN.test(slug)) {
      formError = 'slug must be lowercase alphanumerics and dashes, starting alphanumeric (max 64)';
      return;
    }
    const built = buildPlacementsPayload($state.snapshot(stagedPlacements));
    if (!built.ok) {
      formError = built.error;
      return;
    }

    if (channel) {
      const removed = removedPlacementIds(channel.placements, stagedPlacements);
      if (removed.length) {
        const labels = removed.map((id) => {
          const orig = channel!.placements.find((p) => p.id === id);
          return orig ? `${$instName(orig.instanceId)} / ${orig.nodeId}` : id;
        });
        if (
          !confirm(
            `Remove ${removed.length} placement${removed.length === 1 ? '' : 's'} (${labels.join(', ')})? ` +
              'Those nodes stop encoding this channel.',
          )
        ) {
          return;
        }
      }
    }

    busy = true;
    try {
      if (channel) {
        const patch: RestreamChannelPatch = {};
        if (name !== channel.channelName || (numberVal.trim() || null) !== channel.channelNumber) {
          // name+number always travel as a pair: a name-only patch would NULL
          // the pin server-side (string identity rules)
          patch.channelName = name;
          patch.channelNumber = numberVal.trim() || null;
        }
        if (slug && slug !== channel.slug) patch.slug = slug;
        if (profileId !== channel.profileId) patch.profileId = profileId;
        if (enabled !== channel.enabled) patch.enabled = enabled;
        if ((comment.trim() || null) !== channel.comment) patch.comment = comment.trim() || null;
        const oldPl = [...channel.playlistIds].sort().join(',');
        const newPl = [...selectedPlaylists].sort().join(',');
        if (oldPl !== newPl) patch.playlistIds = [...selectedPlaylists];
        await api.applyRestreamChannel(channel.id, {
          ...(Object.keys(patch).length ? { channel: patch } : {}),
          placements: built.placements,
          ...(forceSave ? { force: true } : {}),
        });
      } else {
        await api.createRestreamChannel({
          channelName: name,
          channelNumber: numberVal.trim() || null,
          profileId,
          ...(slug ? { slug } : {}),
          enabled,
          comment: comment.trim() || null,
          playlistIds: [...selectedPlaylists],
          placements: built.placements,
          ...(forceSave ? { force: true } : {}),
        });
      }
      onclose();
    } catch (err) {
      formError = availabilityText(err) ?? errText(err);
    } finally {
      busy = false;
    }
  }
</script>

<!-- when the placement edit modal is stacked on top, Escape belongs to it -->
<svelte:window onkeydown={(e) => e.key === 'Escape' && !placementEdit && onclose()} />

<!-- write-time availability of the form's identity on one placement's node -->
{#snippet availBadge(instanceId: string, nodeId: string)}
  {@const a = availability(instanceId, nodeId)}
  {#if a === 'ok'}
    <span class="badge ok" title="available on this node">ok</span>
  {:else if a === 'unavailable'}
    <span class="badge warn" title="not available on this node — saving without force is rejected">unavailable</span>
  {:else}
    <span class="badge neutral" title="availability unknown — topology/catalog not loaded yet">?</span>
  {/if}
{/snippet}

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label={channel ? `Edit ${channel.slug}` : 'New restream channel'}
  >
    <h2 style="margin-top:0">
      {channel ? `Edit restream channel: ${channel.slug}` : 'New restream channel'}
    </h2>
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <label for="rc-channel" style="margin:0;width:150px;flex:none;padding-top:6px">Channel</label>
        <div style="flex:1">
          <input
            id="rc-channel"
            style="width:100%"
            bind:value={channelInput}
            oninput={onChannelInput}
            list="rc-channel-options"
            placeholder="channel name"
          />
          <datalist id="rc-channel-options">
            {#each $channelOptions as c (chanKey(c.name, c.number))}
              <option value={chanLabel(c.name, c.number)}></option>
            {/each}
            {#each catalogOnlyOptions as c (chanKey(c.name, c.number))}
              <option value={c.label}></option>
            {/each}
          </datalist>
          {#if pick.name && !knownChannel}
            <div class="small" style="color:var(--warn)">
              channel "{pick.name}" is not on any tvheadend instance right now — it may still resolve
              via a node's sources.m3u catalog, or placements stay blocked until it appears
            </div>
          {/if}
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <label for="rc-number" style="margin:0;width:150px;flex:none">Number pin</label>
        <input id="rc-number" style="width:110px;flex:none" bind:value={numberVal} placeholder="(lowest)" />
        <span class="muted small">
          exact string match ("9.1" ≠ "9.10"); blank = the lowest-numbered "{pick.name || '…'}"
          on each instance{#if numberVal.trim() === '' && lowest !== null}&nbsp;(currently {lowest}){/if}
        </span>
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <label for="rc-slug" style="margin:0;width:150px;flex:none">Slug</label>
        <input id="rc-slug" style="width:220px;flex:none" bind:value={slugVal} placeholder={slugPreview || 'derived from name'} />
        <span class="muted small">output dir on every node + public URL segment{#if !slugVal.trim() && slugPreview}&nbsp;— will be "{slugPreview}"{/if}</span>
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <label for="rc-profile" style="margin:0;width:150px;flex:none">Profile</label>
        <select id="rc-profile" style="width:auto" bind:value={profileId}>
          {#each profiles as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <label for="rc-enabled" style="margin:0;width:150px;flex:none">Enabled</label>
        <input id="rc-enabled" type="checkbox" bind:checked={enabled} />
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <label for="rc-comment" style="margin:0;width:150px;flex:none">Comment</label>
        <input id="rc-comment" style="flex:1" bind:value={comment} />
      </div>

      <div style="display:flex;gap:10px;align-items:flex-start">
        <span class="small muted" style="width:150px;flex:none">Playlists</span>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          {#each playlists as pl (pl.id)}
            <label style="display:flex;gap:6px;align-items:center;margin:0">
              <input
                type="checkbox"
                checked={selectedPlaylists.includes(pl.id)}
                onchange={() => togglePlaylist(pl.id)}
              />
              {pl.title}
            </label>
          {:else}
            <span class="muted small">no playlists yet</span>
          {/each}
        </div>
      </div>

      <div class="muted small" style="margin-top:8px;text-transform:uppercase;font-size:11px">
        Placements (failover order — every enabled placement encodes hot-hot)
      </div>
      <table>
        <thead>
          <tr>
            <th style="width:60px">Priority</th>
            <th>Node</th>
            <th>Mode</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each stagedPlacements as p, i (p.id ?? `${p.instanceId}/${p.nodeId}`)}
            {@const live = liveFor(p)}
            <tr>
              <td style="white-space:nowrap">
                <button class="expander" disabled={i === 0} title="higher priority" onclick={() => move(i, -1)}>▲</button>
                <button class="expander" disabled={i === stagedPlacements.length - 1} title="lower priority" onclick={() => move(i, 1)}>▼</button>
                {i + 1}
              </td>
              <td class="small">
                {$instName(p.instanceId)} / {p.nodeId}
                {@render availBadge(p.instanceId, p.nodeId)}
                {#if live?.session}<span class="badge {sessionStateBadge(live.session.state)}">{live.session.state}</span>{/if}
                {#if live?.blockedReason}<span class="badge warn" title={live.blockedReason}>blocked</span>{/if}
                {#if live?.resolvedVia}<span class="badge neutral" title="channel identity resolved via {live.resolvedVia}">{live.resolvedVia}</span>{/if}
                {#if placementModeBadge(p)}
                  {@const modeBadge = placementModeBadge(p)!}
                  <span class="badge {modeBadge.cls}">{modeBadge.label}</span>
                {/if}
                {#if p.programNumber}<span class="muted">prog {p.programNumber}</span>{/if}
                {#if p.profileId}<span class="muted">{profileName(p.profileId)}</span>{/if}
              </td>
              <td>
                <select style="width:auto" bind:value={p.mode} aria-label="mode">
                  <option value="hot">hot</option>
                  <option value="cold">cold</option>
                </select>
              </td>
              <td><input type="checkbox" bind:checked={p.enabled} /></td>
              <td style="text-align:right;white-space:nowrap">
                <button onclick={() => (placementEdit = { index: i })}>Edit</button>
                <button class="danger" onclick={() => removePlacement(i)}>Remove</button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="5" class="muted">No placements yet — add a node below.</td></tr>
          {/each}
        </tbody>
      </table>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select style="width:auto" bind:value={addInstance} aria-label="instance">
          {#each nodeInstanceIds as id (id)}
            <option value={id}>{$instName(id)}</option>
          {/each}
        </select>
        <select style="width:auto" bind:value={addNode} aria-label="node">
          {#each nodesByInstance.get(addInstance) ?? [] as n (n)}
            <option value={n}>{n}</option>
          {/each}
        </select>
        <select style="width:auto" bind:value={addMode} aria-label="mode">
          <option value="hot">hot</option>
          <option value="cold">cold</option>
        </select>
        <button disabled={addDisabled} onclick={addPlacement}>Add placement</button>
        {#if !nodeInstanceIds.length}
          <span class="muted small">no restreamer nodes configured</span>
        {/if}
      </div>
      <div class="muted small">
        Placement changes are staged locally and applied together with the channel when you Save.
      </div>

      {#if anyUnavailable}
        <label style="display:flex;gap:6px;align-items:center;margin:0" title="force: true — the write is accepted and the placement stays blocked until the channel/catalog entry appears">
          <input type="checkbox" bind:checked={forceSave} />
          <span class="small" style="color:var(--warn)">
            {channel ? 'Save' : 'Create'} anyway (pre-provisioning — some nodes cannot serve this right now)
          </span>
        </label>
      {/if}
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button onclick={onclose}>{channel ? 'Close' : 'Cancel'}</button>
      <button class="primary" onclick={save} disabled={busy || !effName}>
        {channel ? 'Save' : 'Create'}
      </button>
    </div>
  </div>
</div>

{#if placementEdit}
  {@const editIndex = placementEdit.index}
  {@const editTarget = stagedPlacements[editIndex]!}
  <PlacementEditModal
    placement={editTarget}
    {profiles}
    title={`Edit placement: ${$instName(editTarget.instanceId)}/${editTarget.nodeId}`}
    onsave={(patch) => {
      stagedPlacements[editIndex]!.programNumber = patch.programNumber;
      stagedPlacements[editIndex]!.profileId = patch.profileId;
      placementEdit = null;
    }}
    oncancel={() => (placementEdit = null)}
  />
{/if}
