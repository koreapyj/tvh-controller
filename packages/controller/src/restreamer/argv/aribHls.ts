// ported from restreamer src/pipeline/templates/aribHls.ts — keep in sync;
// if that file changes, update this port and the golden fixture in
// test/argv.test.ts together.
//
// Pure params → string[] builder. Must NOT import anything daemon-specific
// (no filesystem, no process, no runtime context) — the controller uses this
// to pre-render a 'raw-argv' PipelineParams doc for nodes that advertise the
// 'raw-argv' template, so the daemon-side filter-graph/var_stream_map logic
// stays in exactly one place (semantically) even though it now runs in two
// processes. Must be deterministic: no Date, no randomness, no unordered
// object iteration — the output feeds a SHA-256 doc-revision hash.

import type { AribHlsParams, RawArgvParams } from '@tvhc/shared';

/** software-deinterlace + inverse-telecine chain running on OpenCL, frames mapped back to QSV for the encoder */
export const IVTC_CHAIN = 'hwmap=derive_device=opencl,ivtc_opencl,hwmap=derive_device=qsv:reverse=1';

/** audio bitrate default is index-dependent (see contract note on AribHlsAudio) */
function defaultAudioBitrate(index: number): string {
  return index === 0 ? '128k' : '64k';
}

/** rendition LANGUAGE default: prod labels the first two ARIB audio tracks ja/en; further tracks carry no language */
function defaultAudioLanguage(index: number): string | undefined {
  if (index === 0) return 'ja';
  if (index === 1) return 'en';
  return undefined;
}

/** `[0:a:<i>]volume=<vol>[audio<i>]` per entry; volume 'none' keeps the label without a gain stage */
export function audioFilters(params: AribHlsParams): string {
  return params.audio
    .map((a, i) => {
      const volume = a.volume ?? '5dB';
      const filter = volume === 'none' ? 'anull' : `volume=${volume}`;
      return `[0:a:${i}]${filter}[audio${i}]`;
    })
    .join(';');
}

export function buildFilterComplex(params: AribHlsParams, thumbEnabled: boolean): string {
  const width = params.thumbnail?.width ?? 1280;
  const height = params.thumbnail?.height ?? 720;
  const interval = params.thumbnail?.intervalSec ?? 2;
  const thumbScale = `scale=w=${width}:h=${height}`;

  let video: string;
  switch (params.video.mode) {
    case 'ivtc':
      video = thumbEnabled
        ? `[0:v]split[venc][vtmb];[venc]${IVTC_CHAIN}[1080p];[vtmb]deinterlace_qsv,fps=1/${interval},hwdownload,format=nv12,${thumbScale}[thumb]`
        : `[0:v]${IVTC_CHAIN}[1080p]`;
      break;
    case 'deinterlace':
      video = thumbEnabled
        ? `[0:v]vpp_qsv=deinterlace=advanced:rate=frame,split[1080p][tmpv];[tmpv]fps=1/${interval},${thumbScale}[thumb]`
        : `[0:v]vpp_qsv=deinterlace=advanced:rate=frame[1080p]`;
      break;
    case 'none':
      // No deinterlace stage. With `-hwaccel qsv -hwaccel_output_format qsv`
      // decoded frames are hardware surfaces, so the thumbnail branch must
      // hwdownload before the software scale — mirroring the ivtc thumb
      // branch (the deinterlace branch scales via vpp_qsv-produced frames
      // that ffmpeg transfers implicitly, kept verbatim from prod).
      video = thumbEnabled
        ? `[0:v]split[1080p][tmpv];[tmpv]fps=1/${interval},hwdownload,format=nv12,${thumbScale}[thumb]`
        : `[0:v]null[1080p]`;
      break;
  }

  return `${video};${audioFilters(params)}`;
}

/**
 * var_stream_map generated from the audio/subtitle arrays. For prod params it
 * must equal the legacy string:
 * `v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,language:en s:0,sgroup:arib,name:arib_ass,language:ja`
 */
export function buildVarStreamMap(params: AribHlsParams, subtitlesEnabled: boolean): string {
  const parts = ['v:0,name:1080p,agroup:audio'];
  params.audio.forEach((a, i) => {
    const attrs = [`a:${i}`, `name:${a.name ?? `arib_${i + 1}`}`, 'agroup:audio'];
    if (a.isDefault ?? i === 0) attrs.push('default:yes');
    const language = a.language ?? defaultAudioLanguage(i);
    if (language !== undefined) attrs.push(`language:${language}`);
    parts.push(attrs.join(','));
  });
  if (subtitlesEnabled) {
    const name = params.subtitles?.name ?? 'arib_ass';
    const language = params.subtitles?.language ?? 'ja';
    parts.push(`s:0,sgroup:arib,name:${name},language:${language}`);
  }
  return parts.join(' ');
}

/**
 * Pure port of the daemon's `build(params, ctx)`. `outDir` is a literal
 * string substituted verbatim into the output-path tokens — callers pass
 * `'{OUT_DIR}'` to produce a RawArgvParams doc the daemon will token-replace
 * at runtime. `progress`, when true, appends `-progress pipe:3` (mirrors
 * `ctx.progress` in the daemon); callers building a RawArgvParams doc leave
 * it unset since the daemon appends the progress channel itself.
 */
export function build(params: AribHlsParams, outDir: string, progress?: boolean): string[] {
  const out = outDir;
  const thumbEnabled = params.thumbnail?.enabled ?? true;
  const subtitlesEnabled = params.subtitles?.enabled ?? true;
  const gop = params.video.gop ?? (params.video.mode === 'ivtc' ? '24000/1001' : '30000/1001');

  const argv = [
    '-nostats',
    '-hide_banner',
    '-hwaccel',
    'qsv',
    '-hwaccel_output_format',
    'qsv',
    '-analyzeduration',
    '3000000',
    '-probesize',
    '1G',
    '-start_at_zero',
    '-avoid_negative_ts',
    'disabled',
    '-f',
    'mpegts',
    '-font:s',
    'WadaLabChuMaruGo2004ARIB',
    '-rw_timeout',
    '5000000',
    // prod repeats `-analyzeduration 3000000` here — deliberately dropped (deviation 1)
    '-i',
    '-',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-threads',
    '1',
    '-max_interleave_delta',
    '1000000',
    '-max_muxing_queue_size',
    '2048',
    '-filter_complex',
    buildFilterComplex(params, thumbEnabled),
    '-map',
    '[1080p]',
    '-c:v:0',
    params.video.codec ?? 'hevc_qsv',
    '-b:v:0',
    params.video.bitrate ?? '3M',
    '-profile:v:0',
    '1',
    '-tier:v:0',
    '0',
    '-scenario:v:0',
    '4',
    '-tag:v:0',
    'hvc1',
    '-flags:v:0',
    '+cgop',
    '-g:v:0',
    gop,
    '-preset:v:0',
    String(params.video.preset ?? 7),
    '-aspect:v:0',
    '16:9',
  ];

  params.audio.forEach((a, i) => {
    argv.push('-map', `[audio${i}]`, `-c:a:${i}`, 'libfdk_aac', `-b:a:${i}`, a.bitrate ?? defaultAudioBitrate(i));
  });

  if (subtitlesEnabled) {
    argv.push('-map', '0:s:0', '-c:s', 'ass', '-hls_subtitle_type', 'ass');
  }

  argv.push(
    '-f',
    'hls',
    '-hls_time',
    String(params.hls?.segmentSeconds ?? 5),
    '-hls_list_size',
    String(params.hls?.listSize ?? 120),
    '-hls_segment_filename',
    `${out}/%v/%Y%m%d-%H%M%S.ts`,
    '-strftime',
    '1',
    '-hls_segment_type',
    'mpegts',
    '-hls_flags',
    'delete_segments+append_list+discont_start+omit_endlist+program_date_time',
  );

  if (subtitlesEnabled) {
    argv.push(
      '-hls_subtitle_path',
      `${out}/%v/playlist.m3u8`,
      '-hls_subtitle_segment_filename',
      `${out}/%v/%Y%m%d-%H%M%S.ass`,
    );
  }

  argv.push(
    '-var_stream_map',
    buildVarStreamMap(params, subtitlesEnabled),
    '-master_pl_name',
    'playlist.m3u8',
    `${out}/%v/stream.m3u8`,
  );

  if (thumbEnabled) {
    argv.push('-map', '[thumb]', '-update', '1', '-atomic_writing', '1', '-y', `${out}/thumb.jpg`);
  }

  if (progress) {
    argv.push('-progress', 'pipe:3'); // deviation 2 — session layer's progress channel
  }

  return argv;
}

/**
 * Renders a completed (defaulted) AribHlsParams into a RawArgvParams doc for
 * nodes that advertise the 'raw-argv' template. `{OUT_DIR}` is left as a
 * literal token — the daemon substitutes it at runtime — and no progress
 * flag is appended, since the daemon's raw-argv template appends
 * `-progress pipe:3` itself.
 */
export function buildRawArgvParams(params: AribHlsParams): RawArgvParams {
  return {
    template: 'raw-argv',
    templateVersion: 1,
    ffmpegArgv: build(params, '{OUT_DIR}'),
    segmentSeconds: params.hls?.segmentSeconds ?? 5,
    listSize: params.hls?.listSize ?? 120,
  };
}
