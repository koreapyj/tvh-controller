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
  import type { UnifiedCopy, UnifiedGroup, UnifiedItem } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { bytes, duration, ts } from '../lib/format.js';
  import { route } from '../lib/router.js';
  import { instances, recordingsTick } from '../lib/stores.js';
  import BatchEditModal from '../components/BatchEditModal.svelte';
  import { RECORDING_FIELDS } from '../components/batchFields.js';

  let tab: 'upcoming' | 'finished' | 'failed' = $state('upcoming');
  let groups: UnifiedGroup[] = $state([]);
  let error = $state('');
  let busy = $state(false);
  let notice = $state('');

  type SortKey = 'rule' | 'title' | 'channel' | 'time' | 'duration' | 'instance';
  let sortKey: SortKey = $state('time');
  let sortDir: 1 | -1 = $state(1);

  function setTab(t: typeof tab): void {
    tab = t;
    sortKey = 'time';
    sortDir = t === 'upcoming' ? 1 : -1; // past tabs newest-first
    selected = {};
    menuFor = null;
  }

  function clickSort(key: SortKey): void {
    if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
    else {
      sortKey = key;
      sortDir = 1;
    }
  }

  function arrow(key: SortKey): string {
    return sortKey === key ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
  }

  interface Row {
    rule: string;
    ruleComment: string;
    item: UnifiedItem;
  }

  // ---------- filters (exact match; deep-linkable via query string) ----------

  let filterRule: string | null = $state(null);
  let filterChannel: string | null = $state(null);
  let filterDate: string | null = $state(null);

  // (re)apply filters from the query string on every NAVIGATION — including
  // re-clicking the sidebar link (go('/recordings') with no query resets them)
  $effect(() => {
    const q = new URLSearchParams($route.search);
    filterRule = q.get('rule');
    filterChannel = q.get('channel');
    filterDate = q.get('date');
  });

  // keep the URL shareable without triggering navigation
  $effect(() => {
    const q = new URLSearchParams();
    if (filterRule !== null) q.set('rule', filterRule);
    if (filterChannel !== null) q.set('channel', filterChannel);
    if (filterDate !== null) q.set('date', filterDate);
    const qs = q.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  });

  /** local date (YYYY-MM-DD) of a recording's programme start */
  function dateOf(start: number): string {
    const d = new Date(start * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const allRows: Row[] = $derived(
    groups.flatMap((g) =>
      g.items.map((item) => ({ rule: g.label, ruleComment: g.comment, item })),
    ),
  );
  const ruleFilterOptions = $derived([...new Set(allRows.map((r) => r.rule))].sort());
  const channelFilterOptions = $derived(
    [...new Set(allRows.map((r) => r.item.channelname).filter(Boolean))].sort(),
  );
  const dateFilterOptions = $derived(
    [...new Set(allRows.map((r) => dateOf(r.item.start)))].sort().reverse(),
  );

  function clearFilters(): void {
    filterRule = null;
    filterChannel = null;
    filterDate = null;
  }

  const rows: Row[] = $derived.by(() => {
    const flat = allRows.filter(
      (r) =>
        (filterRule === null || r.rule === filterRule) &&
        (filterChannel === null || r.item.channelname === filterChannel) &&
        (filterDate === null || dateOf(r.item.start) === filterDate),
    );
    const cmp = (a: Row, b: Row): number => {
      switch (sortKey) {
        case 'rule':
          return a.rule.localeCompare(b.rule);
        case 'title':
          return a.item.title.localeCompare(b.item.title);
        case 'channel':
          return a.item.channelname.localeCompare(b.item.channelname);
        case 'duration':
          return (a.item.stop - a.item.start) - (b.item.stop - b.item.start);
        case 'instance':
          return (a.item.copies[0]?.instanceId ?? '').localeCompare(b.item.copies[0]?.instanceId ?? '');
        default:
          return a.item.start - b.item.start;
      }
    };
    return flat.sort((a, b) => cmp(a, b) * sortDir || a.item.start - b.item.start);
  });

  async function refresh(): Promise<void> {
    try {
      groups = await api.unifiedRecordings(tab);
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  $effect(() => {
    void tab;
    void $recordingsTick;
    void refresh();
  });

  function copyFor(item: { copies: UnifiedCopy[] }, instanceId: string): UnifiedCopy | null {
    return item.copies.find((c) => c.instanceId === instanceId) ?? null;
  }

  /**
   * best copy to archive: fewest stream errors, then fewest data errors,
   * then largest file; ties keep instance config order
   */
  function bestCopy(item: { copies: UnifiedCopy[] }): UnifiedCopy | null {
    return (
      [...item.copies].sort(
        (a, b) =>
          a.errors - b.errors ||
          a.dataErrors - b.dataErrors ||
          (b.filesize ?? 0) - (a.filesize ?? 0),
      )[0] ?? null
    );
  }

  function qualityTag(c: UnifiedCopy): string {
    return c.errors === 0 && c.dataErrors === 0 ? 'clean' : `${c.errors}·${c.dataErrors} err`;
  }

  let expanded: Record<string, boolean> = $state({});
  function rowKey(item: UnifiedItem): string {
    // failed rows are per-instance (unmerged) — the instance disambiguates
    return item.channelname + item.start + item.title + (tab === 'failed' ? (item.copies[0]?.instanceId ?? '') : '');
  }
  function toggle(key: string): void {
    expanded = { ...expanded, [key]: !expanded[key] };
  }

  /** errors apply once a file exists: while recording, finished, or failed */
  function hasErrorInfo(c: UnifiedCopy): boolean {
    return tab !== 'upcoming' || c.schedStatus === 'recording';
  }

  function errClass(c: UnifiedCopy): string {
    if (c.errors > 0) return 'bad';
    if (c.dataErrors > 0) return 'warn';
    return 'ok';
  }

  async function upload(instanceId: string, uuid: string): Promise<void> {
    busy = true;
    notice = '';
    try {
      const results = await api.startUploads(instanceId, [uuid]);
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

  // ---------- selection & batch ----------

  let selected: Record<string, boolean> = $state({});
  let menuFor: string | null = $state(null);

  const selectedRows = $derived(rows.filter((r) => selected[rowKey(r.item)]));
  const allSelected = $derived(rows.length > 0 && rows.every((r) => selected[rowKey(r.item)]));

  function toggleSelect(key: string, checked: boolean): void {
    selected = { ...selected, [key]: checked };
  }
  function toggleAll(checked: boolean): void {
    const next = { ...selected };
    for (const r of rows) next[rowKey(r.item)] = checked;
    selected = next;
  }
  function clearSelection(): void {
    selected = {};
  }

  /** which tracked editable fields disagree across an item's copies (for the "differs" badge) */
  function differingFields(item: UnifiedItem): string[] {
    const cs = item.copies;
    if (cs.length < 2) return [];
    const out: string[] = [];
    if (new Set(cs.map((c) => c.enabled)).size > 1) out.push('enabled');
    const scalars: Array<[keyof UnifiedCopy, string]> = [
      ['pri', 'priority'],
      ['comment', 'comment'],
      ['startExtra', 'start padding'],
      ['stopExtra', 'stop padding'],
      ['removal', 'removal'],
      ['retention', 'retention'],
    ];
    for (const [k, label] of scalars) {
      const vals = cs.map((c) => c[k]).filter((v) => v !== undefined && v !== null);
      if (vals.length > 1 && new Set(vals).size > 1) out.push(label);
    }
    return out;
  }

  // ---------- edit / delete modal ----------

  let editRows: Row[] | null = $state(null);

  function openEdit(target: Row[]): void {
    if (!target.length) return;
    menuFor = null;
    editRows = target;
  }

  const editInstances = $derived.by(() => {
    if (!editRows) return [] as Array<{ id: string; name: string; initial: boolean | 'mixed' }>;
    const states = new Map<string, boolean[]>();
    for (const row of editRows) {
      for (const c of row.item.copies) {
        const list = states.get(c.instanceId) ?? [];
        list.push(c.enabled);
        states.set(c.instanceId, list);
      }
    }
    return $instances
      .filter((i) => states.has(i.id))
      .map((i) => {
        const en = states.get(i.id)!;
        const initial: boolean | 'mixed' = en.every(Boolean)
          ? true
          : en.every((x) => !x)
            ? false
            : 'mixed';
        return { id: i.id, name: i.name, initial };
      });
  });

  const editInstanceSelector = $derived({
    instances: editInstances.map(({ id, name }) => ({ id, name })),
    initial: Object.fromEntries(editInstances.map((e) => [e.id, e.initial])),
  });

  async function runRecordingBatch(
    fn: () => Promise<Array<{ instanceId: string; uuid: string; ok: boolean; error?: string }>>,
    okVerb: string,
  ): Promise<void> {
    busy = true;
    notice = '';
    try {
      const res = await fn();
      const fails = res.filter((r) => !r.ok);
      if (fails.length === 0) {
        notice = `${okVerb} ${res.length} cop${res.length === 1 ? 'y' : 'ies'}.`;
      } else {
        const sample = fails.slice(0, 3).map((f) => `${f.instanceId}: ${f.error ?? 'failed'}`).join('; ');
        notice = `${res.length - fails.length} ok, ${fails.length} failed — ${sample}${fails.length > 3 ? '…' : ''}`;
      }
      selected = {};
      await refresh();
    } catch (err) {
      notice = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function applyEdit(out: { fields: Record<string, unknown>; instanceEnabled: Record<string, boolean> }): void {
    const target = editRows ?? [];
    editRows = null;
    const uniform = { ...out.fields };
    const enabledOverride = 'enabled' in uniform ? (uniform.enabled as boolean) : undefined;
    delete uniform.enabled;

    const opsByInstance = new Map<string, { uuids: string[]; fields: Record<string, unknown> }>();
    for (const row of target) {
      for (const c of row.item.copies) {
        const enabledForInst =
          enabledOverride !== undefined ? enabledOverride : out.instanceEnabled[c.instanceId];
        const fields: Record<string, unknown> = { ...uniform };
        if (enabledForInst !== undefined) fields.enabled = enabledForInst;
        if (Object.keys(fields).length === 0) continue;
        const acc = opsByInstance.get(c.instanceId) ?? { uuids: [], fields };
        acc.uuids.push(c.uuid);
        acc.fields = fields; // identical for every copy on this instance
        opsByInstance.set(c.instanceId, acc);
      }
    }
    const ops = [...opsByInstance.entries()].map(([instanceId, v]) => ({
      instanceId,
      uuids: v.uuids,
      fields: v.fields,
    }));
    if (!ops.length) {
      notice = 'No changes to apply.';
      return;
    }
    void runRecordingBatch(() => api.editRecordings(ops), 'Updated');
  }

  function deleteEdit(): void {
    const target = editRows ?? [];
    const targets = target.flatMap((row) =>
      row.item.copies.map((c) => ({ instanceId: c.instanceId, uuid: c.uuid })),
    );
    if (!targets.length) return;
    const instCount = new Set(targets.map((t) => t.instanceId)).size;
    const ruleUpcoming =
      tab === 'upcoming' && target.some((row) => row.item.copies.some((c) => c.fromRule));
    const msg =
      `Delete ${targets.length} recording cop${targets.length === 1 ? 'y' : 'ies'} across ${instCount} instance(s)?` +
      (tab === 'finished' ? '\n\nThis permanently deletes the recording files.' : '') +
      (ruleUpcoming
        ? '\n\nSome were created by an autorec rule and may be re-created on the next EPG scan — disable instead to skip durably.'
        : '');
    if (!confirm(msg)) return;
    editRows = null;
    void runRecordingBatch(() => api.deleteRecordings(targets), 'Deleted');
  }

  async function uploadSelected(): Promise<void> {
    const picks = selectedRows.map((r) => bestCopy(r.item)).filter((c): c is UnifiedCopy => !!c);
    if (!picks.length) return;
    const byInstance = new Map<string, string[]>();
    for (const c of picks) {
      const list = byInstance.get(c.instanceId) ?? [];
      list.push(c.uuid);
      byInstance.set(c.instanceId, list);
    }
    busy = true;
    notice = '';
    try {
      let queued = 0;
      let dup = 0;
      let err = 0;
      for (const [instanceId, uuids] of byInstance) {
        const res = await api.startUploads(instanceId, uuids);
        for (const r of res) {
          if (r.error) err++;
          else if (r.duplicateOf) dup++;
          else queued++;
        }
      }
      notice = `Upload: ${queued} queued, ${dup} already uploaded, ${err} failed.`;
      selected = {};
      await refresh();
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onclick={() => (menuFor = null)} />

<h1>Recordings</h1>
{#if error}<div class="error-banner">{error}</div>{/if}
{#if notice}<div class="card" style="margin-bottom:12px">{notice}</div>{/if}

<div class="tabs">
  {#each ['upcoming', 'finished', 'failed'] as t}
    <button class:active={tab === t} onclick={() => setTab(t as typeof tab)}>{t}</button>
  {/each}
</div>

<div class="toolbar">
  <label for="rf-rule" style="margin:0">Rule</label>
  <select id="rf-rule" style="width:auto;max-width:280px" bind:value={filterRule}>
    <option value={null}>(any)</option>
    {#each ruleFilterOptions as r}<option value={r}>{r}</option>{/each}
  </select>
  <label for="rf-channel" style="margin:0">Channel</label>
  <select id="rf-channel" style="width:auto" bind:value={filterChannel}>
    <option value={null}>(any)</option>
    {#each channelFilterOptions as c}<option value={c}>{c}</option>{/each}
  </select>
  <label for="rf-date" style="margin:0">Date</label>
  <select id="rf-date" style="width:auto" bind:value={filterDate}>
    <option value={null}>(any)</option>
    {#each dateFilterOptions as d}<option value={d}>{d}</option>{/each}
  </select>
  {#if filterRule !== null || filterChannel !== null || filterDate !== null}
    <button onclick={clearFilters}>Clear</button>
    <span class="muted small">{rows.length} / {allRows.length}</span>
  {/if}
</div>

{#if selectedRows.length}
  <div class="toolbar">
    <span class="muted small">{selectedRows.length} selected</span>
    <button disabled={busy} onclick={() => openEdit(selectedRows)}>Edit…</button>
    {#if tab === 'finished'}
      <button disabled={busy} onclick={uploadSelected}>Upload selected</button>
    {/if}
    <button onclick={clearSelection}>Clear selection</button>
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
      <th class="sortable" onclick={() => clickSort('title')}>Title{arrow('title')}</th>
      <th class="sortable" onclick={() => clickSort('rule')}>Rule{arrow('rule')}</th>
      <th class="sortable" onclick={() => clickSort('channel')}>Channel{arrow('channel')}</th>
      <th class="sortable" onclick={() => clickSort('time')}>Time{arrow('time')}</th>
      <th class="sortable" onclick={() => clickSort('duration')}>Duration{arrow('duration')}</th>
      {#if tab === 'failed'}
        <th class="sortable" onclick={() => clickSort('instance')}>Instance{arrow('instance')}</th>
        <th>Status</th>
        <th title="stream errors · data (TS) errors">errors</th>
      {:else}
        {#each $instances as inst (inst.id)}
          <th>{inst.name}</th>
          <th title="stream errors · data (TS) errors on {inst.name}">errors</th>
        {/each}
      {/if}
      {#if tab === 'finished'}<th>Archive</th>{/if}
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each rows as { rule, ruleComment, item } (rowKey(item))}
      {@const key = rowKey(item)}
      {@const diffs = differingFields(item)}
      <tr class="m-card">
        <td>
          <input
            type="checkbox"
            checked={selected[key] ?? false}
            onchange={(e) => toggleSelect(key, e.currentTarget.checked)}
            title="select"
          />
        </td>
        <td>
          <button class="expander" onclick={() => toggle(key)} title="per-instance details">
            {expanded[key] ? '▾' : '▸'}
          </button>
          {item.title}
          {#if item.subtitle}<span class="muted small"> · {item.subtitle}</span>{/if}
          {#if item.copies.some((c) => !c.enabled)}<span class="badge neutral" title="recording disabled on one or more instances">disabled</span>{/if}
          {#if diffs.length}<span class="badge warn" title="copies differ on: {diffs.join(', ')}">differs</span>{/if}
        </td>
        <td class="small">
          <button class="linklike muted" title="filter by this rule" onclick={() => (filterRule = rule)}>{rule}</button>
          {#if ruleComment}<span class="muted small"> ({ruleComment})</span>{/if}
        </td>
        <td class="small m-inline">
          {#if item.channelname}
            <button class="linklike" title="filter by this channel" onclick={() => (filterChannel = item.channelname)}>
              {item.channelname}
            </button>
          {/if}
        </td>
        <td class="small m-inline">
          <button class="linklike muted" title="filter by this date" onclick={() => (filterDate = dateOf(item.start))}>
            {ts(item.start)}
          </button>
        </td>
        <td class="small muted m-inline">{duration(item.start, item.stop)}</td>
        {#if tab === 'failed'}
          {@const c = item.copies[0]}
          <td class="small m-inline"><span class="m-only">on</span>{c?.instanceId ?? '—'}</td>
          <td style="white-space:nowrap" class="m-inline">
            {#if c}
              <span class="badge bad">{c.status ?? 'failed'}</span>
              <span class="muted small">{bytes(c.filesize)}</span>
            {/if}
          </td>
          <td style="white-space:nowrap" class="m-inline">
            {#if c}
              <span class="m-only">err</span>
              <span
                class="badge {errClass(c)}"
                title="{c.errors} stream errors · {c.dataErrors} data (TS) errors"
              >
                {c.errors} · {c.dataErrors}
              </span>
            {/if}
          </td>
        {:else}
          {#each $instances as inst (inst.id)}
            {@const c = copyFor(item, inst.id)}
            <td style="white-space:nowrap" class="m-inline">
              <span class="m-only">{inst.name}</span>
              {#if !c}
                <span class="badge bad" title="this broadcast is not {tab} on {inst.name}">missing</span>
              {:else if tab === 'upcoming'}
                {#if c.schedStatus === 'recording'}
                  <span class="rec-dot rec-blink" title="recording"></span>
                  <span class="muted small">{bytes(c.filesize)}</span>
                {:else}
                  <span class="badge neutral">scheduled</span>
                {/if}
                {#if c.conflictLevel === 'conflict'}<span class="badge bad">conflict</span>
                {:else if c.conflictLevel === 'low-margin'}<span class="badge warn">low margin</span>{/if}
              {:else}
                <span class="muted small">{bytes(c.filesize)}</span>
              {/if}
              {#if c && !c.enabled}<span class="badge neutral" title="recording disabled on {inst.name}">disabled</span>{/if}
            </td>
            <td style="white-space:nowrap" class="m-inline">
              {#if c && hasErrorInfo(c)}
                <span class="m-only">err</span>
                <span
                  class="badge {errClass(c)}"
                  title="{c.errors} stream errors · {c.dataErrors} data (TS) errors"
                >
                  {c.errors} · {c.dataErrors}
                </span>
              {:else}
                <span class="muted small">—</span>
              {/if}
            </td>
          {/each}
        {/if}
        {#if tab === 'finished'}
          <td style="white-space:nowrap">
            {#if item.upload}
              <span class="badge {item.upload.status === 'done' ? 'ok' : 'info'}">
                {item.upload.status === 'done' ? 'uploaded' : item.upload.status}
                <span class="muted">({item.upload.byInstanceId})</span>
              </span>
            {:else}
              {@const best = bestCopy(item)}
              {#if best}
                <button
                  disabled={busy}
                  title="best copy: fewest errors, then largest file"
                  onclick={() => upload(best.instanceId, best.uuid)}
                >
                  Upload ({best.instanceId} · {qualityTag(best)})
                </button>
              {/if}
            {/if}
          </td>
        {/if}
        <td style="position:relative;text-align:right;white-space:nowrap">
          <button
            class="expander"
            style="font-size:15px;padding:0 4px"
            title="actions"
            onclick={(e) => {
              e.stopPropagation();
              menuFor = menuFor === key ? null : key;
            }}
          >
            ⋮
          </button>
          {#if menuFor === key}
            <div class="row-menu" role="menu">
              <button onclick={() => openEdit([{ rule, ruleComment, item }])}>Edit…</button>
            </div>
          {/if}
        </td>
      </tr>
      {#if expanded[key]}
        <tr class="subrow">
          <td colspan="99">
            <table class="subtable">
              <tbody>
                {#each item.copies as c (c.instanceId)}
                  <tr>
                    <td class="small" style="width:90px"><b>{c.instanceId}</b></td>
                    <td class="small" style="width:110px">
                      {#if c.schedStatus === 'recording'}
                        <span class="rec-dot rec-blink" title="recording"></span> recording
                      {:else}
                        {c.status ?? c.schedStatus ?? '—'}
                      {/if}
                      {#if !c.enabled}<span class="badge neutral">disabled</span>{/if}
                    </td>
                    <td class="small muted" style="width:90px">{bytes(c.filesize)}</td>
                    <td style="width:90px">
                      {#if hasErrorInfo(c)}
                        <span class="badge {errClass(c)}" title="stream · data errors">{c.errors} · {c.dataErrors}</span>
                      {:else}
                        <span class="muted small">—</span>
                      {/if}
                    </td>
                    <td class="small muted" style="max-width:420px;overflow:hidden;text-overflow:ellipsis">
                      {c.filename ?? ''}
                    </td>
                    <td style="white-space:nowrap">
                      {#if tab === 'finished'}
                        <button disabled={busy} onclick={() => upload(c.instanceId, c.uuid)}>
                          Upload this copy
                        </button>
                      {/if}
                    </td>
                  </tr>
                {:else}
                  <tr><td class="muted small">no copies</td></tr>
                {/each}
              </tbody>
            </table>
          </td>
        </tr>
      {/if}
    {:else}
      <tr><td colspan="99" class="muted">No {tab} recordings.</td></tr>
    {/each}
  </tbody>
</table>

{#if editRows}
  <BatchEditModal
    title={editRows.length === 1 ? 'Edit recording' : `Edit ${editRows.length} recordings`}
    subtitle="Ticked fields apply to all copies. Instance checkboxes enable/disable per instance (unchecked = disabled)."
    fields={RECORDING_FIELDS}
    instanceSelector={editInstanceSelector}
    onsave={applyEdit}
    oncancel={() => (editRows = null)}
    ondelete={deleteEdit}
    deleteLabel="Delete recording(s)…"
  />
{/if}
