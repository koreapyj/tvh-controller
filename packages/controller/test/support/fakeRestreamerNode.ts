/*
 * In-memory restreamer daemon node at the client boundary RestreamerService
 * uses (putDesired/getDesired — see RestreamerNodeClient). No network: stores
 * the last accepted doc, supports one-shot put failure injection and an
 * `unreachable` toggle that throws a network-ish error, and logs every call.
 */

import type { DesiredState } from '@tvhc/shared';

export interface FakeNodeCall {
  method: 'putDesired' | 'getDesired';
  /** revision of the doc a putDesired carried */
  revision?: string;
}

export interface FakeRestreamerNode {
  /** last accepted desired doc; null = never pushed (getDesired 404s → null) */
  desired: DesiredState | null;
  /** while true every call throws a connection-refused-shaped error */
  unreachable: boolean;
  calls: FakeNodeCall[];
  /** make the NEXT putDesired throw (once) */
  failNextPut(err?: Error): void;
  putDesired(doc: DesiredState): Promise<void>;
  getDesired(): Promise<DesiredState | null>;
  puts(): FakeNodeCall[];
}

export function fakeRestreamerNode(): FakeRestreamerNode {
  let nextPutError: Error | null = null;
  const node: FakeRestreamerNode = {
    desired: null,
    unreachable: false,
    calls: [],
    failNextPut(err?: Error) {
      nextPutError = err ?? new Error('injected put failure');
    },
    async putDesired(doc: DesiredState): Promise<void> {
      node.calls.push({ method: 'putDesired', revision: doc.revision });
      if (node.unreachable) throw new Error('fetch failed: ECONNREFUSED');
      if (nextPutError) {
        const err = nextPutError;
        nextPutError = null;
        throw err;
      }
      node.desired = structuredClone(doc);
    },
    async getDesired(): Promise<DesiredState | null> {
      node.calls.push({ method: 'getDesired' });
      if (node.unreachable) throw new Error('fetch failed: ECONNREFUSED');
      return node.desired ? structuredClone(node.desired) : null;
    },
    puts(): FakeNodeCall[] {
      return node.calls.filter((c) => c.method === 'putDesired');
    },
  };
  return node;
}
