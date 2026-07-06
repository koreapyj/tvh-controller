/*
 * In-memory switcher at the client boundary SwitcherSync uses
 * (putDesired/switchChannel — see SwitcherNodeClient). No network: stores the
 * last accepted doc, records switch commands, supports one-shot put failure
 * injection and an `unreachable` toggle, and logs every call.
 */

import type { SwitcherDesiredState } from '@tvhc/shared';

export interface FakeSwitcherCall {
  method: 'putDesired' | 'switchChannel';
  /** revision of the doc a putDesired carried */
  revision?: string;
  slug?: string;
  upstreamId?: string;
}

export interface FakeSwitcher {
  /** last accepted desired doc; null = never pushed */
  desired: SwitcherDesiredState | null;
  /** while true every call throws a connection-refused-shaped error */
  unreachable: boolean;
  calls: FakeSwitcherCall[];
  /** make the NEXT putDesired throw (once) */
  failNextPut(err?: Error): void;
  /** make the NEXT switchChannel throw (once) */
  failNextSwitch(err?: Error): void;
  putDesired(doc: SwitcherDesiredState): Promise<void>;
  switchChannel(slug: string, upstreamId: string): Promise<void>;
  puts(): FakeSwitcherCall[];
  switches(): FakeSwitcherCall[];
}

export function fakeSwitcher(): FakeSwitcher {
  let nextPutError: Error | null = null;
  let nextSwitchError: Error | null = null;
  const sw: FakeSwitcher = {
    desired: null,
    unreachable: false,
    calls: [],
    failNextPut(err?: Error) {
      nextPutError = err ?? new Error('injected put failure');
    },
    failNextSwitch(err?: Error) {
      nextSwitchError = err ?? new Error('injected switch failure');
    },
    async putDesired(doc: SwitcherDesiredState): Promise<void> {
      sw.calls.push({ method: 'putDesired', revision: doc.revision });
      if (sw.unreachable) throw new Error('fetch failed: ECONNREFUSED');
      if (nextPutError) {
        const err = nextPutError;
        nextPutError = null;
        throw err;
      }
      sw.desired = structuredClone(doc);
    },
    async switchChannel(slug: string, upstreamId: string): Promise<void> {
      sw.calls.push({ method: 'switchChannel', slug, upstreamId });
      if (sw.unreachable) throw new Error('fetch failed: ECONNREFUSED');
      if (nextSwitchError) {
        const err = nextSwitchError;
        nextSwitchError = null;
        throw err;
      }
    },
    puts(): FakeSwitcherCall[] {
      return sw.calls.filter((c) => c.method === 'putDesired');
    },
    switches(): FakeSwitcherCall[] {
      return sw.calls.filter((c) => c.method === 'switchChannel');
    },
  };
  return sw;
}
