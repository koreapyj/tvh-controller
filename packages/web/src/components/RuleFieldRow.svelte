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
  import { WEEKDAY_LABELS } from '../lib/format.js';
  import { needsOverrideToggle, type FieldSpec } from '../lib/ruleFields.js';

  // One form row for a rule field (apply-checkbox · label · control · muted
  // help). Three modes share the markup:
  //   batch   — apply-checkbox per field; controls disabled until ticked
  //   plain   — direct edit; '' selects the default
  //   overlay — '' inherits from the parent (shown via inheritPlaceholder),
  //             unless the field's Override checkbox forces an explicit
  //             empty value ('' = Any)
  // The control value is always a string ('' = untouched/inherit); the shells
  // convert with parseFieldValue / resolveChannelPick on save.

  let {
    spec,
    mode = 'batch',
    value = $bindable(''),
    apply = $bindable(false),
    inheritPlaceholder = undefined,
    hint = '',
    datalistId = undefined,
    override = $bindable(false),
  }: {
    spec: FieldSpec;
    mode?: 'batch' | 'plain' | 'overlay';
    value?: string;
    /** batch mode only: whether this field is applied */
    apply?: boolean;
    /** overlay mode: formatted parent value; single edit: '(multiple values)' */
    inheritPlaceholder?: string;
    /** extra muted hint (e.g. EIT time conversion) */
    hint?: string;
    /** channel rows: id of a datalist rendered by the shell */
    datalistId?: string;
    /**
     * overlay mode, needsOverrideToggle types (str/time/weekdays): the
     * Override-checkbox state. Bindable so the shell can tell "override on
     * with a blank control" (emit ''/[] = Any) apart from "inherit" ('' value
     * in both cases). Unbound callers get the same local behavior as before.
     */
    override?: boolean;
  } = $props();

  const disabled = $derived(mode === 'batch' && !apply);
  const showOverride = $derived(mode === 'overlay' && needsOverrideToggle(spec));
  // a checked-but-blank field is explicitly empty (Any), not inheriting —
  // show the spec's own placeholder instead of the parent value
  const placeholder = $derived(
    showOverride && override
      ? (spec.placeholder ?? '')
      : (inheritPlaceholder ?? spec.placeholder ?? ''),
  );

  // enum: label of the payload-default option for the plain-mode '' entry
  const defaultOptionLabel = $derived.by(() => {
    const opts = spec.options ?? [];
    const init = spec.initial ?? String(opts[0]?.value ?? '');
    return opts.find((o) => String(o.value) === init)?.label ?? '';
  });

  // weekdays: value is a CSV of selected day numbers (1 = Mon … 7 = Sun)
  const days = $derived(
    value
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => n >= 1 && n <= 7),
  );
  // overlay mode: unchecked = inherit ('' stays omitted). Typing/seeding a
  // non-empty value auto-checks the override; unchecking clears the value
  // first, so this never re-fires against it.
  $effect(() => {
    if (value !== '') override = true;
  });
  const wdEnabled = $derived(mode === 'overlay' ? override : !disabled);

  function toggleDay(d: number): void {
    const next = days.includes(d)
      ? days.filter((x) => x !== d)
      : [...days, d].sort((a, b) => a - b);
    value = next.join(',');
  }

  // ticking a weekdays row seeds every day; text rows stay blank (= Any)
  function toggleOverride(on: boolean): void {
    override = on;
    value = on && spec.type === 'weekdays' ? '1,2,3,4,5,6,7' : '';
  }
</script>

<div style="display:flex;gap:10px;align-items:center">
  {#if mode === 'batch'}
    <input type="checkbox" bind:checked={apply} title="apply this field" />
  {/if}
  <label for="bf-{spec.key}" style="margin:0;width:150px;flex:none">{spec.label}</label>
  {#if spec.type === 'bool'}
    <select id="bf-{spec.key}" style="width:auto" {disabled} bind:value>
      {#if mode !== 'batch'}
        <option value="">
          {mode === 'overlay' ? `inherit (${inheritPlaceholder ?? ''})` : '(default)'}
        </option>
      {/if}
      <option value="yes">yes</option>
      <option value="no">no</option>
    </select>
  {:else if spec.type === 'enum'}
    <select id="bf-{spec.key}" style="width:auto" {disabled} bind:value>
      {#if mode !== 'batch'}
        <option value="">
          {mode === 'overlay'
            ? `inherit (${inheritPlaceholder ?? ''})`
            : `(default: ${defaultOptionLabel})`}
        </option>
      {/if}
      {#each spec.options ?? [] as o (o.value)}
        <option value={String(o.value)}>{o.label}</option>
      {/each}
    </select>
  {:else if spec.type === 'weekdays'}
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      {#if mode === 'overlay'}
        <input
          type="checkbox"
          style="width:auto"
          checked={override}
          onchange={(e) => toggleOverride(e.currentTarget.checked)}
          title="override the inherited value"
          aria-label="override {spec.label}"
        />
      {/if}
      {#if mode !== 'overlay' || override}
        {#each WEEKDAY_LABELS as label, i}
          <button
            type="button"
            class:primary={days.includes(i + 1)}
            disabled={!wdEnabled}
            onclick={() => toggleDay(i + 1)}
          >
            {label}
          </button>
        {/each}
      {:else}
        <span class="muted small">inherited: {inheritPlaceholder ?? 'every day'}</span>
      {/if}
    </div>
  {:else if spec.type === 'channel'}
    <input id="bf-{spec.key}" style="flex:1" list={datalistId} {placeholder} {disabled} bind:value />
  {:else}
    {#if showOverride}
      <input
        type="checkbox"
        style="width:auto;flex:none"
        checked={override}
        onchange={(e) => toggleOverride(e.currentTarget.checked)}
        title="tick with a blank field to explicitly clear it (Any) instead of inheriting"
        aria-label="override {spec.label}"
      />
    {/if}
    <input
      id="bf-{spec.key}"
      style="flex:1"
      inputmode={spec.type === 'int' ? 'numeric' : undefined}
      {placeholder}
      {disabled}
      bind:value
    />
  {/if}
  {#if hint}<span class="muted small">{hint}</span>{/if}
  {#if spec.help}<span class="muted small">{spec.help}</span>{/if}
</div>
