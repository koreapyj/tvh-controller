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

import { describe, expect, it } from 'vitest';
import { MasterRulePayload } from '@tvhc/shared';
import {
  buildRulePatch,
  formatFieldValue,
  needsOverrideToggle,
  parseFieldValue,
  RULE_FIELD_SPECS,
  RULE_PAYLOAD_DEFAULTS,
  type FieldSpec,
} from './ruleFields.js';

function spec(key: string): FieldSpec {
  const s = RULE_FIELD_SPECS.find((f) => f.key === key);
  if (!s) throw new Error(`no spec for ${key}`);
  return s;
}

describe('RULE_FIELD_SPECS', () => {
  it('covers every MasterRulePayload field except name and channel_number', () => {
    // a new payload field permanently fails this test until exposed in batch edit
    const expected = new Set(
      Object.keys(MasterRulePayload.properties).filter(
        (k) => k !== 'name' && k !== 'channel_number',
      ),
    );
    expect(new Set(RULE_FIELD_SPECS.map((f) => f.key))).toEqual(expected);
  });

  it('has unique keys', () => {
    const keys = RULE_FIELD_SPECS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every enum spec has non-empty options with unique numeric values', () => {
    for (const f of RULE_FIELD_SPECS.filter((f) => f.type === 'enum')) {
      expect(f.options, f.key).toBeTruthy();
      expect(f.options!.length, f.key).toBeGreaterThan(0);
      const values = f.options!.map((o) => o.value);
      for (const v of values) expect(typeof v, f.key).toBe('number');
      expect(new Set(values).size, f.key).toBe(values.length);
    }
  });

  it('pri initial matches the payload default (6)', () => {
    expect(spec('pri').initial).toBe('6');
  });
});

describe('parseFieldValue', () => {
  it('enum → number', () => {
    expect(parseFieldValue(spec('btype'), '2')).toEqual({ ok: true, value: 2 });
    expect(parseFieldValue(spec('content_type'), '16')).toEqual({ ok: true, value: 16 });
  });

  it('bool → boolean', () => {
    expect(parseFieldValue(spec('enabled'), 'yes')).toEqual({ ok: true, value: true });
    expect(parseFieldValue(spec('fulltext'), 'no')).toEqual({ ok: true, value: false });
  });

  it('int → number, rejecting NaN and blank with the modal error text', () => {
    expect(parseFieldValue(spec('minduration'), ' 300 ')).toEqual({ ok: true, value: 300 });
    expect(parseFieldValue(spec('minduration'), 'x')).toEqual({
      ok: false,
      error: '"Min duration (s)" must be a number',
    });
    expect(parseFieldValue(spec('minduration'), '')).toEqual({
      ok: false,
      error: '"Min duration (s)" must be a number',
    });
  });

  it('time accepts blank (= any) and HH:MM; rejects minutes >= 60 and garbage', () => {
    expect(parseFieldValue(spec('start'), '')).toEqual({ ok: true, value: '' });
    expect(parseFieldValue(spec('start'), '6:00')).toEqual({ ok: true, value: '6:00' });
    expect(parseFieldValue(spec('start'), '23:59')).toEqual({ ok: true, value: '23:59' });
    expect(parseFieldValue(spec('start'), '6:99')).toEqual({
      ok: false,
      error: '"Start after" must be HH:MM or blank',
    });
    expect(parseFieldValue(spec('start'), 'six')).toEqual({
      ok: false,
      error: '"Start after" must be HH:MM or blank',
    });
  });

  it('weekdays CSV → sorted unique array; blank → [] (server folds to every day)', () => {
    expect(parseFieldValue(spec('weekdays'), '7,1,1')).toEqual({ ok: true, value: [1, 7] });
    expect(parseFieldValue(spec('weekdays'), '')).toEqual({ ok: true, value: [] });
  });

  it('str and channel pass the raw string through', () => {
    expect(parseFieldValue(spec('directory'), 'a/b')).toEqual({ ok: true, value: 'a/b' });
    expect(parseFieldValue(spec('channel'), 'KBS1 (1)')).toEqual({ ok: true, value: 'KBS1 (1)' });
  });
});

describe('formatFieldValue', () => {
  it('maps payload values back to control strings (null/undefined → blank)', () => {
    expect(formatFieldValue(spec('enabled'), true)).toBe('yes');
    expect(formatFieldValue(spec('fulltext'), false)).toBe('no');
    expect(formatFieldValue(spec('weekdays'), [1, 7])).toBe('1,7');
    expect(formatFieldValue(spec('pri'), 6)).toBe('6');
    expect(formatFieldValue(spec('title'), '^News')).toBe('^News');
    expect(formatFieldValue(spec('directory'), undefined)).toBe('');
    expect(formatFieldValue(spec('directory'), null)).toBe('');
  });

  it('round-trips with parseFieldValue for representative specs', () => {
    const cases: Array<[string, unknown]> = [
      ['enabled', false],
      ['mergetext', true],
      ['btype', 2],
      ['pri', 6],
      ['record', 14],
      ['minduration', 300],
      ['weekdays', [1, 7]],
      ['weekdays', []],
      ['start', '6:00'],
      ['start', ''],
      ['directory', 'some/dir'],
      ['title', ''],
    ];
    for (const [key, value] of cases) {
      const s = spec(key);
      const parsed = parseFieldValue(s, formatFieldValue(s, value));
      expect(parsed, `${key} ${JSON.stringify(value)}`).toEqual({ ok: true, value });
    }
  });
});

describe('RULE_PAYLOAD_DEFAULTS', () => {
  it('matches the TypeBox schema defaults for every field', () => {
    expect(Object.keys(RULE_PAYLOAD_DEFAULTS).sort()).toEqual(
      Object.keys(MasterRulePayload.properties).sort(),
    );
    for (const [key, prop] of Object.entries(MasterRulePayload.properties)) {
      // name has no schema default (minLength 1); the editor starts it at ''
      const expected = key === 'name' ? '' : (prop as { default?: unknown }).default;
      expect(RULE_PAYLOAD_DEFAULTS[key as keyof typeof RULE_PAYLOAD_DEFAULTS], key).toEqual(
        expected,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// buildRulePatch parity fixtures
//
// legacyBuildOverlay/legacyBuildPayload below are LITERAL transcriptions of
// the sf/bf-based buildOverlay()/buildPayload() that RuleEditor.svelte used
// before the registry migration (channel branch omitted: channel resolution
// needs the channel store and is deliberately kept out of buildRulePatch as
// well). Each fixture drives both implementations from the same form state
// and requires deep-equal patch objects, pinning the exact legacy semantics:
// ''-omission, Number() coercion, bool tri-state, and the weekday-override
// gate (off ⇒ no weekdays key; on ⇒ the key is written even as []).
// ---------------------------------------------------------------------------

type LegacyStrNum =
  | 'title' | 'channel' | 'tag' | 'config_name' | 'start' | 'start_window' | 'comment'
  | 'pri' | 'minduration' | 'maxduration' | 'record' | 'start_extra' | 'stop_extra' | 'maxcount';
type LegacyBool = 'enabled' | 'fulltext';

interface LegacyForm {
  sf: Record<LegacyStrNum, string>;
  bf: Record<LegacyBool, '' | 'yes' | 'no'>;
  wdOverride: boolean;
  wd: number[];
}

function legacyForm(over: {
  sf?: Partial<Record<LegacyStrNum, string>>;
  bf?: Partial<Record<LegacyBool, '' | 'yes' | 'no'>>;
  wdOverride?: boolean;
  wd?: number[];
} = {}): LegacyForm {
  return {
    sf: {
      title: '', channel: '', tag: '', config_name: '', start: '', start_window: '',
      comment: '', pri: '', minduration: '', maxduration: '', record: '',
      start_extra: '', stop_extra: '', maxcount: '',
      ...over.sf,
    },
    bf: { enabled: '', fulltext: '', ...over.bf },
    wdOverride: over.wdOverride ?? false,
    wd: over.wd ?? [1, 2, 3, 4, 5, 6, 7],
  };
}

/** transcription of RuleEditor.svelte buildOverlay() as of the sf/bf version */
function legacyBuildOverlay(f: LegacyForm): Partial<MasterRulePayload> {
  const o: Partial<MasterRulePayload> = {};
  for (const k of ['title', 'tag', 'config_name', 'start', 'start_window', 'comment'] as const) {
    if (f.sf[k] !== '') o[k] = f.sf[k];
  }
  for (const k of ['pri', 'minduration', 'maxduration', 'record', 'start_extra', 'stop_extra', 'maxcount'] as const) {
    if (f.sf[k] !== '') o[k] = Number(f.sf[k]);
  }
  for (const k of ['enabled', 'fulltext'] as const) {
    if (f.bf[k] !== '') o[k] = f.bf[k] === 'yes';
  }
  if (f.wdOverride) o.weekdays = [...f.wd];
  return o;
}

/** transcription of RuleEditor.svelte buildPayload() as of the sf/bf version */
function legacyBuildPayload(f: LegacyForm, name: string): MasterRulePayload {
  const o = legacyBuildOverlay(f);
  return { ...RULE_PAYLOAD_DEFAULTS, ...o, name, weekdays: f.wdOverride ? [...f.wd] : [] };
}

/** map the legacy sf/bf/wd state onto the single vals record the editor now keeps */
function toVals(f: LegacyForm): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const s of RULE_FIELD_SPECS) vals[s.key] = '';
  Object.assign(vals, f.sf);
  vals.enabled = f.bf.enabled;
  vals.fulltext = f.bf.fulltext;
  vals.weekdays = f.wd.join(',');
  return vals;
}

const parityCases: Array<[string, LegacyForm]> = [
  ['all fields empty, no weekday override', legacyForm()],
  ['strings set', legacyForm({
    sf: { title: '^News$', tag: 'HD', config_name: '4K', start: '20:00', start_window: '23:30', comment: 'keep' },
  })],
  ['numbers set incl explicit zero', legacyForm({
    sf: { pri: '3', minduration: '300', maxduration: '7200', record: '14', start_extra: '2', stop_extra: '5', maxcount: '0' },
  })],
  ['bools explicit yes/no', legacyForm({ bf: { enabled: 'no', fulltext: 'yes' } })],
  ['weekday override with a subset', legacyForm({ wdOverride: true, wd: [2, 4, 6] })],
  ['weekday override with none selected (emits [])', legacyForm({ wdOverride: true, wd: [] })],
  ['weekday override off (day state ignored, no key)', legacyForm({ wdOverride: false, wd: [1, 2, 3] })],
  ['kitchen sink', legacyForm({
    sf: {
      title: 'x', tag: 't', config_name: 'c', start: '6:00', start_window: '8:00', comment: 'z',
      pri: '0', minduration: '60', maxduration: '120', record: '5', start_extra: '1', stop_extra: '2', maxcount: '3',
    },
    bf: { enabled: 'yes', fulltext: 'no' },
    wdOverride: true,
    wd: [6, 7],
  })],
];

describe('buildRulePatch — parity with the legacy RuleEditor buildOverlay/buildPayload', () => {
  // the harness models the UI invariant "non-empty value ⇒ override checkbox
  // auto-checked", so non-empty str/time fixtures need no explicit flags:
  // buildRulePatch writes any non-empty value regardless of the flag
  for (const [label, f] of parityCases) {
    it(`overlay: ${label}`, () => {
      const r = buildRulePatch(RULE_FIELD_SPECS, toVals(f), {
        mode: 'overlay',
        overrides: { weekdays: f.wdOverride },
      });
      expect(r).toEqual({ ok: true, patch: legacyBuildOverlay(f) });
    });

    it(`plain payload: ${label}`, () => {
      // plain mode always edits weekdays (the legacy editor forced wdOverride on)
      const g = { ...f, wdOverride: true };
      const r = buildRulePatch(RULE_FIELD_SPECS, toVals(g), { mode: 'plain' });
      if (!r.ok) throw new Error(r.error);
      expect({ ...RULE_PAYLOAD_DEFAULTS, ...r.patch, name: 'My rule' }).toEqual(
        legacyBuildPayload(g, 'My rule'),
      );
    });
  }

  it('never emits channel/channel_number — resolution stays in the shell', () => {
    const vals = toVals(legacyForm());
    vals.channel = '1　KBS1';
    for (const mode of ['overlay', 'plain'] as const) {
      const r = buildRulePatch(RULE_FIELD_SPECS, vals, { mode });
      if (!r.ok) throw new Error(r.error);
      expect('channel' in r.patch, mode).toBe(false);
      expect('channel_number' in r.patch, mode).toBe(false);
    }
  });

  it("overlay: the registry's added fields obey the same ''-omission gate", () => {
    const vals = toVals(legacyForm());
    Object.assign(vals, {
      btype: '2', content_type: '16', star_rating: '4', minseason: '1', maxseason: '3',
      minyear: '1990', maxyear: '2020', mergetext: 'yes', retention: '30', removal: '60',
      maxsched: '2', directory: 'anime',
    });
    const r = buildRulePatch(RULE_FIELD_SPECS, vals, { mode: 'overlay' });
    expect(r).toEqual({
      ok: true,
      patch: {
        btype: 2, content_type: 16, star_rating: 4, minseason: 1, maxseason: 3,
        minyear: 1990, maxyear: 2020, mergetext: true, retention: 30, removal: 60,
        maxsched: 2, directory: 'anime',
      },
    });
  });

  it('propagates int parse errors with the field label', () => {
    const vals = toVals(legacyForm({ sf: { minduration: 'abc' } }));
    expect(buildRulePatch(RULE_FIELD_SPECS, vals, { mode: 'overlay' })).toEqual({
      ok: false,
      error: '"Min duration (s)" must be a number',
    });
  });

  it('rejects malformed times (deliberate tightening vs the legacy pass-through)', () => {
    const vals = toVals(legacyForm({ sf: { start: '6:99' } }));
    expect(buildRulePatch(RULE_FIELD_SPECS, vals, { mode: 'overlay' })).toEqual({
      ok: false,
      error: '"Start after" must be HH:MM or blank',
    });
  });
});

describe('buildRulePatch — explicit empty overrides (override to Any)', () => {
  it('needsOverrideToggle covers exactly the ambiguous types', () => {
    for (const key of ['title', 'tag', 'comment', 'config_name', 'directory', 'start', 'start_window', 'weekdays', 'channel']) {
      expect(needsOverrideToggle(spec(key)), key).toBe(true);
    }
    for (const key of ['enabled', 'pri', 'btype', 'minduration', 'maxcount']) {
      expect(needsOverrideToggle(spec(key)), key).toBe(false);
    }
  });

  it("overlay: a flagged blank str/time field writes '' (override the parent to Any)", () => {
    for (const key of ['title', 'tag', 'comment', 'config_name', 'directory', 'start', 'start_window']) {
      const r = buildRulePatch(RULE_FIELD_SPECS, toVals(legacyForm()), {
        mode: 'overlay',
        overrides: { [key]: true },
      });
      expect(r, key).toEqual({ ok: true, patch: { [key]: '' } });
    }
  });

  it('overlay: a flagged field with a value writes the value (flag is redundant)', () => {
    const r = buildRulePatch(RULE_FIELD_SPECS, toVals(legacyForm({ sf: { start: '6:00' } })), {
      mode: 'overlay',
      overrides: { start: true },
    });
    expect(r).toEqual({ ok: true, patch: { start: '6:00' } });
  });

  it('overlay: an unflagged blank field stays omitted (inherit)', () => {
    const r = buildRulePatch(RULE_FIELD_SPECS, toVals(legacyForm()), {
      mode: 'overlay',
      overrides: { start: false },
    });
    expect(r).toEqual({ ok: true, patch: {} });
  });

  it('plain mode ignores override flags (blank = default, key omitted)', () => {
    const r = buildRulePatch(RULE_FIELD_SPECS, toVals(legacyForm({ wdOverride: true })), {
      mode: 'plain',
      overrides: { start: true, title: true },
    });
    if (!r.ok) throw new Error(r.error);
    expect('start' in r.patch).toBe(false);
    expect('title' in r.patch).toBe(false);
  });

  it('a stray flag on a non-toggle type is inert (no blank-int parse error)', () => {
    const r = buildRulePatch(RULE_FIELD_SPECS, toVals(legacyForm()), {
      mode: 'overlay',
      overrides: { minduration: true, enabled: true, pri: true },
    });
    expect(r).toEqual({ ok: true, patch: {} });
  });

  it('channel stays shell-resolved even when flagged', () => {
    const r = buildRulePatch(RULE_FIELD_SPECS, toVals(legacyForm()), {
      mode: 'overlay',
      overrides: { channel: true },
    });
    if (!r.ok) throw new Error(r.error);
    expect('channel' in r.patch).toBe(false);
    expect('channel_number' in r.patch).toBe(false);
  });
});
