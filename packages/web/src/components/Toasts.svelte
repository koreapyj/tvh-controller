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
  import { notify, toasts } from '../lib/notifications.js';
</script>

<div class="toast-host" aria-live="polite">
  {#each $toasts as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <span class="msg">{t.message}</span>
      {#if t.action}
        <button class="action" onclick={t.action.onclick}>{t.action.label}</button>
      {/if}
      <button class="close" aria-label="Dismiss notification" onclick={() => notify.dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toast-host {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 380px;
    width: calc(100vw - 32px);
    pointer-events: none;
  }

  @media (max-width: 768px) {
    .toast-host {
      top: auto;
      bottom: 12px;
      left: 8px;
      right: 8px;
      max-width: none;
      width: auto;
    }
  }

  .toast {
    pointer-events: auto;
    background: var(--panel2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .toast.error { border-color: var(--bad); color: var(--bad); }
  .toast.success { border-color: var(--ok); }
  .toast.info { border-color: var(--accent); }

  .msg { flex: 1; overflow-wrap: anywhere; }

  .close {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
  }
  .close:hover { color: var(--text); }

  .action { flex-shrink: 0; }
</style>
