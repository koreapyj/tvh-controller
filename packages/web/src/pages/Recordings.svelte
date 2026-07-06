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
  import { chanLabel, chanNumberOrder, type UnifiedCopy, type UnifiedGroup, type UnifiedItem } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { latestWins } from '../lib/fetchGuard.js';
  import { bytes, duration, ts } from '../lib/format.js';
  import { parseListParam } from '../lib/query.js';
  import { route } from '../lib/router.js';
  import { instName, instances, recordingsTick } from '../lib/stores.js';
  import { notify } from '../lib/notifications.js';
  import BatchEditModal from '../components/BatchEditModal.svelte';
  import MultiSelectDropdown from '../components/MultiSelectDropdown.svelte';
  import { RECORDING_FIELDS } from '../components/batchFields.js';

  let tab: 'upcoming' | 'finished' | 'failed' = $state('upcoming');
  let groups: UnifiedGroup[] = $state([]);
  let busy = $state(false);

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
  let filterComment: string | null = $state(null);
  let filterChannels: string[] = $state([]);
  let filterDateFrom = $state('');
  let filterDateTo = $state('');

  /** the /recordings URL for the current filters, with the given overrides applied */
  function recordingsUrl(
    over: {
      rule?: string | null;
      comment?: string | null;
      channels?: string[];
      from?: string;
      to?: string;
    } = {},
  ): string {
    const rule = over.rule !== undefined ? over.rule : filterRule;
    const comment = over.comment !== undefined ? over.comment : filterComment;
    const channels = over.channels !== undefined ? over.channels : filterChannels;
    const from = over.from !== undefined ? over.from : filterDateFrom;
    const to = over.to !== undefined ? over.to : filterDateTo;
    const q = new URLSearchParams();
    if (rule !== null) q.set('rule', rule);
    if (comment !== null) q.set('comment', comment);
    if (channels.length) q.set('channels', JSON.stringify(channels));
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return `/recordings${qs ? `?${qs}` : ''}`;
  }

  // (re)apply filters from the query string on every NAVIGATION — including
  // re-clicking the sidebar link (go('/recordings') with no query resets them)
  $effect(() => {
    const q = new URLSearchParams($route.search);
    filterRule = q.get('rule');
    filterComment = q.get('comment');
    filterChannels = parseListParam(q.get('channels'));
    filterDateFrom = q.get('from') ?? '';
    filterDateTo = q.get('to') ?? '';
  });

  // keep the URL shareable without triggering navigation
  $effect(() => {
    window.history.replaceState({}, '', recordingsUrl());
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
  const commentFilterOptions = $derived(
    [...new Set(allRows.map((r) => r.ruleComment).filter(Boolean))].sort(),
  );
  // options are keyed by the full name+number label (channel identity) — two
  // same-name channels with different numbers become separate options
  const channelOptions = $derived(
    [
      ...new Map(
        allRows
          .filter((r) => r.item.channelname)
          .map((r) => [chanLabel(r.item.channelname, r.item.channelNumber ?? null), r.item] as const),
      ),
    ]
      .sort(
        ([, a], [, b]) =>
          chanNumberOrder(a.channelNumber ?? null) - chanNumberOrder(b.channelNumber ?? null) ||
          a.channelname.localeCompare(b.channelname),
      )
      .map(([label]) => ({ value: label, label })),
  );

  const hasFilters = $derived(
    filterRule !== null ||
      filterComment !== null ||
      filterChannels.length > 0 ||
      filterDateFrom !== '' ||
      filterDateTo !== '',
  );

  function clearFilters(): void {
    filterRule = null;
    filterComment = null;
    filterChannels = [];
    filterDateFrom = '';
    filterDateTo = '';
  }

  const rows: Row[] = $derived.by(() => {
    const flat = allRows.filter(
      (r) =>
        (filterRule === null || r.rule === filterRule) &&
        (filterComment === null || r.ruleComment === filterComment) &&
        (filterChannels.length === 0 ||
          filterChannels.includes(chanLabel(r.item.channelname, r.item.channelNumber ?? null))) &&
        (!filterDateFrom || dateOf(r.item.start) >= filterDateFrom) &&
        (!filterDateTo || dateOf(r.item.start) <= filterDateTo),
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

  const guard = latestWins();
  async function refresh(): Promise<void> {
    // latest-wins: a slow response for a previously selected tab must never
    // overwrite the currently selected tab's rows
    const forTab = tab;
    await guard(
      () => api.unifiedRecordings(forTab),
      (g) => {
        groups = g;
        notify.dismiss('recordings-load');
      },
      (msg) => notify.error(msg, { key: 'recordings-load' }),
    );
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
   * one traffic-light dot per instance: red = conflict, yellow = low margin,
   * gray = disabled, green = scheduled; the detail lives in the hover title
   */
  function dotFor(c: UnifiedCopy, instName: string): { cls: string; title: string } {
    const notes: string[] = [];
    if (c.conflictLevel === 'conflict') notes.push('conflict');
    else if (c.conflictLevel === 'low-margin') notes.push('low margin');
    if (!c.enabled) notes.push('recording disabled');
    const cls =
      c.conflictLevel === 'conflict' ? 'bad'
      : c.conflictLevel === 'low-margin' ? 'warn'
      : !c.enabled ? 'off'
      : 'ok';
    return { cls, title: `${notes.length ? notes.join(' · ') : 'scheduled'} on ${instName}` };
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
    try {
      const results = await api.startUploads(instanceId, [uuid]);
      const r = results[0];
      if (r?.error) notify.error(`Upload not started: ${r.error}`);
      else if (r?.duplicateOf) notify.info('Already uploaded (or uploading) from another instance.');
      else notify.success('Upload queued.');
      await refresh();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
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
  let editSingle = $state(false);

  /** recordings batch-field key -> UnifiedCopy property (for single-edit pre-fill) */
  const KEY_TO_UC: Record<string, keyof UnifiedCopy> = {
    comment: 'comment',
    pri: 'pri',
    start_extra: 'startExtra',
    stop_extra: 'stopExtra',
    retention: 'retention',
    removal: 'removal',
  };
  // single edit drops the Enabled field — the instance selector is the enable control
  const singleFields = RECORDING_FIELDS.filter((f) => f.key !== 'enabled');

  // upcoming, single-edit only: instances where this broadcast could be added (redundant)
  let addTargets: Array<{ instanceId: string; eventId: number }> = $state([]);
  let addLoading = $state(false);

  function openEditBatch(): void {
    if (!selectedRows.length) return;
    editSingle = false;
    addTargets = [];
    editRows = selectedRows;
  }
  async function openEditSingle(row: Row): Promise<void> {
    menuFor = null;
    editSingle = true;
    addTargets = [];
    editRows = [row];
    if (tab !== 'upcoming') return; // a finished broadcast can't be re-recorded elsewhere
    addLoading = true;
    try {
      const exclude = row.item.copies.map((c) => c.instanceId);
      addTargets = await api.recordingAddCandidates(
        row.item.channelname,
        row.item.start,
        row.item.stop,
        exclude,
      );
    } catch {
      addTargets = [];
    } finally {
      addLoading = false;
    }
  }

  /** single-edit: pre-fill fields the copies agree on; flag the rest as differing */
  const editPrefill = $derived.by(() => {
    const values: Record<string, string> = {};
    const differing: string[] = [];
    if (!editSingle || !editRows || editRows.length !== 1) return { values, differing };
    const editRow = editRows[0];
    if (!editRow) return { values, differing };
    const copies = editRow.item.copies;
    for (const f of singleFields) {
      const ucKey = KEY_TO_UC[f.key];
      if (!ucKey) continue;
      // compare only across instances that hold this recording; an unset field
      // reads as empty, so a single copy is never "(multiple values)"
      const strs = copies.map((c) => {
        const v = c[ucKey];
        return v === undefined || v === null ? '' : String(v);
      });
      if (copies.length && new Set(strs).size === 1) {
        values[f.key] = strs[0] ?? '';
      } else {
        differing.push(f.key);
      }
    }
    return { values, differing };
  });

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

  const editSelectorBatch = $derived({
    instances: editInstances.map((e) => ({ id: e.id, name: e.name, initial: e.initial })),
  });

  /** single-edit: classify EVERY instance — existing copy (toggle), addable (schedule), or blocked */
  const editInstanceItems = $derived.by(() => {
    type Item = {
      id: string;
      name: string;
      initial: boolean | 'mixed';
      disabled?: boolean;
      reason?: string;
      addEventId?: number;
    };
    if (!editSingle || !editRows || editRows.length !== 1) return [] as Item[];
    const editRow = editRows[0];
    if (!editRow) return [] as Item[];
    const item = editRow.item;
    const copyById = new Map(item.copies.map((c) => [c.instanceId, c]));
    const addById = new Map(addTargets.map((t) => [t.instanceId, t.eventId]));
    return $instances.map((inst): Item => {
      const copy = copyById.get(inst.id);
      if (copy) return { id: inst.id, name: inst.name, initial: copy.enabled };
      if (tab !== 'upcoming')
        return { id: inst.id, name: inst.name, initial: false, disabled: true, reason: 'already recorded' };
      if (addLoading)
        return { id: inst.id, name: inst.name, initial: false, disabled: true, reason: 'checking…' };
      if (!inst.hasTvh)
        return { id: inst.id, name: inst.name, initial: false, disabled: true, reason: 'no tvheadend' };
      if (!inst.reachable)
        return { id: inst.id, name: inst.name, initial: false, disabled: true, reason: 'unreachable' };
      const eventId = addById.get(inst.id);
      if (eventId !== undefined) return { id: inst.id, name: inst.name, initial: false, addEventId: eventId };
      return { id: inst.id, name: inst.name, initial: false, disabled: true, reason: 'no matching programme here' };
    });
  });

  const editSelectorSingle = $derived({
    hint: '(check to record on / uncheck to disable)',
    instances: editInstanceItems.map((i) => ({
      id: i.id,
      name: i.name,
      initial: i.initial,
      disabled: i.disabled,
      reason: i.reason,
    })),
  });

  /** instance id -> event id for instances the single-edit can add (schedule) */
  const editAddTargetsMap = $derived(
    Object.fromEntries(
      editInstanceItems
        .filter((i) => i.addEventId !== undefined)
        .map((i) => [i.id, i.addEventId as number]),
    ) as Record<string, number>,
  );

  async function runRecordingBatch(
    fn: () => Promise<Array<{ instanceId: string; uuid: string; ok: boolean; error?: string }>>,
    okVerb: string,
  ): Promise<void> {
    busy = true;
    try {
      const res = await fn();
      const fails = res.filter((r) => !r.ok);
      if (fails.length === 0) {
        notify.success(`${okVerb} ${res.length} cop${res.length === 1 ? 'y' : 'ies'}.`);
      } else {
        const sample = fails.slice(0, 3).map((f) => `${f.instanceId}: ${f.error ?? 'failed'}`).join('; ');
        notify.error(
          `${res.length - fails.length} ok, ${fails.length} failed — ${sample}${fails.length > 3 ? '…' : ''}`,
        );
      }
      selected = {};
      await refresh();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }

  function applyEdit(out: { fields: Record<string, unknown>; instanceEnabled: Record<string, boolean> }): void {
    const target = editRows ?? [];
    const addMap = editAddTargetsMap;
    editRows = null;
    const uniform = { ...out.fields };
    const enabledOverride = 'enabled' in uniform ? (uniform.enabled as boolean) : undefined;
    delete uniform.enabled;

    // checking an instance with no copy schedules a redundant recording there;
    // everything else is enable/disable of an existing copy
    const adds: Array<{ instanceId: string; eventId: number }> = [];
    const enabledByInstance: Record<string, boolean> = {};
    for (const [instId, checked] of Object.entries(out.instanceEnabled)) {
      const eventId = addMap[instId];
      if (eventId !== undefined) {
        if (checked) adds.push({ instanceId: instId, eventId });
      } else {
        enabledByInstance[instId] = checked;
      }
    }

    const opsByInstance = new Map<string, { uuids: string[]; fields: Record<string, unknown> }>();
    for (const row of target) {
      for (const c of row.item.copies) {
        const enabledForInst =
          enabledOverride !== undefined ? enabledOverride : enabledByInstance[c.instanceId];
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

    if (!ops.length && !adds.length) {
      notify.info('No changes to apply.');
      return;
    }
    void applyEditAndAdd(ops, adds);
  }

  async function applyEditAndAdd(
    ops: Array<{ instanceId: string; uuids: string[]; fields: Record<string, unknown> }>,
    adds: Array<{ instanceId: string; eventId: number }>,
  ): Promise<void> {
    busy = true;
    try {
      const parts: string[] = [];
      let hasFailure = false;
      if (ops.length) {
        const res = await api.editRecordings(ops);
        const fails = res.filter((r) => !r.ok);
        if (fails.length) hasFailure = true;
        parts.push(
          fails.length
            ? `${res.length - fails.length} updated, ${fails.length} failed — ${fails
                .slice(0, 2)
                .map((f) => `${f.instanceId}: ${f.error ?? 'failed'}`)
                .join('; ')}`
            : `updated ${res.length} cop${res.length === 1 ? 'y' : 'ies'}`,
        );
      }
      let added = 0;
      const addFails: string[] = [];
      for (const a of adds) {
        try {
          await api.recordEvent(a.instanceId, a.eventId);
          added++;
        } catch (e) {
          addFails.push(`${$instName(a.instanceId)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (added) parts.push(`added on ${added} instance${added === 1 ? '' : 's'}`);
      if (addFails.length) {
        hasFailure = true;
        parts.push(`add failed — ${addFails.join('; ')}`);
      }
      const message = parts.join('; ') || 'No changes.';
      if (hasFailure) notify.error(message);
      else notify.success(message);
      selected = {};
      await refresh();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
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
      const message = `Upload: ${queued} queued, ${dup} already uploaded, ${err} failed.`;
      if (err > 0) notify.error(message);
      else notify.success(message);
      selected = {};
      await refresh();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onclick={() => (menuFor = null)} />

<h1>Recordings</h1>

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
  <label for="rf-comment" style="margin:0">Comment</label>
  <select id="rf-comment" style="width:auto;max-width:220px" bind:value={filterComment}>
    <option value={null}>(any)</option>
    {#each commentFilterOptions as c}<option value={c}>{c}</option>{/each}
  </select>
  <span style="margin:0">Channel</span>
  <MultiSelectDropdown
    options={channelOptions}
    selected={filterChannels}
    onchange={(next) => (filterChannels = next)}
    allLabel="All channels"
    unit="channels"
    searchPlaceholder="Search channel…"
  />
  <label for="rf-from" style="margin:0">Date</label>
  <input id="rf-from" type="date" style="width:auto" bind:value={filterDateFrom} aria-label="from date" />
  <span class="muted small">–</span>
  <input id="rf-to" type="date" style="width:auto" bind:value={filterDateTo} aria-label="to date" />
  {#if hasFilters}
    <button onclick={clearFilters}>Clear</button>
    <span class="muted small">{rows.length} / {allRows.length}</span>
  {/if}
</div>

{#if selectedRows.length}
  <div class="toolbar">
    <span class="muted small">{selectedRows.length} selected</span>
    <button disabled={busy} onclick={openEditBatch}>Edit…</button>
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
        <td class="small cell-clip" title={rule + (ruleComment ? ` (${ruleComment})` : '')}>
          <a class="linklike muted" href={recordingsUrl({ rule })}>{rule}</a>
          {#if ruleComment}<span class="muted small"> ({ruleComment})</span>{/if}
        </td>
        <td class="small m-inline cell-clip" title={item.channelname ? chanLabel(item.channelname, item.channelNumber ?? null) : ''}>
          {#if item.channelname}
            <a class="linklike" href={recordingsUrl({ channels: [chanLabel(item.channelname, item.channelNumber ?? null)] })}>
              {chanLabel(item.channelname, item.channelNumber ?? null)}
            </a>
          {/if}
        </td>
        <td class="small m-inline" style="white-space:nowrap">
          <a class="linklike muted" title="filter to this date" href={recordingsUrl({ from: dateOf(item.start), to: dateOf(item.start) })}>
            {ts(item.start)}
          </a>
        </td>
        <td class="small muted m-inline" style="white-space:nowrap">{duration(item.start, item.stop)}</td>
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
                <span class="rec-dot bad" title="this broadcast is not {tab} on {inst.name}"></span>
              {:else if tab === 'upcoming'}
                {#if c.schedStatus === 'recording'}
                  <span
                    class="rec-dot rec-blink"
                    title={`recording on ${inst.name}${c.conflictLevel ? ` · ${c.conflictLevel === 'conflict' ? 'conflict' : 'low margin'}` : ''}`}
                  ></span>
                  <span class="muted small">{bytes(c.filesize)}</span>
                {:else}
                  {@const d = dotFor(c, inst.name)}
                  <span class="rec-dot {d.cls}" title={d.title}></span>
                {/if}
              {:else}
                <span class="muted small">{bytes(c.filesize)}</span>
                {#if !c.enabled}<span class="rec-dot off" title="recording disabled on {inst.name}"></span>{/if}
              {/if}
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
              <button onclick={() => openEditSingle({ rule, ruleComment, item })}>Edit…</button>
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
  {#key editRows}
    {#if editSingle}
      <BatchEditModal
        title="Edit recording"
        subtitle="Changes apply to all copies. Check an unchecked instance to record it there too; uncheck a copy to disable it."
        mode="single"
        fields={singleFields}
        initialValues={editPrefill.values}
        differingKeys={editPrefill.differing}
        instanceSelector={editSelectorSingle}
        onsave={applyEdit}
        oncancel={() => (editRows = null)}
        ondelete={deleteEdit}
        deleteLabel="Delete recording…"
      />
    {:else}
      <BatchEditModal
        title={`Edit ${editRows.length} recordings`}
        subtitle="Ticked fields apply to all copies. Instance checkboxes enable/disable per instance (unchecked = disabled)."
        fields={RECORDING_FIELDS}
        instanceSelector={editSelectorBatch}
        onsave={applyEdit}
        oncancel={() => (editRows = null)}
        ondelete={deleteEdit}
        deleteLabel="Delete recording(s)…"
      />
    {/if}
  {/key}
{/if}
