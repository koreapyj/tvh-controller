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

/**
 * Raw response shapes of the tvheadend HTTP JSON API.
 * Field names match the idnode property names exactly (see
 * .claude/ref/tvheadend/src/dvr/dvr_db.c and dvr_autorec.c).
 */

export interface TvhGridResponse<T> {
  entries: T[];
  total: number;
}

export type DvrState = 'upcoming' | 'finished' | 'failed';

export interface TvhDvrEntry {
  uuid: string;
  enabled?: boolean;
  create?: number;
  start: number;
  stop: number;
  start_real?: number;
  stop_real?: number;
  start_extra?: number;
  stop_extra?: number;
  duration?: number;
  channel?: string;
  channelname?: string;
  disp_title?: string;
  disp_subtitle?: string;
  disp_description?: string;
  status?: string;
  sched_status?: string;
  filesize?: number;
  filename?: string;
  errors?: number;
  data_errors?: number;
  errorcode?: number;
  pri?: number;
  config_name?: string;
  owner?: string;
  creator?: string;
  comment?: string;
  /** uuid of the originating autorec rule, empty when manual */
  autorec?: string;
  autorec_caption?: string;
  episode_disp?: string;
  url?: string;
}

export interface TvhAutorecRule {
  uuid: string;
  enabled?: boolean;
  name?: string;
  directory?: string;
  title?: string;
  fulltext?: boolean;
  mergetext?: boolean;
  /** instance-local channel uuid (setter also accepts a channel name) */
  channel?: string;
  /** instance-local channel tag uuid (setter also accepts a tag name) */
  tag?: string;
  btype?: number;
  content_type?: number;
  star_rating?: number;
  start?: string;
  start_window?: string;
  start_extra?: number;
  stop_extra?: number;
  weekdays?: number[];
  minduration?: number;
  maxduration?: number;
  minyear?: number;
  maxyear?: number;
  minseason?: number;
  maxseason?: number;
  pri?: number;
  record?: number;
  retention?: number;
  removal?: number;
  maxcount?: number;
  maxsched?: number;
  /** instance-local DVR config uuid (setter also accepts the profile name) */
  config_name?: string;
  serieslink?: string;
  owner?: string;
  creator?: string;
  comment?: string;
}

export interface TvhChannel {
  uuid: string;
  enabled?: boolean;
  name: string;
  number?: number;
  tags?: string[];
  /** service uuids mapped to this channel */
  services?: string[];
}

export interface TvhChannelTag {
  uuid: string;
  name: string;
  enabled?: boolean;
}

export interface TvhDvrConfig {
  uuid: string;
  name: string;
  enabled?: boolean;
  /** recording storage root, e.g. /mnt/media/recordings */
  storage?: string;
  /** filename format string, e.g. "%F/$c - $t$n.$x" */
  pathname?: string;
}

/**
 * One EPG broadcast from /api/epg/events/grid (and /load). Field names match
 * tvheadend's JSON exactly (see .claude/ref/tvheadend/src/api/api_epg.c).
 * Boolean-ish flags are emitted as 0/1.
 */
export interface TvhEpgEvent {
  eventId: number;
  eventId_xmltv?: string;
  episodeUri?: string;
  serieslinkUri?: string;
  channelName: string;
  channelUuid: string;
  channelNumber?: string;
  channelIcon?: string;
  start: number;
  stop: number;
  title?: string;
  subtitle?: string;
  summary?: string;
  description?: string;
  credits?: Record<string, string>;
  category?: string[];
  keyword?: string[];
  new?: number;
  repeat?: number;
  widescreen?: number;
  deafsigned?: number;
  subtitled?: number;
  audiodesc?: number;
  hd?: number;
  bw?: number;
  lines?: number;
  aspect?: number;
  seasonNumber?: number;
  seasonCount?: number;
  episodeNumber?: number;
  episodeCount?: number;
  partNumber?: number;
  partCount?: number;
  episodeOnscreen?: string;
  image?: string;
  starRating?: number;
  ageRating?: number;
  ratingLabel?: string;
  ratingLabelIcon?: string;
  first_aired?: number;
  copyright_year?: number;
  genre?: number[];
  /** present when this broadcast already has a DVR entry */
  dvrUuid?: string;
  dvrState?: string;
  nextEventId?: number;
}

export interface TvhInputStatus {
  uuid: string;
  input: string;
  stream?: string;
  subs?: number;
  weight?: number;
  signal?: number;
  signal_scale?: number;
  snr?: number;
  snr_scale?: number;
  ber?: number;
  unc?: number;
  cc?: number;
  te?: number;
  bps?: number;
}

export interface TvhSubscription {
  id: number;
  hostname?: string;
  username?: string;
  client?: string;
  title?: string;
  channel?: string;
  service?: string;
  profile?: string;
  state?: string;
  errors?: number;
  in?: number;
  out?: number;
  start?: number;
}

export interface TvhServerInfo {
  sw_version?: string;
  api_version?: number;
  name?: string;
  capabilities?: string[];
}

export interface TvhMux {
  uuid: string;
  enabled?: number | boolean;
  name?: string;
  network?: string;
  network_uuid?: string;
  frequency?: number;
}

export interface TvhService {
  uuid: string;
  enabled?: boolean;
  svcname?: string;
  multiplex?: string;
  multiplex_uuid?: string;
  channel?: string[] | string;
}

export interface TvhNetwork {
  uuid: string;
  networkname?: string;
  enabled?: boolean;
  /**
   * "EIT time offset" (mn_localtime): 0 = UTC, 1 = server-local time,
   * otherwise the EIT zone's UTC offset in minutes (e.g. 540 = UTC+9)
   */
  localtime?: number;
  /** present on IPTV networks: stream slots instead of physical tuners */
  max_streams?: number;
}

/**
 * node of /api/hardware/tree — the tree is fetched ONE LEVEL PER CALL
 * (POST uuid=root, then uuid=<node uuid> for each non-leaf node)
 */
export interface TvhHardwareNode {
  uuid: string;
  text?: string;
  class?: string;
  enabled?: boolean;
  leaf?: boolean | number;
  children?: TvhHardwareNode[];
  params?: Array<{ id: string; value: unknown }>;
}
