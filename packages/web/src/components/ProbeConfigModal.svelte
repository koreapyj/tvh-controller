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
  import type { NodeProbeSettings, NodeSettings } from '@tvhc/shared';
  import {
    initialDelayToInput,
    maxSessionsToInput,
    parseInitialDelayInput,
    parseMaxSessionsInput,
  } from '../lib/nodeCapacity.js';
  import { buildProbesPayload, PROBE_FIELDS, PROBE_GROUPS, probesToVals } from '../lib/probeFields.js';

  // Pure form — no fetching in here; the page loads `initial`/`initialSettings`
  // and fans the single onsave out to both PUTs.

  let {
    nodeLabel,
    initial,
    initialSettings,
    onsave,
    oncancel,
  }: {
    nodeLabel: string;
    initial: NodeProbeSettings;
    initialSettings: NodeSettings;
    onsave: (payload: { probes: NodeProbeSettings; settings: NodeSettings }) => void;
    oncancel: () => void;
  } = $props();

  let vals: Record<string, string> = $state(probesToVals(initial));
  let maxSessionsVal = $state(maxSessionsToInput(initialSettings.maxSessions));
  let initialDelayVal = $state(initialDelayToInput(initialSettings.initialDelaySec));
  let formError = $state('');

  function save(): void {
    formError = '';
    const maxSessions = parseMaxSessionsInput(maxSessionsVal);
    if (maxSessions === undefined) {
      formError = 'Max sessions must be a non-negative integer, or blank for uncapped';
      return;
    }
    const initialDelaySec = parseInitialDelayInput(initialDelayVal);
    if (initialDelaySec === undefined) {
      formError = 'On-demand start delay must be a positive integer number of seconds, or blank for the default';
      return;
    }
    const built = buildProbesPayload($state.snapshot(vals));
    if (!built.ok) {
      formError = built.error;
      return;
    }
    onsave({ probes: built.payload, settings: { maxSessions, initialDelaySec } });
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={`Node settings: ${nodeLabel}`}>
    <h2 style="margin-top:0">Node settings: {nodeLabel}</h2>
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
        <div>
          <b class="small">Capacity</b>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <label for="pc-max-sessions" style="margin:0;width:160px;flex:none">Max sessions</label>
          <input
            id="pc-max-sessions"
            style="flex:1"
            inputmode="numeric"
            placeholder="uncapped"
            bind:value={maxSessionsVal}
          />
        </div>
        <div class="muted small">
          Benchmark: ramp sessions until speed/lag degrade, then set 1–2 below the stable max — that
          margin is what failover and profile-cutover admissions consume. Empty = uncapped.
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <label for="pc-initial-delay" style="margin:0;width:160px;flex:none">On-demand start delay</label>
          <input
            id="pc-initial-delay"
            style="flex:1"
            inputmode="numeric"
            placeholder="default (30 s)"
            bind:value={initialDelayVal}
          />
        </div>
        <div class="muted small">
          Delay before an on-demand channel's encode is stopped again if the viewer never starts
          playback after opening it. Blank = 30 s.
        </div>
      </div>
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
