/*
 * GOLDEN TEST for packages/controller/src/restreamer/argv/aribHls.ts, the
 * SOLE remaining owner of arib-hls profile→argv rendering (the daemon repo
 * dropped the semantic 'arib-hls' template — it only understands pre-rendered
 * raw-argv docs now, see restreamer/src/contract/v1.ts). Update both files
 * together when the rendering logic changes.
 *
 * Same production at-x fixtures (restreamer.sh run as `restreamer at-x` with
 * profile.d/at-x: PID=333, MODE=ivtc; restreamer.conf: SERVE_DIR=/media), but
 * adjusted for the controller's use: output paths use the literal `{OUT_DIR}`
 * token (the daemon substitutes it at runtime) instead of a resolved
 * `/media/at-x`, and there is NO trailing `-progress pipe:3` — the daemon's
 * raw-argv template appends that itself.
 */

import { describe, expect, it } from 'vitest';
import type { AribHlsParams } from '@tvhc/shared';
import { build, buildRawArgvParams, buildFilterComplex, buildVarStreamMap } from '../src/restreamer/argv/index.js';

// restreamer.sh line 12 — the ivtc FILTER, verbatim
const PROD_FILTER =
  '[0:v]split[venc][vtmb];[venc]hwmap=derive_device=opencl,ivtc_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[vtmb]deinterlace_qsv,fps=1/2,hwdownload,format=nv12,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]';

// restreamer.sh line 34 — the var_stream_map, verbatim
const PROD_VAR_STREAM_MAP =
  'v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,language:en s:0,sgroup:arib,name:arib_ass,language:ja';

// restreamer.sh lines 23–35, tokenized, with output paths rewritten to the
// {OUT_DIR} token and no trailing -progress pipe:3 (see header note).
const PROD_FFMPEG_ARGV = [
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
  PROD_FILTER,
  '-map',
  '[1080p]',
  '-c:v:0',
  'hevc_qsv',
  '-b:v:0',
  '3M',
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
  '24000/1001',
  '-preset:v:0',
  '7',
  '-aspect:v:0',
  '16:9',
  '-map',
  '[audio0]',
  '-c:a:0',
  'libfdk_aac',
  '-b:a:0',
  '128k',
  '-map',
  '[audio1]',
  '-c:a:1',
  'libfdk_aac',
  '-b:a:1',
  '64k',
  '-map',
  '0:s:0',
  '-c:s',
  'ass',
  '-hls_subtitle_type',
  'ass',
  '-f',
  'hls',
  '-hls_time',
  '5',
  '-hls_list_size',
  '120',
  '-hls_segment_filename',
  '{OUT_DIR}/%v/%Y%m%d-%H%M%S.ts',
  '-strftime',
  '1',
  '-hls_segment_type',
  'mpegts',
  '-hls_flags',
  'delete_segments+append_list+discont_start+omit_endlist+program_date_time',
  '-hls_subtitle_path',
  '{OUT_DIR}/%v/playlist.m3u8',
  '-hls_subtitle_segment_filename',
  '{OUT_DIR}/%v/%Y%m%d-%H%M%S.ass',
  '-var_stream_map',
  PROD_VAR_STREAM_MAP,
  '-master_pl_name',
  'playlist.m3u8',
  '{OUT_DIR}/%v/stream.m3u8',
  '-map',
  '[thumb]',
  '-update',
  '1',
  '-atomic_writing',
  '1',
  '-y',
  '{OUT_DIR}/thumb.jpg',
];

/** production at-x: MODE=ivtc, everything else contract defaults */
function atXParams(): AribHlsParams {
  return {
    template: 'arib-hls',
    templateVersion: 1,
    video: { mode: 'ivtc' },
    audio: [{}, {}],
  };
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

describe('golden: production at-x argv parity (raw-argv rendering)', () => {
  it('reproduces the production ffmpeg argv token-for-token via build()', () => {
    expect(build(atXParams(), '{OUT_DIR}')).toEqual(PROD_FFMPEG_ARGV);
  });

  it('buildRawArgvParams reproduces the same argv, with no trailing progress flag', () => {
    const doc = buildRawArgvParams(atXParams());
    expect(doc.ffmpegArgv).toEqual(PROD_FFMPEG_ARGV);
    expect(doc.ffmpegArgv).not.toContain('-progress');
  });

  it('build() does not append -progress pipe:3 even when progress is requested (raw-argv docs never carry it)', () => {
    // the daemon's raw-argv template appends the progress channel itself at
    // runtime; the controller-rendered doc must never include it, so callers
    // of build() for raw-argv purposes must omit the progress argument.
    expect(build(atXParams(), '{OUT_DIR}')).toEqual(PROD_FFMPEG_ARGV);
  });

  it('sets template/templateVersion to raw-argv@1', () => {
    const doc = buildRawArgvParams(atXParams());
    expect(doc.template).toBe('raw-argv');
    expect(doc.templateVersion).toBe(1);
  });

  it('fills segmentSeconds/listSize from params.hls, defaulting to 5/120', () => {
    const defaulted = buildRawArgvParams(atXParams());
    expect(defaulted.segmentSeconds).toBe(5);
    expect(defaulted.listSize).toBe(120);

    const overridden = buildRawArgvParams({ ...atXParams(), hls: { segmentSeconds: 2, listSize: 60 } });
    expect(overridden.segmentSeconds).toBe(2);
    expect(overridden.listSize).toBe(60);
  });

  it('is deterministic: two calls with the same params produce identical output', () => {
    const a = buildRawArgvParams(atXParams());
    const b = buildRawArgvParams(atXParams());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('video modes', () => {
  it('deinterlace: prod filter chain and GOP 30000/1001', () => {
    const params = atXParams();
    params.video.mode = 'deinterlace';
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]vpp_qsv=deinterlace=advanced:rate=frame,split[1080p][tmpv];[tmpv]fps=1/2,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argValue(argv, '-g:v:0')).toBe('30000/1001');
  });

  it('none: split without deinterlace, sw scale after hwdownload, GOP 30000/1001', () => {
    const params = atXParams();
    params.video.mode = 'none';
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]split[1080p][tmpv];[tmpv]fps=1/2,hwdownload,format=nv12,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argValue(argv, '-g:v:0')).toBe('30000/1001');
  });

  it('explicit gop overrides the mode default', () => {
    const params = atXParams();
    params.video.gop = '60000/1001';
    expect(argValue(build(params, '{OUT_DIR}'), '-g:v:0')).toBe('60000/1001');
  });

  it('yadif: OpenCL sandwich filter chain and GOP 30000/1001', () => {
    const params = atXParams();
    params.video.mode = 'yadif';
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]split[venc][vtmb];[venc]hwmap=derive_device=opencl,yadif_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[vtmb]deinterlace_qsv,fps=1/2,hwdownload,format=nv12,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argValue(argv, '-g:v:0')).toBe('30000/1001');
  });

  it('bwdif: OpenCL sandwich filter chain and GOP 30000/1001', () => {
    const params = atXParams();
    params.video.mode = 'bwdif';
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]split[venc][vtmb];[venc]hwmap=derive_device=opencl,bwdif_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[vtmb]deinterlace_qsv,fps=1/2,hwdownload,format=nv12,scale=w=1280:h=720[thumb];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argValue(argv, '-g:v:0')).toBe('30000/1001');
  });

  it('ivtc chain stays byte-identical after adding yadif/bwdif (regression guard)', () => {
    expect(buildFilterComplex(atXParams(), true)).toBe(PROD_FILTER);
  });
});

describe('audio', () => {
  it('single audio entry: one filter label, one map, prod-shaped var_stream_map', () => {
    const params = atXParams();
    params.audio = [{}];
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-filter_complex')).toContain(';[0:a:0]volume=5dB[audio0]');
    expect(argValue(argv, '-filter_complex')).not.toContain('audio1');
    expect(argv).not.toContain('[audio1]');
    expect(argValue(argv, '-var_stream_map')).toBe(
      'v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja s:0,sgroup:arib,name:arib_ass,language:ja',
    );
    expect(argValue(argv, '-b:a:0')).toBe('128k');
  });

  it('third entry gets 64k, name arib_3 and no language attribute', () => {
    const params = atXParams();
    params.audio = [{}, {}, {}];
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-b:a:2')).toBe('64k');
    expect(argValue(argv, '-var_stream_map')).toContain(' a:2,name:arib_3,agroup:audio ');
    expect(argValue(argv, '-var_stream_map')).not.toContain('a:2,name:arib_3,agroup:audio,language');
  });

  it("volume 'none' keeps the label via anull without a gain stage", () => {
    const params = atXParams();
    params.audio = [{ volume: 'none' }, {}];
    const filter = argValue(build(params, '{OUT_DIR}'), '-filter_complex')!;
    expect(filter).toContain('[0:a:0]anull[audio0]');
    expect(filter).toContain('[0:a:1]volume=5dB[audio1]');
  });

  it('per-entry overrides flow into bitrate, rendition name/language/default', () => {
    const params = atXParams();
    params.audio = [{ bitrate: '192k', name: 'main', language: 'ja' }, { isDefault: true }];
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-b:a:0')).toBe('192k');
    expect(argValue(argv, '-var_stream_map')).toBe(
      'v:0,name:1080p,agroup:audio a:0,name:main,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,default:yes,language:en s:0,sgroup:arib,name:arib_ass,language:ja',
    );
  });
});

describe('subtitles', () => {
  it('disabled: no s:0 mapping anywhere, no subtitle codec or hls_subtitle args', () => {
    const params = atXParams();
    params.subtitles = { enabled: false };
    const argv = build(params, '{OUT_DIR}');
    expect(argv).not.toContain('0:s:0');
    expect(argv).not.toContain('-c:s');
    expect(argv).not.toContain('-hls_subtitle_type');
    expect(argv).not.toContain('-hls_subtitle_path');
    expect(argv).not.toContain('-hls_subtitle_segment_filename');
    expect(argValue(argv, '-var_stream_map')).toBe(
      'v:0,name:1080p,agroup:audio a:0,name:arib_1,agroup:audio,default:yes,language:ja a:1,name:arib_2,agroup:audio,language:en',
    );
  });

  it('name/language overrides land in var_stream_map', () => {
    const params = atXParams();
    params.subtitles = { enabled: true, language: 'en', name: 'captions' };
    expect(argValue(build(params, '{OUT_DIR}'), '-var_stream_map')).toContain(
      's:0,sgroup:arib,name:captions,language:en',
    );
  });
});

describe('thumbnail', () => {
  it('disabled: no thumb branch in the filter and no thumb output', () => {
    const params = atXParams();
    params.thumbnail = { enabled: false };
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-filter_complex')).toBe(
      '[0:v]hwmap=derive_device=opencl,ivtc_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
    expect(argv).not.toContain('[thumb]');
    expect(argv).not.toContain('{OUT_DIR}/thumb.jpg');
    expect(argv).not.toContain('-atomic_writing');
  });

  it('disabled + deinterlace: chain goes straight to [1080p]', () => {
    const params = atXParams();
    params.video.mode = 'deinterlace';
    params.thumbnail = { enabled: false };
    expect(argValue(build(params, '{OUT_DIR}'), '-filter_complex')).toBe(
      '[0:v]vpp_qsv=deinterlace=advanced:rate=frame[1080p];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
  });

  it('disabled + yadif: chain goes straight to [1080p]', () => {
    const params = atXParams();
    params.video.mode = 'yadif';
    params.thumbnail = { enabled: false };
    expect(argValue(build(params, '{OUT_DIR}'), '-filter_complex')).toBe(
      '[0:v]hwmap=derive_device=opencl,yadif_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
  });

  it('disabled + bwdif: chain goes straight to [1080p]', () => {
    const params = atXParams();
    params.video.mode = 'bwdif';
    params.thumbnail = { enabled: false };
    expect(argValue(build(params, '{OUT_DIR}'), '-filter_complex')).toBe(
      '[0:v]hwmap=derive_device=opencl,bwdif_opencl,hwmap=derive_device=qsv:reverse=1[1080p];[0:a:0]volume=5dB[audio0];[0:a:1]volume=5dB[audio1]',
    );
  });

  it('size/interval overrides land in the thumb branch', () => {
    const params = atXParams();
    params.thumbnail = { enabled: true, width: 640, height: 360, intervalSec: 10 };
    expect(argValue(build(params, '{OUT_DIR}'), '-filter_complex')).toContain(
      '[vtmb]deinterlace_qsv,fps=1/10,hwdownload,format=nv12,scale=w=640:h=360[thumb]',
    );
  });
});

describe('hls and encoder overrides', () => {
  it('hls_time / hls_list_size from params.hls', () => {
    const params = atXParams();
    params.hls = { segmentSeconds: 2, listSize: 60 };
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-hls_time')).toBe('2');
    expect(argValue(argv, '-hls_list_size')).toBe('60');
  });

  it('video bitrate and preset overrides', () => {
    const params = atXParams();
    params.video.bitrate = '5M';
    params.video.preset = 4;
    const argv = build(params, '{OUT_DIR}');
    expect(argValue(argv, '-b:v:0')).toBe('5M');
    expect(argValue(argv, '-preset:v:0')).toBe('4');
  });
});

describe('helpers exported for direct testing', () => {
  it('buildFilterComplex matches the golden filter for at-x params', () => {
    expect(buildFilterComplex(atXParams(), true)).toBe(PROD_FILTER);
  });

  it('buildVarStreamMap matches the golden var_stream_map for at-x params', () => {
    expect(buildVarStreamMap(atXParams(), true)).toBe(PROD_VAR_STREAM_MAP);
  });
});
