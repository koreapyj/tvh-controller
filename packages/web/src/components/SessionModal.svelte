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
  import type { EnrichedSessionStatus, LogLine } from '@tvhc/shared';
  import { api } from '../lib/api.js';
  import { nextArmedState, type ScrollMetrics } from '../lib/autoscroll.js';
  import { errText } from '../lib/fetchGuard.js';
  import { dateTime } from '../lib/format.js';
  import { notify } from '../lib/notifications.js';
  import { sessionStateBadge } from '../lib/restreamFields.js';
  import { appendLogLine, nodeLogStreamUrl, sessionLogStreamUrl } from '../lib/sessionLog.js';

  // One session's detail: live info (lag/memory/restarts), restart /
  // reset-restarts controls, and a live-tailing log pane. The log pane opens
  // its own EventSource (no one-shot REST seed — the stream itself replays a
  // ring tail on connect) and re-seeds `lines` on every 'open' so an
  // auto-reconnect never shows the replay twice.
  //
  // `session: null` is the node-level "daemon log" variant: no per-session
  // state/lag/memory/restart controls, just the log pane tailing the
  // daemon's own log ring instead of one session's.

  let {
    instanceId,
    nodeId,
    session,
    serveUrl,
    channelId,
    onDemandStopAt,
    onclose,
  }: {
    instanceId: string;
    nodeId: string;
    session: EnrichedSessionStatus | null;
    serveUrl: string | null;
    channelId: string | null;
    onDemandStopAt: string | null;
    onclose: () => void;
  } = $props();

  let lines: LogLine[] = $state([]);
  let armed = $state(true);
  let pane: HTMLDivElement | undefined = $state();
  let busyReset = $state(false);
  let busyRestart = $state(false);
  let liveStopAt: string | null = $state(onDemandStopAt);

  // session.name is a bare placement uuid post-rename; channelSlug (resolved
  // controller-side) is what a human should see first, with the uuid kept
  // around (muted / tooltip) to disambiguate two placements of the same
  // channel mid-cutover.
  const displayName = $derived(session ? (session.channelSlug ?? session.name) : 'Daemon log');

  // deadline-only changes never trigger a `restreamer-channel` SSE publish
  // (dedup key excludes it), so keep it current with a direct poll instead
  $effect(() => {
    liveStopAt = onDemandStopAt;
  });

  $effect(() => {
    if (!channelId) return;
    const id = channelId;
    const timer = setInterval(() => {
      void api
        .restreamChannel(id)
        .then((c) => {
          liveStopAt = c.onDemandStopAt;
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    const es = new EventSource(
      session ? sessionLogStreamUrl(instanceId, nodeId, session.name) : nodeLogStreamUrl(instanceId, nodeId),
    );
    es.addEventListener('open', () => {
      lines = []; // dedup the replayed ring tail across auto-reconnects
    });
    es.addEventListener('log', (e) => {
      lines = appendLogLine(lines, JSON.parse((e as MessageEvent).data) as LogLine);
    });
    es.addEventListener('end', () => {
      es.close();
    });
    return () => es.close();
  });

  // autoscroll: stick to the bottom while armed, whenever new lines land
  $effect(() => {
    void lines.length;
    if (armed && pane) {
      const el = pane;
      queueMicrotask(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  });

  function onPaneScroll(): void {
    if (!pane) return;
    const m: ScrollMetrics = {
      scrollTop: pane.scrollTop,
      scrollHeight: pane.scrollHeight,
      clientHeight: pane.clientHeight,
    };
    armed = nextArmedState(m);
  }

  async function resetRestarts(): Promise<void> {
    if (!session) return; // no restart-count control in the daemon-log variant
    busyReset = true;
    try {
      await api.resetRestreamSessionRestarts(instanceId, nodeId, session.name);
    } catch (err) {
      notify.error(errText(err));
    } finally {
      busyReset = false;
    }
  }

  async function restart(): Promise<void> {
    if (!session) return; // no restart control in the daemon-log variant
    if (!confirm(`Restart session "${displayName}"? Playback glitches briefly.`)) return;
    busyRestart = true;
    try {
      await api.restartRestreamSession(instanceId, nodeId, session.name);
    } catch (err) {
      notify.error(errText(err));
    } finally {
      busyRestart = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="modal-backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label={session ? `Session ${displayName}` : displayName}>
    <h2 style="margin-top:0">
      {displayName}
      {#if session}
        {#if session.channelSlug}<span class="muted small" title={session.name}>{session.name}</span>{/if}
        <span class="badge {sessionStateBadge(session.state)}">{session.state}</span>
      {/if}
    </h2>

    {#if session}
      <div class="muted small" style="display:flex;flex-direction:column;gap:6px">
        {#if liveStopAt}
          <div>on-demand · stops at {dateTime(liveStopAt)}</div>
        {/if}
        <div>
          Playlist:
          {#if serveUrl}
            <a href="{serveUrl}/{session.name}/playlist.m3u8" target="_blank">
              {serveUrl}/{session.name}/playlist.m3u8
            </a>
          {:else}—{/if}
        </div>
        <div>Lag: {session.playlistLagSec !== undefined ? `${Math.round(session.playlistLagSec)}s` : '—'}</div>
        <div>
          Memory: {session.memoryRssMb !== undefined ? `${Math.round(session.memoryRssMb)} MB` : '—'}
        </div>
        <div>
          Last exit:
          {session.lastExit ? `${session.lastExit.class} @ ${dateTime(session.lastExit.at)}` : '—'}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span>Restarts: {session.restarts}</span>
          <button disabled={busyReset} onclick={() => void resetRestarts()}>Reset count</button>
          <button disabled={busyRestart} title="kill + respawn, reset backoff" onclick={() => void restart()}>
            Restart
          </button>
        </div>
      </div>
    {/if}

    <div style="margin-top:14px">
      <div style="display:flex;align-items:center;gap:8px">
        <b class="small">Log</b>
        <span style="flex:1"></span>
        <button onclick={() => (lines = [])}>Clear</button>
      </div>
      <div class="log-pane" bind:this={pane} onscroll={onPaneScroll}>
        {#each lines as l, i (i)}
          <div class="log-line"><span class="log-src">{l.src}</span>{l.line}</div>
        {:else}
          <div class="muted small">no log output yet</div>
        {/each}
      </div>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button onclick={onclose}>Close</button>
    </div>
  </div>
</div>
