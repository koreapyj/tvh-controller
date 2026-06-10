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

import type { MasterRule, MasterRulePayload, RuleInstances } from '@tvhc/shared';
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
    return normalizePayload({
      ...parent.payload,
      ...definedProps<MasterRulePayload>(rule.overlay),
      name: rule.name,
    });
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
