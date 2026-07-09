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
  import type { NodeProbeSettings } from '@tvhc/shared';
  import { buildProbesPayload, PROBE_FIELDS, PROBE_GROUPS, probesToVals } from '../lib/probeFields.js';

  // Per-node probe threshold editor: one bordered group per probe (liveness /
  // underspeed / lag), mirroring RestreamProfileModal's section
  // styling. Pure form — no fetching in here; the page loads `initial` and
  // performs the PUT after onsave.

  let {
    nodeLabel,
    initial,
    onsave,
    oncancel,
  }: {
    nodeLabel: string;
    initial: NodeProbeSettings;
    onsave: (payload: NodeProbeSettings) => void;
    oncancel: () => void;
  } = $props();

  let vals: Record<string, string> = $state(probesToVals(initial));
  let formError = $state('');

  function save(): void {
    formError = '';
    const built = buildProbesPayload($state.snapshot(vals));
    if (!built.ok) {
      formError = built.error;
      return;
    }
    onsave(built.payload);
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={`Probe settings: ${nodeLabel}`}>
    <h2 style="margin-top:0">Probe settings: {nodeLabel}</h2>
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    <div style="display:flex;flex-direction:column;gap:10px">
      {#each PROBE_GROUPS as group (group.key)}
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
          <div>
            <b class="small">{group.label}</b>
            <span class="muted small">— {group.help}</span>
          </div>
          {#each PROBE_FIELDS[group.key] as f (f.key)}
            <div style="display:flex;gap:10px;align-items:center">
              <label for="pc-{group.key}-{f.key}" style="margin:0;width:160px;flex:none">{f.label}</label>
              <input
                id="pc-{group.key}-{f.key}"
                style="flex:1"
                inputmode="decimal"
                bind:value={vals[`${group.key}.${f.key}`]}
              />
            </div>
          {/each}
        </div>
      {/each}
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={save}>Save</button>
    </div>
  </div>
</div>
