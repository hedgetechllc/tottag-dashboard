// A TotTag plugged in over USB, however the port is reached: what its commands are and how a log
// download is read. Shared by the two ways this page reaches a tag over USB, the browser's Web Serial
// and the TotTag Helper, so that neither keeps a copy.
//
// A tag that finds a USB host at boot enters USB maintenance mode and serves a CDC command loop
// (`UsbCdcTask` in firmware/src/tasks/usb_task.c) in place of Bluetooth, which stays off until it is
// unplugged. Every command is one byte, some followed by a payload, and only some answer. Nothing is
// framed, so each read here asks for exactly as many bytes as that command's reply holds.
//
// A serial port carries NO IDENTITY: its USB vendor and product IDs are every TotTag's, and the USB
// serial-number string is a fixed model name. The EUI has to be asked for with USB_GET_UID_COMMAND, so
// identifying a port means opening it, and a tag's handle is its EUI, the only thing about it that
// survives being unplugged. Firmware older than that command stays silent, and such a tag cannot be put
// in a deployment over USB, since the schedule has to name every tag by its EUI.

import {
  EUI_LEN, NANDLOG_MAX_RETRANSMIT_PAGES, STREAM_HEADER_LAYOUT, USB_COMMAND,
  V2_STREAM_MAGIC, WIRE_PAGE_LAYOUT, ThroughputMeter,
  encodeExperimentDetails, formatEui, parseExperimentDetails,
  type DeploymentConfig, type ExperimentDetails,
} from '@tottag/schema';
import type { DownloadProgress, TagConnection, TagIdentity, TagSnapshot } from '../ports/tagTransport.ts';

/** Long enough for a flash write on the tag, short enough that a silent tag is not a hang. */
const OPERATION_TIMEOUT_MS = 3_000;
/** How long an unidentified port gets to answer. Older firmware never will. */
const IDENTIFY_TIMEOUT_MS = 1_000;
/** No data for this long mid-transfer means the transfer has died. */
const STREAM_IDLE_TIMEOUT_MS = 20_000;
/**
 * Before the stream header, the tag reads every page of the log to total its size, at about 1.1 ms a
 * page: 15 s for a week of data and about 6 minutes for a full 1 GiB part.
 */
const STREAM_START_TIMEOUT_MS = 600_000;
/** The firmware reads the retransmission count as one byte, and each request replaces the last. */
const MAX_SEQS_PER_REQUEST = Math.min(255, NANDLOG_MAX_RETRANSMIT_PAGES);
/** The download reply opens with the tag's UID and a newline, then the details length. */
const DOWNLOAD_PREAMBLE_BYTES = EUI_LEN + 1 + 2;

const NEWLINE = 0x0a;

/** A tag's handle over USB, however the port is reached: its EUI, the one thing that outlives unplugging. */
export const usbHandleFor = (eui: Uint8Array): string => `usb:${formatEui(eui)}`;

/** Where a link's bytes go, and how it is let go of: a port the browser opened, or one the TotTag Helper holds. */
export interface SerialPipe {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * An open port, with its incoming bytes buffered so they can be read by count.
 *
 * Whatever holds the port passes in what arrives, for as long as it is open. Bytes that arrive when
 * nothing is waiting are kept, because a reply can land before the code that wants it has started
 * reading.
 */
export class SerialLink {
  private readonly pipe: SerialPipe;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private wake: (() => void) | null = null;
  private closedError: Error | null = null;

  constructor(pipe: SerialPipe) {
    this.pipe = pipe;
  }

  get isOpen(): boolean {
    return this.closedError === null;
  }

  /** Bytes the port received. */
  received(chunk: Uint8Array): void {
    if (this.closedError || !chunk.length) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.wake?.();
  }

  /** The port closed or failed: whatever is waiting fails with `error`. */
  ended(error: Error): void {
    this.closedError ??= error;
    this.wake?.();
  }

  /** Drop anything already received, so a reply cannot be confused with leftovers from the last one. */
  discardInput(): void {
    this.chunks = [];
    this.buffered = 0;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closedError) throw this.closedError;
    await this.pipe.write(bytes);
  }

  /** Resolve once at least `count` bytes are buffered, or reject after `ms` with nothing new. */
  private async waitFor(count: number, ms: number, what: string): Promise<void> {
    while (this.buffered < count) {
      if (this.closedError) throw this.closedError;
      const before = this.buffered;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = null;
      if (this.buffered === before && !this.closedError) throw new Error(`${what} timed out after ${ms / 1000}s`);
    }
  }

  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.chunks[0]!;
      const used = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, used), filled);
      filled += used;
      if (used === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
    }
    this.buffered -= count;
    return out;
  }

  async read(count: number, ms: number, what: string): Promise<Uint8Array> {
    await this.waitFor(count, ms, what);
    return this.take(count);
  }

  /** Whatever has arrived, at least one byte and at most `max`. */
  async readSome(max: number, ms: number, what: string): Promise<Uint8Array> {
    await this.waitFor(1, ms, what);
    return this.take(Math.min(max, this.buffered));
  }

  async readLine(ms: number, what: string): Promise<string> {
    const bytes: number[] = [];
    for (;;) {
      const [byte] = await this.read(1, ms, what);
      if (byte === NEWLINE) return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/, '');
      bytes.push(byte!);
    }
  }

  async close(): Promise<void> {
    if (!this.closedError) this.ended(new Error('The USB port was closed.'));
    await this.pipe.close();
  }
}

const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

/** The tag's EUI, or null when it does not answer USB_GET_UID_COMMAND. */
export async function readEui(link: SerialLink): Promise<Uint8Array | null> {
  link.discardInput();
  await link.write(Uint8Array.of(USB_COMMAND.USB_GET_UID_COMMAND));
  try {
    const reply = await link.read(EUI_LEN + 1, IDENTIFY_TIMEOUT_MS, 'Identifying the tag');
    return reply[EUI_LEN] === NEWLINE ? reply.slice(0, EUI_LEN) : null;
  } catch {
    return null;
  }
}

class SerialTag implements TagConnection {
  readonly identity: TagIdentity;
  private readonly link: SerialLink;

  constructor(link: SerialLink, identity: TagIdentity) {
    this.link = link;
    this.identity = identity;
  }

  isConnected(): boolean {
    return this.link.isOpen;
  }

  async readSnapshot(): Promise<TagSnapshot> {
    const batteryMv = await this.query(USB_COMMAND.USB_VOLTAGE_COMMAND, 2, 'Reading the battery')
      .then((bytes) => new DataView(bytes.buffer).getUint16(0, true), () => null);
    const timestamp = await this.query(USB_COMMAND.USB_GET_TIMESTAMP_COMMAND, 4, "Reading the tag's clock")
      .then((bytes) => new DataView(bytes.buffer).getUint32(0, true), () => null);
    let experiment: ExperimentDetails | null = null;
    try {
      experiment = await this.readExperiment();
    } catch {
      // A tag with no deployment yet is normal, not an error worth surfacing here.
    }
    return { batteryMv, timestamp, experiment };
  }

  private async query(command: number, replyBytes: number, what: string): Promise<Uint8Array> {
    this.link.discardInput();
    await this.link.write(Uint8Array.of(command));
    return this.link.read(replyBytes, OPERATION_TIMEOUT_MS, what);
  }

  async syncClock(): Promise<void> {
    // One write, so the timestamp arrives in the same USB packet as its command byte.
    await this.link.write(join(Uint8Array.of(USB_COMMAND.USB_SET_TIMESTAMP_COMMAND), u32(Math.round(Date.now() / 1000))));
  }

  async writeDeployment(config: DeploymentConfig): Promise<void> {
    // Clock first, always, for the same reason as over Bluetooth: the tag compares the stored start
    // time against its own RTC. Neither command answers, so success is only known from the readback
    // that the caller always does next.
    await this.syncClock();
    await this.link.write(join(Uint8Array.of(USB_COMMAND.USB_NEW_EXPERIMENT_COMMAND), encodeExperimentDetails(config)));
  }

  async readExperiment(): Promise<ExperimentDetails> {
    const length = new DataView((await this.query(USB_COMMAND.USB_GET_EXPERIMENT_COMMAND, 2, 'Reading the deployment back')).buffer)
      .getUint16(0, true);
    return parseExperimentDetails(await this.link.read(length, OPERATION_TIMEOUT_MS, 'Reading the deployment back'));
  }

  async cancelDeployment(): Promise<void> {
    await this.syncClock();
    await this.link.write(Uint8Array.of(USB_COMMAND.USB_DELETE_EXPERIMENT_COMMAND));
  }

  async locate(_seconds: number): Promise<void> {
    // The USB command takes no duration; the firmware sounds the buzzer for a fixed ten seconds.
    await this.link.write(Uint8Array.of(USB_COMMAND.USB_FIND_MY_TOTTAG_COMMAND));
  }

  async downloadLog(
    range: { start: number; end: number } | null,
    onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.link.discardInput();
    await this.link.write(join(
      Uint8Array.of(USB_COMMAND.USB_SET_LOG_DL_DATES_COMMAND),
      u32(range ? range.start : 0),
      u32(range ? range.end : 0),
    ));
    return this.collectStream(onProgress, signal);
  }

  async retransmitPages(seqs: readonly number[], onProgress: (progress: DownloadProgress) => void): Promise<Uint8Array> {
    // Each request REPLACES the device's list rather than adding to it, so everything asked for in
    // one round has to go in one request. The caller keeps whatever does not fit for a later round.
    seqs = seqs.slice(0, MAX_SEQS_PER_REQUEST);
    const request = new Uint8Array(2 + seqs.length * 4);
    const view = new DataView(request.buffer);
    request[0] = USB_COMMAND.USB_RETRANSMIT_PAGES_COMMAND;
    request[1] = seqs.length;
    seqs.forEach((seq, position) => view.setUint32(2 + position * 4, seq, true));
    this.link.discardInput();
    await this.link.write(request);
    return this.collectStream(onProgress);
  }

  /**
   * Start a transfer and read the stream it produces.
   *
   * Over USB the reply is the tag's UID and a newline, a u16 details length, and then exactly the
   * stream Bluetooth delivers: the header, the details unless this is a repair round, and the page
   * frames. There is no completion marker, so the end is the last page the header announced, at the
   * length its own frame gives.
   */
  private async collectStream(onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal): Promise<Uint8Array> {
    onProgress({ phase: 'starting', bytesReceived: 0, bytesExpected: null, pagesExpected: null, bytesPerSecond: null, secondsRemaining: null });
    await this.link.write(Uint8Array.of(USB_COMMAND.USB_DOWNLOAD_LOG_COMMAND));
    const idle = 'The tag stopped sending. Check the USB cable and try again.';
    await this.link.read(DOWNLOAD_PREAMBLE_BYTES, STREAM_IDLE_TIMEOUT_MS, idle);

    const header = await this.link.read(STREAM_HEADER_LAYOUT.size, STREAM_START_TIMEOUT_MS, idle);
    if (new TextDecoder().decode(header.subarray(0, 4)) !== V2_STREAM_MAGIC) {
      throw new Error("This tag's firmware sends a log format that USB downloads here do not read. Update the firmware.");
    }
    const at = (name: string): number => {
      const field = STREAM_HEADER_LAYOUT.fields.find((candidate) => candidate.name === name);
      if (!field) throw new Error(`nandlog_stream_header_t has no field '${name}'`);
      return field.offset;
    };
    const view = new DataView(header.buffer);
    const totalPages = view.getUint32(at('total_pages'), true);
    const detailsLength = view.getUint16(at('details_length'), true);
    // The declared total only sizes the progress bar. Firmware before nandlog 8a88cad declares a
    // date-limited download one page short, so each page is read by the length in its own frame
    const expected =
      STREAM_HEADER_LAYOUT.size + detailsLength + totalPages * WIRE_PAGE_LAYOUT.size + view.getUint32(at('total_payload_bytes'), true);
    const payloadLengthAt = WIRE_PAGE_LAYOUT.fields.find((field) => field.name === 'payload_length')?.offset;
    if (payloadLengthAt === undefined) throw new Error("nandlog_wire_page_t has no field 'payload_length'");

    const parts: Uint8Array[] = [header];
    let received = header.length;
    const meter = new ThroughputMeter();
    const report = (phase: DownloadProgress['phase']) => {
      meter.record(performance.now(), received);
      const estimate = meter.estimate(Math.max(expected, received));
      onProgress({
        phase, bytesReceived: received, bytesExpected: Math.max(expected, received), pagesExpected: totalPages,
        bytesPerSecond: estimate.bytesPerSecond, secondsRemaining: estimate.secondsRemaining,
      });
    };
    const take = async (count: number) => {
      for (let left = count; left > 0;) {
        if (signal?.aborted) throw new Error('Download canceled');
        const chunk = await this.link.readSome(left, STREAM_IDLE_TIMEOUT_MS, idle);
        parts.push(chunk);
        received += chunk.length;
        left -= chunk.length;
        report('pages');
      }
    };

    report('pages');
    await take(detailsLength);
    for (let page = 0; page < totalPages; page += 1) {
      const frame = await this.link.read(WIRE_PAGE_LAYOUT.size, STREAM_IDLE_TIMEOUT_MS, idle);
      parts.push(frame);
      received += frame.length;
      await take(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(payloadLengthAt, true));
    }
    report('done');
    return join(...parts);
  }

  async disconnect(): Promise<void> {
    await this.link.close();
  }
}

/**
 * Find out which tag is on a link just opened, and make it a connection.
 *
 * Null when the tag does not report its EUI, which firmware older than USB_GET_UID_COMMAND does not;
 * the link is then left for the caller to close.
 */
export async function identifyTag(link: SerialLink): Promise<TagConnection | null> {
  const eui = await readEui(link);
  if (!eui) return null;
  let firmware: string | null = null;
  let hardware: string | null = null;
  try {
    link.discardInput();
    await link.write(Uint8Array.of(USB_COMMAND.USB_VERSION_COMMAND));
    firmware = await link.readLine(OPERATION_TIMEOUT_MS, 'Reading the firmware version');
    hardware = await link.readLine(OPERATION_TIMEOUT_MS, 'Reading the hardware revision');
  } catch { /* optional, as over Bluetooth */ }
  return new SerialTag(link, { handle: usbHandleFor(eui), eui, firmware, hardware, transport: 'serial' });
}

/** What a tag on a port that did not say which tag it is gets told. */
export const UNIDENTIFIED_TAG =
  'That tag did not report its ID over USB. Close any other program or tab using it, or ' +
  'update its firmware — older firmware cannot be identified, and so cannot be scheduled, over USB.';
