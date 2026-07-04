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
  import type { FieldSpec } from './batchFields.js';

  // tvheadend-style batch edit: a checkbox per field — only ticked fields are
  // written. An optional instance selector (recordings only) doubles as the
  // per-instance enable/disable control.

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
      const init = mode === 'single' ? (initialValues[f.key] ?? '') : f.type === 'bool' ? 'yes' : '';
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
      if (f.type === 'bool') {
        out[f.key] = vals[f.key] === 'yes';
      } else if (f.type === 'int') {
        if (vals[f.key] === '') {
          if (mode === 'single') continue; // cleared = leave unchanged
          formError = `"${f.label}" must be a number`;
          return;
        }
        const n = Number(vals[f.key]);
        if (Number.isNaN(n)) {
          formError = `"${f.label}" must be a number`;
          return;
        }
        out[f.key] = n;
      } else {
        out[f.key] = vals[f.key];
      }
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
  <div class="modal" style="width:560px" role="dialog" aria-modal="true" aria-label={title}>
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
      {#each fields as f (f.key)}
        <div style="display:flex;gap:10px;align-items:center">
          {#if mode === 'batch'}
            <input type="checkbox" bind:checked={apply[f.key]} title="apply this field" />
          {/if}
          <label for="bf-{f.key}" style="margin:0;width:150px;flex:none">{f.label}</label>
          {#if f.type === 'bool'}
            <select
              id="bf-{f.key}"
              style="width:auto"
              disabled={mode === 'batch' && !apply[f.key]}
              bind:value={vals[f.key]}
            >
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          {:else}
            <input
              id="bf-{f.key}"
              style="flex:1"
              inputmode={f.type === 'int' ? 'numeric' : undefined}
              placeholder={mode === 'single' && differingKeys.includes(f.key)
                ? '(multiple values)'
                : (f.placeholder ?? '')}
              disabled={mode === 'batch' && !apply[f.key]}
              bind:value={vals[f.key]}
            />
          {/if}
          {#if f.help}<span class="muted small">{f.help}</span>{/if}
        </div>
      {/each}
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
