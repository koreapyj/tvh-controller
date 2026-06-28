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
  import type { EpgChannel, MasterRulePayload, TvhEpgEvent, UnifiedEpgEvent } from '@tvhc/shared';
  import { api, type RuleInput } from '../lib/api.js';
  import { duration, ts } from '../lib/format.js';
  import { epgTick, instances } from '../lib/stores.js';
  import RuleEditor from './RuleEditor.svelte';
  import MultiSelectDropdown from '../components/MultiSelectDropdown.svelte';

  /** channel identity used for filtering — must match the server's chanKey() */
  const chanKey = (c: EpgChannel) => `${c.name} ${c.number ?? ''}`;

  // virtual scroll (tvheadend livegrid style): full-height scrollbar, only a
  // window of rows in the DOM, pages fetched on demand as they scroll into view
  const ROW_H = 34;
  const BUFFER = 8;
  const PAGE = 200;

  let total = $state(0);
  let rows: (UnifiedEpgEvent | null)[] = $state([]);
  let loaded = new Set<number>(); // loaded page indices
  let token = 0; // invalidates in-flight fetches on reset
  let error = $state('');
  let notice = $state('');

  let channels: EpgChannel[] = $state([]);
  let channelFilter: string[] = $state([]); // selected chanKey() strings
  let titleFilter = $state('');
  let titleTimer: ReturnType<typeof setTimeout> | undefined;
  let jumpAt = $state(''); // datetime-local value for "jump to time"

  let viewport: HTMLElement | undefined = $state();
  let viewportH = $state(0);
  let scrollTop = $state(0);

  let viewing: UnifiedEpgEvent | null = $state(null);
  let details: TvhEpgEvent | null = $state(null);
  let busy = $state(false);
  let autorecInit: { name: string; channel: string } | null = $state(null);

  // record modal: pick one or more instances for (redundant) recording
  let recordingFor: UnifiedEpgEvent | null = $state(null);
  let recordInstances: string[] = $state([]);

  const firstIndex = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER));
  const lastIndex = $derived(
    Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + BUFFER),
  );
  const visible = $derived(
    Array.from({ length: Math.max(0, lastIndex - firstIndex) }, (_, k) => firstIndex + k),
  );

  const channelOptions = $derived(
    channels.map((ch) => ({
      value: chanKey(ch),
      label: `${ch.number ? `${ch.number} · ` : ''}${ch.name}`,
      search: `${ch.name} ${ch.number ?? ''}`,
    })),
  );

  function params(offset: number) {
    return { channels: channelFilter, q: titleFilter || undefined, offset, limit: PAGE };
  }

  async function fetchPage(p: number): Promise<void> {
    const my = token;
    try {
      const res = await api.epg(params(p * PAGE));
      if (my !== token) return;
      if (res.total !== total) {
        total = res.total;
        const next = rows.slice();
        next.length = total;
        rows = next;
      }
      const next = rows.slice();
      res.items.forEach((it, i) => (next[p * PAGE + i] = it));
      rows = next;
      error = '';
    } catch (err) {
      loaded.delete(p); // allow a retry on the next scroll tick
      if (my === token) error = err instanceof Error ? err.message : String(err);
    }
  }

  function ensureLoaded(start: number, end: number): void {
    if (end <= start) {
      if (!loaded.has(0)) {
        loaded.add(0);
        void fetchPage(0);
      }
      return;
    }
    for (let p = Math.floor(start / PAGE); p <= Math.floor((end - 1) / PAGE); p++) {
      if (!loaded.has(p)) {
        loaded.add(p);
        void fetchPage(p);
      }
    }
  }

  $effect(() => {
    ensureLoaded(firstIndex, lastIndex);
  });

  /** filter change / first load: clear everything and reload from the top */
  function reset(): void {
    token++;
    loaded = new Set();
    rows = [];
    total = 0;
    scrollTop = 0;
    viewport?.scrollTo(0, 0);
    ensureLoaded(0, 0);
  }

  /** epg push: refetch the loaded pages in place (keep scroll position) */
  function refreshInPlace(): void {
    token++;
    loaded = new Set();
    ensureLoaded(firstIndex, lastIndex);
  }

  function onTitleInput(): void {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(reset, 300);
  }

  /** format a Date as a datetime-local input value (local time, minute precision) */
  function toLocalInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** scroll so the first programme starting at/after the picked time is at the top */
  async function jumpToTime(): Promise<void> {
    if (!jumpAt) return;
    const at = Math.floor(new Date(jumpAt).getTime() / 1000);
    if (!Number.isFinite(at)) return;
    try {
      const res = await api.epgIndex({ channels: channelFilter, q: titleFilter || undefined, at });
      if (!res.total) return;
      const idx = Math.min(Math.max(0, res.index), res.total - 1);
      viewport?.scrollTo(0, idx * ROW_H);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  onMount(() => {
    reset();
    jumpAt = toLocalInput(new Date());
    void api.epgChannels().then((c) => (channels = c)).catch(() => {});
    let first = true;
    const unsub = epgTick.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      refreshInPlace();
      void api.epgChannels().then((c) => (channels = c)).catch(() => {});
    });
    return unsub;
  });

  function endTime(stop: number): string {
    return new Date(stop * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }

  function instName(id: string): string {
    return $instances.find((i) => i.id === id)?.name ?? id;
  }

  function isScheduled(e: UnifiedEpgEvent): boolean {
    return e.copies.some((c) => c.dvrUuid);
  }

  async function openDetails(e: UnifiedEpgEvent): Promise<void> {
    viewing = e;
    details = e.details;
    notice = '';
    const c = e.copies[0];
    if (c) {
      const full = await api.epgEvent(c.instanceId, c.eventId).catch(() => null);
      if (full && viewing === e) details = full;
    }
  }

  /** open the record modal, defaulting to the recommended instance */
  function openRecord(e: UnifiedEpgEvent): void {
    recordingFor = e;
    const rec = e.recommendedInstanceId ?? e.copies[0]?.instanceId;
    recordInstances = rec ? [rec] : [];
    viewing = null;
  }

  function toggleRecordInstance(id: string): void {
    recordInstances = recordInstances.includes(id)
      ? recordInstances.filter((x) => x !== id)
      : [...recordInstances, id];
  }

  /** schedule the broadcast on every checked instance (redundant recording) */
  async function confirmRecord(): Promise<void> {
    if (!recordingFor || !recordInstances.length) return;
    busy = true;
    const done: string[] = [];
    const failed: string[] = [];
    for (const id of recordInstances) {
      const eventId = recordingFor.copies.find((c) => c.instanceId === id)?.eventId;
      if (eventId === undefined) continue;
      try {
        await api.recordEvent(id, eventId);
        done.push(instName(id));
      } catch (err) {
        failed.push(`${instName(id)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    notice = [done.length ? `Scheduled on ${done.join(', ')}.` : '', ...failed].filter(Boolean).join(' ');
    recordingFor = null;
    busy = false;
    refreshInPlace();
  }

  function startAutorec(): void {
    if (!viewing) return;
    autorecInit = { name: viewing.title, channel: viewing.channelName };
    viewing = null;
  }

  async function saveAutorec(out: Omit<RuleInput, 'parentId'>): Promise<void> {
    try {
      await api.createRule(out);
      notice = `Autorec rule "${out.name}" created. Push it from the Autorec Rules page.`;
    } catch (err) {
      notice = err instanceof Error ? err.message : String(err);
    } finally {
      autorecInit = null;
    }
  }

  function autorecPayload(title: string, channel: string): MasterRulePayload {
    return {
      enabled: true, name: '', title, fulltext: false, mergetext: false,
      channel, tag: '', btype: 0, content_type: 0, star_rating: 0,
      start: '', start_window: '', start_extra: 0, stop_extra: 0, weekdays: [],
      minduration: 0, maxduration: 0, minyear: 0, maxyear: 0, minseason: 0,
      maxseason: 0, pri: 6, record: 0, retention: 0, removal: 0, maxcount: 0,
      maxsched: 0, config_name: '', directory: '', comment: '',
    };
  }
</script>

<h1>EPG</h1>
{#if error}<div class="error-banner">{error}</div>{/if}
{#if notice}<div class="card" style="margin-bottom:12px">{notice}</div>{/if}

<div class="toolbar">
  <MultiSelectDropdown
    options={channelOptions}
    selected={channelFilter}
    onchange={(next) => { channelFilter = next; reset(); }}
    allLabel="All channels"
    unit="channels"
    searchPlaceholder="Search number or name…"
  />
  <input placeholder="Filter title…" bind:value={titleFilter} oninput={onTitleInput} />
  <span class="muted small">Jump to</span>
  <input type="datetime-local" style="width:auto" bind:value={jumpAt} aria-label="Jump to date and time" />
  <button onclick={jumpToTime}>Jump</button>
  <span class="spacer"></span>
  <span class="muted small">{total} programmes</span>
</div>

<div
  class="epg-viewport"
  bind:this={viewport}
  bind:clientHeight={viewportH}
  onscroll={() => (scrollTop = viewport?.scrollTop ?? 0)}
>
  <div class="epg-spacer" style="height:{total * ROW_H}px">
    {#each visible as i (i)}
      {@const e = rows[i]}
      <div
        class="epg-row"
        style="top:{i * ROW_H}px"
        role="button"
        tabindex="0"
        onclick={() => e && openDetails(e)}
        onkeydown={(ev) => e && (ev.key === 'Enter' || ev.key === ' ') && openDetails(e)}
      >
        {#if e}
          <span class="epg-ch muted small">{#if e.channelNumber}{e.channelNumber} · {/if}{e.channelName}</span>
          <span class="epg-time muted small">{ts(e.start)}–{endTime(e.stop)}</span>
          <span class="epg-title">{e.title}{#if e.subtitle}<span class="muted small"> · {e.subtitle}</span>{/if}</span>
          {#if isScheduled(e)}<span class="badge info">scheduled</span>{/if}
        {:else}
          <span class="muted small">…</span>
        {/if}
      </div>
    {/each}
  </div>
</div>
{#if total === 0}<div class="muted" style="padding:10px">No programmes.</div>{/if}

{#if viewing && details}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && (viewing = null)}
  >
    <div class="modal">
      <h2>{details.title ?? viewing.title}</h2>
      {#if details.subtitle}<div class="muted">{details.subtitle}</div>{/if}

      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
        {#if details.hd}<span class="badge info">HD</span>{/if}
        {#if details.widescreen}<span class="badge neutral">16:9</span>{/if}
        {#if details.new}<span class="badge ok">new</span>{/if}
        {#if details.repeat}<span class="badge neutral">repeat</span>{/if}
        {#if details.subtitled}<span class="badge neutral">subtitled</span>{/if}
        {#if details.audiodesc}<span class="badge neutral">audio desc</span>{/if}
      </div>

      <table>
        <tbody>
          <tr><td class="muted small">Channel</td><td>{viewing.channelNumber ? `${viewing.channelNumber} · ` : ''}{viewing.channelName}</td></tr>
          <tr><td class="muted small">Time</td><td>{ts(viewing.start)}–{endTime(viewing.stop)} · {duration(viewing.start, viewing.stop)}</td></tr>
          {#if details.episodeOnscreen}<tr><td class="muted small">Episode</td><td>{details.episodeOnscreen}</td></tr>{/if}
          {#if details.starRating}<tr><td class="muted small">Rating</td><td>{details.starRating}/4</td></tr>{/if}
          {#if details.ageRating}<tr><td class="muted small">Age</td><td>{details.ageRating}+</td></tr>{/if}
          {#if details.first_aired}<tr><td class="muted small">First aired</td><td>{ts(details.first_aired)}</td></tr>{/if}
          <tr>
            <td class="muted small">Carried by</td>
            <td>
              {#each viewing.copies as c (c.instanceId)}
                <span class="badge neutral" title={c.dvrState ?? ''}>
                  {instName(c.instanceId)}{#if c.dvrState} · {c.dvrState}{/if}
                </span>
              {/each}
            </td>
          </tr>
        </tbody>
      </table>

      {#if details.summary}<p style="margin:10px 0 0;white-space:pre-wrap">{details.summary}</p>{/if}
      {#if details.description && details.description !== details.summary}
        <p style="margin:10px 0 0;white-space:pre-wrap">{details.description}</p>
      {/if}

      <div style="display:flex;gap:8px;align-items:center;margin-top:16px;flex-wrap:wrap">
        <span class="spacer"></span>
        <button onclick={() => (viewing = null)}>Close</button>
        <button onclick={startAutorec}>Create autorec…</button>
        <button class="primary" onclick={() => viewing && openRecord(viewing)}>
          {isScheduled(viewing) ? 'Record again…' : 'Record…'}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if recordingFor}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && (recordingFor = null)}
  >
    <div class="modal">
      <h2>Record "{recordingFor.title}"</h2>
      <div class="muted small">{recordingFor.channelName} · {ts(recordingFor.start)}–{endTime(recordingFor.stop)}</div>
      <p class="muted small">Select instances — check more than one for a redundant recording.</p>
      <div style="display:flex;flex-direction:column;gap:6px">
        {#each recordingFor.copies as c (c.instanceId)}
          <label style="display:flex;align-items:center;gap:8px;margin:0;font-size:14px;color:var(--text)">
            <input
              type="checkbox"
              checked={recordInstances.includes(c.instanceId)}
              onchange={() => toggleRecordInstance(c.instanceId)}
            />
            {instName(c.instanceId)}
            {#if c.instanceId === recordingFor.recommendedInstanceId}
              <span class="badge ok" title="Reachable instance with a free tuner during this broadcast (uses the same conflict check as the Conflicts page)">recommended</span>
            {/if}
            {#if c.dvrState}<span class="badge info">already {c.dvrState}</span>{/if}
          </label>
        {/each}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button onclick={() => (recordingFor = null)}>Cancel</button>
        <button class="primary" disabled={busy || !recordInstances.length} onclick={confirmRecord}>
          Record on {recordInstances.length || 0}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if autorecInit}
  <div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && (autorecInit = null)}>
    <div class="modal">
      <h2>New autorec rule</h2>
      <RuleEditor
        initialName={autorecInit.name}
        initialInstances="all"
        initialPayload={autorecPayload(autorecInit.name, autorecInit.channel)}
        onsave={saveAutorec}
        oncancel={() => (autorecInit = null)}
      />
    </div>
  </div>
{/if}

<style>
  .epg-viewport {
    height: calc(100vh - 170px);
    min-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .epg-spacer {
    position: relative;
  }
  .epg-row {
    position: absolute;
    left: 0;
    right: 0;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .epg-row:hover {
    background: var(--panel2);
  }
  .epg-ch {
    flex: 0 0 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .epg-time {
    flex: 0 0 110px;
  }
  .epg-title {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
