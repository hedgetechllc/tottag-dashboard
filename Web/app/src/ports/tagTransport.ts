// Talking to a tag, independent of how.
//
// Three kinds: the TotTag Helper, which reaches tags over Bluetooth by scanning for them where it is
// installed; Web Bluetooth, which reaches them through the browser's chooser where it is not; and USB
// for a tag plugged into this computer, which puts it into USB maintenance mode, through the helper
// where it is installed and the browser's Web Serial where it is not. Any can identify, configure and download a tag, so everything that uses a tag
// goes through this interface and neither knows nor cares which one it has.

import type { DeploymentConfig, ExperimentDetails, RadioStats } from '@tottag/schema';

export interface TagIdentity {
  /** Stable within this browser profile. NOT the MAC address — Web Bluetooth never exposes one. */
  readonly handle: string;
  /** Full 6-byte EUI, least-significant byte first: from GATT System ID, or asked for over USB. */
  readonly eui: Uint8Array;
  /** Which transport `handle` belongs to, and so which one reconnects to it. */
  readonly transport: TagTransport['id'];
  readonly firmware: string | null;
  readonly hardware: string | null;
}

export interface TagSnapshot {
  readonly batteryMv: number | null;
  readonly timestamp: number | null;
  readonly experiment: ExperimentDetails | null;
}

export interface DownloadProgress {
  readonly phase: 'starting' | 'header' | 'pages' | 'done';
  readonly bytesReceived: number;
  /** Null until the stream header arrives and says how much there is. */
  readonly bytesExpected: number | null;
  readonly pagesExpected: number | null;
  /**
   * Measured from this transfer, not from a constant.
   *
   * Null while warming up. Both are null early on by design: a rate computed from the first moments
   * of a connection — which include MTU exchange and a connection-parameter update — is wrong in
   * the alarming direction and then visibly halves, which is how a progress bar earns distrust.
   */
  readonly bytesPerSecond: number | null;
  readonly secondsRemaining: number | null;
}

/**
 * What a live radio test needs from a tag. Only Bluetooth provides it: a tag on USB is in maintenance mode and
 * cannot range, so a Web Serial connection leaves `liveRadio` undefined.
 */
export interface LiveRadioLink {
  /**
   * Start a radio test among `euis`, this tag included, from `startTime` to `endTime` (Unix seconds). The tag
   * restarts into the test, so this connection drops a moment later. Rejects if the tag refuses the test.
   */
  startRadioTest(startTime: number, endTime: number, euis: readonly Uint8Array[]): Promise<void>;
  /** End the test early; the tag restarts into whatever it would otherwise be doing. */
  stopRadioTest(): Promise<void>;
  readRadioStats(): Promise<RadioStats>;
  /** Deliver every ranges notification until the returned function is called. */
  watchRanges(onRanges: (ranges: ReadonlyMap<number, number>, truncated: boolean) => void): Promise<() => Promise<void>>;
  /** Call `listener` once if the connection drops; the returned function cancels that. */
  onDisconnect(listener: () => void): () => void;
}

export interface TagConnection {
  readonly identity: TagIdentity;
  /** Present only when this transport and this tag's firmware can run a live radio test. */
  readonly liveRadio?: LiveRadioLink;
  isConnected(): boolean;
  readSnapshot(): Promise<TagSnapshot>;
  /** Set the tag's clock to now. Always done before writing a deployment. */
  syncClock(): Promise<void>;
  writeDeployment(config: DeploymentConfig): Promise<void>;
  /** Read the stored deployment back, for confirming what the device actually took. */
  readExperiment(): Promise<ExperimentDetails>;
  cancelDeployment(): Promise<void>;
  /** Sound the buzzer so a tag can be found in a bag. */
  locate(seconds: number): Promise<void>;
  /**
   * Pull the log. `range` is Unix seconds; omit for everything.
   *
   * Returns the offload stream verbatim — exactly the bytes a `.ttg` file holds — so the same
   * parser reads a live download and a file from disk, and neither path can drift from the other.
   */
  downloadLog(
    range: { start: number; end: number } | null,
    onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  /** Ask for specific pages again, by sequence number, after a CRC failure or a hole. */
  retransmitPages(seqs: readonly number[], onProgress: (progress: DownloadProgress) => void): Promise<Uint8Array>;
  disconnect(): Promise<void>;
}

/**
 * What a page asks of the list a tag is picked from. Only the TotTag Helper's list is the dashboard's
 * own; the browser's choosers cannot be told any of this, and ignore it.
 */
export interface PickOptions {
  /** False leaves tags plugged in by USB out of the list, for a use only Bluetooth serves. */
  readonly usb?: boolean;
  /**
   * Tags this page is already done with, by the last two parts of their address as in their names
   * (`02:31`), kept out of the way unless asked for and marked with `label` when they are.
   */
  readonly done?: { readonly ids: ReadonlySet<string>; readonly label: string };
}

export interface TagTransport {
  readonly id: 'helper' | 'bluetooth' | 'serial';
  readonly label: string;
  isAvailable(): boolean;
  unavailableReason(): string | null;

  /**
   * Show the chooser and connect to whatever is picked. Null when the chooser was dismissed.
   *
   * Returns a LIVE connection rather than just an identity, so a caller that is about to do
   * something does not pay for a second connection. The caller owns it and must disconnect.
   * Identifying at all costs a connection, because Web Bluetooth never exposes a MAC address — the
   * EUI has to be read from GATT System ID.
   *
   * `onPicked` is called once a device has been picked and the chooser has closed, before connecting
   * to it. Connecting and identifying take a few seconds, during which nothing else on the page would
   * change, so this is where a page says that it is connecting.
   */
  requestDevice(onPicked?: () => void, options?: PickOptions): Promise<TagConnection | null>;

  /**
   * Pick several tags at once from this transport's own list, and connect to each in turn. Only
   * the TotTag Helper has one, of the tags it found nearby and plugged in; the browser's chooser
   * picks one tag at a time, so the others leave this out.
   *
   * Yields each tag's connection, which the caller owns and should let go of before asking for the
   * next, or an Error for a tag that could not be reached, so one tag out of range does not stop the
   * rest. `onPicked` is told how many were picked, before any is connected to.
   */
  requestDevices?(onPicked?: (count: number) => void, options?: PickOptions): AsyncGenerator<TagConnection | Error, void, void>;

  /**
   * Reconnect to a device already granted to this origin, with no chooser.
   *
   * Devices chosen earlier IN THIS PAGE SESSION always work. Across a reload it depends on
   * `navigator.bluetooth.getDevices()`, which several Chrome versions gate behind a flag, and on the
   * grant still being held — see `canReachWithoutChooser()`. Returns null when the tag cannot be reached.
   */
  connect(handle: string): Promise<TagConnection | null>;

  /**
   * Whether `connect(handle)` can work without the chooser: the tag was picked earlier in this page
   * session, or the browser still holds a grant for it from before a reload. False means it has to be
   * picked again, which a page can only ask for from a click.
   */
  canReachWithoutChooser(handle: string): boolean;

  /**
   * Be told when an answer from `canReachWithoutChooser` may have changed: once the browser has said
   * which devices it still holds grants for, and whenever one is picked. Returns the unsubscribe.
   */
  onReachabilityChange(listener: () => void): () => void;
}
