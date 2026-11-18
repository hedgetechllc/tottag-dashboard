// Web Serial: a TotTag plugged in over USB, reached through the browser. One of the adapters allowed
// to touch a browser API. What a tag on a port is and does is serialTag.ts, shared with the TotTag
// Helper; this file is only the browser's side: its chooser, the ports it has granted, and pumping
// bytes in and out of one.
//
// `getPorts()` returns every port already granted to this origin with no dialog, so a tag plugged in
// again after a reload is found by opening each granted port and asking which tag it is. That is why
// the handle is the EUI itself: a port object does not survive being unplugged, and the EUI is the
// only thing that stays the same.

import { USB_PID, USB_VID } from '@tottag/schema';
import type { TagConnection, TagTransport } from '../ports/tagTransport.ts';
import { SerialLink, UNIDENTIFIED_TAG, identifyTag } from './serialTag.ts';

// The parts of the Web Serial API used here. The DOM library does not declare them, and they are
// small enough that pulling in a types package for them is not worth it.
interface SerialPortInfo { usbVendorId?: number; usbProductId?: number }
interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}
interface Serial {
  requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

const serial = (): Serial | undefined => (navigator as Navigator & { serial?: Serial }).serial;

/** Ignored by a CDC device, but `open()` insists on one. */
const BAUD_RATE = 115_200;
const TOTTAG_FILTER: SerialPortInfo = { usbVendorId: USB_VID, usbProductId: USB_PID };

/** Tag handle to the port it was last found on, for this page session. */
const sessionPorts = new Map<string, SerialPort>();

/**
 * Open a port, and keep reading it into a link for as long as it is open.
 *
 * The reader runs until the port closes, so a reply that arrives before anything asks for it is kept.
 */
async function openLink(port: SerialPort): Promise<SerialLink> {
  await port.open({ baudRate: BAUD_RATE });
  if (!port.readable || !port.writable) throw new Error('The USB port opened without a data channel');
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  let pumping: Promise<void> = Promise.resolve();
  const link = new SerialLink({
    async write(bytes) {
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      await writer.write(copy);
    },
    async close() {
      try { await reader.cancel(); } catch { /* already closed */ }
      await pumping;
      reader.releaseLock();
      writer.releaseLock();
      try { await port.close(); } catch { /* unplugged */ }
    },
  });
  pumping = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) link.received(value);
      }
      link.ended(new Error('The tag was unplugged.'));
    } catch (error) {
      link.ended(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return link;
}

/**
 * Open a port and find out which tag is on it.
 *
 * Null when the port cannot be opened (another tab or program has it) or the tag does not report
 * its EUI; in both cases the port is left closed.
 */
async function openPort(port: SerialPort): Promise<TagConnection | null> {
  let link: SerialLink;
  try {
    link = await openLink(port);
  } catch {
    return null;
  }
  try {
    const connection = await identifyTag(link);
    if (!connection) { await link.close(); return null; }
    sessionPorts.set(connection.identity.handle, port);
    return connection;
  } catch (error) {
    await link.close();
    throw error;
  }
}

export const webSerialTransport: TagTransport = {
  id: 'serial',
  label: 'TotTag over USB',

  isAvailable: () => serial() !== undefined,

  unavailableReason() {
    if (serial()) return null;
    return 'This browser cannot talk to tags over USB. Chrome, Edge or Opera on a computer can; Safari and Firefox do not support it.';
  },

  canReachWithoutChooser(handle: string) {
    // A granted port is found again by asking each one which tag it is, so a tag plugged in is
    // always reachable without the chooser; one that is not plugged in is reported by connect().
    return sessionPorts.has(handle) || typeof serial()?.getPorts === 'function';
  },

  // Fixed for the life of the page, by the reasoning above
  onReachabilityChange: () => () => {},

  async requestDevice(onPicked?: () => void): Promise<TagConnection | null> {
    const api = serial();
    if (!api) throw new Error(webSerialTransport.unavailableReason() ?? 'USB unavailable');
    let port: SerialPort;
    try {
      port = await api.requestPort({ filters: [TOTTAG_FILTER] });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;   // dismissed
      throw error;
    }
    onPicked?.();
    const connection = await openPort(port);
    if (!connection) throw new Error(UNIDENTIFIED_TAG);
    return connection;
  },

  async connect(handle: string): Promise<TagConnection | null> {
    const api = serial();
    if (!api) return null;
    // The port this tag was last seen on first; if it has been unplugged and plugged back in, it is
    // a new port, so every other granted TotTag port gets asked which tag it is.
    const remembered = sessionPorts.get(handle);
    const candidates = [
      ...(remembered ? [remembered] : []),
      ...(await api.getPorts()).filter((port) => {
        const info = port.getInfo();
        return port !== remembered && info.usbVendorId === USB_VID && info.usbProductId === USB_PID;
      }),
    ];
    for (const port of candidates) {
      const connection = await openPort(port).catch(() => null);
      if (connection?.identity.handle === handle) return connection;
      await connection?.disconnect();
    }
    return null;
  },
};
