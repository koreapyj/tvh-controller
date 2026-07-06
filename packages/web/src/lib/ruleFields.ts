/*
 * tvh-controller - Centralized tvheadend controller
 * Copyright (C) 2026 Yoonji Park
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Pure-TS field layer shared by the autorec forms (batch edit modal, rule
// editor) and the read-only details view: field metadata, enum options with
// tvheadend's human-readable labels, and the string<->payload conversions.
// No Svelte imports — everything here is node-testable.

import type { MasterRulePayload } from '@tvhc/shared';

export interface EnumOption {
  value: number;
  label: string;
}

/** enum whose payload values are opaque strings (e.g. restream profile ids) */
export interface StrEnumOption {
  value: string;
  label: string;
}

export type FieldType =
  | 'bool'
  | 'int'
  | 'str'
  | 'channel'
  | 'enum'
  | 'strenum'
  | 'time'
  | 'weekdays';

export interface FieldSpec {
  /** keyof MasterRulePayload (or a tvheadend idnode field for recordings) */
  key: string;
  label: string;
  type: FieldType;
  /** required for 'enum' */
  options?: EnumOption[];
  /** required for 'strenum' */
  strOptions?: StrEnumOption[];
  /** batch-mode initial control value (enum: the payload default) */
  initial?: string;
  placeholder?: string;
  help?: string;
  /** section heading rendered when it differs from the previous row's */
  section?: string;
}

// ---------------------------------------------------------------------------
// enum options (values from tvheadend dvr.h enums — single source of truth)
// ---------------------------------------------------------------------------

/** dvr priority; 6 = "let the profile decide". 5 'Not set' is display-only, never offered. */
export const PRIORITY_OPTIONS: EnumOption[] = [
  { value: 6, label: 'Default' },
  { value: 0, label: 'Important' },
  { value: 1, label: 'High' },
  { value: 2, label: 'Normal' },
  { value: 3, label: 'Low' },
  { value: 4, label: 'Unimportant' },
];

/** autorec dedup ("record") modes, in tvheadend UI order */
export const RECORD_MODE_OPTIONS: EnumOption[] = [
  { value: 0, label: 'Record all' },
  { value: 14, label: 'Unique episode (EPG)' },
  { value: 1, label: 'Different episode number' },
  { value: 2, label: 'Different subtitle' },
  { value: 3, label: 'Different description' },
  { value: 12, label: 'Once per month' },
  { value: 4, label: 'Once per week' },
  { value: 5, label: 'Once per day' },
  { value: 6, label: 'Local: different episode number' },
  { value: 7, label: 'Local: different title' },
  { value: 8, label: 'Local: different subtitle' },
  { value: 9, label: 'Local: different description' },
  { value: 13, label: 'Local: once per month' },
  { value: 10, label: 'Local: once per week' },
  { value: 11, label: 'Local: once per day' },
  { value: 15, label: 'Use DVR profile setting' },
];

/** broadcast type filter */
export const BTYPE_OPTIONS: EnumOption[] = [
  { value: 0, label: 'Any' },
  { value: 1, label: 'New / unknown' },
  { value: 2, label: 'Repeated' },
  { value: 3, label: 'New only' },
];

/**
 * ETSI EN 300 468 major content groups, value = group << 4 — verified against
 * a live tvheadend `api/epg/content_type/list` (major groups only; tvheadend
 * exposes no 176 entry).
 */
export const CONTENT_TYPE_OPTIONS: EnumOption[] = [
  { value: 0, label: 'Any' },
  { value: 16, label: 'Movie / Drama' },
  { value: 32, label: 'News / Current affairs' },
  { value: 48, label: 'Show / Game show' },
  { value: 64, label: 'Sports' },
  { value: 80, label: "Children's / Youth programs" },
  { value: 96, label: 'Music / Ballet / Dance' },
  { value: 112, label: 'Arts / Culture (without music)' },
  { value: 128, label: 'Social / Political issues / Economics' },
  { value: 144, label: 'Education / Science / Factual topics' },
  { value: 160, label: 'Leisure hobbies' },
];

// derived value → label maps for display (RuleDetails etc.)

function toMap(options: EnumOption[]): Record<number, string> {
  return Object.fromEntries(options.map((o) => [o.value, o.label]));
}

/** includes 5 'Not set' (seen on instance rules) which is never offered in pickers */
export const PRIORITIES: Record<number, string> = { ...toMap(PRIORITY_OPTIONS), 5: 'Not set' };
export const RECORD_MODES: Record<number, string> = toMap(RECORD_MODE_OPTIONS);
export const BTYPES: Record<number, string> = toMap(BTYPE_OPTIONS);

// ---------------------------------------------------------------------------
// field registry: every MasterRulePayload key except `name` (rule identity;
// engine batchEdit deletes it) and `channel_number` (controller-internal,
// owned by the channel picker row)
// ---------------------------------------------------------------------------

export const RULE_FIELD_SPECS: FieldSpec[] = [
  // Rule
  { key: 'enabled', label: 'Enabled', type: 'bool', section: 'Rule' },
  { key: 'comment', label: 'Comment', type: 'str', section: 'Rule' },
  // Matching
  { key: 'title', label: 'Title pattern (regex)', type: 'str', placeholder: '(any)', section: 'Matching' },
  { key: 'fulltext', label: 'Full-text match', type: 'bool', section: 'Matching' },
  { key: 'mergetext', label: 'Merge title & subtitle', type: 'bool', section: 'Matching' },
  { key: 'channel', label: 'Channel', type: 'channel', help: 'blank = any channel', section: 'Matching' },
  { key: 'tag', label: 'Channel tag', type: 'str', help: 'blank = none', section: 'Matching' },
  { key: 'content_type', label: 'Content type', type: 'enum', options: CONTENT_TYPE_OPTIONS, section: 'Matching' },
  { key: 'btype', label: 'Broadcast type', type: 'enum', options: BTYPE_OPTIONS, section: 'Matching' },
  { key: 'star_rating', label: 'Min stars', type: 'int', placeholder: '0 = any', section: 'Matching' },
  { key: 'minseason', label: 'Min season', type: 'int', placeholder: '0 = any', section: 'Matching' },
  { key: 'maxseason', label: 'Max season', type: 'int', placeholder: '0 = any', section: 'Matching' },
  { key: 'minyear', label: 'Min year', type: 'int', placeholder: '0 = any', section: 'Matching' },
  { key: 'maxyear', label: 'Max year', type: 'int', placeholder: '0 = any', section: 'Matching' },
  // Time window
  {
    key: 'start',
    label: 'Start after',
    type: 'time',
    placeholder: 'HH:MM',
    help: 'HH:MM, server time; blank = any',
    section: 'Time window',
  },
  {
    key: 'start_window',
    label: 'Start before',
    type: 'time',
    placeholder: 'HH:MM',
    help: 'HH:MM, server time; blank = any',
    section: 'Time window',
  },
  {
    key: 'weekdays',
    label: 'Weekdays',
    type: 'weekdays',
    help: 'none selected = every day',
    section: 'Time window',
  },
  { key: 'minduration', label: 'Min duration (s)', type: 'int', placeholder: '0 = any', section: 'Time window' },
  { key: 'maxduration', label: 'Max duration (s)', type: 'int', placeholder: '0 = any', section: 'Time window' },
  // Recording
  { key: 'pri', label: 'Priority', type: 'enum', options: PRIORITY_OPTIONS, initial: '6', section: 'Recording' },
  { key: 'record', label: 'Dedup', type: 'enum', options: RECORD_MODE_OPTIONS, section: 'Recording' },
  { key: 'start_extra', label: 'Start padding (min)', type: 'int', placeholder: '0', section: 'Recording' },
  { key: 'stop_extra', label: 'Stop padding (min)', type: 'int', placeholder: '0', section: 'Recording' },
  { key: 'maxcount', label: 'Max recordings', type: 'int', placeholder: '0 = unlimited', section: 'Recording' },
  { key: 'maxsched', label: 'Max scheduled', type: 'int', placeholder: '0 = unlimited', section: 'Recording' },
  // Storage
  { key: 'config_name', label: 'DVR profile', type: 'str', placeholder: '(default)', section: 'Storage' },
  { key: 'directory', label: 'Directory', type: 'str', placeholder: '(profile default)', section: 'Storage' },
  { key: 'retention', label: 'Keep log (days)', type: 'int', placeholder: '0 = config default', section: 'Storage' },
  { key: 'removal', label: 'Keep file (days)', type: 'int', placeholder: '0 = config default', section: 'Storage' },
];

// ---------------------------------------------------------------------------
// value conversions (form string <-> payload value)
// ---------------------------------------------------------------------------

/** payload value → form control string (inverse of parseFieldValue) */
export function formatFieldValue(spec: FieldSpec, v: unknown): string {
  if (v === null || v === undefined) return '';
  switch (spec.type) {
    case 'bool':
      return v ? 'yes' : 'no';
    case 'weekdays':
      return Array.isArray(v) ? v.join(',') : String(v);
    default:
      return String(v);
  }
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * form control string → payload value. Total over every FieldType; 'channel'
 * returns the raw string untouched — the shells resolve it against the
 * channel store via resolveChannelPick (needs {channel, channel_number}).
 */
export function parseFieldValue(spec: FieldSpec, raw: string): ParseResult {
  switch (spec.type) {
    case 'enum':
      return { ok: true, value: Number(raw) };
    case 'bool':
      return { ok: true, value: raw === 'yes' };
    case 'int': {
      const t = raw.trim();
      const n = Number(t);
      if (t === '' || Number.isNaN(n)) {
        return { ok: false, error: `"${spec.label}" must be a number` };
      }
      return { ok: true, value: n };
    }
    case 'time': {
      const t = raw.trim();
      if (t === '') return { ok: true, value: '' };
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m || Number(m[2]) >= 60) {
        return { ok: false, error: `"${spec.label}" must be HH:MM or blank` };
      }
      return { ok: true, value: t };
    }
    case 'weekdays': {
      const days = [
        ...new Set(
          raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '')
            .map(Number),
        ),
      ].sort((a, b) => a - b);
      return { ok: true, value: days };
    }
    default:
      // 'str', 'strenum' and 'channel' pass the string through (channel is
      // resolved by the shells; strenum values are opaque string ids)
      return { ok: true, value: raw };
  }
}

// ---------------------------------------------------------------------------
// rule editor save path (pure core of RuleEditor's buildOverlay/buildPayload)
// ---------------------------------------------------------------------------

/** payload defaults (mirror the TypeBox schema defaults; `name` is '' until the user types one) */
export const RULE_PAYLOAD_DEFAULTS: MasterRulePayload = {
  enabled: true, name: '', title: '', fulltext: false, mergetext: false,
  channel: '', channel_number: null, tag: '', btype: 0, content_type: 0, star_rating: 0,
  start: '', start_window: '', start_extra: 0, stop_extra: 0, weekdays: [],
  minduration: 0, maxduration: 0, minyear: 0, maxyear: 0, minseason: 0,
  maxseason: 0, pri: 6, record: 0, retention: 0, removal: 0, maxcount: 0,
  maxsched: 0, config_name: '', directory: '', comment: '',
};

/**
 * Overlay-mode types whose payload "any/empty" value is indistinguishable
 * from a blank control ('' or no days selected): they need an explicit
 * per-field override flag to tell "override to Any" apart from "inherit".
 * bool/enum rows carry an explicit inherit option and int rows spell Any as
 * a literal 0, so they never need the toggle.
 */
export function needsOverrideToggle(spec: FieldSpec): boolean {
  return (
    spec.type === 'str' || spec.type === 'time' || spec.type === 'weekdays' || spec.type === 'channel'
  );
}

export interface RulePatchOptions {
  /**
   * 'overlay': '' = inherit from the parent → key omitted.
   * 'plain': '' = default → key omitted; the shell fills the gaps by
   * spreading the patch over RULE_PAYLOAD_DEFAULTS.
   */
  mode: 'overlay' | 'plain';
  /**
   * Per-field override flags (overlay mode, needsOverrideToggle types only):
   * off/absent ⇒ NO key at all (inherit), on ⇒ the key is always written —
   * even blank ('' = Any; weekdays [] which the server canonicalizes to every
   * day). Ignored in plain mode and for bool/enum/int specs, except that
   * plain mode always writes weekdays regardless of the flag.
   */
  overrides?: Record<string, boolean>;
}

export type RulePatchResult =
  | { ok: true; patch: Partial<MasterRulePayload> }
  | { ok: false; error: string };

/**
 * Fold the editor's form strings into a payload patch. Semantics pinned by
 * the parity tests against the legacy RuleEditor buildOverlay/buildPayload:
 * '' is omitted (inherit/default) unless the field's override flag forces an
 * explicit empty value, bool 'yes'/'no' → boolean, enum/int → Number,
 * weekdays CSV → number[] gated by its override flag. 'channel' specs are
 * always skipped — resolving the picked label into the {channel,
 * channel_number} identity pair needs the channel store and stays in the
 * shell (resolveChannelPick).
 */
export function buildRulePatch(
  specs: FieldSpec[],
  vals: Record<string, string>,
  opts: RulePatchOptions,
): RulePatchResult {
  const patch: Record<string, unknown> = {};
  for (const f of specs) {
    if (f.type === 'channel') continue;
    const raw = vals[f.key] ?? '';
    const forced =
      opts.mode === 'overlay' && needsOverrideToggle(f) && (opts.overrides?.[f.key] ?? false);
    if (f.type === 'weekdays') {
      if (opts.mode === 'overlay' && !forced) continue;
      const parsed = parseFieldValue(f, raw);
      if (!parsed.ok) return parsed;
      patch[f.key] = parsed.value;
      continue;
    }
    if (raw === '' && !forced) continue; // inherit (overlay) / default (plain)
    const parsed = parseFieldValue(f, raw);
    if (!parsed.ok) return parsed;
    patch[f.key] = parsed.value;
  }
  return { ok: true, patch: patch as Partial<MasterRulePayload> };
}
