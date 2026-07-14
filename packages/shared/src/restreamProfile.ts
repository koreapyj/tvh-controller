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

// Controller-owned profile schema for stored restream profiles — formerly the
// 'arib-hls' wire template. The daemon's wire contract (./restreamer-contract.ts)
// now carries pre-rendered argv only ('raw-argv'); this schema only
// validates/edits stored profile payloads (restream_profiles.payload) and
// drives the controller's own argv renderer
// (packages/controller/src/restreamer/argv/aribHls.ts), which is the sole
// remaining owner of 'arib-hls' semantics. `template`/`templateVersion`
// literals are kept exactly as they were on the wire so existing DB payloads
// keep validating with no data migration.

import { type Static, Type } from '@sinclair/typebox';

/** One audio output. Bitrate default is index-dependent ('128k' for the first entry, '64k' for the rest) and therefore applied by the renderer, not the schema. */
export const AribHlsAudio = Type.Object({
  bitrate: Type.Optional(Type.String()),
  /** volume gain filter */
  volume: Type.Optional(Type.String({ default: '5dB' })),
  /** rendition LANGUAGE attribute */
  language: Type.Optional(Type.String()),
  /** rendition NAME attribute */
  name: Type.Optional(Type.String()),
  isDefault: Type.Optional(Type.Boolean()),
});
export type AribHlsAudio = Static<typeof AribHlsAudio>;

/**
 * 'arib-hls' — the production pipeline: MPEG-TS in, QSV HEVC + libfdk_aac +
 * ARIB→ASS subtitles + thumbnail out, browser-playable HLS. Stored/edited as
 * this semantic shape; rendered into a raw ffmpeg argv before being pushed.
 */
export const AribHlsParams = Type.Object({
  template: Type.Literal('arib-hls'),
  templateVersion: Type.Literal(1),
  video: Type.Object({
    /** selects the filter branch + default GOP: ivtc → 24000/1001, deinterlace/none/yadif/bwdif → 30000/1001 */
    mode: Type.Union([
      Type.Literal('ivtc'),
      Type.Literal('deinterlace'),
      Type.Literal('none'),
      Type.Literal('yadif'),
      Type.Literal('bwdif'),
    ]),
    codec: Type.Optional(Type.Literal('hevc_qsv', { default: 'hevc_qsv' })),
    bitrate: Type.Optional(Type.String({ default: '3M' })),
    /** GOP expression; default derived from `mode` by the renderer */
    gop: Type.Optional(Type.String()),
    /** QSV encode preset */
    preset: Type.Optional(Type.Integer({ default: 7 })),
  }),
  /** 1..4 audio outputs — drives var_stream_map / rendition generation */
  audio: Type.Array(AribHlsAudio, { minItems: 1, maxItems: 4 }),
  subtitles: Type.Optional(
    Type.Object({
      /** ARIB caption → ASS subtitle playlist */
      enabled: Type.Optional(Type.Boolean({ default: true })),
      language: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
    }),
  ),
  thumbnail: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      width: Type.Optional(Type.Integer()),
      height: Type.Optional(Type.Integer()),
      intervalSec: Type.Optional(Type.Number()),
    }),
  ),
  hls: Type.Optional(
    Type.Object({
      /** hls_time */
      segmentSeconds: Type.Optional(Type.Number({ default: 5 })),
      /** hls_list_size */
      listSize: Type.Optional(Type.Integer({ default: 120 })),
    }),
  ),
});
export type AribHlsParams = Static<typeof AribHlsParams>;
