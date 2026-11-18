// Reaching a tag this browser already knows, and saying plainly why when it cannot be reached.

import { useMemo, useSyncExternalStore } from 'react';
import { tagName } from '@tottag/schema';
import { webBluetoothTransport } from '../adapters/webBluetooth.ts';
import { webSerialTransport } from '../adapters/webSerial.ts';
import { knownTagTransport, type KnownTag } from '../features/useKnownTags.ts';
import type { TagConnection, TagTransport } from '../ports/tagTransport.ts';

export const TRANSPORTS: Record<TagTransport['id'], TagTransport> = {
  bluetooth: webBluetoothTransport,
  serial: webSerialTransport,
};

export const transportFor = (route: KnownTag): TagTransport => TRANSPORTS[knownTagTransport(route)];

/** Whether the tag can be reached from a click on anything, or has to be picked in the chooser again first. */
export const reachableWithoutChooser = (route: KnownTag | null): boolean =>
  !!route && transportFor(route).canReachWithoutChooser(route.handle);

/** Every transport's reachability changes, as one store a component can subscribe to. */
const reachability = (() => {
  let version = 0;
  const listeners = new Set<() => void>();
  let stop: Array<() => void> = [];
  return {
    get: () => version,
    subscribe(listener: () => void) {
      if (!listeners.size) {
        stop = Object.values(TRANSPORTS).map((transport) => transport.onReachabilityChange(() => {
          version += 1;
          for (const each of [...listeners]) each();
        }));
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) for (const each of stop.splice(0)) each();
      };
    },
  };
})();

/**
 * The known tags that can be reached from a click, kept current as that changes; the rest have to be
 * picked in the chooser again. Also re-renders the caller whenever `reachableWithoutChooser` may answer
 * differently, for anything else on the page that asks it.
 *
 * After a reload, a Bluetooth tag is reachable only if the browser says it still holds a grant for it,
 * which it answers asynchronously. Until it has answered, no tag from before the reload is offered.
 */
export function useReachableTags(tags: readonly KnownTag[]): readonly KnownTag[] {
  // The version is what changes when the transports' answers do, so the list depends on it
  const version = useSyncExternalStore(reachability.subscribe, reachability.get, reachability.get);
  return useMemo(() => tags.filter((tag) => reachableWithoutChooser(tag)), [tags, version]);
}

/** Why known tags are missing from a list offering them, or null when none are. */
export function unlistedNote(known: number, listed: number): string | null {
  const unlisted = known - listed;
  if (unlisted <= 0) return null;
  return `${unlisted === 1 ? 'One tag this browser knows is' : `${unlisted} tags this browser knows are`} not listed: `
    + `after a reload, this browser needs ${unlisted === 1 ? 'it' : 'each one'} picked again.`;
}

/** Why a tag could not be reached, in terms of what to do about it. */
export function unreachableMessage(eui: Uint8Array | readonly number[], route: KnownTag | null): string {
  const name = tagName(eui);
  if (!route) return `This browser does not know how to reach ${name} yet. Use Reconnect and pick it from the list.`;
  if (knownTagTransport(route) === 'serial') return `Could not reach ${name}. Plug it into this computer with its USB cable, then try again.`;
  if (!reachableWithoutChooser(route)) return `After a reload, this browser needs you to pick ${name} again. Use Reconnect.`;
  return `Could not reach ${name}. Make sure it is on its charger and close to this computer, then try again.`;
}

/**
 * Connect, do one thing, disconnect.
 *
 * One tag at a time and never left open, exactly as the desktop tool does it: a tag accepts two
 * Bluetooth connections at most, and a USB port held open blocks every other program. Null when the
 * tag could not be reached; whatever `action` throws is passed on.
 */
export async function withTag<T>(route: KnownTag, action: (connection: TagConnection) => Promise<T>): Promise<{ value: T } | null> {
  const connection = await transportFor(route).connect(route.handle);
  if (!connection) return null;
  try {
    return { value: await action(connection) };
  } finally {
    await connection.disconnect();
  }
}

export const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));
