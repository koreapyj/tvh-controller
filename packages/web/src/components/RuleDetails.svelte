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
  import type { MasterRulePayload } from '@tvhc/shared';
  import { conversionFor, toEitTime } from '../lib/eit.js';
  import { channelOptions, instances } from '../lib/stores.js';

  let { payload, compact = false }: { payload: MasterRulePayload; compact?: boolean } = $props();

  const conv = $derived(conversionFor(payload.channel, $channelOptions, $instances));

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // labels from tvheadend dvr.h enums
  const RECORD_MODES: Record<number, string> = {
    0: 'Record all',
    14: 'Unique episode (EPG)',
    1: 'Different episode number',
    2: 'Different subtitle',
    3: 'Different description',
    12: 'Once per month',
    4: 'Once per week',
    5: 'Once per day',
    6: 'Local: different episode number',
    7: 'Local: different title',
    8: 'Local: different subtitle',
    9: 'Local: different description',
    13: 'Local: once per month',
    10: 'Local: once per week',
    11: 'Local: once per day',
    15: 'Use DVR profile setting',
  };
  const BTYPES: Record<number, string> = {
    0: 'Any',
    1: 'New / unknown',
    2: 'Repeated',
    3: 'New only',
  };
  const PRIORITIES: Record<number, string> = {
    0: 'Important',
    1: 'High',
    2: 'Normal',
    3: 'Low',
    4: 'Unimportant',
    5: 'Not set',
    6: 'Default',
  };

  function weekdays(days: number[]): string {
    if (!days.length || days.length === 7) return 'Every day';
    return days.map((d) => DAYS[d - 1] ?? String(d)).join(', ');
  }

  function seconds(v: number): string {
    if (!v) return '—';
    const m = Math.round(v / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
  }

  function enumLabel(map: Record<number, string>, v: number): string {
    return map[v] ?? String(v);
  }

  function eitTime(hhmm: string): string {
    if (!hhmm) return 'Any';
    if (!conv) return hhmm;
    const t = toEitTime(hhmm, conv);
    return t ? `${t.time} EIT` : hhmm;
  }

  type Row = { label: string; value: string; isDefault: boolean };

  const rows: Row[] = $derived([
    { label: 'Enabled', value: payload.enabled ? 'yes' : 'NO', isDefault: payload.enabled },
    { label: 'Title pattern', value: payload.title || '(any)', isDefault: !payload.title },
    {
      label: 'Full-text match',
      value: payload.fulltext ? 'yes' : 'no',
      isDefault: !payload.fulltext,
    },
    { label: 'Channel', value: payload.channel || 'Any channel', isDefault: !payload.channel },
    { label: 'Channel tag', value: payload.tag || '—', isDefault: !payload.tag },
    { label: 'Weekdays', value: weekdays(payload.weekdays), isDefault: !payload.weekdays.length },
    {
      label: 'Start window',
      value:
        payload.start || payload.start_window
          ? conv
            ? `${eitTime(payload.start)} – ${eitTime(payload.start_window)} (server: ${payload.start || 'Any'} – ${payload.start_window || 'Any'})`
            : `${payload.start || 'Any'} – ${payload.start_window || 'Any'}`
          : 'Any time',
      isDefault: !payload.start && !payload.start_window,
    },
    {
      label: 'Duration',
      value:
        payload.minduration || payload.maxduration
          ? `${seconds(payload.minduration)} – ${seconds(payload.maxduration)}`
          : 'Any',
      isDefault: !payload.minduration && !payload.maxduration,
    },
    {
      label: 'Padding',
      value: `${payload.start_extra || 0} min / ${payload.stop_extra || 0} min`,
      isDefault: !payload.start_extra && !payload.stop_extra,
    },
    {
      label: 'Broadcast type',
      value: enumLabel(BTYPES, payload.btype),
      isDefault: payload.btype === 0,
    },
    {
      label: 'Dedup (record)',
      value: enumLabel(RECORD_MODES, payload.record),
      isDefault: payload.record === 0,
    },
    {
      label: 'Priority',
      value: enumLabel(PRIORITIES, payload.pri),
      isDefault: payload.pri === 6,
    },
    {
      label: 'Max recordings',
      value: payload.maxcount ? String(payload.maxcount) : '∞',
      isDefault: !payload.maxcount,
    },
    {
      label: 'Max scheduled',
      value: payload.maxsched ? String(payload.maxsched) : '∞',
      isDefault: !payload.maxsched,
    },
    {
      label: 'Retention / removal',
      value: `${payload.retention || 'default'} / ${payload.removal || 'default'}`,
      isDefault: !payload.retention && !payload.removal,
    },
    {
      label: 'Season filter',
      value:
        payload.minseason || payload.maxseason
          ? `S${payload.minseason || '?'} – S${payload.maxseason || '?'}`
          : '—',
      isDefault: !payload.minseason && !payload.maxseason,
    },
    {
      label: 'Year filter',
      value:
        payload.minyear || payload.maxyear
          ? `${payload.minyear || '?'} – ${payload.maxyear || '?'}`
          : '—',
      isDefault: !payload.minyear && !payload.maxyear,
    },
    {
      label: 'Min stars',
      value: payload.star_rating ? String(payload.star_rating) : '—',
      isDefault: !payload.star_rating,
    },
    { label: 'DVR profile', value: payload.config_name || '(default)', isDefault: !payload.config_name },
    { label: 'Directory', value: payload.directory || '—', isDefault: !payload.directory },
    { label: 'Comment', value: payload.comment || '—', isDefault: !payload.comment },
  ]);

  const visible = $derived(compact ? rows.filter((r) => !r.isDefault) : rows);
</script>

<table class="rule-details">
  <tbody>
    {#each visible as row}
      <tr>
        <td class="muted small" style="width:160px">{row.label}</td>
        <td class="small" style={row.isDefault ? 'color:var(--muted)' : ''}>{row.value}</td>
      </tr>
    {/each}
    {#if compact && visible.length < rows.length}
      <tr><td colspan="2" class="muted small">… {rows.length - visible.length} fields at default values</td></tr>
    {/if}
  </tbody>
</table>
