// Tags over Bluetooth through the TotTag Helper, where it is installed.
//
// The helper scans, so there is no browser chooser: tags are picked from the dashboard's own list
// of what the scan found (helperTransport.ts), and reached again later by the ID the scan reported,
// with no grants to lose. What a connected tag can do is gattTag.ts, the same code Web
// Bluetooth uses: this file supplies characteristics that look like Web Bluetooth's but pass each
// read, write and subscription to the helper, and hand its notifications back.

import { BLE_UUID } from '@tottag/schema';
import { fromBase64, helper, HelperClient, toBase64, type HelperEvent } from '../lib/helper.ts';
import type { TagConnection } from '../ports/tagTransport.ts';
import { GattTag, readIdentity, type GattCharacteristic, type GattLink, type TagIdentityFacts } from './gattTag.ts';

const DEVICE_INFO = '0000180a-0000-1000-8000-00805f9b34fb';
const LIVE_STATS = BLE_UUID.BLE_LIVE_STATS_SERVICE_ID.uuid;
const MAINTENANCE = BLE_UUID.BLE_MAINTENANCE_SERVICE_ID.uuid;

const bytesOf = (value: BufferSource): Uint8Array =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

/** A characteristic on a tag the helper is connected to, shaped like Web Bluetooth's. */
class HelperCharacteristic implements GattCharacteristic {
  value: DataView | undefined = undefined;
  readonly service: string;
  readonly uuid: string;
  private readonly client: HelperClient;
  private readonly connection: string;
  private readonly listeners = new Set<(event: Event) => void>();

  constructor(client: HelperClient, connection: string, service: string, uuid: string) {
    this.client = client;
    this.connection = connection;
    this.service = service;
    this.uuid = uuid;
  }

  private where() {
    return { connection: this.connection, service: this.service, characteristic: this.uuid };
  }

  async readValue(): Promise<DataView> {
    const { data } = await this.client.request<{ data?: string }>('read', this.where());
    const bytes = fromBase64(data);
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return this.value;
  }

  async writeValueWithResponse(value: BufferSource): Promise<void> {
    await this.client.request('write', { ...this.where(), data: toBase64(bytesOf(value)), withResponse: true });
  }

  async startNotifications(): Promise<this> {
    await this.client.request('notify', { ...this.where(), on: true });
    return this;
  }

  async stopNotifications(): Promise<this> {
    await this.client.request('notify', { ...this.where(), on: false });
    return this;
  }

  addEventListener(_type: 'characteristicvaluechanged', listener: (event: Event) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'characteristicvaluechanged', listener: (event: Event) => void): void {
    this.listeners.delete(listener);
  }

  /** A notification the helper passed on, delivered as Web Bluetooth delivers one. */
  notified(data: Uint8Array): void {
    this.value = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const event = { type: 'characteristicvaluechanged', target: this } as unknown as Event;
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** A connection the helper holds, and everything listening to it. */
class HelperLink implements GattLink {
  connected = true;
  readonly connection: string;
  readonly characteristics = new Map<string, HelperCharacteristic>();
  private readonly client: HelperClient;
  private readonly forget: (link: HelperLink) => void;
  private readonly listeners = new Set<() => void>();

  constructor(client: HelperClient, connection: string, forget: (link: HelperLink) => void) {
    this.client = client;
    this.connection = connection;
    this.forget = forget;
  }

  disconnect(): void {
    if (!this.connected) return;
    void this.client.request('disconnect', { connection: this.connection }).catch(() => undefined);
    // As Web Bluetooth does, letting go is also heard as the connection dropping
    this.dropped();
  }

  onDisconnected(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dropped(): void {
    if (!this.connected) return;
    this.connected = false;
    this.forget(this);
    for (const listener of [...this.listeners]) listener();
  }
}

const keyOf = (service: string, characteristic: string) => `${service.toLowerCase()}/${characteristic.toLowerCase()}`;

/**
 * Connecting to tags through one helper, and routing what it says back to the connection it is about.
 *
 * Exported for tests, which give it a stand-in helper; the page uses `helperTransport`.
 */
export class HelperTags {
  private readonly client: HelperClient;
  private readonly links = new Map<string, HelperLink>();
  /** Identity by device ID, read once a page session, as webBluetooth.ts keeps it. */
  private readonly identities = new Map<string, TagIdentityFacts>();

  constructor(client: HelperClient) {
    this.client = client;
    client.onEvent((event) => this.heard(event));
  }

  private heard(event: HelperEvent) {
    if (event.event === 'helperStopped') {
      for (const link of [...this.links.values()]) link.dropped();
      return;
    }
    if (event.event === 'disconnected') {
      this.links.get(event.connection)?.dropped();
    } else if (event.event === 'notification') {
      this.links.get(event.connection)?.characteristics.get(keyOf(event.service, event.characteristic))?.notified(fromBase64(event.data));
    }
  }

  /**
   * Connect to the tag a scan reported as `device`, and find what this page uses on it.
   *
   * `identify` 'fresh' reads who the tag is again, for a tag just picked; 'remembered' uses what this
   * page session read before, when it has, and then does not even look for the service it is in.
   */
  async open(device: string, identify: 'fresh' | 'remembered'): Promise<TagConnection> {
    const remembered = identify === 'remembered' ? this.identities.get(device) : undefined;
    const services = remembered ? [LIVE_STATS, MAINTENANCE] : [LIVE_STATS, MAINTENANCE, DEVICE_INFO];
    const reply = await this.client.request<{ connection: string; services: Array<{ uuid: string; characteristics: string[] }> }>(
      'connect', { device, services });
    const link = new HelperLink(this.client, reply.connection, (gone) => this.links.delete(gone.connection));
    this.links.set(link.connection, link);
    try {
      for (const service of reply.services) {
        for (const uuid of service.characteristics) {
          link.characteristics.set(keyOf(service.uuid, uuid), new HelperCharacteristic(this.client, reply.connection, service.uuid, uuid));
        }
      }
      // gattTag.ts finds characteristics by their UUID alone, as Web Bluetooth does within the services it asked for
      const chars = new Map<string, GattCharacteristic>();
      for (const characteristic of link.characteristics.values()) {
        if (characteristic.service !== DEVICE_INFO) chars.set(characteristic.uuid, characteristic);
      }
      const identity = remembered ?? await readIdentity(async (uuid) => {
        const found = link.characteristics.get(keyOf(DEVICE_INFO, uuid));
        if (!found) throw new Error(`The tag has no ${uuid}`);
        return found;
      });
      this.identities.set(device, identity);
      return new GattTag(link, chars, { handle: device, ...identity, transport: 'helper' });
    } catch (error) {
      // Nothing owns the connection until it is returned, so a failure here would otherwise leave it open
      link.disconnect();
      throw error;
    }
  }
}

/** The page's. */
export const helperTags = new HelperTags(helper);
