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
  import type { DriftItem, IgnoredOrphan, IntegrityIssue, ReconcileAction } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { dateTime } from '../lib/format.js';
  import { driftItems, instances } from '../lib/stores.js';
  import RuleDetails from '../components/RuleDetails.svelte';

  let items: DriftItem[] = $state([]);
  let ignored: IgnoredOrphan[] = $state([]);
  let error = $state('');
  let busy = $state(false);

  async function refresh(): Promise<void> {
    try {
      [items, ignored] = await Promise.all([api.drift(), api.ignoredOrphans()]);
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  let integrity: IntegrityIssue[] | null = $state(null);
  let integrityRunning = $state(false);

  async function runIntegrityCheck(): Promise<void> {
    integrityRunning = true;
    try {
      integrity = await api.integrityCheck();
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      integrityRunning = false;
    }
  }

  function issueBadge(kind: IntegrityIssue['kind']): string {
    switch (kind) {
      case 'content-mismatch': return 'warn';
      case 'missing-on-instance': case 'missing-parent': return 'bad';
      case 'out-of-scope-binding': return 'bad';
      case 'unpushed': return 'info';
      default: return 'neutral';
    }
  }

  async function unignore(o: IgnoredOrphan): Promise<void> {
    busy = true;
    try {
      await api.unignoreOrphan(o.instanceId, o.tvhUuid);
      await refresh();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    if ($driftItems !== null) items = $driftItems;
    else void refresh();
  });

  function instName(id: string): string {
    return $instances.find((i) => i.id === id)?.name ?? id;
  }

  async function act(item: DriftItem, action: ReconcileAction, confirmText?: string): Promise<void> {
    if (confirmText && !confirm(confirmText)) return;
    busy = true;
    try {
      await api.reconcile(item.id, action);
      await refresh();
      error = '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function fmt(v: unknown): string {
    if (v === '' || v === undefined || v === null) return '—';
    if (Array.isArray(v)) return v.join(', ') || '—';
    return String(v);
  }
</script>

<h1>Drift</h1>
<p class="muted small">
  The controller is the master for autorec rules; instances should be read-only. Items below were
  changed, deleted, or created directly on an instance.
</p>
{#if error}<div class="error-banner">{error}</div>{/if}

<div class="toolbar">
  <button disabled={integrityRunning} onclick={runIntegrityCheck}>
    {integrityRunning ? 'Checking…' : 'Run integrity check'}
  </button>
  <span class="muted small">
    Full baseline-free comparison against fresh instance state — finds desync the drift list
    tolerates (e.g. renames not yet pushed).
  </span>
</div>

{#if integrity !== null}
  <div class="card" style="margin-bottom:12px">
    <h3 style="margin-top:0">Integrity check {integrity.length === 0 ? '— ✓ everything matches' : `— ${integrity.length} finding(s)`}</h3>
    {#if integrity.length}
      <table>
        <thead><tr><th>Kind</th><th>Rule</th><th>Instance</th><th>Detail</th></tr></thead>
        <tbody>
          {#each integrity as issue}
            <tr>
              <td><span class="badge {issueBadge(issue.kind)}">{issue.kind}</span></td>
              <td class="small">{issue.masterRuleName ?? issue.instanceRuleName ?? '—'}</td>
              <td class="small">{issue.instanceId ?? '—'}</td>
              <td class="small muted">
                {issue.detail}
                {#if issue.diffs?.length}
                  <table class="diff-table" style="margin-top:4px">
                    <tbody>
                      {#each issue.diffs as d}
                        <tr>
                          <td><code>{d.field}</code></td>
                          <td>{fmt(d.master)}</td>
                          <td class="changed">{fmt(d.instance)}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/if}

{#if items.length === 0}
  <div class="card">✓ No drift — all instances match the master rules.</div>
{/if}

{#if ignored.length}
  <details class="group" style="margin-bottom:12px">
    <summary><b>Ignored instance-local rules</b> <span class="badge neutral">{ignored.length}</span></summary>
    <table>
      <thead><tr><th>Rule</th><th>Instance</th><th>Ignored</th><th></th></tr></thead>
      <tbody>
        {#each ignored as o (o.instanceId + o.tvhUuid)}
          <tr>
            <td>{o.name || o.tvhUuid}</td>
            <td class="small">{instName(o.instanceId)}</td>
            <td class="small muted">{dateTime(o.ignoredAt)}</td>
            <td><button disabled={busy} onclick={() => unignore(o)}>Un-ignore</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </details>
{/if}

{#each items as item (item.id)}
  <div class="card" style="margin-bottom:12px">
    <h3>
      {#if item.kind === 'modified-on-instance'}
        <span class="badge warn">modified on instance</span> {item.masterRuleName}
      {:else if item.kind === 'deleted-on-instance'}
        <span class="badge bad">deleted on instance</span> {item.masterRuleName}
      {:else}
        <span class="badge info">orphan rule</span> {item.instanceRuleName ?? item.tvhUuid}
      {/if}
      <span class="muted small">on {instName(item.instanceId)}</span>
    </h3>

    {#if item.diffs?.length}
      <h4 style="margin:10px 0 4px">Changed fields</h4>
      <table class="diff-table">
        <thead><tr><th>Field</th><th>Master</th><th>Instance</th></tr></thead>
        <tbody>
          {#each item.diffs as d}
            <tr>
              <td><code>{d.field}</code></td>
              <td>{fmt(d.master)}</td>
              <td class="changed">{fmt(d.instance)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    {#if item.kind === 'orphan' && item.instancePayload}
      <h4 style="margin:10px 0 4px">Rule as configured on {instName(item.instanceId)}</h4>
      <RuleDetails payload={item.instancePayload} compact />
      {#if item.tvhUuid}<div class="muted small" style="margin-top:4px">tvh uuid: <code>{item.tvhUuid}</code></div>{/if}
    {:else if item.kind === 'deleted-on-instance' && item.masterPayload}
      <h4 style="margin:10px 0 4px">Master rule that would be re-created</h4>
      <RuleDetails payload={item.masterPayload} compact />
    {:else if item.kind === 'modified-on-instance' && item.instancePayload}
      <details style="margin-top:8px">
        <summary class="muted small" style="cursor:pointer">Show full rule (as on instance)</summary>
        <RuleDetails payload={item.instancePayload} />
      </details>
    {/if}

    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      {#if item.kind === 'modified-on-instance'}
        <button
          class="primary"
          disabled={busy}
          title="Keeps both variants: the master stops targeting this instance and a linked clone (overriding only the differing fields) takes over its existing rule. No tvheadend writes."
          onclick={() => act(item, 'split-into-clone')}
        >
          Split into linked clone
        </button>
        <button disabled={busy} onclick={() => act(item, 'overwrite-from-master')}>
          Overwrite from master
        </button>
        <button disabled={busy} onclick={() => act(item, 'import-into-master')}>
          Import into master
        </button>
      {:else if item.kind === 'deleted-on-instance'}
        <button class="primary" disabled={busy} onclick={() => act(item, 'recreate-on-instance')}>
          Re-create on instance
        </button>
        <button
          class="danger"
          disabled={busy}
          onclick={() =>
            act(
              item,
              'delete-master',
              `Delete master rule "${item.masterRuleName}" everywhere? Scheduled recordings from this rule on other instances will be cancelled.`,
            )}
        >
          Delete master everywhere
        </button>
      {:else}
        <button class="primary" disabled={busy} onclick={() => act(item, 'adopt-orphan')}>
          Adopt as master rule
        </button>
        <button
          disabled={busy}
          title="Keep this rule on the instance as-is and stop reporting it as drift"
          onclick={() => act(item, 'ignore-orphan')}
        >
          Keep instance-local (ignore)
        </button>
        <button
          class="danger"
          disabled={busy}
          onclick={() =>
            act(
              item,
              'delete-from-instance',
              `Delete "${item.instanceRuleName}" from ${instName(item.instanceId)}? Its scheduled recordings will be cancelled.`,
            )}
        >
          Delete from instance
        </button>
      {/if}
    </div>
  </div>
{/each}
