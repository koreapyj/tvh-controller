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

import { chanNumberOrder, type MasterRule, type MasterRulePayload, type RuleInstances, type TvhChannel } from '@tvhc/shared';
import { normalizePayload } from './normalize.js';

/** strip undefined/null values so they don't shadow inherited fields */
export function definedProps<T extends object>(obj: Partial<T> | null | undefined): Partial<T> {
  if (!obj) return {};
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>;
}

/**
 * Effective payload of a rule. Linked clones inherit every field from the
 * parent and override only what the overlay defines; the NAME always comes
 * from the rule itself (master names are unique and are pushed to tvheadend).
 */
export function resolveEffective(
  rule: Pick<MasterRule, 'name' | 'payload' | 'parentId' | 'overlay'>,
  parent?: Pick<MasterRule, 'payload'> | null,
): MasterRulePayload {
  if (rule.parentId) {
    if (!parent) {
      throw new Error(`linked clone "${rule.name}" references a missing parent rule`);
    }
    const overrides = definedProps<MasterRulePayload>(rule.overlay);
    const merged: MasterRulePayload = {
      ...parent.payload,
      ...overrides,
      name: rule.name,
    };
    // channel identity is (name, number): an overlay that overrides the channel
    // name must never inherit the parent's number; absent/null = any number
    if (Object.prototype.hasOwnProperty.call(overrides, 'channel')) {
      merged.channel_number = overrides.channel_number ?? null;
    }
    return normalizePayload(merged);
  }
  return normalizePayload({ ...rule.payload, name: rule.name });
}

export function inScope(instances: RuleInstances, instanceId: string): boolean {
  return instances === 'all' || instances.includes(instanceId);
}

/** materialize 'all' into an explicit list (used when narrowing a scope) */
export function materializeScope(instances: RuleInstances, allIds: string[]): string[] {
  return instances === 'all' ? [...allIds] : [...instances];
}

/**
 * Value for tvheadend's channel setter, always an instance-local uuid:
 *  - pinned number: the exact (name, number) channel; if several share both,
 *    the first grid entry wins (deterministic per topology order);
 *  - no number (legacy rules): the LOWEST-numbered channel with that name
 *    (numberless channels sort last, grid order breaks ties) - an unpinned
 *    rule must deterministically target one channel, never whichever
 *    same-name channel tvheadend happens to resolve a bare name to.
 * Falls back to the bare name when nothing matches (unreachable after
 * validateNames, but keeps the function total).
 */
export function channelSetterValue(channels: TvhChannel[], name: string, number: string | null): string {
  if (!name) return name;
  if (number != null) {
    return channels.find((c) => c.name === name && (c.number ?? null) === number)?.uuid ?? name;
  }
  const matches = channels.filter((c) => c.name === name);
  if (matches.length === 0) return name;
  const lowest = matches.reduce((a, b) =>
    chanNumberOrder(b.number) < chanNumberOrder(a.number) ? b : a,
  );
  return lowest.uuid;
}
