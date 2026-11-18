// Reaching tags through the TotTag Helper, over Bluetooth and over USB, as the rest of the page sees it.
//
// There is no browser chooser. Tags are picked from the dashboard's own list of what the helper has
// found, nearby and plugged in, several at once if wanted. A tag is reached again later by the ID a
// scan reported for it over Bluetooth (helperBluetooth.ts), or over USB by its EUI on whichever port it
// is plugged into (helperUsb.ts).

import { helper } from '../lib/helper.ts';
import type { PickOptions, TagConnection, TagTransport } from '../ports/tagTransport.ts';
import { helperTags } from './helperBluetooth.ts';
import { helperUsb } from './helperUsb.ts';

/** A tag picked from the helper's list: one a scan found nearby, or one plugged into a port. */
export type PickedTag =
  | { readonly kind: 'bluetooth'; readonly device: string }
  | { readonly kind: 'usb'; readonly port: string };

/** How the page asks someone to pick tags from what the helper has found, or none: one, or `multiple`. */
export type TagPicker = (options: PickOptions & { readonly multiple: boolean }) => Promise<PickedTag[]>;

let picker: TagPicker | null = null;

/** Set by the page's picker when it is on screen, and cleared when it goes. */
export function setTagPicker(next: TagPicker | null): void {
  picker = next;
}

function pick(multiple: boolean, options: PickOptions = {}): Promise<PickedTag[]> {
  if (!picker) return Promise.reject(new Error('This page cannot show the list of tags the TotTag Helper found.'));
  return picker({ usb: true, ...options, multiple });
}

const open = (picked: PickedTag): Promise<TagConnection> =>
  (picked.kind === 'usb' ? helperUsb.open(picked.port) : helperTags.open(picked.device, 'fresh'));

async function requestDevice(onPicked?: () => void, options?: PickOptions): Promise<TagConnection | null> {
  const [picked] = await pick(false, options);
  if (!picked) return null;
  onPicked?.();
  return open(picked);
}

const notRunning = () => (helper.ready ? null : 'The TotTag Helper is not running.');

/** Tags over Bluetooth through the helper, and picking any tag it has found. */
export const helperTransport: TagTransport = {
  id: 'helper',
  label: 'TotTag over the TotTag Helper',

  isAvailable: () => helper.ready,

  unavailableReason: notRunning,

  // Any tag a scan has ever reported can be connected to again, for as long as the helper runs
  canReachWithoutChooser: () => helper.ready,

  onReachabilityChange: (listener: () => void) => helper.onStateChange(listener),

  requestDevice,

  async *requestDevices(onPicked?: (count: number) => void, options?: PickOptions): AsyncGenerator<TagConnection | Error, void, void> {
    const picked = await pick(true, options);
    if (!picked.length) return;
    onPicked?.(picked.length);
    for (const each of picked) {
      try {
        yield await open(each);
      } catch (error) {
        yield error instanceof Error ? error : new Error(String(error));
      }
    }
  },

  async connect(handle: string): Promise<TagConnection | null> {
    try {
      return await helperTags.open(handle, 'remembered');
    } catch {
      return null;   // out of range, asleep, plugged in, or the helper has stopped
    }
  },
};

/**
 * Tags plugged in by USB, through the helper. A tag's handle is its EUI, as it is over the browser's
 * Web Serial, so a tag known over USB is reached either way.
 */
export const helperUsbTransport: TagTransport = {
  id: 'serial',
  label: 'TotTag over USB, through the TotTag Helper',

  isAvailable: () => helper.ready,

  unavailableReason: notRunning,

  // Whichever port it is on, a tag plugged in is found by asking each one
  canReachWithoutChooser: () => helper.ready,

  onReachabilityChange(listener: () => void) {
    const stops = [helper.onStateChange(listener), helperUsb.subscribe(listener)];
    return () => { for (const stop of stops) stop(); };
  },

  requestDevice,

  connect: (handle: string) => helperUsb.connect(handle),
};
