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

export interface FieldSpec {
  key: string;
  label: string;
  type: 'bool' | 'int' | 'str';
  placeholder?: string;
  help?: string;
}

/** DVR-entry fields exposed in the recordings batch edit (keys = tvheadend idnode fields) */
export const RECORDING_FIELDS: FieldSpec[] = [
  { key: 'enabled', label: 'Enabled', type: 'bool' },
  { key: 'comment', label: 'Comment', type: 'str' },
  { key: 'pri', label: 'Priority', type: 'int', placeholder: '6 = default, 0 = highest' },
  { key: 'start_extra', label: 'Start padding (min)', type: 'int', placeholder: '0' },
  { key: 'stop_extra', label: 'Stop padding (min)', type: 'int', placeholder: '0' },
  { key: 'removal', label: 'Keep file (days)', type: 'int', placeholder: '0 = config default' },
];

/** master-rule payload fields exposed in the autorec batch edit */
export const RULE_FIELDS: FieldSpec[] = [
  { key: 'enabled', label: 'Enabled', type: 'bool' },
  { key: 'pri', label: 'Priority', type: 'int', placeholder: '6 = default, 0 = highest' },
  { key: 'config_name', label: 'DVR profile', type: 'str', placeholder: '(default)' },
  { key: 'comment', label: 'Comment', type: 'str' },
  { key: 'start_extra', label: 'Start padding (min)', type: 'int', placeholder: '0' },
  { key: 'stop_extra', label: 'Stop padding (min)', type: 'int', placeholder: '0' },
  { key: 'retention', label: 'Keep log (days)', type: 'int', placeholder: '0 = config default' },
  { key: 'removal', label: 'Keep file (days)', type: 'int', placeholder: '0 = config default' },
];
