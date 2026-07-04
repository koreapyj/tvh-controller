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
  import type { MasterRule, MasterRulePayload, RuleWithStatus, SyncState } from '@tvhc/shared';
  import { api, type RuleInput } from '../lib/api.js';
  import { dateTime, weekdays } from '../lib/format.js';
  import { parseListParam } from '../lib/query.js';
  import { channelOptions, instances } from '../lib/stores.js';
  import { route } from '../lib/router.js';
  import { conversionFor, offsetLabel, toEitTime } from '../lib/eit.js';
  import { notify } from '../lib/notifications.js';
  import RuleEditor from './RuleEditor.svelte';
  import RuleDetails from '../components/RuleDetails.svelte';
  import BatchEditModal from '../components/BatchEditModal.svelte';
  import MultiSelectDropdown from '../components/MultiSelectDropdown.svelte';
  import { RULE_FIELDS } from '../components/batchFields.js';

  let rules: RuleWithStatus[] = $state([]);
  let busy = $state(false);
  let viewing: RuleWithStatus | null = $state(null);
  let importInstance = $state('');

  interface EditorState {
    id: string | null;
    parentId: string | null;
    parentName: string;
    parentPayload: MasterRulePayload | null;
    initialName: string;
    initialInstances: RuleWithStatus['instances'];
    initialPayload: MasterRulePayload | null;
    initialOverlay: Partial<MasterRulePayload> | null;
  }
  let editing: EditorState | null = $state(null);

  interface CloneState {
    source: RuleWithStatus;
    linked: boolean;
    name: string;
  }
  let cloning: CloneState | null = $state(null);
  /** rule id whose row action menu is open */
  let menuFor: string | null = $state(null);

  let view: 'active' | 'deleted' = $state('active');
  let deletedRules: MasterRule[] = $state([]);
  /** the Details modal shows a deleted rule (no sync state, no Edit) */
  let viewingDeleted = $state(false);

  function openDeletedDetails(rule: MasterRule): void {
    const parent =
      rule.parentId
        ? (rules.find((r) => r.id === rule.parentId) ??
           deletedRules.find((r) => r.id === rule.parentId) ??
           null)
        : null;
    const parentPayload =
      parent && 'effectivePayload' in parent
        ? (parent as RuleWithStatus).effectivePayload
        : ((parent as MasterRule | null)?.payload ?? null);
    const effectivePayload = rule.parentId
      ? ({ ...(parentPayload as MasterRulePayload), ...(rule.overlay ?? {}), name: rule.name } as MasterRulePayload)
      : ({ ...rule.payload, name: rule.name } as MasterRulePayload);
    viewingDeleted = true;
    viewing = {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      updatedAt: rule.updatedAt,
      payload: rule.payload,
      effectivePayload,
      parentId: rule.parentId,
      parentName: parent?.name ?? null,
      overlay: rule.overlay,
      instances: rule.instances,
      perInstance: {},
      upcomingMatches: 0,
    };
  }

  async function refreshDeleted(): Promise<void> {
    try {
      deletedRules = await api.deletedRules();
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err));
    }
  }

  $effect(() => {
    if (view === 'deleted') void refreshDeleted();
  });

  async function restore(rule: MasterRule): Promise<void> {
    if (!confirm(`Restore "${rule.name}" and push it back to its instances?`)) return;
    await run(async () => {
      await api.restoreRule(rule.id);
      await refreshDeleted();
    });
  }

  async function purge(rule: MasterRule): Promise<void> {
    if (!confirm(`PERMANENTLY delete "${rule.name}"? This cannot be undone.`)) return;
    await run(async () => {
      await api.purgeRule(rule.id);
      await refreshDeleted();
    });
  }

  async function refresh(): Promise<void> {
    try {
      rules = await api.rules();
      notify.dismiss('rules-load');
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err), { key: 'rules-load' });
    }
  }

  $effect(() => {
    void refresh();
  });

  // ---------- filtering (exact match, set by clicking a cell or the selects) ----------

  let filterChannels: string[] = $state([]);
  let filterComment: string | null = $state(null);
  let filterZeroMatch = $state(false);

  /** the /rules URL for the current filters, with the given overrides applied */
  function rulesUrl(
    over: { channels?: string[]; comment?: string | null; zero?: boolean } = {},
  ): string {
    const channels = over.channels !== undefined ? over.channels : filterChannels;
    const comment = over.comment !== undefined ? over.comment : filterComment;
    const zero = over.zero !== undefined ? over.zero : filterZeroMatch;
    const q = new URLSearchParams();
    if (channels.length) q.set('channels', JSON.stringify(channels));
    if (comment !== null) q.set('comment', comment);
    if (zero) q.set('zero', '1');
    const qs = q.toString();
    return `/rules${qs ? `?${qs}` : ''}`;
  }

  // restore filters from the URL on (re)navigation
  $effect(() => {
    const q = new URLSearchParams($route.search);
    filterChannels = parseListParam(q.get('channels'));
    filterComment = q.get('comment');
    filterZeroMatch = q.get('zero') === '1';
  });

  // mirror the active filters into the URL so they survive reload / are shareable
  $effect(() => {
    window.history.replaceState({}, '', rulesUrl());
  });

  const channelFilterOptions = $derived(
    [...new Set(rules.map((r) => r.effectivePayload.channel).filter(Boolean))]
      .sort()
      .map((c) => ({ value: c, label: c })),
  );
  const commentFilterOptions = $derived(
    [...new Set(rules.map((r) => r.effectivePayload.comment).filter(Boolean))].sort(),
  );

  const filtered = $derived(
    rules.filter(
      (r) =>
        (filterChannels.length === 0 || filterChannels.includes(r.effectivePayload.channel)) &&
        (filterComment === null || r.effectivePayload.comment === filterComment) &&
        (!filterZeroMatch || (r.enabled && r.upcomingMatches === 0)),
    ),
  );

  // ---------- sorting ----------

  type SortKey = 'name' | 'channel' | 'start' | 'start_window' | 'weekdays' | 'comment' | 'instances';
  let sortKey: SortKey | null = $state(null);
  let sortDir: 1 | -1 = $state(1);

  function clickSort(key: SortKey): void {
    if (sortKey !== key) {
      sortKey = key;
      sortDir = 1;
    } else if (sortDir === 1) {
      sortDir = -1;
    } else {
      sortKey = null; // third click returns to the default nested order
    }
  }

  function arrow(key: SortKey): string {
    return sortKey === key ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
  }

  function sortValue(r: RuleWithStatus, key: SortKey): string {
    switch (key) {
      case 'name': return r.name;
      case 'channel': return r.effectivePayload.channel;
      case 'start': return r.effectivePayload.start;
      case 'start_window': return r.effectivePayload.start_window;
      case 'weekdays': return weekdays(r.effectivePayload.weekdays);
      case 'comment': return r.effectivePayload.comment;
      case 'instances': return instancesLabel(r);
    }
  }

  /**
   * Linked clones always render directly under their parent (the ↳ marker
   * relies on it), so sorting orders the parent FAMILIES — clones move with
   * their parent and are sorted among siblings.
   */
  const ordered = $derived.by(() => {
    const cmp = sortKey
      ? (a: RuleWithStatus, b: RuleWithStatus) =>
          sortValue(a, sortKey!).localeCompare(sortValue(b, sortKey!)) * sortDir ||
          a.name.localeCompare(b.name)
      : (a: RuleWithStatus, b: RuleWithStatus) => a.name.localeCompare(b.name);

    const parents = [...filtered.filter((r) => !r.parentId)].sort(cmp);
    const byParent = new Map<string, RuleWithStatus[]>();
    for (const r of filtered) {
      if (!r.parentId) continue;
      const list = byParent.get(r.parentId) ?? [];
      list.push(r);
      byParent.set(r.parentId, list);
    }
    const out: RuleWithStatus[] = [];
    for (const p of parents) {
      out.push(p);
      out.push(...(byParent.get(p.id) ?? []).sort(cmp));
    }
    // clones whose parent is missing or filtered out still need to show up
    for (const r of [...filtered].sort(cmp)) {
      if (r.parentId && !out.includes(r)) out.push(r);
    }
    return out;
  });

  const anyConv = $derived(conversionFor('', $channelOptions, $instances));

  function eitTimeCell(hhmm: string, channel: string): { text: string; title: string } {
    if (!hhmm) return { text: 'Any', title: '' };
    const conv = conversionFor(channel, $channelOptions, $instances);
    if (!conv) return { text: hhmm, title: '' };
    const t = toEitTime(hhmm, conv);
    if (!t) return { text: hhmm, title: '' };
    return {
      text: t.time,
      title: `${hhmm} in server time (UTC${offsetLabel(conv.serverOffsetMinutes)})`,
    };
  }

  function badgeClass(state: SyncState): string {
    switch (state) {
      case 'in-sync': return 'ok';
      case 'pending': case 'unpushed': return 'info';
      case 'drift': return 'warn';
      case 'blocked': return 'bad';
      default: return 'neutral';
    }
  }

  function instancesLabel(r: RuleWithStatus): string {
    return r.instances === 'all' ? 'All' : r.instances.join(', ');
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

  function openEditor(rule: RuleWithStatus | null): void {
    if (!rule) {
      editing = {
        id: null, parentId: null, parentName: '', parentPayload: null,
        initialName: '', initialInstances: 'all', initialPayload: null, initialOverlay: null,
      };
      return;
    }
    const parent = rule.parentId ? (rules.find((r) => r.id === rule.parentId) ?? null) : null;
    editing = {
      id: rule.id,
      parentId: rule.parentId,
      parentName: parent?.name ?? '',
      parentPayload: rule.parentId ? $state.snapshot(parent?.effectivePayload ?? null) as MasterRulePayload | null : null,
      initialName: rule.name,
      initialInstances: $state.snapshot(rule.instances) as RuleWithStatus['instances'],
      initialPayload: rule.parentId ? null : ($state.snapshot(rule.payload) as MasterRulePayload),
      initialOverlay: rule.parentId
        ? ($state.snapshot(rule.overlay ?? {}) as Partial<MasterRulePayload>)
        : null,
    };
  }

  async function save(out: Omit<RuleInput, 'parentId'>): Promise<void> {
    const e = editing;
    if (!e) return;
    if (e.id) {
      // scope-shrink confirm: removing a bound instance deletes the rule there
      const rule = rules.find((r) => r.id === e.id);
      if (rule) {
        const all = $instances.map((i) => i.id);
        const oldScope = rule.instances === 'all' ? all : rule.instances;
        const newScope = out.instances === 'all' ? all : out.instances;
        const removedBound = oldScope.filter(
          (i) => !newScope.includes(i) && rule.perInstance[i]?.tvhUuid,
        );
        if (
          removedBound.length &&
          !confirm(
            `Removing ${removedBound.join(', ')} from this rule's instances DELETES the rule there.\n\n` +
              'Tvheadend will CANCEL its scheduled recordings on the removed instance(s). Continue?',
          )
        ) {
          return;
        }
      }
    }
    editing = null;
    await run(() =>
      e.id
        ? api.updateRule(e.id, { ...out, parentId: e.parentId })
        : api.createRule(out),
    );
  }

  function openClone(rule: RuleWithStatus): void {
    cloning = {
      source: rule,
      linked: !rule.parentId, // default to linked when allowed
      name: `${rule.name} (copy)`,
    };
  }

  async function doClone(): Promise<void> {
    const c = cloning;
    if (!c) return;
    cloning = null;
    await run(() => api.cloneRule(c.source.id, c.linked, c.name.trim()));
  }

  async function remove(rule: RuleWithStatus): Promise<void> {
    if (
      !confirm(
        `Delete "${rule.name}" from every targeted instance?\n\n` +
          'Tvheadend will CANCEL all scheduled recordings created by this rule.\n' +
          'The rule moves to the Deleted tab and can be restored later.',
      )
    )
      return;
    await run(() => api.deleteRule(rule.id));
  }

  // ---------- selection & batch ----------

  let selected: Record<string, boolean> = $state({});
  let batchEditing = $state(false);

  const selectedIds = $derived(ordered.filter((r) => selected[r.id]).map((r) => r.id));
  const allSelected = $derived(ordered.length > 0 && ordered.every((r) => selected[r.id]));

  function toggleSelect(id: string, checked: boolean): void {
    selected = { ...selected, [id]: checked };
  }
  function toggleAll(checked: boolean): void {
    const next = { ...selected };
    for (const r of ordered) next[r.id] = checked;
    selected = next;
  }

  async function runRuleBatch(
    action: 'edit' | 'delete' | 'push',
    ids: string[],
    patch?: Partial<MasterRulePayload>,
  ): Promise<void> {
    if (!ids.length) return;
    busy = true;
    try {
      const res = await api.batchRules(action, ids, patch);
      const fails = res.filter((r) => !r.ok);
      if (fails.length) {
        notify.error(
          `${fails.length} of ${res.length} failed: ${fails.slice(0, 3).map((f) => f.error ?? 'failed').join('; ')}`,
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

  function batchEditSave(out: { fields: Record<string, unknown> }): void {
    const ids = selectedIds;
    batchEditing = false;
    void runRuleBatch('edit', ids, out.fields as Partial<MasterRulePayload>);
  }

  async function batchDelete(): Promise<void> {
    const ids = selectedIds;
    if (!ids.length) return;
    if (
      !confirm(
        `Delete ${ids.length} rule${ids.length === 1 ? '' : 's'} from their targeted instances?\n\n` +
          'Tvheadend will CANCEL the scheduled recordings each rule created.\n' +
          'They move to the Deleted tab and can be restored later.',
      )
    )
      return;
    await runRuleBatch('delete', ids);
  }
</script>

<svelte:window
  onclick={() => (menuFor = null)}
  onkeydown={(e) => {
    if (e.key !== 'Escape') return;
    if (cloning) cloning = null;
    else if (viewing) {
      viewing = null;
      viewingDeleted = false;
    }
  }}
/>

<h1>Autorec Rules</h1>
{#if anyConv}
  <p class="muted small">
    Start times are shown in broadcast (EIT) time UTC{offsetLabel(anyConv.eitOffsetMinutes)} (from
    each channel's network in tvheadend); tvheadend stores them in server time
    UTC{offsetLabel(anyConv.serverOffsetMinutes)} — hover a value to see the stored server time.
    Weekdays and the editor use server time as-is.
  </p>
{/if}

<div class="tabs">
  <button class:active={view === 'active'} onclick={() => (view = 'active')}>Active</button>
  <button class:active={view === 'deleted'} onclick={() => (view = 'deleted')}>Deleted</button>
</div>

{#if view === 'active'}
<div class="toolbar">
  <button class="primary" onclick={() => openEditor(null)}>New rule</button>
  <button disabled={busy} onclick={() => run(() => api.pushAll())}>Push all pending</button>
  <span style="display:flex;gap:6px;align-items:center">
    <span style="margin:0">Channel</span>
    <MultiSelectDropdown
      options={channelFilterOptions}
      selected={filterChannels}
      onchange={(next) => (filterChannels = next)}
      allLabel="All channels"
      unit="channels"
      searchPlaceholder="Search channel…"
    />
    <label for="rf-comment" style="margin:0">Comment</label>
    <select id="rf-comment" style="width:auto" bind:value={filterComment}>
      <option value={null}>(any)</option>
      {#each commentFilterOptions as c}<option value={c}>{c}</option>{/each}
    </select>
    <button
      class:primary={filterZeroMatch}
      title="show only enabled rules with no upcoming matches"
      onclick={() => (filterZeroMatch = !filterZeroMatch)}
    >
      0 match
    </button>
    {#if filterChannels.length || filterComment !== null || filterZeroMatch}
      <button onclick={() => { filterChannels = []; filterComment = null; filterZeroMatch = false; }}>Clear</button>
      <span class="muted small">{filtered.length} / {rules.length}</span>
    {/if}
  </span>
  <span class="spacer"></span>
  {#if rules.length === 0}
    <select bind:value={importInstance} style="width:auto">
      <option value="" disabled selected>Bootstrap: import from…</option>
      {#each $instances as inst}
        <option value={inst.id}>{inst.name}</option>
      {/each}
    </select>
    <button
      disabled={!importInstance || busy}
      onclick={() =>
        run(async () => {
          const r = await api.importFrom(importInstance);
          alert(`Imported ${r.imported} rules, bound ${r.bound} instance rules.`);
        })}
    >
      Import
    </button>
  {/if}
</div>

{#if selectedIds.length}
  <div class="toolbar">
    <span class="muted small">{selectedIds.length} selected</span>
    <button disabled={busy} onclick={() => (batchEditing = true)}>Edit…</button>
    <button class="danger" disabled={busy} onclick={batchDelete}>Delete</button>
    <button disabled={busy} onclick={() => runRuleBatch('push', selectedIds)}>Push selected</button>
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
      <th class="sortable" onclick={() => clickSort('name')}>Rule{arrow('name')}</th>
      <th class="sortable" onclick={() => clickSort('channel')}>Channel{arrow('channel')}</th>
      <th class="sortable" onclick={() => clickSort('start')}>Start after{arrow('start')}</th>
      <th class="sortable" onclick={() => clickSort('start_window')}>Start before{arrow('start_window')}</th>
      <th class="sortable" onclick={() => clickSort('weekdays')}>Days of week{arrow('weekdays')}</th>
      <th class="sortable" onclick={() => clickSort('comment')}>Comment{arrow('comment')}</th>
      <th class="sortable" onclick={() => clickSort('instances')}>Instances{arrow('instances')}</th>
      {#each $instances as inst}
        <th>{inst.name}</th>
      {/each}
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each ordered as rule (rule.id)}
      {@const p = rule.effectivePayload}
      <tr class="m-card">
        <td>
          <input
            type="checkbox"
            checked={selected[rule.id] ?? false}
            onchange={(e) => toggleSelect(rule.id, e.currentTarget.checked)}
            title="select"
          />
        </td>
        <td>
          {#if rule.parentId}<span class="muted">↳ </span>{/if}
          <a
            class="linklike"
            style="color:var(--text)"
            title="show this rule's recordings"
            href="/recordings?rule={encodeURIComponent(rule.name)}"
          >
            {rule.name}
          </a>
          {#if rule.parentId}<span class="badge info" title="linked clone of {rule.parentName}">linked</span>{/if}
          {#if !rule.enabled}<span class="badge neutral">disabled</span>{/if}
          {#if rule.enabled && rule.upcomingMatches === 0}
            <a
              class="badge warn badge-button"
              title="no upcoming recording matches this rule on any targeted instance (within the EPG window) — check the title pattern, channel, and time window; for a seasonal show this may just mean the season ended. Click to filter."
              href={rulesUrl({ zero: true })}
            >
              0 match
            </a>
          {/if}
        </td>
        <td class="small m-inline">
          {#if p.channel}
            <a class="linklike" title="filter by this channel" href={rulesUrl({ channels: [p.channel] })}>
              {p.channel}
            </a>
          {:else}any{/if}
          {#if rule.parentId && rule.overlay && 'channel' in rule.overlay}<span class="badge warn" title="overrides parent">override</span>{/if}
        </td>
        {#each [eitTimeCell(p.start, p.channel), eitTimeCell(p.start_window, p.channel)] as cell, ci}
          <td class="small m-inline" title={cell.title}>
            <span class="m-only">{ci === 0 ? 'after' : 'before'}</span>{cell.text}
          </td>
        {/each}
        <td class="small m-inline">{weekdays(p.weekdays)}</td>
        <td class="small m-inline">
          {#if p.comment}
            <a class="linklike" title="filter by this comment" href={rulesUrl({ comment: p.comment })}>
              {p.comment}
            </a>
          {:else}<span class="muted m-hide">—</span>{/if}
        </td>
        <td class="small m-inline">
          <span class="m-only">on</span>
          <span class="badge {rule.instances === 'all' ? 'neutral' : 'info'}">{instancesLabel(rule)}</span>
        </td>
        {#each $instances as inst}
          {@const st = rule.perInstance[inst.id]}
          <td style="white-space:nowrap" class="m-inline">
            {#if st}
              <span class="m-only">{inst.name}</span>
              <span class="badge {badgeClass(st.state)}" title={st.blockedReason ?? ''}>{st.state}</span>
            {:else}
              <span class="muted small m-hide" title="not targeted by this rule">—</span>
            {/if}
          </td>
        {/each}
        <td style="position:relative;text-align:right">
          <button
            class="expander"
            style="font-size:15px;padding:0 4px"
            title="actions"
            onclick={(e) => {
              e.stopPropagation();
              menuFor = menuFor === rule.id ? null : rule.id;
            }}
          >
            ⋮
          </button>
          {#if menuFor === rule.id}
            <div class="row-menu" role="menu">
              <button onclick={() => { menuFor = null; viewing = rule; }}>Details</button>
              <button onclick={() => { menuFor = null; openEditor(rule); }}>Edit</button>
              <button onclick={() => { menuFor = null; openClone(rule); }}>Clone</button>
              <button disabled={busy} onclick={() => { menuFor = null; void run(() => api.pushRule(rule.id)); }}>Push</button>
              <button class="danger" disabled={busy} onclick={() => { menuFor = null; void remove(rule); }}>Delete</button>
            </div>
          {/if}
        </td>
      </tr>
    {:else}
      <tr><td colspan="99" class="muted">No master rules yet — bootstrap by importing from an instance.</td></tr>
    {/each}
  </tbody>
</table>
{:else}
<p class="muted small">
  Deleted rules were removed from the instances (their scheduled recordings cancelled) but are
  kept here. Restore pushes a rule back to its instances; purge removes it permanently.
</p>
<table class="m-cards">
  <thead>
    <tr>
      <th>Rule</th>
      <th>Instances</th>
      <th>Deleted at</th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each deletedRules as rule (rule.id)}
      <tr class="m-card">
        <td>
          <button class="linklike" style="color:var(--text)" title="details" onclick={() => openDeletedDetails(rule)}>
            {rule.name}
          </button>
          {#if rule.parentId}<span class="badge info">linked clone</span>{/if}
        </td>
        <td class="small m-inline">
          <span class="m-only">on</span>
          <span class="badge {rule.instances === 'all' ? 'neutral' : 'info'}">
            {rule.instances === 'all' ? 'All' : rule.instances.join(', ')}
          </span>
        </td>
        <td class="small muted m-inline">
          <span class="m-only">deleted</span>{rule.deletedAt ? dateTime(rule.deletedAt) : '—'}
        </td>
        <td style="white-space:nowrap">
          <button disabled={busy} onclick={() => restore(rule)}>Restore</button>
          <button class="danger" disabled={busy} onclick={() => purge(rule)}>Delete forever</button>
        </td>
      </tr>
    {:else}
      <tr><td colspan="99" class="muted">No deleted rules.</td></tr>
    {/each}
  </tbody>
</table>
{/if}

{#if editing}
  {#key editing}
    <RuleEditor
      initialName={editing.initialName}
      initialInstances={editing.initialInstances}
      initialPayload={editing.initialPayload}
      initialOverlay={editing.initialOverlay}
      parentPayload={editing.parentPayload}
      parentName={editing.parentName}
      onsave={save}
      oncancel={() => (editing = null)}
    />
  {/key}
{/if}

{#if cloning}
  <div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && (cloning = null)}>
    <div class="modal" style="width:480px" role="dialog" aria-modal="true" aria-label={`Clone ${cloning.source.name}`}>
      <h2 style="margin-top:0">Clone: {cloning.source.name}</h2>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;gap:8px;align-items:flex-start;margin:0">
          <input type="radio" style="width:auto;margin-top:3px" bind:group={cloning.linked} value={true} disabled={!!cloning.source.parentId} />
          <span>
            <b>Linked clone</b> — inherits every property from the source; you override only what
            you fill in afterwards. Follows future edits of the source.
            {#if cloning.source.parentId}<br /><span class="small" style="color:var(--warn)">unavailable: the source is itself a linked clone</span>{/if}
          </span>
        </label>
        <label style="display:flex;gap:8px;align-items:flex-start;margin:0">
          <input type="radio" style="width:auto;margin-top:3px" bind:group={cloning.linked} value={false} />
          <span><b>Plain copy</b> — independent rule with a snapshot of the current values.</span>
        </label>
        <div>
          <label for="clone-name">Name</label>
          <input id="clone-name" bind:value={cloning.name} />
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button onclick={() => (cloning = null)}>Cancel</button>
        <button class="primary" disabled={!cloning.name.trim() || busy} onclick={doClone}>Create</button>
      </div>
    </div>
  </div>
{/if}

{#if viewing}
  <div
    class="modal-backdrop"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && ((viewing = null), (viewingDeleted = false))}
  >
    <div class="modal" role="dialog" aria-modal="true" aria-label={viewing.name}>
      <h2 style="margin-top:0">
        {viewing.name}
        {#if viewingDeleted}<span class="badge bad">deleted</span>{/if}
        {#if viewing.parentId}<span class="badge info">linked: {viewing.parentName}</span>{/if}
        {#if !viewing.enabled}<span class="badge neutral">disabled</span>{/if}
      </h2>
      {#if viewing.parentId && viewing.overlay}
        <p class="muted small" style="margin-top:0">
          Overrides: {Object.keys(viewing.overlay).length
            ? Object.keys(viewing.overlay).join(', ')
            : '(none)'} — everything else inherited from <b>{viewing.parentName}</b>.
        </p>
      {/if}
      <RuleDetails payload={viewing.effectivePayload} />

      <h2>Instances <span class="badge {viewing.instances === 'all' ? 'neutral' : 'info'}">{instancesLabel(viewing)}</span></h2>
      {#if viewingDeleted}
        <p class="muted small">Deleted — not present on any instance. Restore to push it back.</p>
      {:else}
        <table>
          <thead><tr><th>Instance</th><th>State</th><th>tvh uuid</th></tr></thead>
          <tbody>
            {#each $instances as inst}
              {@const st = viewing.perInstance[inst.id]}
              <tr>
                <td>{inst.name}</td>
                <td>
                  {#if st}
                    <span class="badge {badgeClass(st.state)}">{st.state}</span>
                    {#if st.blockedReason}<span class="small" style="color:var(--bad)"> {st.blockedReason}</span>{/if}
                  {:else}
                    <span class="muted small">not targeted</span>
                  {/if}
                </td>
                <td class="small muted"><code>{st?.tvhUuid ?? '—'}</code></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      <div class="muted small" style="margin-top:8px">Last updated: {dateTime(viewing.updatedAt)}</div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button onclick={() => { viewing = null; viewingDeleted = false; }}>Close</button>
        {#if !viewingDeleted}
          <button
            class="primary"
            onclick={() => {
              const r = viewing!;
              viewing = null;
              openEditor(r);
            }}
          >
            Edit
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if batchEditing}
  <BatchEditModal
    title={`Edit ${selectedIds.length} rule${selectedIds.length === 1 ? '' : 's'}`}
    subtitle="Ticked fields are applied to every selected rule; rules stay pending until you push."
    fields={RULE_FIELDS}
    onsave={batchEditSave}
    oncancel={() => (batchEditing = false)}
  />
{/if}
