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
  import { chanKey, chanLabel } from '@tvhc/shared';
  import { resolveChannelPick } from '../lib/channelPick.js';
  import { parseFieldValue, type FieldSpec } from '../lib/ruleFields.js';
  import { channelOptions } from '../lib/stores.js';
  import RuleFieldRow from './RuleFieldRow.svelte';

  // tvheadend-style batch edit: a checkbox per field — only ticked fields are
  // written. An optional instance selector doubles as the per-instance control
  // (enable/disable for recordings, scope add/remove for rules) — only touched
  // checkboxes are reported back.

  interface InstanceOption {
    id: string;
    name: string;
    /** current per-instance enabled state; 'mixed' across a batch */
    initial: boolean | 'mixed';
    /** shown but not toggleable (e.g. can't be added here); `reason` explains why */
    disabled?: boolean;
    reason?: string;
  }
  interface InstanceSelector {
    instances: InstanceOption[];
    /** hint shown above the checkboxes */
    hint?: string;
  }

  let {
    title,
    subtitle = '',
    fields,
    mode = 'batch',
    initialValues = {},
    differingKeys = [],
    instanceSelector = null,
    saveLabel = 'Save',
    onsave,
    oncancel,
    ondelete = null,
    deleteLabel = 'Delete…',
  }: {
    title: string;
    subtitle?: string;
    fields: FieldSpec[];
    /** 'batch' = a checkbox per field (only ticked applied); 'single' = pre-filled direct edit (only changed applied) */
    mode?: 'batch' | 'single';
    /** single mode: pre-filled string value per field key ('' = no agreed value) */
    initialValues?: Record<string, string>;
    /** single mode: field keys whose copies disagree — shown as "(multiple values)" */
    differingKeys?: string[];
    instanceSelector?: InstanceSelector | null;
    saveLabel?: string;
    onsave: (out: { fields: Record<string, unknown>; instanceEnabled: Record<string, boolean> }) => void;
    oncancel: () => void;
    ondelete?: (() => void) | null;
    deleteLabel?: string;
  } = $props();

  let apply: Record<string, boolean> = $state({});
  let vals: Record<string, string> = $state({});
  const initialVals: Record<string, string> = {};
  let instChecked: Record<string, boolean> = $state({});
  let instTouched: Record<string, boolean> = $state({});
  const instInitial: Record<string, boolean | 'mixed'> = {};
  let formError = $state('');

  // one-time init
  {
    for (const f of fields) {
      apply[f.key] = false;
      const init =
        mode === 'single'
          ? (initialValues[f.key] ?? '')
          : f.type === 'bool'
            ? 'yes'
            : f.type === 'enum'
              ? (f.initial ?? String(f.options?.[0]?.value ?? ''))
              : f.type === 'weekdays'
                ? '1,2,3,4,5,6,7'
                : '';
      vals[f.key] = init;
      initialVals[f.key] = init;
    }
    if (instanceSelector) {
      for (const inst of instanceSelector.instances) {
        instChecked[inst.id] = inst.initial === true;
        instInitial[inst.id] = inst.initial;
        instTouched[inst.id] = false;
      }
    }
  }

  function isMixed(id: string): boolean {
    return instInitial[id] === 'mixed' && !instTouched[id];
  }

  function toggleInstance(id: string, checked: boolean): void {
    instChecked[id] = checked;
    instTouched[id] = true;
  }

  const hasChanges = $derived(
    (mode === 'single'
      ? fields.some((f) => vals[f.key] !== initialVals[f.key])
      : Object.values(apply).some(Boolean)) || Object.values(instTouched).some(Boolean),
  );

  function save(): void {
    formError = '';
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const include = mode === 'single' ? vals[f.key] !== initialVals[f.key] : apply[f.key];
      if (!include) continue;
      if (f.type === 'channel') {
        // channel stays in the modal: it needs the channel store to resolve
        // the picked label into the {channel, channel_number} identity pair
        const pick = resolveChannelPick(vals[f.key] ?? '', $channelOptions);
        if (!pick) {
          formError = 'channel not found — pick one from the list';
          return;
        }
        out.channel = pick.name;
        out.channel_number = pick.number;
        continue;
      }
      if (f.type === 'int' && mode === 'single' && vals[f.key] === '') continue; // cleared = leave unchanged
      const parsed = parseFieldValue(f, vals[f.key] ?? '');
      if (!parsed.ok) {
        formError = parsed.error;
        return;
      }
      out[f.key] = parsed.value;
    }
    const instanceEnabled: Record<string, boolean> = {};
    if (instanceSelector) {
      for (const inst of instanceSelector.instances) {
        if (instTouched[inst.id]) instanceEnabled[inst.id] = instChecked[inst.id] ?? false;
      }
    }
    if (!Object.keys(out).length && !Object.keys(instanceEnabled).length) {
      formError = 'nothing to apply — change a field or an instance';
      return;
    }
    onsave({ fields: out, instanceEnabled });
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={title}>
    <h2 style="margin-top:0">{title}</h2>
    {#if subtitle}<p class="muted small" style="margin-top:0">{subtitle}</p>{/if}
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    {#if instanceSelector}
      <div style="margin-bottom:14px">
        <div style="margin-bottom:4px">
          Instances
          <span class="muted small">
            {instanceSelector.hint ?? '(unchecked = disabled on that instance)'}
          </span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px">
          {#each instanceSelector.instances as inst (inst.id)}
            <label
              class:muted={inst.disabled}
              title={inst.reason ?? ''}
              style="display:flex;gap:6px;align-items:center;margin:0"
            >
              <input
                type="checkbox"
                checked={instChecked[inst.id]}
                indeterminate={isMixed(inst.id)}
                disabled={inst.disabled}
                onchange={(e) => toggleInstance(inst.id, e.currentTarget.checked)}
              />
              {inst.name}{#if inst.disabled && inst.reason}<span class="muted small"> — {inst.reason}</span>{/if}
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="muted small">
        {mode === 'batch'
          ? 'Tick a field to apply it; unticked fields are left unchanged.'
          : 'Only fields you change are saved; the rest are left unchanged.'}
      </div>
      {#each fields as f, i (f.key)}
        {#if f.section && f.section !== fields[i - 1]?.section}
          <div class="muted small" style="margin-top:8px;text-transform:uppercase;font-size:11px">
            {f.section}
          </div>
        {/if}
        <RuleFieldRow
          spec={f}
          mode={mode === 'single' ? 'plain' : 'batch'}
          bind:value={vals[f.key]}
          bind:apply={apply[f.key]}
          inheritPlaceholder={mode === 'single' && differingKeys.includes(f.key)
            ? '(multiple values)'
            : undefined}
          datalistId={f.type === 'channel' ? 'be-channel-options' : undefined}
        />
      {/each}
      {#if fields.some((f) => f.type === 'channel')}
        <datalist id="be-channel-options">
          {#each $channelOptions as c (chanKey(c.name, c.number))}
            <option value={chanLabel(c.name, c.number)}></option>
          {/each}
        </datalist>
      {/if}
    </div>

    <div style="display:flex;gap:8px;align-items:center;margin-top:16px">
      {#if ondelete}
        <button class="danger" onclick={ondelete}>{deleteLabel}</button>
      {/if}
      <span style="flex:1"></span>
      <button onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={save} disabled={!hasChanges}>{saveLabel}</button>
    </div>
  </div>
</div>
