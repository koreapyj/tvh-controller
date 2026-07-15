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
  import { onMount, untrack } from 'svelte';
  import type { EventLogEntry } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { dateTime } from '../lib/format.js';
  import { parseListParam } from '../lib/query.js';
  import { eventLogTick } from '../lib/stores.js';
  import { route } from '../lib/router.js';
  import { notify } from '../lib/notifications.js';
  import MultiSelectDropdown from '../components/MultiSelectDropdown.svelte';

  const PAGE = 200;

  let items: EventLogEntry[] = $state([]);
  let total = $state(0);
  let offset = $state(0);
  let loadingMore = $state(false);

  // ---------- filters (server-side; facet lists are NOT derived from loaded rows) ----------

  let filterServices: string[] = $state([]);
  let filterSources: string[] = $state([]);
  let filterType: '' | 'normal' | 'warning' = $state('');

  let facetServices: string[] = $state([]);
  let facetSources: string[] = $state([]);

  const serviceOptions = $derived(facetServices.map((s) => ({ value: s, label: s })));
  const sourceOptions = $derived(facetSources.map((s) => ({ value: s, label: s })));

  onMount(() => {
    void api
      .eventLogFacets()
      .then((f) => {
        facetServices = f.services;
        facetSources = f.sources;
      })
      .catch(() => {});
  });

  // ---------- sorting ----------

  type SortKey = 'time' | 'service' | 'source' | 'type';
  let sortKey: SortKey = $state('time');
  let sortDir: 1 | -1 = $state(-1);

  /** same 3-state cycle as Rules' clickSort, but the "reset" state here is
   *  time/desc (the default view) rather than an unsorted state */
  function clickSort(key: SortKey): void {
    if (sortKey !== key) {
      sortKey = key;
      sortDir = 1;
    } else if (sortDir === 1) {
      sortDir = -1;
    } else {
      sortKey = 'time';
      sortDir = -1;
    }
    void refetch();
  }

  function arrow(key: SortKey): string {
    return sortKey === key ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
  }

  const atDefaultView = (): boolean => sortKey === 'time' && sortDir === -1 && offset <= PAGE;

  // ---------- fetching ----------

  // latest-wins guard: bumped per fetch so a stale response can detect it's been superseded and bail out.
  let fetchSeq = 0;

  function listParams(off: number) {
    return {
      service: filterServices,
      source: filterSources,
      type: filterType === '' ? undefined : filterType,
      sort: sortKey,
      dir: sortDir === 1 ? 'asc' : 'desc',
      offset: off,
      limit: PAGE,
    };
  }

  async function refetch(): Promise<void> {
    const seq = ++fetchSeq;
    try {
      const res = await api.eventLog(listParams(0));
      if (seq !== fetchSeq) return; // a newer refetch superseded this one
      items = res.items;
      total = res.total;
      offset = items.length;
      notify.dismiss('events-load');
    } catch (err) {
      if (seq !== fetchSeq) return;
      notify.error(err instanceof Error ? err.message : String(err), { key: 'events-load' });
    }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || items.length >= total) return;
    loadingMore = true;
    // don't increment fetchSeq: loading an older page doesn't invalidate anything, but a
    // newer refetch started while we were awaiting must still win over this page
    const seq = fetchSeq;
    try {
      const res = await api.eventLog(listParams(offset));
      if (seq !== fetchSeq) return;
      // live SSE-driven inserts can shift server-side offsets between pages, so the next
      // page may re-fetch rows already rendered; drop duplicates before appending to avoid
      // a duplicate key crash in the keyed {#each}
      const existingIds = new Set(items.map((i) => i.id));
      const fresh = res.items.filter((i) => !existingIds.has(i.id));
      items = [...items, ...fresh];
      total = res.total;
      offset += res.items.length; // raw fetched count: offset tracks the server-side window
      notify.dismiss('events-load');
    } catch (err) {
      if (seq !== fetchSeq) return;
      notify.error(err instanceof Error ? err.message : String(err), { key: 'events-load' });
    } finally {
      loadingMore = false;
    }
  }

  function setFilterType(t: '' | 'normal' | 'warning'): void {
    filterType = t;
    void refetch();
  }

  function clearFilters(): void {
    filterServices = [];
    filterSources = [];
    filterType = '';
    void refetch();
  }

  // ---------- URL persistence (mirrors Rules.svelte's rulesUrl()/filter effects) ----------

  function eventsUrl(
    over: { service?: string[]; source?: string[]; type?: '' | 'normal' | 'warning' } = {},
  ): string {
    const service = over.service !== undefined ? over.service : filterServices;
    const source = over.source !== undefined ? over.source : filterSources;
    const type = over.type !== undefined ? over.type : filterType;
    const q = new URLSearchParams();
    if (service.length) q.set('service', JSON.stringify(service));
    if (source.length) q.set('source', JSON.stringify(source));
    if (type) q.set('type', type);
    if (sortKey !== 'time' || sortDir !== -1) {
      q.set('sort', sortKey);
      q.set('dir', sortDir === 1 ? 'asc' : 'desc');
    }
    const qs = q.toString();
    return `/events${qs ? `?${qs}` : ''}`;
  }

  // restore filters/sort from the URL on (re)navigation, then reload with them applied.
  // untrack: refetch() synchronously reads filterServices/filterSources/filterType/sortKey/
  // sortDir, which this effect also writes — tracking them would make the effect invalidate
  // itself (same rationale as EPG.svelte's URL-restore effect).
  $effect(() => {
    const q = new URLSearchParams($route.search);
    filterServices = parseListParam(q.get('service'));
    filterSources = parseListParam(q.get('source'));
    const t = q.get('type');
    filterType = t === 'normal' || t === 'warning' ? t : '';
    const s = q.get('sort');
    sortKey = s === 'service' || s === 'source' || s === 'type' ? s : 'time';
    sortDir = q.get('dir') === 'asc' ? 1 : -1;
    untrack(() => void refetch());
  });

  // mirror the active filters/sort into the URL so they survive reload / are shareable
  $effect(() => {
    window.history.replaceState({}, '', eventsUrl());
  });

  // live refresh: a new row landed via SSE — only pull it in when the user is looking at
  // the default view (time desc, first page), so it never yanks someone reading older pages.
  // untrack + a first-run skip: the URL-restore effect above already does the initial load.
  let firstTick = true;
  $effect(() => {
    void $eventLogTick;
    if (firstTick) {
      firstTick = false;
      return;
    }
    untrack(() => {
      if (!loadingMore && atDefaultView()) void refetch();
    });
  });

  function typeBadge(t: EventLogEntry['type']): string {
    return t === 'warning' ? 'warn' : 'ok';
  }
  function typeLabel(t: EventLogEntry['type']): string {
    return t === 'warning' ? 'Warning' : 'Normal';
  }
</script>

<h1>Events</h1>

<div class="toolbar">
  <span style="display:flex;gap:6px;align-items:center">
    <span style="margin:0">Service</span>
    <MultiSelectDropdown
      options={serviceOptions}
      selected={filterServices}
      onchange={(next) => {
        filterServices = next;
        void refetch();
      }}
      allLabel="All services"
      unit="services"
      searchPlaceholder="Search service…"
    />
  </span>
  <span style="display:flex;gap:6px;align-items:center">
    <span style="margin:0">Source</span>
    <MultiSelectDropdown
      options={sourceOptions}
      selected={filterSources}
      onchange={(next) => {
        filterSources = next;
        void refetch();
      }}
      allLabel="All sources"
      unit="sources"
      searchPlaceholder="Search source…"
    />
  </span>
  <label for="ev-type" style="margin:0">Type</label>
  <select
    id="ev-type"
    style="width:auto"
    value={filterType}
    onchange={(e) => setFilterType(e.currentTarget.value as '' | 'normal' | 'warning')}
  >
    <option value="">All</option>
    <option value="normal">Normal</option>
    <option value="warning">Warning</option>
  </select>
  {#if filterServices.length || filterSources.length || filterType}
    <button onclick={clearFilters}>Clear</button>
  {/if}
  <span class="spacer"></span>
  <span class="muted small">{items.length} of {total} events</span>
</div>

<table class="m-cards">
  <thead>
    <tr>
      <th class="sortable" onclick={() => clickSort('time')}>Time{arrow('time')}</th>
      <th class="sortable" onclick={() => clickSort('type')}>Type{arrow('type')}</th>
      <th class="sortable" onclick={() => clickSort('service')}>Service{arrow('service')}</th>
      <th class="sortable" onclick={() => clickSort('source')}>Source{arrow('source')}</th>
      <th>Message</th>
    </tr>
  </thead>
  <tbody>
    {#each items as e (e.id)}
      <tr class="m-card">
        <td class="small muted m-inline">{dateTime(e.createdAt)}</td>
        <td class="m-inline">
          <span class="badge {typeBadge(e.type)}">{typeLabel(e.type)}</span>
        </td>
        <td class="small m-inline">
          <span class="m-only">service</span>
          <a class="linklike" title="filter by this service" href={eventsUrl({ service: [e.service] })}>
            {e.service}
          </a>
        </td>
        <td class="small m-inline">
          <span class="m-only">source</span>
          <a class="linklike" title="filter by this source" href={eventsUrl({ source: [e.source] })}>
            {e.source}
          </a>
        </td>
        <td class="small" style="white-space:pre-wrap;word-break:break-word">{e.message}</td>
      </tr>
    {:else}
      <tr><td colspan="5" class="muted">No events.</td></tr>
    {/each}
  </tbody>
</table>

{#if items.length < total}
  <div style="margin-top:10px">
    <button disabled={loadingMore} onclick={loadMore}>{loadingMore ? 'Loading…' : 'Load older'}</button>
  </div>
{/if}
