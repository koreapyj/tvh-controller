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

// Minimal mock tvheadend for development/testing without real instances.
//   node scripts/mock-tvh.mjs [port]
// Fixture: 3 channels on 2 muxes, ONE tuner -> the two overlapping upcoming
// recordings on different muxes produce a capacity conflict.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 19981);
const now = Math.floor(Date.now() / 1000);
const H = 3600;
const zone = port === 19981 ? 'A' : 'B';

// channel `number` types mirror the real tvheadend wire (verified against
// tvh 4.3 / API v19 prod): INTEGER numbers arrive as JSON numbers, dotted
// sub-channel numbers as STRINGS — the controller stringifies at ingestion.
const channels = [
  { uuid: 'ch1', enabled: true, name: 'KBS1', number: 1, services: ['svc1'], tags: [] },
  { uuid: 'ch2', enabled: true, name: 'MBC', number: 2, services: ['svc2'], tags: [] },
  { uuid: 'ch3', enabled: true, name: 'SBS', number: 3, services: ['svc3'], tags: [] },
  // cross-zone collision fixtures: ch4 is identical on both zones (duplicate
  // name, different number); ch5 collides on number but the name differs
  // per zone, exercising both flavors of dedup ambiguity.
  { uuid: 'ch4', enabled: true, name: 'KBS1', number: 51, services: ['svc4'], tags: [] },
  { uuid: 'ch5', enabled: true, name: `Regional ${zone}`, number: 3, services: ['svc5'], tags: [] },
  // non-integer channel number fixture ("9.1" sub-channels come as strings) —
  // exercises the ingestion stringification and chanNumberOrder ordering.
  { uuid: 'ch6', enabled: true, name: 'TOKYO MX1', number: '9.1', services: ['svc6'], tags: [] },
];

const upcoming = [
  {
    uuid: 'e1', enabled: true, channel: 'ch1', channelname: 'KBS1',
    disp_title: 'Evening News', start: now + 2 * H, stop: now + 3 * H,
    start_real: now + 2 * H - 60, stop_real: now + 3 * H + 300,
    duration: H, status: 'Scheduled', sched_status: 'scheduled',
    autorec: 'ar1', autorec_caption: 'Daily News', pri: 6, creator: 'Autorec',
  },
  {
    uuid: 'e2', enabled: true, channel: 'ch2', channelname: 'MBC',
    disp_title: 'Friday Drama', start: now + 2 * H + 1800, stop: now + 3 * H + 1800,
    start_real: now + 2 * H + 1740, stop_real: now + 3 * H + 2100,
    duration: H, status: 'Scheduled', sched_status: 'scheduled',
    autorec: 'ar2', autorec_caption: 'Dramas', pri: 6, creator: 'Autorec',
  },
  {
    uuid: 'e3', enabled: true, channel: 'ch3', channelname: 'SBS',
    disp_title: 'Variety Show', start: now + 2 * H + 2400, stop: now + 3 * H,
    start_real: now + 2 * H + 2340, stop_real: now + 3 * H + 300,
    duration: 1800, status: 'Scheduled', sched_status: 'scheduled',
    autorec: 'ar2', autorec_caption: 'Dramas', pri: 6, creator: 'Autorec',
  },
];

const finished = [
  {
    uuid: 'f1', enabled: true, channel: 'ch1', channelname: 'KBS1',
    disp_title: 'Morning News', start: now - 5 * H, stop: now - 4 * H,
    start_real: now - 5 * H, stop_real: now - 4 * H, duration: H,
    status: 'Completed OK', sched_status: 'completed', filesize: 1_234_567_890,
    filename: '/recordings/Morning News.ts', autorec: 'ar1',
    autorec_caption: 'Daily News', errors: 0, data_errors: 0,
  },
];

const failed = [
  {
    uuid: 'x1', enabled: true, channel: 'ch2', channelname: 'MBC',
    disp_title: 'Late Movie', start: now - 30 * H, stop: now - 28 * H,
    status: 'Aborted by error', sched_status: 'completederror',
    errors: 12, data_errors: 340, autorec: '', autorec_caption: '',
  },
];

const autorecs = [
  {
    uuid: 'ar1', enabled: true, name: 'Daily News', title: '^.*News$',
    fulltext: false, channel: 'ch1', start: 'Any', start_window: 'Any',
    weekdays: [1, 2, 3, 4, 5], pri: 6, record: 0, retention: 0, removal: 0,
    minduration: 0, maxduration: 0, maxcount: 0, maxsched: 0, comment: 'mock',
  },
  {
    uuid: 'ar2', enabled: true, name: 'Dramas', title: 'Drama|Show',
    fulltext: true, channel: '', start: 'Any', start_window: 'Any',
    weekdays: [], pri: 2, record: 0, retention: 0, removal: 0,
    minduration: 0, maxduration: 0, maxcount: 0, maxsched: 0, comment: 'mock',
  },
];

// mirrors the upcoming DVR entries plus one unscheduled broadcast, so the
// EPG page has data and dedup across two mock zones can be exercised
const epgEvents = [
  { eventId: 101, channelUuid: 'ch1', channelName: 'KBS1', channelNumber: '1', title: 'Evening News', start: now + 2 * H, stop: now + 3 * H, dvrUuid: 'e1', dvrState: 'scheduled' },
  { eventId: 102, channelUuid: 'ch2', channelName: 'MBC', channelNumber: '2', title: 'Friday Drama', start: now + 2 * H + 1800, stop: now + 3 * H + 1800, dvrUuid: 'e2', dvrState: 'scheduled' },
  { eventId: 103, channelUuid: 'ch3', channelName: 'SBS', channelNumber: '3', title: 'Variety Show', start: now + 2 * H + 2400, stop: now + 3 * H },
  { eventId: 104, channelUuid: 'ch1', channelName: 'KBS1', channelNumber: '1', title: 'Late Documentary', start: now + 4 * H, stop: now + 5 * H },
  { eventId: 105, channelUuid: 'ch4', channelName: 'KBS1', channelNumber: '51', title: 'Subchannel Show', start: now + 3 * H, stop: now + 4 * H },
  { eventId: 106, channelUuid: 'ch6', channelName: 'TOKYO MX1', channelNumber: '9.1', title: 'MX Anime Hour', start: now + 3 * H, stop: now + 4 * H },
];

const routes = {
  '/api/serverinfo': { sw_version: '4.3-mock', api_version: 19, name: 'mock-tvh' },
  '/api/epg/events/grid': { entries: epgEvents, totalCount: epgEvents.length },
  '/api/epg/events/load': { entries: [epgEvents[0]] },
  '/api/dvr/entry/grid_upcoming': { entries: upcoming, total: upcoming.length },
  '/api/dvr/entry/grid_finished': { entries: finished, total: finished.length },
  '/api/dvr/entry/grid_failed': { entries: failed, total: failed.length },
  '/api/status/inputs': {
    entries: [
      { uuid: 'fe1', input: 'Mock DVB-T Tuner', stream: 'mux1 (KBS1)', subs: 0, weight: 0, signal: 80, signal_scale: 1, snr: 28000, snr_scale: 2 },
    ],
    totalCount: 1,
  },
  '/api/status/subscriptions': {
    entries: [
      { id: 1, hostname: '192.168.1.50', username: 'kodi', title: 'Kodi', channel: 'KBS1', state: 'Running', errors: 0, in: 0, out: 4_500_000, start: now - 600 },
    ],
    totalCount: 1,
  },
  '/api/channel/grid': { entries: channels, total: channels.length },
  '/api/channeltag/grid': { entries: [{ uuid: 'tag1', name: 'Terrestrial', enabled: true }], total: 1 },
  '/api/dvr/config/grid': { entries: [{ uuid: 'cfg1', name: '', enabled: true }], total: 1 },
  '/api/mpegts/mux/grid': {
    entries: [
      { uuid: 'mux1', enabled: 1, name: '177.5MHz', network: 'DVB-T', network_uuid: 'net1' },
      { uuid: 'mux2', enabled: 1, name: '189.5MHz', network: 'DVB-T', network_uuid: 'net1' },
    ],
    total: 2,
  },
  '/api/mpegts/service/grid': {
    entries: [
      { uuid: 'svc1', enabled: true, svcname: 'KBS1', multiplex: '177.5MHz', multiplex_uuid: 'mux1', channel: ['ch1'] },
      { uuid: 'svc2', enabled: true, svcname: 'MBC', multiplex: '189.5MHz', multiplex_uuid: 'mux2', channel: ['ch2'] },
      { uuid: 'svc3', enabled: true, svcname: 'SBS', multiplex: '189.5MHz', multiplex_uuid: 'mux2', channel: ['ch3'] },
      { uuid: 'svc4', enabled: true, svcname: 'KBS1', multiplex: '177.5MHz', multiplex_uuid: 'mux1', channel: ['ch4'] },
      { uuid: 'svc5', enabled: true, svcname: `Regional ${zone}`, multiplex: '189.5MHz', multiplex_uuid: 'mux2', channel: ['ch5'] },
      { uuid: 'svc6', enabled: true, svcname: 'TOKYO MX1', multiplex: '177.5MHz', multiplex_uuid: 'mux1', channel: ['ch6'] },
    ],
    total: 6,
  },
  '/api/mpegts/network/grid': {
    entries: [{ uuid: 'net1', networkname: 'DVB-T', enabled: true }],
    total: 1,
  },
  '/api/hardware/tree': [
    {
      uuid: 'adapter1', text: 'Mock adapter', class: 'linuxdvb_adapter', leaf: false,
      children: [{ uuid: 'fe1', text: 'Mock DVB-T frontend', class: 'linuxdvb_frontend_dvbt', enabled: true, leaf: true }],
    },
  ],
  '/api/mpegts/input/network_list': { entries: [{ key: 'net1', val: 'DVB-T' }] },
};

// autorecs is the single mutable store for the write endpoints below; the
// dynamic routes read/write it directly so grid reads reflect prior writes.
let arSeq = 1;
// tvheadend's channel setter accepts a uuid or a name and stores the uuid;
// unknown values are silently cleared - mirror that
const resolveChannel = (v) => (!v ? '' : (channels.find((c) => c.uuid === v || c.name === v)?.uuid ?? ''));
const dynamic = {
  '/api/dvr/autorec/grid': () => ({ entries: autorecs, total: autorecs.length }),
  '/api/dvr/autorec/create': (p) => {
    const conf = JSON.parse(p.get('conf') ?? '{}');
    const uuid = `mock-ar-${port}-${arSeq++}`;
    autorecs.push({ ...conf, uuid, channel: resolveChannel(conf.channel) });
    return { uuid };
  },
  '/api/idnode/save': (p) => {
    const node = JSON.parse(p.get('node') ?? '{}');
    const i = autorecs.findIndex((r) => r.uuid === node.uuid);
    if (i !== -1) autorecs[i] = { ...autorecs[i], ...node, channel: resolveChannel(node.channel ?? autorecs[i].channel) };
    return {};
  },
  '/api/idnode/delete': (p) => {
    const uuids = JSON.parse(p.get('uuid') ?? '[]');
    for (let i = autorecs.length - 1; i >= 0; i--) if (uuids.includes(autorecs[i].uuid)) autorecs.splice(i, 1);
    return {};
  },
};

// 1x1 transparent PNG served for every /imagecache/<n> — exercises the
// controller's authenticated logo proxy passthrough (content-type + ETag)
const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

createServer((req, res) => {
  const path = req.url.split('?')[0];
  let chunks = '';
  req.on('data', (c) => (chunks += c));
  req.on('end', () => {
    const icon = /^\/imagecache\/(\d+)$/.exec(path);
    if (icon) {
      const etag = `"mock-icon-${icon[1]}"`;
      if (req.headers['if-none-match'] === etag) {
        console.log(`[mock-tvh:${port}] 304 ${path}`);
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      console.log(`[mock-tvh:${port}] 200 ${path}`);
      res.writeHead(200, { 'content-type': 'image/png', etag });
      res.end(ICON_PNG);
      return;
    }
    const dyn = dynamic[path];
    if (dyn) {
      console.log(`[mock-tvh:${port}] 200 ${path} (dynamic)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(dyn(new URLSearchParams(chunks))));
      return;
    }
    const body = routes[path];
    if (body === undefined) {
      console.log(`[mock-tvh:${port}] 404 ${path}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    console.log(`[mock-tvh:${port}] 200 ${path}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}).listen(port, () => console.log(`mock tvheadend listening on :${port}`));
