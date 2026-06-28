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

  interface InstanceSelector {
    instances: { id: string; name: string }[];
    /** current per-instance enabled state; 'mixed' across a batch */
    initial: Record<string, boolean | 'mixed'>;
  }

  let {
    title,
    subtitle = '',
    fields,
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
    instanceSelector?: InstanceSelector | null;
    saveLabel?: string;
    onsave: (out: { fields: Record<string, unknown>; instanceEnabled: Record<string, boolean> }) => void;
    oncancel: () => void;
    ondelete?: (() => void) | null;
    deleteLabel?: string;
  } = $props();

  let apply: Record<string, boolean> = $state({});
  let vals: Record<string, string> = $state({});
  let instChecked: Record<string, boolean> = $state({});
  let instTouched: Record<string, boolean> = $state({});
  let formError = $state('');

  // one-time init
  {
    for (const f of fields) {
      apply[f.key] = false;
      vals[f.key] = f.type === 'bool' ? 'yes' : '';
    }
    if (instanceSelector) {
      for (const inst of instanceSelector.instances) {
        const cur = instanceSelector.initial[inst.id];
        instChecked[inst.id] = cur === true;
        instTouched[inst.id] = false;
      }
    }
  }

  function isMixed(id: string): boolean {
    return instanceSelector?.initial[id] === 'mixed' && !instTouched[id];
  }

  function toggleInstance(id: string, checked: boolean): void {
    instChecked[id] = checked;
    instTouched[id] = true;
  }

  const hasChanges = $derived(
    Object.values(apply).some(Boolean) || Object.values(instTouched).some(Boolean),
  );

  function save(): void {
    formError = '';
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (!apply[f.key]) continue;
      if (f.type === 'bool') {
        out[f.key] = vals[f.key] === 'yes';
      } else if (f.type === 'int') {
        const n = Number(vals[f.key]);
        if (vals[f.key] === '' || Number.isNaN(n)) {
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
        if (instTouched[inst.id]) instanceEnabled[inst.id] = instChecked[inst.id];
      }
    }
    if (!Object.keys(out).length && !Object.keys(instanceEnabled).length) {
      formError = 'nothing to apply — tick a field or change an instance';
      return;
    }
    onsave({ fields: out, instanceEnabled });
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal" style="width:560px">
    <h2 style="margin-top:0">{title}</h2>
    {#if subtitle}<p class="muted small" style="margin-top:0">{subtitle}</p>{/if}
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    {#if instanceSelector}
      <div style="margin-bottom:14px">
        <div style="margin-bottom:4px">Instances <span class="muted small">(unchecked = disabled on that instance)</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:6px">
          {#each instanceSelector.instances as inst (inst.id)}
            <label style="display:flex;gap:6px;align-items:center;margin:0">
              <input
                type="checkbox"
                checked={instChecked[inst.id]}
                indeterminate={isMixed(inst.id)}
                onchange={(e) => toggleInstance(inst.id, e.currentTarget.checked)}
              />
              {inst.name}
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="muted small">Tick a field to apply it; unticked fields are left unchanged.</div>
      {#each fields as f (f.key)}
        <div style="display:flex;gap:10px;align-items:center">
          <input type="checkbox" bind:checked={apply[f.key]} title="apply this field" />
          <label for="bf-{f.key}" style="margin:0;width:150px;flex:none">{f.label}</label>
          {#if f.type === 'bool'}
            <select id="bf-{f.key}" style="width:auto" disabled={!apply[f.key]} bind:value={vals[f.key]}>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          {:else}
            <input
              id="bf-{f.key}"
              style="flex:1"
              inputmode={f.type === 'int' ? 'numeric' : undefined}
              placeholder={f.placeholder ?? ''}
              disabled={!apply[f.key]}
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
