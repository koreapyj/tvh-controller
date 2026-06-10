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

import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { MasterRulePayload, type TvhAutorecRule } from '@tvhc/shared';

export interface NameMaps {
  /** channel uuid -> channel name */
  channelsByUuid: Map<string, string>;
  /** tag uuid -> tag name */
  tagsByUuid: Map<string, string>;
  /** dvr config uuid -> profile name */
  dvrConfigsByUuid: Map<string, string>;
}

/**
 * Instance autorec rule -> canonical MasterRulePayload.
 * - drops uuid / serieslink / owner / creator (instance-local or read-only)
 * - resolves channel/tag/config uuids to NAMES (push uses names; tvheadend
 *   setters accept either)
 * - sorts weekdays and fills explicit defaults so a rule pushed minimal and
 *   read back fully-populated does not register false drift
 */
export function normalizeRule(rule: TvhAutorecRule, maps: NameMaps): MasterRulePayload {
  const withDefaults = Value.Default(MasterRulePayload, {}) as MasterRulePayload;
  const payload: MasterRulePayload = {
    ...withDefaults,
    enabled: rule.enabled ?? true,
    name: rule.name ?? '',
    title: rule.title ?? '',
    fulltext: rule.fulltext ?? false,
    mergetext: rule.mergetext ?? false,
    channel: rule.channel ? (maps.channelsByUuid.get(rule.channel) ?? rule.channel) : '',
    tag: rule.tag ? (maps.tagsByUuid.get(rule.tag) ?? rule.tag) : '',
    btype: rule.btype ?? 0,
    content_type: rule.content_type ?? 0,
    star_rating: rule.star_rating ?? 0,
    start: rule.start ?? '',
    start_window: rule.start_window ?? '',
    start_extra: rule.start_extra ?? 0,
    stop_extra: rule.stop_extra ?? 0,
    weekdays: [...(rule.weekdays ?? [])].sort((a, b) => a - b),
    minduration: rule.minduration ?? 0,
    maxduration: rule.maxduration ?? 0,
    minyear: rule.minyear ?? 0,
    maxyear: rule.maxyear ?? 0,
    minseason: rule.minseason ?? 0,
    maxseason: rule.maxseason ?? 0,
    pri: rule.pri ?? 6,
    record: rule.record ?? 0,
    retention: rule.retention ?? 0,
    removal: rule.removal ?? 0,
    maxcount: rule.maxcount ?? 0,
    maxsched: rule.maxsched ?? 0,
    config_name: rule.config_name
      ? (maps.dvrConfigsByUuid.get(rule.config_name) ?? rule.config_name)
      : '',
    directory: rule.directory ?? '',
    comment: rule.comment ?? '',
  };
  return payload;
}

/** canonical, key-ordered serialization → stable hash */
export function payloadHash(payload: MasterRulePayload): string {
  const ordered = Object.fromEntries(
    Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export function normalizePayload(payload: MasterRulePayload): MasterRulePayload {
  return {
    ...(Value.Default(MasterRulePayload, {}) as MasterRulePayload),
    ...payload,
    weekdays: [...payload.weekdays].sort((a, b) => a - b),
  };
}
