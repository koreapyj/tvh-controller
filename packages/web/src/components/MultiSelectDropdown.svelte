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
  // Searchable multi-select dropdown (the EPG channel filter pattern, extracted
  // so EPG, Recordings and Rules share one implementation).
  interface Option {
    value: string;
    label: string;
    /** optional text the search box matches against (defaults to label) */
    search?: string;
  }

  let {
    options,
    selected,
    onchange,
    allLabel = 'All',
    unit = 'selected',
    searchPlaceholder = 'Search…',
  }: {
    options: Option[];
    selected: string[];
    onchange: (next: string[]) => void;
    allLabel?: string;
    unit?: string;
    searchPlaceholder?: string;
  } = $props();

  let search = $state('');
  let searchInput: HTMLInputElement | undefined = $state();

  const filtered = $derived.by(() => {
    const s = search.trim().toLowerCase();
    if (!s) return options;
    return options.filter((o) => (o.search ?? o.label).toLowerCase().includes(s));
  });

  function toggle(value: string): void {
    onchange(
      selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value],
    );
  }
</script>

<details
  class="ms-filter"
  ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && searchInput?.focus()}
>
  <summary>{selected.length ? `${selected.length} ${unit}` : allLabel}</summary>
  <div class="ms-list">
    <div class="ms-search">
      <input bind:this={searchInput} placeholder={searchPlaceholder} bind:value={search} aria-label="Search" />
      {#if selected.length}
        <button class="linklike" onclick={() => onchange([])}>Clear ({selected.length})</button>
      {/if}
    </div>
    {#each filtered as o (o.value)}
      <label>
        <input type="checkbox" checked={selected.includes(o.value)} onchange={() => toggle(o.value)} />
        {o.label}
      </label>
    {/each}
    {#if !filtered.length}<div class="muted small" style="padding:4px">No matches.</div>{/if}
  </div>
</details>

<style>
  .ms-filter {
    position: relative;
  }
  .ms-filter > summary {
    list-style: none;
    cursor: pointer;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    white-space: nowrap;
  }
  .ms-filter > summary::-webkit-details-marker {
    display: none;
  }
  .ms-list {
    position: absolute;
    z-index: 20;
    margin-top: 4px;
    min-width: 220px;
    max-height: 320px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .ms-search {
    position: sticky;
    top: -8px;
    background: var(--panel);
    padding: 4px 0 6px;
    margin: -8px 0 2px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ms-search input {
    flex: 1;
  }
  .ms-list label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px;
    white-space: nowrap;
    cursor: pointer;
  }
  .ms-list label:hover {
    background: var(--panel2);
  }
</style>
