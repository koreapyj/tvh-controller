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

import { createHash, randomBytes } from 'node:crypto';

/**
 * Minimal RFC 2617 HTTP Digest auth (MD5 / MD5-sess, qop=auth or none),
 * enough for tvheadend's digest implementation (src/http.c).
 */

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: string;
  algorithm?: string;
  stale?: boolean;
}

export function parseDigestChallenge(header: string): DigestChallenge | null {
  if (!/^digest\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header.slice(7))) !== null) {
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  if (!params.realm || !params.nonce) return null;
  return {
    realm: params.realm,
    nonce: params.nonce,
    opaque: params.opaque,
    qop: params.qop,
    algorithm: params.algorithm,
    stale: params.stale?.toLowerCase() === 'true',
  };
}

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

export class DigestSession {
  private nc = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private challenge: DigestChallenge,
  ) {}

  updateChallenge(challenge: DigestChallenge): void {
    this.challenge = challenge;
    this.nc = 0;
  }

  authorize(method: string, uri: string): string {
    const c = this.challenge;
    const cnonce = randomBytes(8).toString('hex');
    this.nc += 1;
    const nc = this.nc.toString(16).padStart(8, '0');
    const algorithm = (c.algorithm ?? 'MD5').toUpperCase();

    let ha1 = md5(`${this.username}:${c.realm}:${this.password}`);
    if (algorithm === 'MD5-SESS') {
      ha1 = md5(`${ha1}:${c.nonce}:${cnonce}`);
    }
    const ha2 = md5(`${method}:${uri}`);

    const qop = c.qop
      ?.split(',')
      .map((q) => q.trim())
      .find((q) => q === 'auth');

    const response = qop
      ? md5(`${ha1}:${c.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5(`${ha1}:${c.nonce}:${ha2}`);

    const parts = [
      `username="${this.username}"`,
      `realm="${c.realm}"`,
      `nonce="${c.nonce}"`,
      `uri="${uri}"`,
      `response="${response}"`,
    ];
    if (algorithm !== 'MD5') parts.push(`algorithm=${algorithm}`);
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(', ')}`;
  }
}
