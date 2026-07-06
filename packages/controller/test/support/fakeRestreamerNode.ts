/*
 * In-memory restreamer daemon node at the client boundary RestreamerService
 * uses (putDesired/getDesired/sources — see RestreamerNodeClient). No network:
 * stores the last accepted doc, supports one-shot put failure injection and an
 * `unreachable` toggle that throws a network-ish error, and logs every call.
 * Also serves a mutable sources catalog (setSources/setSourcesHash) with an
 * `oldDaemon` mode that mimics the real client's 404 mapping (empty catalog).
 */

import type { DesiredState, SourceCatalogEntry, SourcesResponse } from '@tvhc/shared';

export interface FakeNodeCall {
  method: 'putDesired' | 'getDesired' | 'sources';
  /** revision of the doc a putDesired carried */
  revision?: string;
}

export interface FakeRestreamerNode {
  /** last accepted desired doc; null = never pushed (getDesired 404s → null) */
  desired: DesiredState | null;
  /** while true every call throws a connection-refused-shaped error */
  unreachable: boolean;
  /** daemon without the sources API: sources() returns the 404-mapped empty response */
  oldDaemon: boolean;
  /** current catalog fingerprint (for status literals); null = no catalog */
  sourcesHash: string | null;
  calls: FakeNodeCall[];
  /** make the NEXT putDesired throw (once) */
  failNextPut(err?: Error): void;
  /** replace the catalog; the hash is derived from the entries unless given */
  setSources(entries: SourceCatalogEntry[], hash?: string): void;
  /** force the fingerprint only (e.g. to simulate hash churn / catalog removal) */
  setSourcesHash(hash: string | null): void;
  putDesired(doc: DesiredState): Promise<void>;
  getDesired(): Promise<DesiredState | null>;
  sources(): Promise<SourcesResponse>;
  puts(): FakeNodeCall[];
}

export function fakeRestreamerNode(): FakeRestreamerNode {
  let nextPutError: Error | null = null;
  let entries: SourceCatalogEntry[] = [];
  const node: FakeRestreamerNode = {
    desired: null,
    unreachable: false,
    oldDaemon: false,
    sourcesHash: null,
    calls: [],
    failNextPut(err?: Error) {
      nextPutError = err ?? new Error('injected put failure');
    },
    setSources(next: SourceCatalogEntry[], hash?: string): void {
      entries = structuredClone(next);
      node.sourcesHash = hash ?? `hash-${JSON.stringify(next)}`;
    },
    setSourcesHash(hash: string | null): void {
      node.sourcesHash = hash;
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
    async sources(): Promise<SourcesResponse> {
      node.calls.push({ method: 'sources' });
      if (node.unreachable) throw new Error('fetch failed: ECONNREFUSED');
      // old daemon: the real client maps the 404 to a no-catalog response
      if (node.oldDaemon) return { apiVersion: 1, catalogHash: null, updatedAt: null, entries: [] };
      return {
        apiVersion: 1,
        catalogHash: node.sourcesHash,
        updatedAt: node.sourcesHash === null ? null : '2026-07-06T00:00:00Z',
        entries: structuredClone(entries),
      };
    },
    puts(): FakeNodeCall[] {
      return node.calls.filter((c) => c.method === 'putDesired');
    },
  };
  return node;
}
