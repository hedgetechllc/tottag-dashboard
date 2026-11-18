// Tags plugged into this computer by USB, through the TotTag Helper.
//
// The helper lists the USB ports a TotTag could be on and passes bytes in and out of one; what a tag
// on a port is and does is serialTag.ts, the same code the browser's Web Serial uses.
//
// Nothing here runs in the background. The ports are looked at only when something asks: while the
// picker is open, as Bluetooth is scanned only then, and when the page is about to reach a tag. A port
// says nothing about which tag is on it, so each one is opened for a moment and asked; and since
// another tag can be plugged into the same socket under the same port name, what a port said is
// trusted only for as long as the picker keeps looking, and asked again otherwise.

import { USB_PID, USB_VID, formatEui } from '@tottag/schema';
import { fromBase64, helper, toBase64, type HelperClient, type HelperEvent } from '../lib/helper.ts';
import type { TagConnection } from '../ports/tagTransport.ts';
import { SerialLink, UNIDENTIFIED_TAG, identifyTag, readEui, usbHandleFor } from './serialTag.ts';

/** How often the list of tags plugged in is brought up to date while the picker is open. */
const WATCH_MS = 2000;

export interface PluggedTag {
  /** The port, as the system names it: /dev/cu.usbmodem1101, COM4. */
  readonly port: string;
  /** Which tag is on it, once it has said. */
  readonly eui: Uint8Array | null;
  /**
   * 'identifying' until it has been asked which tag it is, and 'ready' once it has said. 'busy' while
   * another program has the port, which is asked again each time the list is brought up to date.
   * 'silent' for firmware too old to say.
   */
  readonly state: 'identifying' | 'ready' | 'busy' | 'silent';
}

const sameList = (a: readonly PluggedTag[], b: readonly PluggedTag[]) =>
  a.length === b.length && a.every((tag, index) => {
    const other = b[index]!;
    return tag.port === other.port && tag.state === other.state
      && (tag.eui && other.eui ? formatEui(tag.eui) === formatEui(other.eui) : tag.eui === other.eui);
  });

/**
 * The tags plugged into this computer, as one helper sees them, and opening them.
 *
 * Exported for tests, which give it a stand-in helper; the page uses `helperUsb`.
 */
export class HelperUsb {
  private readonly client: HelperClient;
  private readonly watchMs: number;
  private readonly links = new Map<string, SerialLink>();
  private readonly listeners = new Set<() => void>();
  /** Ports a tag is open on for the page, which are not asked again while it is. */
  private readonly inUse = new Set<string>();
  private plugged: readonly PluggedTag[] = [];
  private watchers = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<readonly PluggedTag[]> | null = null;

  constructor(client: HelperClient, watchMs = WATCH_MS) {
    this.client = client;
    this.watchMs = watchMs;
    client.onEvent((event) => this.heard(event));
  }

  getSnapshot = (): readonly PluggedTag[] => this.plugged;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /**
   * Keep the list up to date, every few seconds, until the returned function is called: for the
   * picker, while it is open. Starts from an empty list, so nothing said before is trusted.
   */
  watch(): () => void {
    if (this.watchers++ === 0) {
      this.publish([]);
      void this.tick();
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (--this.watchers > 0) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  private async tick() {
    this.timer = null;
    await this.refresh().catch(() => undefined);
    if (this.watchers > 0 && !this.timer) this.timer = setTimeout(() => void this.tick(), this.watchMs);
  }

  /**
   * Look at the ports now, and say which tag is on each. One look at a time: a call while one is under
   * way waits for that one.
   */
  refresh(): Promise<readonly PluggedTag[]> {
    this.refreshing ??= this.update().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async update(): Promise<readonly PluggedTag[]> {
    const { ports } = await this.client.request<{ ports: Array<{ port: string }> }>('usbList', { vendorId: USB_VID, productId: USB_PID });
    // While the picker is looking, a port that stayed is the same tag: it was asked a moment ago. Otherwise
    // every port is asked again, except one the page has open, which said which tag it is when it was opened.
    const trusted = this.watchers > 0;
    const before = new Map(this.plugged.map((tag) => [tag.port, tag]));
    this.publish(ports.map(({ port }) => {
      const known = before.get(port);
      return known && (trusted || this.inUse.has(port)) ? known : { port, eui: null, state: 'identifying' };
    }));
    for (const { port, state } of this.plugged) {
      if ((state !== 'identifying' && state !== 'busy') || this.inUse.has(port)) continue;
      const found = await this.identify(port);
      this.publish(this.plugged.map((tag) => (tag.port === port ? found : tag)));
    }
    return this.plugged;
  }

  private async identify(port: string): Promise<PluggedTag> {
    let link: SerialLink;
    try {
      link = await this.openLink(port);
    } catch {
      // Another program has it, or it has just been unplugged, which the next look at the list will say
      return { port, eui: null, state: 'busy' };
    }
    try {
      const eui = await readEui(link);
      return eui ? { port, eui, state: 'ready' } : { port, eui: null, state: 'silent' };
    } finally {
      await link.close();
    }
  }

  private publish(next: readonly PluggedTag[]) {
    if (sameList(next, this.plugged)) return;
    this.plugged = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Open a port, and have what it receives passed to the link until it closes. */
  private async openLink(port: string, onClose?: () => void): Promise<SerialLink> {
    const { connection } = await this.client.request<{ connection: string }>('usbOpen', { port });
    const link = new SerialLink({
      write: async (bytes) => { await this.client.request('usbWrite', { connection, data: toBase64(bytes) }); },
      close: async () => {
        this.links.delete(connection);
        onClose?.();
        await this.client.request('usbClose', { connection }).catch(() => undefined);
      },
    });
    // A tag speaks only when spoken to, so nothing it sends can arrive before this
    this.links.set(connection, link);
    return link;
  }

  private heard(event: HelperEvent) {
    if (event.event === 'helperStopped') {
      for (const link of this.links.values()) link.ended(new Error(event.error));
      this.links.clear();
    } else if (event.event === 'usbData') {
      this.links.get(event.connection)?.received(fromBase64(event.data));
    } else if (event.event === 'usbClosed') {
      const link = this.links.get(event.connection);
      this.links.delete(event.connection);
      link?.ended(new Error(event.error ?? 'The tag was unplugged.'));
    }
  }

  /** Open the tag plugged into `port`, and find out which tag it is. */
  async open(port: string): Promise<TagConnection> {
    this.inUse.add(port);
    const release = () => { this.inUse.delete(port); };
    let link: SerialLink;
    try {
      // Not while a look at the ports has it open, asking which tag it is
      await this.refreshing?.catch(() => undefined);
      link = await this.openLink(port, release);
    } catch (error) {
      release();
      throw error;
    }
    try {
      const connection = await identifyTag(link);
      if (connection) {
        // What it said stands for the list too, which does not ask it again while the page has it open
        const eui = connection.identity.eui;
        this.publish(this.plugged.map((tag) => (tag.port === port ? { port, eui, state: 'ready' } : tag)));
        return connection;
      }
    } catch (error) {
      await link.close();
      throw error;
    }
    await link.close();
    throw new Error(UNIDENTIFIED_TAG);
  }

  /**
   * Connect to the tag with this handle, `usb:` and its EUI, on whichever port it is plugged into; null
   * when it is not plugged in. With no tag plugged in at all, finding that out is one look at the list.
   */
  async connect(handle: string): Promise<TagConnection | null> {
    const plugged = await this.refresh().catch(() => [] as readonly PluggedTag[]);
    const found = plugged.find((tag) => tag.eui && usbHandleFor(tag.eui) === handle);
    if (!found) return null;
    try {
      const connection = await this.open(found.port);
      if (connection.identity.handle === handle) return connection;
      // Unplugged, and another tag plugged into the same socket, since the picker last looked
      await connection.disconnect();
    } catch { /* unplugged, or another program has it */ }
    return null;
  }
}

/** The page's. */
export const helperUsb = new HelperUsb(helper);
