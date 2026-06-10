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

const channels = [
  { uuid: 'ch1', enabled: true, name: 'KBS1', number: 1, services: ['svc1'], tags: [] },
  { uuid: 'ch2', enabled: true, name: 'MBC', number: 2, services: ['svc2'], tags: [] },
  { uuid: 'ch3', enabled: true, name: 'SBS', number: 3, services: ['svc3'], tags: [] },
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

const routes = {
  '/api/serverinfo': { sw_version: '4.3-mock', api_version: 19, name: 'mock-tvh' },
  '/api/dvr/entry/grid_upcoming': { entries: upcoming, total: upcoming.length },
  '/api/dvr/entry/grid_finished': { entries: finished, total: finished.length },
  '/api/dvr/entry/grid_failed': { entries: failed, total: failed.length },
  '/api/dvr/autorec/grid': { entries: autorecs, total: autorecs.length },
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
    ],
    total: 3,
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

createServer((req, res) => {
  const path = req.url.split('?')[0];
  const body = routes[path];
  let chunks = '';
  req.on('data', (c) => (chunks += c));
  req.on('end', () => {
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
