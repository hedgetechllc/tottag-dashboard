// Reaching a tag this browser already knows, and saying plainly why when it cannot be reached.

import { useMemo, useSyncExternalStore } from 'react';
import { formatEui, tagName } from '@tottag/schema';
import { helperTransport, helperUsbTransport } from '../adapters/helperTransport.ts';
import { helperUsb } from '../adapters/helperUsb.ts';
import { usbHandleFor } from '../adapters/serialTag.ts';
import { webBluetoothTransport } from '../adapters/webBluetooth.ts';
import { webSerialTransport } from '../adapters/webSerial.ts';
import { knownTagTransport, rememberUsed, routeFor, type KnownTag } from '../features/useKnownTags.ts';
import type { TagConnection, TagTransport } from '../ports/tagTransport.ts';

/** The way to reach a tag over Bluetooth now: through the TotTag Helper when it is running, else the browser's chooser. */
export const bluetoothTransport = (): TagTransport => (helperTransport.isAvailable() ? helperTransport : webBluetoothTransport);

/** The way to reach a tag over USB now: through the TotTag Helper when it is running, else the browser's Web Serial. */
export const usbTransport = (): TagTransport => (helperUsbTransport.isAvailable() ? helperUsbTransport : webSerialTransport);

/** USB as it is reached now. The helper and the browser both name a tag on USB by its EUI, so one entry serves either. */
const serialTransport: TagTransport = {
  id: 'serial',
  label: 'TotTag over USB',
  isAvailable: () => usbTransport().isAvailable(),
  unavailableReason: () => usbTransport().unavailableReason(),
  canReachWithoutChooser: (handle) => usbTransport().canReachWithoutChooser(handle),
  onReachabilityChange(listener) {
    const stops = [helperUsbTransport.onReachabilityChange(listener), webSerialTransport.onReachabilityChange(listener)];
    return () => { for (const stop of stops) stop(); };
  },
  requestDevice: (onPicked, options) => usbTransport().requestDevice(onPicked, options),
  connect: (handle) => usbTransport().connect(handle),
};

export const TRANSPORTS: Record<TagTransport['id'], TagTransport> = {
  helper: helperTransport,
  bluetooth: webBluetoothTransport,
  serial: serialTransport,
};

export const transportFor = (route: KnownTag): TagTransport => TRANSPORTS[knownTagTransport(route)];

/** How to reach the tag with this address now, among the ways this browser knows it and can use at the moment. */
export const routeTo = (tags: readonly KnownTag[], eui: Uint8Array | readonly number[]): KnownTag | null =>
  routeFor(tags, eui, (transport) => TRANSPORTS[transport].isAvailable());

/**
 * Connect to a tag this browser knows. Null when it could not be reached.
 *
 * Through the TotTag Helper, a tag plugged into this computer is reached over USB, however else it is
 * known and even if it never has been over USB: plugged into a computer, a tag turns its Bluetooth off,
 * so its route would only time out. Finding out costs one look at the USB ports, and is done only now,
 * when the tag is wanted.
 */
export async function connectTo(route: KnownTag): Promise<TagConnection | null> {
  let connection: TagConnection | null = null;
  if (knownTagTransport(route) !== 'serial' && helperUsbTransport.isAvailable()) {
    connection = await helperUsb.connect(usbHandleFor(Uint8Array.from(route.eui)));
  }
  connection ??= await transportFor(route).connect(route.handle);
  // Reached, so used now: lists of the tags this browser knows offer the ones used most recently
  if (connection) rememberUsed(connection.identity);
  return connection;
}

/** What picks a tag again, for one that cannot be reached without being picked: USB or Bluetooth, as each is reached now. */
export const pickAgainWith = (route: KnownTag | null): TagTransport =>
  route && knownTagTransport(route) === 'serial' ? usbTransport() : bluetoothTransport();

/**
 * One key for each tag and the kind of link to it. The helper and the browser both reach a tag over
 * Bluetooth, so a tag known both ways is one tag on Bluetooth; over USB it is another entry, reached
 * another way, and listed as such (describeKnownTag).
 */
const tagKey = (tag: KnownTag) => `${formatEui(Uint8Array.from(tag.eui))}/${knownTagTransport(tag) === 'serial' ? 'usb' : 'bluetooth'}`;

/** How many tags a list of the tags this browser knows offers: the ones used most recently. */
export const RECENT_TAGS = 10;

/**
 * The `RECENT_TAGS` tags used most recently, the most recent first: one entry for each tag on Bluetooth
 * and one for it on USB, whichever of its entries was used last.
 */
export function recentlyUsed(tags: readonly KnownTag[]): KnownTag[] {
  const latest = new Map<string, KnownTag>();
  for (const tag of tags) {
    const kept = latest.get(tagKey(tag));
    if (!kept || (kept.lastSeen ?? '') <= (tag.lastSeen ?? '')) latest.set(tagKey(tag), tag);
  }
  return [...latest.values()].sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '')).slice(0, RECENT_TAGS);
}

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
 * The tags used most recently, `RECENT_TAGS` at most and the most recent first, that can be reached
 * from a click, kept current as that changes; the rest have to be picked in the chooser again. Also
 * re-renders the caller whenever `reachableWithoutChooser` may answer differently, for anything else on
 * the page that asks it.
 *
 * After a reload, a Bluetooth tag is reachable only if the browser says it still holds a grant for it,
 * which it answers asynchronously. Until it has answered, no tag from before the reload is offered.
 */
export function useReachableTags(tags: readonly KnownTag[]): readonly KnownTag[] {
  // The version is what changes when the transports' answers do, so the list depends on it
  const version = useSyncExternalStore(reachability.subscribe, reachability.get, reachability.get);
  return useMemo(() => {
    // Each tag once on Bluetooth, by the way it is reached now: through the helper when it can be
    const reachable: KnownTag[] = [];
    for (const tag of recentlyUsed(tags)) {
      const route = knownTagTransport(tag) === 'serial' ? tag
        : routeFor(tags.filter((other) => knownTagTransport(other) !== 'serial'), tag.eui, (transport) => TRANSPORTS[transport].isAvailable());
      if (route && reachableWithoutChooser(route)) reachable.push(route);
    }
    return reachable;
  }, [tags, version]);
}

/** Why some of the tags used most recently are missing from a list offering them, or null when none are. */
export function unlistedNote(known: readonly KnownTag[], listed: number): string | null {
  const unlisted = Math.min(new Set(known.map(tagKey)).size, RECENT_TAGS) - listed;
  if (unlisted <= 0) return null;
  return `${unlisted === 1 ? 'One tag used recently is' : `${unlisted} tags used recently are`} not listed: `
    + `after a reload, this browser needs ${unlisted === 1 ? 'it' : 'each one'} picked again.`;
}

/** Why a tag could not be reached, in terms of what to do about it. */
export function unreachableMessage(eui: Uint8Array | readonly number[], route: KnownTag | null): string {
  const name = tagName(eui);
  if (!route) return `This browser does not know how to reach ${name} yet. Use Reconnect and pick it from the list.`;
  if (knownTagTransport(route) === 'serial') {
    // Known only over USB, so there is no Bluetooth ID to reach it by until it has been picked from the list once
    return helperTransport.isAvailable()
      ? `Could not reach ${name}. Plug it into this computer with its USB cable, or put it on its charger and pick it from the list of tags once, so it can be reached over Bluetooth too.`
      : `Could not reach ${name}. Plug it into this computer with its USB cable, then try again.`;
  }
  if (knownTagTransport(route) === 'helper' && !helperTransport.isAvailable()) {
    return `The TotTag Helper is not running, so ${name} has to be picked again. Use Reconnect.`;
  }
  if (!reachableWithoutChooser(route)) return `After a reload, this browser needs you to pick ${name} again. Use Reconnect.`;
  return helperTransport.isAvailable()
    ? `Could not reach ${name}. Make sure it is on its charger and close to this computer, or plugged into it, then try again.`
    : `Could not reach ${name}. Make sure it is on its charger and close to this computer, then try again.`;
}

/**
 * Connect, do one thing, disconnect.
 *
 * One tag at a time and never left open, exactly as the desktop tool does it: a tag accepts two
 * Bluetooth connections at most, and a USB port held open blocks every other program. Null when the
 * tag could not be reached; whatever `action` throws is passed on.
 */
export async function withTag<T>(route: KnownTag, action: (connection: TagConnection) => Promise<T>): Promise<{ value: T } | null> {
  const connection = await connectTo(route);
  if (!connection) return null;
  try {
    return { value: await action(connection) };
  } finally {
    await connection.disconnect();
  }
}

export const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));
