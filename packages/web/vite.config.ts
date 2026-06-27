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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/** controller API the dev server proxies to, derived from the same config.yaml */
function controllerApi(): string {
  if (process.env.TVHC_API) return process.env.TVHC_API;
  let port = 8080; // controller's default when config omits `port`
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const text = readFileSync(process.env.TVHC_CONFIG ?? resolve(root, 'config.yaml'), 'utf8');
    const m = /^\s*port:\s*(\d+)/m.exec(text);
    if (m) port = Number(m[1]);
  } catch {
    /* config.yaml not present — fall back to the default */
  }
  return `http://127.0.0.1:${port}`;
}

export default defineConfig({
  plugins: [svelte()],
  // only used by `pnpm dev:hmr` (the HMR dev server); the default `dev` is a
  // watch build served by the controller on its own port. Bind IPv4 to avoid
  // Windows' EACCES on the IPv6 (::1) loopback, and proxy the API to the
  // controller's configured port.
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5174),
    proxy: {
      '/api': {
        target: controllerApi(),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
