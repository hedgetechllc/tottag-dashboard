// Web Bluetooth. One of the adapters allowed to touch a browser API.
//
// Everything protocol-shaped — what the bytes mean, how a stream is framed, what a valid deployment
// is — lives in @tottag/schema, and what a connected tag can do lives in gattTag.ts, shared with the
// TotTag Helper. This file is the browser's side: the chooser, the grants it leaves behind, and
// finding a connected tag's characteristics.
//
// Two constraints from the API shape the design and are worth stating, because neither is obvious
// and both changed what the UI can offer:
//
//   1. There is NO WAY TO ENUMERATE NEARBY DEVICES. `requestDevice()` opens a browser-controlled
//      chooser and returns the one the user clicks. A ten-tag deployment therefore costs ten
//      dialogs on first use. The TotTag Helper, where it is installed, scans instead
//      (helperBluetooth.ts). `getDevices()` returns previously-granted devices with no dialog, which
//      is what makes the second and later runs cheap, so pairing is worth doing once and reusing.
//
//   2. THE MAC ADDRESS IS NEVER EXPOSED. `device.id` is an opaque per-origin string. The tag's real
//      EUI has to come from GATT System ID (0x2A23), which the firmware populates in
//      `bluetooth_init()` as [uid0, uid1, uid2, 0xFE, 0xFF, uid3, uid4, uid5]. The Python tool split
//      the BLE address instead, which is why that approach does not port.

import { BLE_UUID } from '@tottag/schema';
import type { TagConnection, TagTransport } from '../ports/tagTransport.ts';
import {
  GattTag, OPERATION_TIMEOUT_MS, readIdentity, withTimeout,
  type GattCharacteristic, type GattLink, type TagIdentityFacts,
} from './gattTag.ts';

const DEVICE_INFO_SERVICE = 0x180a;
const LIVE_STATS = BLE_UUID.BLE_LIVE_STATS_SERVICE_ID.uuid;
const MAINTENANCE = BLE_UUID.BLE_MAINTENANCE_SERVICE_ID.uuid;

const bluetooth = (): Bluetooth | undefined => (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;

/**
 * Devices this page can reach without the chooser, by their opaque id: those the chooser has handed
 * us during this page session, and those `getDevices()` says this origin still holds a grant for.
 *
 * A `BluetoothDevice` from `requestDevice()` stays usable for as long as the page lives, so
 * reconnecting to one costs nothing. Without this cache every reconnect went through
 * `navigator.bluetooth.getDevices()`, which several Chrome versions gate behind
 * chrome://flags/#enable-web-bluetooth-new-permissions-backend — so a tag the user had JUST picked
 * came back as "could not reach that tag", which is both wrong and impossible to act on.
 */
const sessionDevices = new Map<string, BluetoothDevice>();

/**
 * Whether a tag can be reached without the chooser changes in two ways: when `getDevices()` answers
 * with the devices this origin still holds grants for, and when one is picked.
 *
 * Asking `getDevices()` is the only way to know, because the API existing says nothing about which
 * tags it will return. Where a browser has no `getDevices()`, nothing picked outlives a reload; where
 * it has one, a grant can still lapse or be revoked. So a tag offered for a one-click connect after a
 * reload has to be one that `getDevices()` actually returned.
 */
const reachabilityListeners = new Set<() => void>();
let grantsAsked = false;

const reachabilityChanged = () => {
  for (const listener of [...reachabilityListeners]) listener();
};

function askForGrants(): void {
  if (grantsAsked) return;
  grantsAsked = true;
  const api = bluetooth() as (Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> }) | undefined;
  if (!api?.getDevices) return;
  api.getDevices().then((devices) => {
    for (const device of devices) if (!sessionDevices.has(device.id)) sessionDevices.set(device.id, device);
    if (devices.length) reachabilityChanged();
  }, () => { /* no grants to offer, so every tag is picked again */ });
}

/**
 * What identifies each tag, by the browser's id for it, for this page session.
 *
 * Reading it costs three reads on every connection, and none of it changes while the page is open
 * unless the tag is reflashed: picking a tag in the chooser always reads it again, which is how a
 * reflashed tag's new firmware revision is picked up without a reload.
 */
const sessionIdentities = new Map<string, TagIdentityFacts>();

/**
 * Connect and find everything this page uses on the tag.
 *
 * `identify` says whether to read the tag's identity again ('fresh', for a tag just picked in the
 * chooser) or use the one remembered for this page session when there is one ('remembered').
 */
async function openDevice(device: BluetoothDevice, identify: 'fresh' | 'remembered'): Promise<TagConnection> {
  if (!device.gatt) throw new Error('This device does not support GATT');
  const server = await withTimeout(device.gatt.connect(), OPERATION_TIMEOUT_MS, 'Connecting');
  try {
    const chars = new Map<string, GattCharacteristic>();
    for (const [service, uuids] of [
      [LIVE_STATS, [
        BLE_UUID.BLE_LIVE_STATS_BATTERY_CHAR.uuid,
        BLE_UUID.BLE_LIVE_STATS_TIMESTAMP_CHAR.uuid,
        BLE_UUID.BLE_LIVE_STATS_FINDMYTOTTAG_CHAR.uuid,
        BLE_UUID.BLE_LIVE_STATS_RANGING_CHAR.uuid,
        BLE_UUID.BLE_LIVE_STATS_RADIO_CHAR.uuid,
      ]],
      [MAINTENANCE, [
        BLE_UUID.BLE_MAINTENANCE_EXPERIMENT_CHAR.uuid,
        BLE_UUID.BLE_MAINTENANCE_COMMAND_CHAR.uuid,
        BLE_UUID.BLE_MAINTENANCE_DATA_CHAR.uuid,
      ]],
    ] as const) {
      // The first service asked for waits for the browser to discover every service on the tag, which
      // is most of what a connection costs: about 0.7 s on macOS at the interval the tag asks for
      const handle = await server.getPrimaryService(service);
      for (const uuid of uuids) {
        try { chars.set(uuid, await handle.getCharacteristic(uuid)); } catch { /* optional on some builds */ }
      }
    }

    const remembered = identify === 'remembered' ? sessionIdentities.get(device.id) : undefined;
    let info: Promise<BluetoothRemoteGATTService> | null = null;
    const identity = remembered ?? await readIdentity(async (uuid) =>
      (await (info ??= server.getPrimaryService(DEVICE_INFO_SERVICE))).getCharacteristic(uuid));
    sessionIdentities.set(device.id, identity);
    const link: GattLink = {
      get connected() { return server.connected; },
      disconnect: () => server.disconnect(),
      onDisconnected: (listener) => {
        device.addEventListener('gattserverdisconnected', listener);
        return () => device.removeEventListener('gattserverdisconnected', listener);
      },
    };
    return new GattTag(link, chars, { handle: device.id, ...identity, transport: 'bluetooth' });
  } catch (error) {
    // Nothing owns the connection until it is returned, so a failure here would otherwise leave it open
    server.disconnect();
    throw error;
  }
}

export const webBluetoothTransport: TagTransport = {
  id: 'bluetooth',
  label: 'TotTag over Bluetooth',

  isAvailable: () => bluetooth() !== undefined,

  unavailableReason() {
    if (bluetooth()) return null;
    return 'This browser cannot talk to tags over Bluetooth. Chrome, Edge or Opera on a computer can; Safari and Firefox do not support it.';
  },

  canReachWithoutChooser(handle: string) {
    askForGrants();
    return sessionDevices.has(handle);
  },

  onReachabilityChange(listener: () => void) {
    reachabilityListeners.add(listener);
    askForGrants();
    return () => { reachabilityListeners.delete(listener); };
  },

  async requestDevice(onPicked?: () => void): Promise<TagConnection | null> {
    const api = bluetooth();
    if (!api) throw new Error(webBluetoothTransport.unavailableReason() ?? 'Bluetooth unavailable');
    try {
      const device = await api.requestDevice({
        // PREFIX, not an exact name. Firmware advertises "TotTag 02:0A", the same name the dashboard
        // gives the tag (tagName), so that a chooser can tell tags apart. An exact `name` filter
        // would match none of them. Earlier firmware advertised "TotTag-0A" or plain "TotTag", which
        // the same prefix still matches.
        //
        // On macOS the chooser shows the name CoreBluetooth has cached for the device, which can be
        // the plain "TotTag" an earlier firmware reported, not the name it advertises now. Chrome then
        // adds an internal device ID to tell the identical names apart.
        filters: [{ namePrefix: 'TotTag' }],
        optionalServices: [LIVE_STATS, MAINTENANCE, DEVICE_INFO_SERVICE],
      });
      onPicked?.();
      const known = sessionDevices.has(device.id);
      sessionDevices.set(device.id, device);
      if (!known) reachabilityChanged();
      return await openDevice(device, 'fresh');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;   // dismissed
      throw error;
    }
  },

  async connect(handle: string): Promise<TagConnection | null> {
    // Session cache first: a device the chooser already returned needs no permission lookup at all.
    let device = sessionDevices.get(handle);
    if (!device) {
      const api = bluetooth() as (Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> }) | undefined;
      if (!api?.getDevices) return null;
      device = (await api.getDevices()).find((candidate) => candidate.id === handle);
      if (!device) return null;
      sessionDevices.set(handle, device);
      reachabilityChanged();
    }
    try {
      return await openDevice(device, 'remembered');
    } catch {
      return null;   // out of range, asleep, or the grant has lapsed
    }
  },
};