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
  import { chanKey, chanLabel, chanNumberOrder, type ChannelOption, type MasterRulePayload, type RuleInstances } from '@tvhc/shared';
  import RuleFieldRow from '../components/RuleFieldRow.svelte';
  import type { RuleInput } from '../lib/api.js';
  import { parseChannelInput, resolveChannelPick } from '../lib/channelPick.js';
  import { conversionFor, toEitTime } from '../lib/eit.js';
  import { buildRulePatch, formatFieldValue, needsOverrideToggle, RULE_FIELD_SPECS, RULE_PAYLOAD_DEFAULTS, type FieldSpec } from '../lib/ruleFields.js';
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
  const rowMode = $derived(overlayMode ? ('overlay' as const) : ('plain' as const));

  const base = $derived((parentPayload ?? null) as MasterRulePayload | null);

  // form state: one string per field spec; '' = inherit (overlay mode) /
  // default (plain mode). The channel value may be a full identity label
  // ("N　Name") — resolveChannelPick maps it back to {channel, channel_number}.
  let name = $state('');
  let vals: Record<string, string> = $state({});
  /**
   * per-field Override checkboxes (overlay mode, needsOverrideToggle types):
   * on ⇒ the key is written even when blank ('' = Any); off ⇒ inherit.
   * Plain mode only uses the weekdays entry, which it forces on.
   */
  let overrides: Record<string, boolean> = $state({});
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
    for (const f of RULE_FIELD_SPECS) {
      const v = source?.[f.key as keyof MasterRulePayload];
      vals[f.key] = v !== undefined && v !== null ? formatFieldValue(f, v) : '';
      // key presence — even with an empty value ('' = Any) — turns the field's
      // override on, so an explicit-empty overlay round-trips instead of
      // collapsing into "inherit". Always a boolean: rows bind the entry, and
      // binding undefined to a prop with a fallback is a runtime error.
      overrides[f.key] = needsOverrideToggle(f) && v !== undefined && v !== null;
    }
    // weekdays: empty = every day in our model, shown as all seven selected
    if (overrides.weekdays && source?.weekdays) {
      vals.weekdays = source.weekdays.length ? source.weekdays.join(',') : '1,2,3,4,5,6,7';
    }
    if (!overlayMode && !overrides.weekdays) {
      // plain mode always edits weekdays; default to every day (all selected)
      overrides.weekdays = true;
      vals.weekdays = '1,2,3,4,5,6,7';
    }
    // seed the channel input with the full identity label when the source
    // carries its own pinned number (absent on legacy overlays that
    // predate channel numbers, or when the source targets "any number").
    if (source?.channel && source.channel_number != null) {
      vals.channel = chanLabel(String(source.channel), source.channel_number);
    }
  }

  function ph(field: keyof MasterRulePayload, fallback = ''): string {
    if (base) {
      const v = base[field];
      if (Array.isArray(v)) return v.length ? v.join(',') : 'every day';
      if (typeof v === 'boolean') return v ? 'yes' : 'no';
      return String(v ?? '') || fallback;
    }
    return fallback;
  }

  /** overlay mode: the formatted parent value shown as the inherit placeholder */
  function inheritText(f: FieldSpec): string | undefined {
    if (!overlayMode || !base) return undefined;
    if (f.type === 'enum') {
      const v = base[f.key as keyof MasterRulePayload];
      return f.options?.find((o) => o.value === v)?.label ?? String(v ?? '');
    }
    return ph(f.key as keyof MasterRulePayload, f.placeholder ?? '');
  }

  function toggleInstance(id: string): void {
    selectedInstances = selectedInstances.includes(id)
      ? selectedInstances.filter((x) => x !== id)
      : [...selectedInstances, id];
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
    const chanRaw = vals.channel ?? '';
    if (chanRaw !== '' && !resolveChannelPick(chanRaw, channels)) {
      formError = 'channel not found on any instance — pick one from the list';
      return;
    }
    const built = buildRulePatch(RULE_FIELD_SPECS, vals, {
      mode: overlayMode ? 'overlay' : 'plain',
      overrides: $state.snapshot(overrides),
    });
    if (!built.ok) {
      formError = built.error;
      return;
    }
    const patch = built.patch;
    // channel + channel_number are always written together; a non-empty
    // channel input was validated above to resolve to a real channel
    if (chanRaw !== '') {
      const pick = resolveChannelPick(chanRaw, channels)!;
      patch.channel = pick.name;
      patch.channel_number = pick.number;
    } else if (overlayMode && overrides.channel) {
      // Override checked with a blank input: explicitly any channel
      patch.channel = '';
      patch.channel_number = null;
    }
    const instancesOut: RuleInstances = allInstances ? 'all' : [...selectedInstances];
    if (overlayMode) {
      onsave({ name: name.trim(), instances: instancesOut, overlay: patch });
    } else {
      onsave({
        name: name.trim(),
        instances: instancesOut,
        payload: { ...RULE_PAYLOAD_DEFAULTS, ...patch, name },
      });
    }
  }

  const channels: ChannelOption[] = $derived($channelOptions);

  const picked = $derived(parseChannelInput(vals.channel ?? '', channels));
  // effective identity: typed value, else the inherited parent pair (overlay
  // mode, unless the channel override forces "any channel")
  const effPick = $derived(
    vals.channel
      ? picked
      : overlayMode && !overrides.channel && base?.channel
        ? { name: base.channel, number: base.channel_number ?? null }
        : { name: '', number: null },
  );
  const matchedChannels = $derived(channels.filter((c) => c.name === effPick.name));
  const pinnedChannel = $derived(
    effPick.number !== null ? (matchedChannels.find((c) => c.number === effPick.number) ?? null) : null,
  );
  // an unpinned pick targets the lowest-numbered same-name channel (numberless
  // last) — mirror channelSetterValue so the editor shows the real target
  const effectiveChannel = $derived(
    pinnedChannel ??
      (matchedChannels.length
        ? matchedChannels.reduce((a, b) =>
            chanNumberOrder(b.number) < chanNumberOrder(a.number) ? b : a,
          )
        : null),
  );
  const matchedInstances = $derived(effectiveChannel?.instances ?? []);
  const scopeIds = $derived(allInstances ? $instances.map((i) => i.id) : selectedInstances);
  const missingOn = $derived(
    matchedChannels.length ? scopeIds.filter((id) => !matchedInstances.includes(id)) : [],
  );

  const conv = $derived(
    conversionFor(effPick.name, effPick.number ?? (effectiveChannel?.number ?? null), $channelOptions, $instances),
  );

  function eitHint(hhmm: string): string {
    if (!conv || !hhmm) return '';
    const t = toEitTime(hhmm, conv);
    return t ? `= ${t.time} EIT` : '';
  }

  /** EIT hint for the start/start_window rows (typed value, else the inherited one) */
  function hintFor(f: FieldSpec): string {
    if (f.key !== 'start' && f.key !== 'start_window') return '';
    const key = f.key as 'start' | 'start_window';
    return eitHint(vals[key] || (overlayMode && !overrides[key] ? ph(key) : ''));
  }

  // a typed channel auto-checks its override (mirrors RuleFieldRow's rule);
  // unchecking clears the input first, so this never re-fires against it
  $effect(() => {
    if (vals.channel) overrides.channel = true;
  });

  /** the inherited parent channel, shown with its pinned number when known */
  const channelPlaceholder = $derived(
    base?.channel && !overrides.channel
      ? chanLabel(base.channel, base.channel_number ?? null)
      : 'Any channel',
  );
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label={initialName ? `Edit ${initialName}` : 'New autorec rule'}
  >
    <h2 style="margin-top:0">
      {initialName ? `Edit: ${initialName}` : overlayMode ? 'New linked clone' : 'New autorec rule'}
      {#if overlayMode}<span class="badge info">linked: {parentName}</span>{/if}
    </h2>
    {#if overlayMode}
      <p class="muted small" style="margin-top:0">
        Empty fields inherit from <b>{parentName}</b> (inherited values shown as placeholders);
        filled fields override. Tick <b>Override</b> with a blank field to explicitly clear it
        (Any) instead of inheriting.
      </p>
    {/if}
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:10px;align-items:center">
        <label for="re-name" style="margin:0;width:150px;flex:none">Name</label>
        <input id="re-name" style="flex:1" bind:value={name} />
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <span style="width:150px;flex:none">Instances</span>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
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

      {#each RULE_FIELD_SPECS as f, i (f.key)}
        {#if f.section && f.section !== RULE_FIELD_SPECS[i - 1]?.section}
          <div class="muted small" style="margin-top:8px;text-transform:uppercase;font-size:11px">
            {f.section}
          </div>
        {/if}
        {#if f.key === 'channel'}
          <!-- bespoke channel block: datalist picker + per-instance diagnostics -->
          <div style="display:flex;gap:10px;align-items:flex-start">
            <label for="re-channel" style="margin:0;width:150px;flex:none;padding-top:6px">
              Channel
            </label>
            {#if overlayMode}
              <input
                type="checkbox"
                style="width:auto;flex:none;margin-top:6px"
                checked={overrides.channel ?? false}
                onchange={(e) => {
                  overrides.channel = e.currentTarget.checked;
                  vals.channel = '';
                }}
                title="tick with a blank field to explicitly match any channel instead of inheriting"
                aria-label="override channel"
              />
            {/if}
            <div style="flex:1">
              <input
                id="re-channel"
                style="width:100%"
                bind:value={vals.channel}
                list="channel-options"
                placeholder={channelPlaceholder}
              />
              <datalist id="channel-options">
                {#each channels as c (chanKey(c.name, c.number))}
                  <option value={chanLabel(c.name, c.number)}></option>
                {/each}
              </datalist>
              {#if effectiveChannel}
                <div class="muted small">
                  {chanLabel(effectiveChannel.name, effectiveChannel.number)}{#if effPick.number === null && effectiveChannel.number !== null}&nbsp;(lowest — will be pinned on save){/if}
                  · on {matchedInstances.join(', ')}
                  {#if missingOn.length}<span style="color:var(--warn)"> — missing on {missingOn.join(', ')}</span>{/if}
                </div>
              {:else if effPick.name}
                <div class="small" style="color:var(--bad)">channel not found on any instance — pick one from the list</div>
              {/if}
            </div>
            {#if !overlayMode}<span class="muted small" style="padding-top:6px">{f.help}</span>{/if}
          </div>
        {:else}
          <RuleFieldRow
            spec={f}
            mode={rowMode}
            bind:value={vals[f.key]}
            bind:override={overrides[f.key]}
            inheritPlaceholder={inheritText(f)}
            hint={hintFor(f)}
          />
        {/if}
      {/each}
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={save} disabled={!name.trim()}>Save</button>
    </div>
  </div>
</div>
