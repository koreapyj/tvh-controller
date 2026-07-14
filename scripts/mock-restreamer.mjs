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

// Minimal mock restreamer daemon (wire contract v1) for development/testing
// without real nodes.
//   node scripts/mock-restreamer.mjs --port 15801 [--name node1] [--raw-argv]
//
// --raw-argv: also advertise {id:'raw-argv',version:1} in /v1/status.templates
// (in addition to arib-hls), so the controller renders pre-built ffmpeg argv
// docs for this node instead of semantic arib-hls params.
//
// Contract endpoints: GET /v1/status, GET/PUT /v1/desired, GET /v1/sources,
// POST /v1/sessions/:name/restart, GET /v1/sessions/:name/log?lines=N,
// GET /v1/healthz. Desired state is kept in memory only; every enabled
// session of the last accepted doc reports state 'running'. The sources
// catalog (external {url} sources) is in-memory too: null = no sourcesM3u
// configured (status sourcesHash null); mutate it via the test hook
//   POST /__sources   body {"entries":[{id,name,url,logo?,chno?},…]} | null
//
// It also serves fake-but-ADVANCING HLS playlists at the paths a real node's
// nginx would (any slug works, no desired doc required; segment URIs 404 by
// design — only the playlists matter):
//   GET /<slug>/playlist.m3u8            master: 1080p variant + arib_1/arib_2
//                                        audio renditions (prod var_stream_map)
//   GET /<slug>/<variant>/stream.m3u8    live 6-segment window, EXTINF 5.0,
//                                        MEDIA-SEQUENCE + PROGRAM-DATE-TIME
//                                        advancing with the wall clock
// Test hooks for the switcher failover demo:
//   POST /__freeze     stop playlist advancement (simulates a stalled encoder)
//   POST /__unfreeze   resume
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const port = Number(argValue('--port', 15801));
const name = argValue('--name', `mock-node:${port}`);
/** advertise the 'raw-argv' template alongside 'arib-hls' in /v1/status.templates */
const rawArgv = args.includes('--raw-argv');

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const SEG_SEC = 5;
const WINDOW = 6;
const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** last accepted desired doc; null = never pushed (GET /v1/desired 404s) */
let desired = null;
/** while set, playlists stop advancing (frozen wall clock for HLS output) */
let frozenAtMs = null;
/** sources.m3u catalog entries; null = no sourcesM3u configured */
let sources = null;
/** ISO 8601 of the last catalog mutation; null while no catalog */
let sourcesUpdatedAt = null;

const sourcesHash = () =>
  sources === null ? null : createHash('sha256').update(JSON.stringify(sources)).digest('hex').slice(0, 16);

const nowMs = () => frozenAtMs ?? Date.now();
const configHash = (session) => createHash('sha256').update(JSON.stringify(session)).digest('hex').slice(0, 16);

function validateDesired(doc) {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'body must be an object';
  if (doc.apiVersion !== 1) return `unsupported apiVersion ${JSON.stringify(doc.apiVersion)}`;
  if (typeof doc.revision !== 'string' || !doc.revision) return 'revision must be a non-empty string';
  if (!Array.isArray(doc.sessions)) return 'sessions must be an array';
  for (const s of doc.sessions) {
    if (typeof s !== 'object' || s === null) return 'sessions[] must be objects';
    if (typeof s.name !== 'string' || !SESSION_NAME.test(s.name)) return `invalid session name ${JSON.stringify(s.name)}`;
    if (typeof s.source !== 'object' || s.source === null) return `session "${s.name}": source is required`;
    if (typeof s.source.channelUuid !== 'string' && typeof s.source.url !== 'string') {
      return `session "${s.name}": source must carry channelUuid or url`;
    }
    if (typeof s.tsreadex !== 'object' || s.tsreadex === null) {
      return `session "${s.name}": tsreadex is required`;
    }
    // absent = the daemon PAT-probes; present must be a non-negative integer
    if (s.tsreadex.programNumber !== undefined && (!Number.isInteger(s.tsreadex.programNumber) || s.tsreadex.programNumber < 0)) {
      return `session "${s.name}": tsreadex.programNumber must be a non-negative integer`;
    }
    if (typeof s.pipeline !== 'object' || s.pipeline === null || typeof s.pipeline.template !== 'string') {
      return `session "${s.name}": pipeline.template is required`;
    }
  }
  return null;
}

function sessionStatuses() {
  const now = new Date().toISOString();
  return (desired?.sessions ?? []).map((s) => {
    const enabled = s.enabled !== false;
    return {
      name: s.name,
      state: enabled ? 'running' : 'disabled',
      enabled,
      configHash: configHash(s),
      ...(enabled
        ? {
            ffmpegPid: 40000 + (port % 1000),
            tsreadexPid: 41000 + (port % 1000),
            startedAt,
            restarts: 0,
            consecutiveFailures: 0,
            progress: {
              bitrateKbps: 3300,
              speed: 1.0,
              outTimeMs: Date.now() - startedMs,
              updatedAt: now,
            },
            memoryRssMb: 512,
            lastSegmentAt: new Date(nowMs()).toISOString(),
            playlistLagSec: frozenAtMs === null ? 0.5 : (Date.now() - frozenAtMs) / 1000,
          }
        : { restarts: 0, consecutiveFailures: 0 }),
    };
  });
}

function logLines(session, count) {
  const out = [];
  for (let i = count; i > 0; i--) {
    out.push({
      ts: new Date(Date.now() - i * 1000).toISOString(),
      src: i % 3 === 0 ? 'daemon' : 'ffmpeg',
      line: `[mock ${name}] ${session}: frame=${1000 - i} fps=29.97 bitrate=3300kbits/s speed=1x`,
    });
  }
  return out;
}

// prod var_stream_map: v:0,name:1080p,agroup:audio  a:0,name:arib_1,default,ja  a:1,name:arib_2,en
function masterPlaylist() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="arib_1",DEFAULT=YES,LANGUAGE="ja",URI="arib_1/stream.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="arib_2",DEFAULT=NO,LANGUAGE="en",URI="arib_2/stream.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L123.B0,mp4a.40.2",AUDIO="audio"',
    '1080p/stream.m3u8',
    '',
  ].join('\n');
}

function segName(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.ts`;
}

function mediaPlaylist() {
  const seq = Math.floor(nowMs() / 1000 / SEG_SEC) - WINDOW;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${SEG_SEC}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  for (let i = 0; i < WINDOW; i++) {
    const segStartMs = (seq + i) * SEG_SEC * 1000;
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segStartMs).toISOString()}`);
    lines.push(`#EXTINF:${SEG_SEC.toFixed(1)},`);
    lines.push(segName(segStartMs));
  }
  return `${lines.join('\n')}\n`; // live window: no EXT-X-ENDLIST
}

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

createServer((req, res) => {
  const path = req.url.split('?')[0];
  const query = new URL(req.url, `http://localhost:${port}`).searchParams;
  let chunks = '';
  req.on('data', (c) => (chunks += c));
  req.on('end', () => {
    const log = (status, detail = '') => console.log(`[mock-restreamer:${port}] ${status} ${req.method} ${path}${detail ? ` ${detail}` : ''}`);

    // ---- contract v1 ----
    if (path === '/v1/healthz') return log(200), send(res, 200, { ok: true });
    if (path === '/v1/status' && req.method === 'GET') {
      log(200);
      return send(res, 200, {
        apiVersion: 1,
        daemonVersion: '0.0.0-mock',
        startedAt,
        uptimeSec: (Date.now() - startedMs) / 1000,
        capabilities: ['qsv'],
        templates: rawArgv
          ? [{ id: 'arib-hls', version: 1 }, { id: 'raw-argv', version: 1 }]
          : [{ id: 'arib-hls', version: 1 }],
        desiredRevision: desired?.revision ?? null,
        sourcesHash: sourcesHash(),
        sessions: sessionStatuses(),
      });
    }
    if (path === '/v1/sources' && req.method === 'GET') {
      log(200);
      return send(res, 200, {
        apiVersion: 1,
        catalogHash: sourcesHash(),
        updatedAt: sourcesUpdatedAt,
        entries: sources ?? [],
      });
    }
    if (path === '/v1/desired' && req.method === 'GET') {
      if (!desired) return log(404), send(res, 404, { error: 'no desired state' });
      return log(200), send(res, 200, desired);
    }
    if (path === '/v1/desired' && req.method === 'PUT') {
      let doc;
      try {
        doc = JSON.parse(chunks);
      } catch {
        return log(400, 'bad json'), send(res, 400, { error: 'invalid JSON' });
      }
      const problem = validateDesired(doc);
      if (problem) return log(400, problem), send(res, 400, { error: problem });
      desired = doc;
      return log(200, `revision=${doc.revision.slice(0, 12)} sessions=${doc.sessions.length}`), send(res, 200, { ok: true });
    }
    let m = /^\/v1\/sessions\/([^/]+)\/restart$/.exec(path);
    if (m && req.method === 'POST') {
      const session = decodeURIComponent(m[1]);
      if (!desired?.sessions.some((s) => s.name === session)) {
        return log(404), send(res, 404, { error: `unknown session "${session}"` });
      }
      return log(200, session), send(res, 200, { ok: true });
    }
    m = /^\/v1\/sessions\/([^/]+)\/log$/.exec(path);
    if (m && req.method === 'GET') {
      const count = Math.min(Number(query.get('lines') ?? 50) || 50, 500);
      return log(200), send(res, 200, logLines(decodeURIComponent(m[1]), count));
    }

    // ---- test hooks (switcher failover demo) ----
    if (path === '/__freeze' && req.method === 'POST') {
      frozenAtMs = frozenAtMs ?? Date.now();
      return log(200, 'playlists frozen'), send(res, 200, { frozen: true });
    }
    if (path === '/__unfreeze' && req.method === 'POST') {
      frozenAtMs = null;
      return log(200, 'playlists advancing'), send(res, 200, { frozen: false });
    }
    if (path === '/__sources' && req.method === 'POST') {
      let body;
      try {
        body = chunks ? JSON.parse(chunks) : null;
      } catch {
        return log(400, 'bad json'), send(res, 400, { error: 'invalid JSON' });
      }
      const entries = body === null ? null : (body.entries ?? null);
      if (entries !== null) {
        if (!Array.isArray(entries)) return log(400), send(res, 400, { error: 'entries must be an array or null' });
        for (const e of entries) {
          if (typeof e?.id !== 'string' || typeof e?.name !== 'string' || typeof e?.url !== 'string') {
            return log(400), send(res, 400, { error: 'entries[] need string id, name and url' });
          }
        }
      }
      sources = entries;
      sourcesUpdatedAt = entries === null ? null : new Date().toISOString();
      return log(200, `catalog=${entries === null ? 'none' : `${entries.length} entries`}`), send(res, 200, { catalogHash: sourcesHash() });
    }

    // ---- fake HLS at the nginx-served paths ----
    m = /^\/([a-z0-9][a-z0-9-]{0,63})\/playlist\.m3u8$/.exec(path);
    if (m && req.method === 'GET') {
      return log(200), send(res, 200, masterPlaylist(), 'application/vnd.apple.mpegurl');
    }
    m = /^\/([a-z0-9][a-z0-9-]{0,63})\/([a-zA-Z0-9_]+)\/stream\.m3u8$/.exec(path);
    if (m && req.method === 'GET') {
      return log(200), send(res, 200, mediaPlaylist(), 'application/vnd.apple.mpegurl');
    }

    log(404);
    send(res, 404, { error: 'not found' });
  });
}).listen(port, () => console.log(`mock restreamer "${name}" listening on :${port}`));
