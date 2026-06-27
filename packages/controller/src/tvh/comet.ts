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

import type { IncomingMessage } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import { DigestSession, parseDigestChallenge } from './digest.js';

/**
 * Client for tvheadend's comet push channel over WebSocket (/comet/ws,
 * subprotocol "tvheadend-comet") — the same mechanism the tvheadend web UI
 * uses. The server pushes {boxid, messages:[{notificationClass, ...}]}
 * roughly once per second while events are pending.
 *
 * The upgrade is access-controlled (ACCESS_WEB_INTERFACE). We authenticate it
 * with the `Authorization` header — Basic first, transparently upgrading to
 * RFC2617 Digest on a 401 (tvheadend default) — so comet works against both
 * anonymous and credentialed instances. No credentials = no header.
 */

export interface CometNotification {
  notificationClass: string;
  [key: string]: unknown;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class CometClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly wsUrl: string;
  private readonly path: string;
  private readonly username: string;
  private readonly password: string;
  private readonly basic: string | null;
  /** set once a 401 Digest challenge has been answered; reused across reconnects */
  private digest: DigestSession | null = null;

  constructor(
    baseUrl: string,
    private readonly onNotification: (n: CometNotification) => void,
    private readonly onStateChange?: (connected: boolean) => void,
    username?: string,
    password?: string,
  ) {
    this.wsUrl = `${baseUrl.replace(/^http/, 'ws')}/comet/ws`;
    this.path = new URL('/comet/ws', baseUrl).pathname;
    this.username = username ?? '';
    this.password = password ?? '';
    this.basic = username
      ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
      : null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Authorization header for the next upgrade — fresh Digest nonce-count each time */
  private authHeader(): string | null {
    if (this.digest) return this.digest.authorize('GET', this.path);
    return this.basic;
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      const auth = this.authHeader();
      ws = new WebSocket(this.wsUrl, ['tvheadend-comet'], {
        headers: auth ? { Authorization: auth } : {},
      });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // ensure exactly one follow-up (immediate auth retry OR backoff reconnect)
    let settled = false;
    const next = (immediate: boolean): void => {
      if (settled) return;
      settled = true;
      this.ws = null;
      this.onStateChange?.(false);
      if (this.stopped) return;
      if (immediate) this.connect();
      else this.scheduleReconnect();
    };

    ws.on('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.onStateChange?.(true);
    });
    ws.on('message', (data: RawData) => {
      try {
        const parsed = JSON.parse(data.toString()) as { messages?: CometNotification[] };
        for (const msg of parsed.messages ?? []) {
          if (msg && typeof msg.notificationClass === 'string') this.onNotification(msg);
        }
      } catch {
        // non-JSON frame — ignore
      }
    });
    ws.on('unexpected-response', (_req, res: IncomingMessage) => {
      const retry = this.handleAuthChallenge(res);
      res.resume(); // drain so the socket can close
      next(retry);
    });
    ws.on('error', () => next(false));
    ws.on('close', () => next(false));
  }

  /**
   * Answer a 401 on the upgrade. Returns true when a NEW Digest header was
   * computed (worth an immediate reconnect); false otherwise (back off, so a
   * persistently-rejecting server doesn't hot-loop).
   */
  private handleAuthChallenge(res: IncomingMessage): boolean {
    if (res.statusCode !== 401 || !this.username) return false;
    const raw = res.headers['www-authenticate'];
    const challenge = parseDigestChallenge(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
    if (!challenge) return false;
    if (this.digest) {
      // we already had a session — only retry if the server flagged a stale nonce
      if (!challenge.stale) return false;
      this.digest.updateChallenge(challenge);
    } else {
      this.digest = new DigestSession(this.username, this.password, challenge);
    }
    return true;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}
