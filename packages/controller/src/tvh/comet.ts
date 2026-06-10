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

/**
 * Client for tvheadend's comet push channel over WebSocket (/comet/ws,
 * subprotocol "tvheadend-comet") — the same mechanism the tvheadend web UI
 * uses. The server pushes {boxid, messages:[{notificationClass, ...}]}
 * roughly once per second while events are pending.
 *
 * Note: the browser-style WebSocket API (Node >= 21 global) cannot send
 * custom headers, so comet only works against no-auth tvheadend access.
 * When the socket cannot be established the controller silently stays on
 * periodic polling.
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

  constructor(
    baseUrl: string,
    private readonly onNotification: (n: CometNotification) => void,
    private readonly onStateChange?: (connected: boolean) => void,
  ) {
    this.wsUrl = `${baseUrl.replace(/^http/, 'ws')}/comet/ws`;
  }

  private readonly wsUrl: string;

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

  private connect(): void {
    if (this.stopped || typeof WebSocket === 'undefined') return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl, ['tvheadend-comet']);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.onStateChange?.(true);
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as { messages?: CometNotification[] };
        for (const msg of data.messages ?? []) {
          if (msg && typeof msg.notificationClass === 'string') {
            this.onNotification(msg);
          }
        }
      } catch {
        // non-JSON frame — ignore
      }
    };
    ws.onerror = () => {
      // close handler performs the reconnect
    };
    ws.onclose = () => {
      this.onStateChange?.(false);
      this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}
