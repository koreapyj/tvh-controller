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

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DigestSession, parseDigestChallenge } from '../src/tvh/digest.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('parseDigestChallenge', () => {
  it('parses a tvheadend-style challenge', () => {
    const c = parseDigestChallenge(
      'Digest realm="tvheadend", qop="auth", nonce="abc123", opaque="xyz"',
    );
    expect(c).toMatchObject({ realm: 'tvheadend', nonce: 'abc123', qop: 'auth', opaque: 'xyz' });
  });

  it('rejects non-digest headers', () => {
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
  });

  it('handles unquoted parameters', () => {
    const c = parseDigestChallenge('Digest realm="r", nonce="n", algorithm=MD5, stale=TRUE');
    expect(c?.algorithm).toBe('MD5');
    expect(c?.stale).toBe(true);
  });
});

describe('DigestSession', () => {
  it('computes a verifiable RFC2617 qop=auth response', () => {
    const session = new DigestSession('user', 'pass', {
      realm: 'tvheadend',
      nonce: 'noncevalue',
      qop: 'auth',
    });
    const header = parseAuth(session.authorize('POST', '/api/serverinfo'));

    const ha1 = md5('user:tvheadend:pass');
    const ha2 = md5('POST:/api/serverinfo');
    const expected = md5(`${ha1}:noncevalue:${header.nc}:${header.cnonce}:auth:${ha2}`);
    expect(header.response).toBe(expected);
    expect(header.nc).toBe('00000001');
  });

  it('increments the nonce count per request', () => {
    const session = new DigestSession('u', 'p', { realm: 'r', nonce: 'n', qop: 'auth' });
    session.authorize('POST', '/a');
    const second = parseAuth(session.authorize('POST', '/a'));
    expect(second.nc).toBe('00000002');
  });

  it('supports legacy no-qop responses', () => {
    const session = new DigestSession('u', 'p', { realm: 'r', nonce: 'n' });
    const header = parseAuth(session.authorize('GET', '/x'));
    expect(header.response).toBe(md5(`${md5('u:r:p')}:n:${md5('GET:/x')}`));
    expect(header.qop).toBeUndefined();
  });
});

function parseAuth(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) out[m[1]!] = m[2] ?? m[3] ?? '';
  return out;
}
