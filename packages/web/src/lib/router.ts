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

import { writable } from 'svelte/store';

export interface Route {
  page:
    | 'epg'
    | 'instances'
    | 'recordings'
    | 'instance'
    | 'rules'
    | 'drift'
    | 'conflicts'
    | 'uploads'
    | 'restreamer'
    | 'events';
  instanceId?: string;
  /** sub-view within a page (rules: 'deleted' tab) */
  sub?: 'deleted';
  /** query string at NAVIGATION time (in-page filter changes update the URL via replaceState without touching this) */
  search: string;
}

function parse(pathname: string, search: string): Route {
  const segs = pathname.replace(/^\/+|\/+$/g, '').split('/');
  switch (segs[0]) {
    case 'epg':
      return { page: 'epg', search };
    case 'instances':
      return { page: 'instances', search };
    case 'instance':
      return segs[1]
        ? { page: 'instance', instanceId: decodeURIComponent(segs[1]), search }
        : { page: 'instances', search };
    case 'recordings':
      return { page: 'recordings', search };
    case 'rules':
      return { page: 'rules', sub: segs[1] === 'deleted' ? 'deleted' : undefined, search };
    case 'drift':
      return { page: 'drift', search };
    case 'conflicts':
      return { page: 'conflicts', search };
    case 'uploads':
      return { page: 'uploads', search };
    case 'restreamer':
      return { page: 'restreamer', search };
    case 'events':
      return { page: 'events', search };
    default:
      return { page: 'epg', search };
  }
}

// legacy hash URLs (e.g. /#/rules) redirect to real paths
if (window.location.hash.startsWith('#/')) {
  window.history.replaceState({}, '', window.location.hash.slice(1));
}

const store = writable<Route>(parse(window.location.pathname, window.location.search));

window.addEventListener('popstate', () =>
  store.set(parse(window.location.pathname, window.location.search)),
);

export const route = { subscribe: store.subscribe };

export function go(path: string): void {
  window.history.pushState({}, '', path);
  const url = new URL(path, window.location.origin);
  store.set(parse(url.pathname, url.search));
}

/**
 * Global click interceptor for internal links: same-origin root-relative
 * hrefs navigate via pushState instead of a full page load.
 */
export function interceptLinkClicks(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  const anchor = (e.target as Element | null)?.closest?.('a');
  if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
  const href = anchor.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api')) return;
  e.preventDefault();
  go(href);
}
