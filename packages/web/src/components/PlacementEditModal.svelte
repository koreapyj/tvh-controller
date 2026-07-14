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
  import type { RestreamProfile } from '@tvhc/shared';
  import { parsePositiveInt, type StagedPlacement } from '../lib/placementStaging.js';

  // Per-placement editor stacked on top of RestreamChannelModal: program
  // number (manual service-SID override; blank = derived) and the
  // per-placement profile override (blank = inherit the channel's profile).
  // Mirrors the RestreamProfileModal / profile-clone dialog skeleton.

  let {
    placement,
    profiles,
    title,
    onsave,
    oncancel,
  }: {
    placement: StagedPlacement;
    profiles: RestreamProfile[];
    title: string;
    onsave: (patch: { programNumber: string; profileId: string }) => void;
    oncancel: () => void;
  } = $props();

  let programNumber = $state(placement.programNumber);
  let profileId = $state(placement.profileId);
  let formError = $state('');

  function save(): void {
    formError = '';
    const trimmed = programNumber.trim();
    if (parsePositiveInt(trimmed) === undefined) {
      formError = 'program number must be a positive integer, or blank';
      return;
    }
    onsave({ programNumber: trimmed, profileId });
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div
  class="modal-backdrop"
  role="presentation"
  style="z-index:11"
  onclick={(e) => e.target === e.currentTarget && oncancel()}
>
  <div class="modal" style="width:480px" role="dialog" aria-modal="true" aria-label={title}>
    <h2 style="margin-top:0">{title}</h2>
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:10px;align-items:center">
        <label for="pe-program" style="margin:0;width:150px;flex:none">Program number</label>
        <input
          id="pe-program"
          style="width:120px"
          inputmode="numeric"
          placeholder="(derived)"
          bind:value={programNumber}
        />
      </div>

      <div style="display:flex;gap:10px;align-items:center">
        <label for="pe-profile" style="margin:0;width:150px;flex:none">Profile</label>
        <select id="pe-profile" style="width:auto" bind:value={profileId}>
          <option value="">(channel default)</option>
          {#each profiles as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </div>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={save}>Save</button>
    </div>
  </div>
</div>
