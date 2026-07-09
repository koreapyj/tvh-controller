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
import type { ChannelFailoverStatus } from '@tvhc/shared';
import {
  channelHasFailoverState,
  placementBadgeClass,
  resetUnavailableReason,
  showActiveCheck,
} from './failoverIndicator.js';

describe('placementBadgeClass', () => {
  it('maps the in-transition indicators to warn', () => {
    for (const indicator of ['starting', 'awaiting-lag', 'switching', 'stopping'] as const) {
      expect(placementBadgeClass(indicator, { enabled: true, sessionState: 'running' })).toBe('warn');
    }
  });

  it('maps active to ok and stopped to neutral, regardless of fallback', () => {
    expect(placementBadgeClass('active', { enabled: false, sessionState: null })).toBe('ok');
    expect(placementBadgeClass('stopped', { enabled: true, sessionState: 'running' })).toBe('neutral');
  });

  it('falls back to session-state coloring when the indicator is idle', () => {
    expect(placementBadgeClass('idle', { enabled: true, sessionState: 'running' })).toBe('ok');
    expect(placementBadgeClass('idle', { enabled: true, sessionState: 'backoff' })).toBe('warn');
    expect(placementBadgeClass('idle', { enabled: true, sessionState: 'invalid' })).toBe('bad');
  });

  it('falls back the same way when the indicator is absent (pre-upgrade payload)', () => {
    expect(placementBadgeClass(undefined, { enabled: true, sessionState: 'running' })).toBe('ok');
    expect(placementBadgeClass(undefined, { enabled: true, sessionState: null })).toBe('neutral');
  });

  it('a disabled placement is always neutral in the fallback path', () => {
    expect(placementBadgeClass('idle', { enabled: false, sessionState: 'running' })).toBe('neutral');
    expect(placementBadgeClass(undefined, { enabled: false, sessionState: null })).toBe('neutral');
  });

  it('a null session state (no session) is neutral in the fallback path', () => {
    expect(placementBadgeClass('idle', { enabled: true, sessionState: null })).toBe('neutral');
  });
});

describe('showActiveCheck', () => {
  it('is true whenever the indicator itself says active', () => {
    expect(showActiveCheck('active', false, false)).toBe(true);
    expect(showActiveCheck('active', false, true)).toBe(true);
  });

  it('falls back to activePlacementId + redundancy when indicator is idle/absent', () => {
    expect(showActiveCheck('idle', true, true)).toBe(true);
    expect(showActiveCheck(undefined, true, true)).toBe(true);
  });

  it('the fallback requires BOTH being the active placement AND redundancy', () => {
    expect(showActiveCheck('idle', true, false)).toBe(false);
    expect(showActiveCheck('idle', false, true)).toBe(false);
    expect(showActiveCheck(undefined, false, false)).toBe(false);
  });

  it('a non-idle, non-active indicator (e.g. starting) never shows the check', () => {
    expect(showActiveCheck('starting', true, true)).toBe(false);
    expect(showActiveCheck('stopped', true, true)).toBe(false);
  });
});

describe('channelHasFailoverState', () => {
  const failover: ChannelFailoverStatus = {
    fromPlacementId: null,
    toPlacementId: 'p1',
    phase: 'bringing-up',
    triggerReason: 'manual',
    triggerDetail: null,
    startedAt: '2026-01-01T00:00:00.000Z',
  };

  it('is true for a persisted failover status', () => {
    expect(channelHasFailoverState(failover)).toBe(true);
  });

  it('is true even while draining — the button renders (disabled via resetUnavailableReason)', () => {
    expect(channelHasFailoverState({ ...failover, phase: 'draining' })).toBe(true);
  });

  it('is false for null/undefined', () => {
    expect(channelHasFailoverState(null)).toBe(false);
    expect(channelHasFailoverState(undefined)).toBe(false);
  });
});

describe('resetUnavailableReason', () => {
  const failover: ChannelFailoverStatus = {
    fromPlacementId: null,
    toPlacementId: 'p1',
    phase: 'complete',
    triggerReason: 'manual',
    triggerDetail: null,
    startedAt: '2026-01-01T00:00:00.000Z',
  };

  it('is null for actionable phases and null/undefined state', () => {
    expect(resetUnavailableReason(failover)).toBeNull();
    expect(resetUnavailableReason({ ...failover, phase: 'awaiting-lag' })).toBeNull();
    expect(resetUnavailableReason(null)).toBeNull();
    expect(resetUnavailableReason(undefined)).toBeNull();
  });

  it('names the drain grace for a draining row (Reset renders disabled)', () => {
    expect(resetUnavailableReason({ ...failover, phase: 'draining' })).toMatch(/draining/);
  });
});
