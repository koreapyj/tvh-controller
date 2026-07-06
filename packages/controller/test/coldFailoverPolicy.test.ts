/*
 * Pure cold-failover-policy tests: planColdFailover / evalPreferredHealth /
 * sameSource over hand-built channel snapshots — debounce thresholds,
 * otherHotHealthy suppression, reason-specific candidate gates, trigger
 * precedence, candidate ordering, delivery-slow forced-switch/switch-back,
 * make-before-break deactivation and purity. No I/O.
 */

import { describe, expect, it } from 'vitest';
import {
  DELIVERY_SLOW_DEBOUNCE_TICKS,
  NODE_UNREACHABLE_DEBOUNCE_TICKS,
  PLAYLIST_LAG_ACTIVATE_SEC,
  PLAYLIST_LAG_RECOVER_SEC,
  RECOVERY_DEBOUNCE_TICKS,
  SESSION_CONSECUTIVE_FAILURES_THRESHOLD,
  SESSION_UNHEALTHY_DEBOUNCE_TICKS,
  evalPreferredHealth,
  planColdFailover,
  sameSource,
  type ColdCandidateInput,
  type ColdChannelInput,
  type ColdTriggerReason,
  type PreferredInput,
} from '../src/restreamer/coldFailoverPolicy.js';

function pref(overrides: Partial<PreferredInput> = {}): PreferredInput {
  return {
    placementId: 'hot-1',
    sourceKey: { kind: 'tvh', instanceId: 'src-a' },
    serveOrigin: 'https://node-a:8080',
    nodeUnreachableStreak: 0,
    sessionUnhealthyStreak: 0,
    deliverySlowStreak: 0,
    sessionHealthyStreak: 0,
    ...overrides,
  };
}

function cand(overrides: Partial<ColdCandidateInput> = {}): ColdCandidateInput {
  return {
    placementId: 'cold-1',
    priority: 1,
    sourceKey: { kind: 'tvh', instanceId: 'src-b' },
    serveOrigin: 'https://node-b:8080',
    admission: { ok: true },
    ...overrides,
  };
}

/** channel with an enabled preferred hot placement, reported by the switcher and currently active on it, unless said otherwise. */
function chan(overrides: Partial<ColdChannelInput> = {}): ColdChannelInput {
  const preferred = overrides.preferred === undefined ? pref() : overrides.preferred;
  return {
    channelId: 'ch-1',
    slug: 'chan-1',
    switcherReported: true,
    switcherActiveUpstreamId: preferred?.placementId ?? null,
    preferred,
    otherHotHealthy: false,
    candidates: [],
    currentActivation: null,
    activeColdReady: false,
    ...overrides,
  };
}

function activation(reason: ColdTriggerReason, placementId = 'cold-1'): { placementId: string; reason: ColdTriggerReason } {
  return { placementId, reason };
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
    Object.freeze(obj);
  }
  return obj;
}

describe('planColdFailover: no currentActivation — triggering', () => {
  it('does not activate below debounce, activates exactly at debounce', () => {
    const below = chan({
      preferred: pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS - 1 }),
      candidates: [cand()],
    });
    expect(planColdFailover([below])).toEqual({ actions: [], blocked: [] });

    const at = chan({
      preferred: pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS }),
      candidates: [cand()],
    });
    const result = planColdFailover([at]);
    expect(result.blocked).toEqual([]);
    expect(result.actions).toEqual([
      {
        type: 'activate',
        channelId: 'ch-1',
        placementId: 'cold-1',
        reason: 'node-unreachable',
        preferredPlacementId: 'hot-1',
        forceSwitch: false,
      },
    ]);
  });

  it('otherHotHealthy suppresses activation entirely', () => {
    const c = chan({
      preferred: pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS }),
      otherHotHealthy: true,
      candidates: [cand()],
    });
    expect(planColdFailover([c])).toEqual({ actions: [], blocked: [] });
  });

  it('source gate applies to session-unhealthy but not to node-unreachable', () => {
    const sameSourceCand = cand({ sourceKey: { kind: 'tvh', instanceId: 'src-a' } }); // same as preferred

    const su = chan({
      preferred: pref({ sessionUnhealthyStreak: SESSION_UNHEALTHY_DEBOUNCE_TICKS }),
      candidates: [sameSourceCand],
    });
    const suResult = planColdFailover([su]);
    expect(suResult.actions).toEqual([]);
    expect(suResult.blocked).toEqual([
      { channelId: 'ch-1', slug: 'chan-1', reason: 'cold-1: same source as preferred' },
    ]);

    const nu = chan({
      preferred: pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS }),
      candidates: [sameSourceCand],
    });
    const nuResult = planColdFailover([nu]);
    expect(nuResult.blocked).toEqual([]);
    expect(nuResult.actions).toEqual([
      {
        type: 'activate',
        channelId: 'ch-1',
        placementId: 'cold-1',
        reason: 'node-unreachable',
        preferredPlacementId: 'hot-1',
        forceSwitch: false,
      },
    ]);
  });

  it('delivery-slow gate rejects same/null serveOrigin, accepts a different one, ignores sourceKey; forceSwitch is true', () => {
    const preferred = pref({
      deliverySlowStreak: DELIVERY_SLOW_DEBOUNCE_TICKS,
      serveOrigin: 'https://node-a:8080',
      sourceKey: { kind: 'tvh', instanceId: 'src-a' },
    });
    const sameOrigin = cand({ placementId: 'c-same', priority: 1, serveOrigin: 'https://node-a:8080' });
    const nullOrigin = cand({ placementId: 'c-null', priority: 2, serveOrigin: null });
    const sameSourceDiffOrigin = cand({
      placementId: 'c-ok',
      priority: 3,
      serveOrigin: 'https://node-b:8080',
      sourceKey: { kind: 'tvh', instanceId: 'src-a' }, // same source as preferred — irrelevant for delivery-slow
    });

    const blockedOnly = chan({ preferred, candidates: [sameOrigin, nullOrigin] });
    const blockedResult = planColdFailover([blockedOnly]);
    expect(blockedResult.actions).toEqual([]);
    expect(blockedResult.blocked).toEqual([
      {
        channelId: 'ch-1',
        slug: 'chan-1',
        reason: 'c-same: same serve origin as preferred; c-null: no serve origin',
      },
    ]);

    const withGood = chan({ preferred, candidates: [sameOrigin, nullOrigin, sameSourceDiffOrigin] });
    const goodResult = planColdFailover([withGood]);
    expect(goodResult.actions).toEqual([
      {
        type: 'activate',
        channelId: 'ch-1',
        placementId: 'c-ok',
        reason: 'delivery-slow',
        preferredPlacementId: 'hot-1',
        forceSwitch: true,
      },
    ]);
  });

  it('trigger precedence: node-unreachable wins over delivery-slow when both are past debounce', () => {
    const preferred = pref({
      nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS,
      deliverySlowStreak: DELIVERY_SLOW_DEBOUNCE_TICKS,
    });
    const c = chan({ preferred, candidates: [cand()] });
    const result = planColdFailover([c]);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ reason: 'node-unreachable' });
  });

  it('tries candidates in (priority, placementId) order, skipping admission-refused ones', () => {
    const preferred = pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS });
    const refused = cand({ placementId: 'b-refused', priority: 1, admission: { ok: false, detail: 'at-capacity' } });
    const ok = cand({ placementId: 'c-ok', priority: 2, admission: { ok: true } });
    // deliberately out of order — the policy must sort
    const c = chan({ preferred, candidates: [ok, refused] });
    const result = planColdFailover([c]);
    expect(result.actions).toEqual([
      {
        type: 'activate',
        channelId: 'ch-1',
        placementId: 'c-ok',
        reason: 'node-unreachable',
        preferredPlacementId: 'hot-1',
        forceSwitch: false,
      },
    ]);
  });

  it('chooses the first eligible candidate by (priority, placementId) when several qualify', () => {
    const preferred = pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS });
    const z = cand({ placementId: 'z-cand', priority: 1 });
    const a = cand({ placementId: 'a-cand', priority: 1 });
    const y = cand({ placementId: 'y-cand', priority: 2 });
    const c = chan({ preferred, candidates: [y, z, a] });
    const result = planColdFailover([c]);
    expect(result.actions[0]).toMatchObject({ placementId: 'a-cand' });
  });

  it('all candidates ineligible -> aggregate blocked reason, no action', () => {
    const preferred = pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS });
    const p2 = cand({ placementId: 'p2', priority: 1, admission: { ok: false, detail: 'at-capacity' } });
    const p3 = cand({ placementId: 'p3', priority: 2, admission: { ok: false, detail: 'draining' } });
    const c = chan({ preferred, candidates: [p3, p2] });
    const result = planColdFailover([c]);
    expect(result.actions).toEqual([]);
    expect(result.blocked).toEqual([
      { channelId: 'ch-1', slug: 'chan-1', reason: 'p2: at-capacity; p3: draining' },
    ]);
  });

  it('a channel with no cold candidates at all is blocked, not silently dropped', () => {
    const preferred = pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS });
    const c = chan({ preferred, candidates: [] });
    const result = planColdFailover([c]);
    expect(result.actions).toEqual([]);
    expect(result.blocked).toEqual([
      { channelId: 'ch-1', slug: 'chan-1', reason: 'no cold candidates available' },
    ]);
  });

  it('leaves the channel untouched when switcherReported is false or preferred is null', () => {
    const notReported = chan({
      switcherReported: false,
      preferred: pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS }),
      candidates: [cand()],
    });
    const noPreferred = chan({ preferred: null });
    const result = planColdFailover([notReported, noPreferred]);
    expect(result).toEqual({ actions: [], blocked: [] });
  });
});

describe('planColdFailover: currentActivation — delivery-slow forced cutover', () => {
  it('emits switch only when activeColdReady && switcher not yet on cold && recovery not reached', () => {
    const preferred = pref({ sessionHealthyStreak: 0 });
    const act = activation('delivery-slow');

    const ready = chan({ preferred, currentActivation: act, switcherActiveUpstreamId: 'hot-1', activeColdReady: true });
    expect(planColdFailover([ready]).actions).toEqual([
      { type: 'switch', channelId: 'ch-1', slug: 'chan-1', toPlacementId: 'cold-1' },
    ]);

    const notReady = chan({ preferred, currentActivation: act, switcherActiveUpstreamId: 'hot-1', activeColdReady: false });
    expect(planColdFailover([notReady]).actions).toEqual([]);

    const alreadyOnCold = chan({ preferred, currentActivation: act, switcherActiveUpstreamId: 'cold-1', activeColdReady: true });
    expect(planColdFailover([alreadyOnCold]).actions).toEqual([]);
  });

  it('switch-back while the switcher is still on the cold placement once recovered', () => {
    const preferred = pref({ sessionHealthyStreak: RECOVERY_DEBOUNCE_TICKS });
    const act = activation('delivery-slow');
    const c = chan({ preferred, currentActivation: act, switcherActiveUpstreamId: 'cold-1' });
    expect(planColdFailover([c]).actions).toEqual([
      { type: 'switch-back', channelId: 'ch-1', slug: 'chan-1', toPlacementId: 'hot-1' },
    ]);
  });

  it('deactivates once recovered AND the switcher has moved off the cold placement', () => {
    const preferred = pref({ sessionHealthyStreak: RECOVERY_DEBOUNCE_TICKS });
    const act = activation('delivery-slow');
    const c = chan({ preferred, currentActivation: act, switcherActiveUpstreamId: 'hot-1' });
    expect(planColdFailover([c]).actions).toEqual([
      { type: 'deactivate', channelId: 'ch-1', placementId: 'cold-1' },
    ]);
  });
});

describe('planColdFailover: currentActivation — non-delivery reasons and deactivation gating', () => {
  it('waits for the switcher to move back on its own; does not deactivate while it is still on cold', () => {
    const act = activation('node-unreachable');
    const stillOnCold = chan({
      preferred: pref({ sessionHealthyStreak: RECOVERY_DEBOUNCE_TICKS }),
      currentActivation: act,
      switcherActiveUpstreamId: 'cold-1',
    });
    expect(planColdFailover([stillOnCold]).actions).toEqual([]);
  });

  it('does not deactivate on switcher-moved-back alone without the recovery streak', () => {
    const act = activation('node-unreachable');
    const notRecovered = chan({
      preferred: pref({ sessionHealthyStreak: RECOVERY_DEBOUNCE_TICKS - 1 }),
      currentActivation: act,
      switcherActiveUpstreamId: 'hot-1',
    });
    expect(planColdFailover([notRecovered]).actions).toEqual([]);
  });

  it('deactivates once BOTH the recovery streak is reached AND the switcher has moved back', () => {
    const act = activation('session-unhealthy');
    const both = chan({
      preferred: pref({ sessionHealthyStreak: RECOVERY_DEBOUNCE_TICKS }),
      currentActivation: act,
      switcherActiveUpstreamId: 'hot-1',
    });
    expect(planColdFailover([both]).actions).toEqual([
      { type: 'deactivate', channelId: 'ch-1', placementId: 'cold-1' },
    ]);
  });

  it('never emits a second activate while an activation already exists, even if another trigger also fires', () => {
    const preferred = pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS, sessionHealthyStreak: 0 });
    const act = activation('session-unhealthy');
    const c = chan({
      preferred,
      currentActivation: act,
      switcherActiveUpstreamId: 'cold-1',
      candidates: [cand({ placementId: 'cold-2' })],
    });
    const result = planColdFailover([c]);
    expect(result.actions.every((a) => a.type !== 'activate')).toBe(true);
    expect(result.blocked).toEqual([]);
  });
});

describe('sameSource', () => {
  it('tvh sources: equal iff same instanceId', () => {
    expect(sameSource({ kind: 'tvh', instanceId: 'a' }, { kind: 'tvh', instanceId: 'a' })).toBe(true);
    expect(sameSource({ kind: 'tvh', instanceId: 'a' }, { kind: 'tvh', instanceId: 'b' })).toBe(false);
  });

  it('catalog sources: equal iff same url', () => {
    expect(sameSource({ kind: 'catalog', url: 'http://x/1' }, { kind: 'catalog', url: 'http://x/1' })).toBe(true);
    expect(sameSource({ kind: 'catalog', url: 'http://x/1' }, { kind: 'catalog', url: 'http://x/2' })).toBe(false);
  });

  it('unresolved never equals anything, including another unresolved', () => {
    expect(sameSource({ kind: 'unresolved' }, { kind: 'unresolved' })).toBe(false);
    expect(sameSource({ kind: 'unresolved' }, { kind: 'tvh', instanceId: 'a' })).toBe(false);
    expect(sameSource({ kind: 'tvh', instanceId: 'a' }, { kind: 'unresolved' })).toBe(false);
  });

  it('different kinds are never equal', () => {
    expect(sameSource({ kind: 'tvh', instanceId: 'a' }, { kind: 'catalog', url: 'http://x/1' })).toBe(false);
  });
});

describe('evalPreferredHealth', () => {
  it('unreachable node', () => {
    expect(evalPreferredHealth({ reachable: false, session: null })).toEqual({
      nodeUnreachable: true,
      sessionUnhealthy: false,
      sessionHealthy: false,
    });
  });

  it('backoff with enough consecutive failures is unhealthy', () => {
    expect(
      evalPreferredHealth({
        reachable: true,
        session: {
          state: 'backoff',
          consecutiveFailures: SESSION_CONSECUTIVE_FAILURES_THRESHOLD,
          playlistLagSec: null,
        },
      }),
    ).toEqual({ nodeUnreachable: false, sessionUnhealthy: true, sessionHealthy: false });
  });

  it('lag over the activate threshold is unhealthy', () => {
    expect(
      evalPreferredHealth({
        reachable: true,
        session: { state: 'running', consecutiveFailures: 0, playlistLagSec: PLAYLIST_LAG_ACTIVATE_SEC + 1 },
      }),
    ).toEqual({ nodeUnreachable: false, sessionUnhealthy: true, sessionHealthy: false });
  });

  it('a missing session while reachable is treated as unhealthy', () => {
    expect(evalPreferredHealth({ reachable: true, session: null })).toEqual({
      nodeUnreachable: false,
      sessionUnhealthy: true,
      sessionHealthy: false,
    });
  });

  it('running with no lag, or lag at/under the recover threshold, is healthy', () => {
    expect(
      evalPreferredHealth({
        reachable: true,
        session: { state: 'running', consecutiveFailures: 0, playlistLagSec: null },
      }).sessionHealthy,
    ).toBe(true);
    expect(
      evalPreferredHealth({
        reachable: true,
        session: { state: 'running', consecutiveFailures: 0, playlistLagSec: PLAYLIST_LAG_RECOVER_SEC },
      }).sessionHealthy,
    ).toBe(true);
  });

  it('running with lag strictly between the recover and activate thresholds is neither healthy nor unhealthy (hysteresis band)', () => {
    const mid = (PLAYLIST_LAG_RECOVER_SEC + PLAYLIST_LAG_ACTIVATE_SEC) / 2;
    const r = evalPreferredHealth({
      reachable: true,
      session: { state: 'running', consecutiveFailures: 0, playlistLagSec: mid },
    });
    expect(r.sessionUnhealthy).toBe(false);
    expect(r.sessionHealthy).toBe(false);
  });
});

describe('purity', () => {
  it('is a pure function over deep-frozen input: repeated calls give equal output', () => {
    const channels = deepFreeze([
      chan({ preferred: pref({ nodeUnreachableStreak: NODE_UNREACHABLE_DEBOUNCE_TICKS }), candidates: [cand()] }),
      chan({
        channelId: 'ch-2',
        slug: 'chan-2',
        preferred: pref({ sessionUnhealthyStreak: SESSION_UNHEALTHY_DEBOUNCE_TICKS }),
        candidates: [cand({ placementId: 'cold-2' })],
      }),
      chan({
        channelId: 'ch-3',
        slug: 'chan-3',
        currentActivation: activation('delivery-slow'),
        preferred: pref({ sessionHealthyStreak: RECOVERY_DEBOUNCE_TICKS }),
        switcherActiveUpstreamId: 'cold-1',
      }),
    ]);
    const a = planColdFailover(channels);
    const b = planColdFailover(channels);
    expect(a).toEqual(b);
  });
});
