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
  import type { ChannelOption, MasterRulePayload, RuleInstances } from '@tvhc/shared';
  import type { RuleInput } from '../lib/api.js';
  import { conversionFor, toEitTime } from '../lib/eit.js';
  import { channelOptions, instances } from '../lib/stores.js';

  let {
    initialName,
    initialInstances,
    initialPayload = null,
    initialOverlay = null,
    parentPayload = null,
    parentName = '',
    onsave,
    oncancel,
  }: {
    initialName: string;
    initialInstances: RuleInstances;
    /** plain mode: the rule's current payload (null for a brand-new rule) */
    initialPayload?: MasterRulePayload | null;
    /** overlay mode: the clone's current overlay */
    initialOverlay?: Partial<MasterRulePayload> | null;
    /** overlay mode is active when this is set: empty fields inherit these values */
    parentPayload?: MasterRulePayload | null;
    parentName?: string;
    onsave: (out: Omit<RuleInput, 'parentId'>) => void;
    oncancel: () => void;
  } = $props();

  const overlayMode = $derived(parentPayload !== null);

  const DEFAULTS: MasterRulePayload = {
    enabled: true, name: '', title: '', fulltext: false, mergetext: false,
    channel: '', tag: '', btype: 0, content_type: 0, star_rating: 0,
    start: '', start_window: '', start_extra: 0, stop_extra: 0, weekdays: [],
    minduration: 0, maxduration: 0, minyear: 0, maxyear: 0, minseason: 0,
    maxseason: 0, pri: 6, record: 0, retention: 0, removal: 0, maxcount: 0,
    maxsched: 0, config_name: '', directory: '', comment: '',
  };

  type StrField =
    | 'title' | 'channel' | 'tag' | 'config_name' | 'start' | 'start_window' | 'comment';
  type NumField =
    | 'pri' | 'minduration' | 'maxduration' | 'record' | 'start_extra' | 'stop_extra' | 'maxcount';
  type BoolField = 'enabled' | 'fulltext';

  const base = $derived((parentPayload ?? null) as MasterRulePayload | null);

  // form state: '' = inherit (overlay mode) / default (plain mode)
  let name = $state('');
  let sf: Record<StrField | NumField, string> = $state({
    title: '', channel: '', tag: '', config_name: '', start: '', start_window: '',
    comment: '', pri: '', minduration: '', maxduration: '', record: '',
    start_extra: '', stop_extra: '', maxcount: '',
  });
  /** '' = inherit/default, 'yes' / 'no' = explicit */
  let bf: Record<BoolField, '' | 'yes' | 'no'> = $state({ enabled: '', fulltext: '' });
  let wdOverride = $state(false);
  // default to every day (all selected); the user narrows down from there
  let wd: number[] = $state([1, 2, 3, 4, 5, 6, 7]);
  let allInstances = $state(true);
  let selectedInstances: string[] = $state([]);
  let formError = $state('');

  // one-time init from props
  {
    name = initialName;
    allInstances = initialInstances === 'all';
    selectedInstances =
      initialInstances === 'all' ? $instances.map((i) => i.id) : [...initialInstances];
    const source: Partial<MasterRulePayload> | null = overlayMode
      ? (initialOverlay ?? {})
      : initialPayload;
    if (source) {
      for (const k of Object.keys(sf) as Array<StrField | NumField>) {
        const v = source[k as keyof MasterRulePayload];
        if (v !== undefined && v !== null) sf[k] = String(v);
      }
      for (const k of ['enabled', 'fulltext'] as BoolField[]) {
        const v = source[k];
        if (v !== undefined && v !== null) bf[k] = v ? 'yes' : 'no';
      }
      if (source.weekdays !== undefined && source.weekdays !== null) {
        wdOverride = true;
        // empty = every day in our model, shown as all selected
        wd = source.weekdays.length ? [...source.weekdays] : [1, 2, 3, 4, 5, 6, 7];
      }
    }
    if (!overlayMode && !wdOverride) wdOverride = true; // plain mode always edits weekdays
  }

  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function ph(field: keyof MasterRulePayload, fallback = ''): string {
    if (base) {
      const v = base[field];
      if (Array.isArray(v)) return v.length ? v.join(',') : 'every day';
      if (typeof v === 'boolean') return v ? 'yes' : 'no';
      return String(v ?? '') || fallback;
    }
    return fallback;
  }

  function toggleDay(d: number): void {
    wd = wd.includes(d) ? wd.filter((x) => x !== d) : [...wd, d].sort((a, b) => a - b);
  }

  function toggleInstance(id: string): void {
    selectedInstances = selectedInstances.includes(id)
      ? selectedInstances.filter((x) => x !== id)
      : [...selectedInstances, id];
  }

  function buildOverlay(): Partial<MasterRulePayload> {
    const o: Partial<MasterRulePayload> = {};
    for (const k of ['title', 'channel', 'tag', 'config_name', 'start', 'start_window', 'comment'] as StrField[]) {
      if (sf[k] !== '') o[k] = sf[k];
    }
    for (const k of ['pri', 'minduration', 'maxduration', 'record', 'start_extra', 'stop_extra', 'maxcount'] as NumField[]) {
      if (sf[k] !== '') o[k] = Number(sf[k]);
    }
    for (const k of ['enabled', 'fulltext'] as BoolField[]) {
      if (bf[k] !== '') o[k] = bf[k] === 'yes';
    }
    if (wdOverride) o.weekdays = [...wd];
    return o;
  }

  function buildPayload(): MasterRulePayload {
    const o = buildOverlay();
    return { ...DEFAULTS, ...o, name, weekdays: wdOverride ? [...wd] : [] };
  }

  function save(): void {
    formError = '';
    if (!name.trim()) {
      formError = 'name is required';
      return;
    }
    if (!allInstances && selectedInstances.length === 0) {
      formError = 'select at least one instance (or All)';
      return;
    }
    for (const k of ['pri', 'minduration', 'maxduration', 'record', 'start_extra', 'stop_extra', 'maxcount'] as NumField[]) {
      if (sf[k] !== '' && Number.isNaN(Number(sf[k]))) {
        formError = `"${k}" must be a number`;
        return;
      }
    }
    const instancesOut: RuleInstances = allInstances ? 'all' : [...selectedInstances];
    if (overlayMode) {
      onsave({ name: name.trim(), instances: instancesOut, overlay: buildOverlay() });
    } else {
      onsave({ name: name.trim(), instances: instancesOut, payload: buildPayload() });
    }
  }

  const conv = $derived(conversionFor(sf.channel || ph('channel'), $channelOptions, $instances));

  function eitHint(hhmm: string): string {
    if (!conv || !hhmm) return '';
    const t = toEitTime(hhmm, conv);
    return t ? `= ${t.time} EIT` : '';
  }

  const channels: ChannelOption[] = $derived($channelOptions);
  const effChannel = $derived(sf.channel || (overlayMode ? ph('channel') : ''));
  const matchedChannel = $derived(channels.find((c) => c.name === effChannel) ?? null);
  const scopeIds = $derived(allInstances ? $instances.map((i) => i.id) : selectedInstances);
  const missingOn = $derived(
    matchedChannel ? scopeIds.filter((id) => !matchedChannel.instances.includes(id)) : [],
  );
</script>

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal">
    <h2 style="margin-top:0">
      {initialName ? `Edit: ${initialName}` : overlayMode ? 'New linked clone' : 'New autorec rule'}
      {#if overlayMode}<span class="badge info">linked: {parentName}</span>{/if}
    </h2>
    {#if overlayMode}
      <p class="muted small" style="margin-top:0">
        Empty fields inherit from <b>{parentName}</b> (inherited values shown as placeholders);
        filled fields override.
      </p>
    {/if}
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    <div class="form-grid">
      <div class="wide">
        <label for="re-name">Name</label>
        <input id="re-name" bind:value={name} />
      </div>

      <div class="wide">
        <label for="re-instances">Instances</label>
        <div id="re-instances" style="display:flex;gap:10px;align-items:center">
          <label style="display:flex;gap:6px;align-items:center;margin:0">
            <input type="checkbox" style="width:auto" bind:checked={allInstances} />
            All (includes instances added later)
          </label>
          {#if !allInstances}
            {#each $instances as inst (inst.id)}
              <label style="display:flex;gap:6px;align-items:center;margin:0">
                <input
                  type="checkbox"
                  style="width:auto"
                  checked={selectedInstances.includes(inst.id)}
                  onchange={() => toggleInstance(inst.id)}
                />
                {inst.name}
              </label>
            {/each}
          {/if}
        </div>
      </div>

      <div class="wide">
        <label for="re-title">Title pattern (regex)</label>
        <input id="re-title" bind:value={sf.title} placeholder={ph('title', '(any)')} />
      </div>
      <div>
        <label for="re-channel">Channel name {overlayMode ? '' : '(blank = any)'}</label>
        <input id="re-channel" bind:value={sf.channel} list="channel-options" placeholder={ph('channel', 'Any channel')} />
        <datalist id="channel-options">
          {#each channels as c (c.name)}
            <option value={c.name} label="{c.number !== null ? `${c.number} · ` : ''}{c.name}"></option>
          {/each}
        </datalist>
        {#if matchedChannel}
          <div class="muted small">
            {#if matchedChannel.number !== null}#{matchedChannel.number} · {/if}on {matchedChannel.instances.join(', ')}
            {#if missingOn.length}<span style="color:var(--warn)"> — missing on {missingOn.join(', ')}</span>{/if}
          </div>
        {:else if effChannel}
          <div class="small" style="color:var(--bad)">channel not found on any instance — push will be blocked</div>
        {/if}
      </div>
      <div>
        <label for="re-tag">Channel tag</label>
        <input id="re-tag" bind:value={sf.tag} placeholder={ph('tag', '—')} />
      </div>
      <div>
        <label for="re-config">DVR profile</label>
        <input id="re-config" bind:value={sf.config_name} placeholder={ph('config_name', '(default)')} />
      </div>
      <div>
        <label for="re-start">Start after (HH:MM, server time)</label>
        <input id="re-start" bind:value={sf.start} placeholder={ph('start', 'Any')} />
        {#if eitHint(sf.start || (overlayMode ? ph('start') : ''))}
          <div class="muted small">{eitHint(sf.start || (overlayMode ? ph('start') : ''))}</div>
        {/if}
      </div>
      <div>
        <label for="re-window">Start before (HH:MM, server time)</label>
        <input id="re-window" bind:value={sf.start_window} placeholder={ph('start_window', 'Any')} />
        {#if eitHint(sf.start_window || (overlayMode ? ph('start_window') : ''))}
          <div class="muted small">{eitHint(sf.start_window || (overlayMode ? ph('start_window') : ''))}</div>
        {/if}
      </div>
      <div>
        <label for="re-pri">Priority (0 high … 6 default)</label>
        <input id="re-pri" inputmode="numeric" bind:value={sf.pri} placeholder={ph('pri', '6')} />
      </div>

      <div class="wide">
        <label for="re-wd">Weekdays</label>
        <div id="re-wd" style="display:flex;gap:6px;align-items:center">
          {#if overlayMode}
            <label style="display:flex;gap:6px;align-items:center;margin:0">
              <input type="checkbox" style="width:auto" bind:checked={wdOverride} /> Override
            </label>
          {/if}
          {#if wdOverride}
            {#each WEEKDAYS as label, i}
              <button type="button" class:primary={wd.includes(i + 1)} onclick={() => toggleDay(i + 1)}>
                {label}
              </button>
            {/each}
          {:else}
            <span class="muted small">inherited: {ph('weekdays', 'every day')}</span>
          {/if}
        </div>
      </div>

      <div>
        <label for="re-mind">Min duration (s)</label>
        <input id="re-mind" inputmode="numeric" bind:value={sf.minduration} placeholder={ph('minduration', '0')} />
      </div>
      <div>
        <label for="re-maxd">Max duration (s)</label>
        <input id="re-maxd" inputmode="numeric" bind:value={sf.maxduration} placeholder={ph('maxduration', '0')} />
      </div>
      <div>
        <label for="re-record">Dedup mode (record)</label>
        <input id="re-record" inputmode="numeric" bind:value={sf.record} placeholder={ph('record', '0')} />
      </div>
      <div>
        <label for="re-sx">Start padding (min)</label>
        <input id="re-sx" inputmode="numeric" bind:value={sf.start_extra} placeholder={ph('start_extra', '0')} />
      </div>
      <div>
        <label for="re-ex">Stop padding (min)</label>
        <input id="re-ex" inputmode="numeric" bind:value={sf.stop_extra} placeholder={ph('stop_extra', '0')} />
      </div>
      <div>
        <label for="re-maxc">Max recordings (0 = ∞)</label>
        <input id="re-maxc" inputmode="numeric" bind:value={sf.maxcount} placeholder={ph('maxcount', '0')} />
      </div>
      <div class="wide">
        <label for="re-comment">Comment</label>
        <input id="re-comment" bind:value={sf.comment} placeholder={ph('comment', '—')} />
      </div>

      <div class="wide" style="display:flex;gap:14px;align-items:center">
        <label for="re-enabled" style="margin:0">Enabled</label>
        <select id="re-enabled" style="width:auto" bind:value={bf.enabled}>
          <option value="">{overlayMode ? `inherit (${ph('enabled')})` : 'yes (default)'}</option>
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
        <label for="re-fulltext" style="margin:0">Full-text match</label>
        <select id="re-fulltext" style="width:auto" bind:value={bf.fulltext}>
          <option value="">{overlayMode ? `inherit (${ph('fulltext')})` : 'no (default)'}</option>
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      </div>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={save} disabled={!name.trim()}>Save</button>
    </div>
  </div>
</div>
