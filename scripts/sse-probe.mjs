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

// Samples the controller's SSE stream for N seconds and prints event counts.
//   node scripts/sse-probe.mjs [url] [seconds]
const url = process.argv[2] ?? 'http://localhost:8090/api/events';
const seconds = Number(process.argv[3] ?? 12);

const res = await fetch(url, { signal: AbortSignal.timeout(seconds * 1000) });
const counts = {};
let statusSample = null;
let buf = '';

try {
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /event: (\S+)/.exec(block);
      const da = /data: (.*)/.exec(block);
      if (!ev) continue;
      counts[ev[1]] = (counts[ev[1]] ?? 0) + 1;
      if (ev[1] === 'status' && da) {
        const d = JSON.parse(da[1]);
        statusSample =
          `${d.instanceId}: inputs=${d.inputs.length} subs=${d.subscriptions.length}` +
          (d.inputs[0] ? ` first="${d.inputs[0].input}" bps=${d.inputs[0].bps ?? 'n/a'}` : '');
      }
    }
  }
} catch (err) {
  if (err.name !== 'TimeoutError' && err.name !== 'AbortError') throw err;
}
console.log(`event counts over ~${seconds}s:`, JSON.stringify(counts));
console.log('last status sample:', statusSample ?? 'none');
