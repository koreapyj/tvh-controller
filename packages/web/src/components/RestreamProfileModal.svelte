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
  import type { AribHlsParams, RestreamProfile } from '@tvhc/shared';
  import {
    addAudioRow,
    AUDIO_ENTRY_FIELDS,
    buildProfilePayload,
    defaultProfilePayload,
    MAX_AUDIO_ENTRIES,
    MIN_AUDIO_ENTRIES,
    PROFILE_FIELDS,
    profileToVals,
    removeAudioRow,
    type ProfileFieldSpec,
  } from '../lib/restreamFields.js';

  // Encoding-profile editor: PROFILE_FIELDS knobs + a 1..4 audio-output row
  // model. Blank knobs are omitted from the payload so the daemon template's
  // production defaults apply (shown as placeholders).

  let {
    profile = null,
    onsave,
    oncancel,
  }: {
    /** null = create */
    profile?: RestreamProfile | null;
    onsave: (out: { name: string; payload: AribHlsParams }) => void;
    oncancel: () => void;
  } = $props();

  let name = $state(profile?.name ?? '');
  let form = $state(profileToVals((profile?.payload as AribHlsParams) ?? defaultProfilePayload()));
  let formError = $state('');

  // audio rows sit between the Video and Subtitles sections
  const videoFields = PROFILE_FIELDS.filter((f) => f.section === 'Video');
  const restFields = PROFILE_FIELDS.filter((f) => f.section !== 'Video');

  function save(): void {
    formError = '';
    if (!name.trim()) {
      formError = 'name is required';
      return;
    }
    const built = buildProfilePayload($state.snapshot(form));
    if (!built.ok) {
      formError = built.error;
      return;
    }
    onsave({ name: name.trim(), payload: built.payload });
  }
</script>

{#snippet fieldControl(f: ProfileFieldSpec, vals: Record<string, string>, idPrefix: string)}
  {#if f.type === 'strenum'}
    <select id="{idPrefix}{f.path}" style="width:auto" bind:value={vals[f.path]}>
      {#each f.options ?? [] as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  {:else if f.type === 'bool'}
    <select id="{idPrefix}{f.path}" style="width:auto" bind:value={vals[f.path]}>
      <option value="">(default{f.placeholder ? `: ${f.placeholder}` : ''})</option>
      <option value="yes">yes</option>
      <option value="no">no</option>
    </select>
  {:else}
    <input
      id="{idPrefix}{f.path}"
      style="flex:1"
      inputmode={f.type === 'int' || f.type === 'num' ? 'numeric' : undefined}
      placeholder={f.placeholder ?? ''}
      bind:value={vals[f.path]}
    />
  {/if}
{/snippet}

{#snippet fieldRow(f: ProfileFieldSpec, vals: Record<string, string>, idPrefix: string)}
  <div style="display:flex;gap:10px;align-items:center">
    <label for="{idPrefix}{f.path}" style="margin:0;width:150px;flex:none">{f.label}</label>
    {@render fieldControl(f, vals, idPrefix)}
    {#if f.help}<span class="muted small">{f.help}</span>{/if}
  </div>
{/snippet}

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label={profile ? `Edit profile ${profile.name}` : 'New encoding profile'}
  >
    <h2 style="margin-top:0">{profile ? `Edit profile: ${profile.name}` : 'New encoding profile'}</h2>
    <p class="muted small" style="margin-top:0">
      Knobs of the <code>arib-hls</code> pipeline template. Blank fields use the template's
      production defaults (shown as placeholders).
    </p>
    {#if formError}<div class="error-banner">{formError}</div>{/if}

    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:10px;align-items:center">
        <label for="rp-name" style="margin:0;width:150px;flex:none">Name</label>
        <input id="rp-name" style="flex:1" bind:value={name} />
      </div>

      <div class="muted small" style="margin-top:8px;text-transform:uppercase;font-size:11px">Video</div>
      {#each videoFields as f (f.path)}
        {@render fieldRow(f, form.vals, 'rp-')}
      {/each}

      <div class="muted small" style="margin-top:8px;text-transform:uppercase;font-size:11px">
        Audio outputs ({MIN_AUDIO_ENTRIES}–{MAX_AUDIO_ENTRIES})
      </div>
      {#each form.audio as row, i (i)}
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center">
            <b class="small">Audio {i + 1}</b>
            <span style="flex:1"></span>
            <button
              class="danger"
              disabled={form.audio.length <= MIN_AUDIO_ENTRIES}
              onclick={() => (form.audio = removeAudioRow(form.audio, i))}
            >
              Remove
            </button>
          </div>
          {#each AUDIO_ENTRY_FIELDS as f (f.path)}
            {@render fieldRow(f, row, `rp-a${i}-`)}
          {/each}
        </div>
      {/each}
      <div>
        <button
          disabled={form.audio.length >= MAX_AUDIO_ENTRIES}
          onclick={() => (form.audio = addAudioRow(form.audio))}
        >
          Add audio output
        </button>
      </div>

      {#each restFields as f, i (f.path)}
        {#if f.section && f.section !== restFields[i - 1]?.section}
          <div class="muted small" style="margin-top:8px;text-transform:uppercase;font-size:11px">
            {f.section}
          </div>
        {/if}
        {@render fieldRow(f, form.vals, 'rp-')}
      {/each}
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button onclick={oncancel}>Cancel</button>
      <button class="primary" onclick={save} disabled={!name.trim()}>Save</button>
    </div>
  </div>
</div>
