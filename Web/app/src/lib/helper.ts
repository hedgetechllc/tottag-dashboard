// The TotTag Helper, through its browser extension: one port for the whole page, shared by
// everything on it.
//
// The helper reaches tags over Bluetooth by scanning, and tags plugged into this computer over USB.
//
// The path is page → extension service worker → helper program. The page reaches the extension by
// its ID through `externally_connectable`, which Chrome checks against the manifest's list of
// origins before a message is delivered. One port is one helper process, which keeps connections
// to tags, their notification streams and USB ports open for as long as the port is: a connection
// outlives a request, so this is never a message at a time.
//
// The dashboard works without any of this. The helper is an optional way to reach tags, and
// everything here says "not available" rather than throwing, so the page falls back to the
// browser's own Bluetooth chooser and USB port picker.

/** The extension's ID, fixed by the public key in its manifest. Overridable for a build keyed differently. */
export const HELPER_EXTENSION_ID =
  (import.meta.env?.VITE_TOTTAG_HELPER_EXTENSION_ID as string | undefined) ?? 'mdcklmmdjhaedkbclflpiehpcmofhcfn';

/** The protocol this page speaks: `ProtocolVersion` in the helper's internal/ble. An older helper is outdated. 2 added USB. */
export const HELPER_PROTOCOL = 2;

/** The newest TotTag Helper released when this page was built (vite.config.ts), or ''. */
export const LATEST_HELPER_RELEASE: string = (import.meta.env?.VITE_HELPER_RELEASE as string | undefined) ?? '';

/**
 * Whether a helper of this version is older than the newest released. A build of one's own,
 * 0.0.0-dev, never is; one from `git describe`, 0.2.1-3-gab12cd3, counts as its release.
 */
export function helperUpdateAvailable(version: string | null | undefined, latest: string = LATEST_HELPER_RELEASE): boolean {
  const parse = (text: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);
  const have = version ? parse(version) : undefined;
  const want = parse(latest);
  if (!have || !want || have.every((part) => part === 0)) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== want[i]) return have[i]! < want[i]!;
  }
  return false;
}

/** An absent or stuck helper must not hold the page's check open. Answering this needs no Bluetooth. */
const IDENTIFY_TIMEOUT_MS = 3000;
/** Long enough for the library's own ten-second waits to give up first. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A tag not heard from for this long, while scanning, has gone. */
const NEARBY_FOR_MS = 15_000;
/** Scan results arrive several times a second per tag; the page hears about them at most this often. */
const SCAN_NOTIFY_MS = 400;

export type HelperStatus =
  /** Not a Chromium browser: it cannot run the extension. */
  | 'unsupported'
  /** The extension is not installed, or does not allow this page. The ordinary case. */
  | 'absent'
  | 'checking'
  /** The extension is installed, but not the helper program it starts. */
  | 'not-installed'
  /** The helper speaks an older protocol than this page. */
  | 'outdated'
  /** The helper would not start, stopped, or stopped answering. */
  | 'failed'
  /** The helper answered and is starting Bluetooth, which may be waiting on the system's permission prompt. */
  | 'starting-bluetooth'
  /** Bluetooth is off, or the helper is not allowed to use it. */
  | 'no-bluetooth'
  | 'ready';

export interface HelperState {
  readonly status: HelperStatus;
  /** The helper's version, once it has said. */
  readonly version: string | null;
  /** Why it is not ready, in the helper's or the system's words. */
  readonly detail: string | null;
}

/** A tag a scan has found. */
export interface ScannedTag {
  /** What the helper calls it: on macOS the system's identifier for it, elsewhere its Bluetooth address. */
  readonly id: string;
  /** Its advertised name, `TotTag 02:31`. */
  readonly name: string;
  /** Signal strength, in dBm. */
  readonly rssi: number;
  /** When it was last heard, in milliseconds since 1970. */
  readonly seenAt: number;
}

export interface HelperSnapshot {
  readonly state: HelperState;
  readonly scanning: boolean;
  /** What the current or last scan has found, by name. */
  readonly nearby: readonly ScannedTag[];
}

/** Something the helper says without being asked. */
export type HelperEvent =
  | { readonly event: 'notification'; readonly connection: string; readonly service: string; readonly characteristic: string; readonly data: string }
  | { readonly event: 'disconnected'; readonly connection: string }
  /** Bytes a USB port received, base64. */
  | { readonly event: 'usbData'; readonly connection: string; readonly data: string }
  /** A USB port closed without the page asking: the tag was unplugged, or the port failed. */
  | { readonly event: 'usbClosed'; readonly connection: string; readonly error?: string }
  | { readonly event: 'helperStopped'; readonly code: string; readonly error: string };

export class HelperError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
  }
}

/** The parts of a Chrome extension port this uses. */
export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}

/** The parts of `chrome.runtime` this uses. A page has `connect` only if an extension allows it. */
export interface RuntimeLike {
  connect?: (extensionId: string) => PortLike;
}

interface Reply {
  readonly id?: string;
  readonly ok?: boolean;
  readonly error?: string;
  readonly code?: string;
  readonly event?: string;
  readonly [field: string]: unknown;
}

/**
 * Whether this browser could run the extension at all, installed or not.
 *
 * Not a test for `chrome.runtime`, which a page has only when an installed extension allows it, so
 * its absence means "not installed", not "cannot be installed".
 */
export function isChromium(): boolean {
  if (typeof navigator === 'undefined') return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands;
  if (brands?.length) return brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(brand));
  return 'bluetooth' in navigator || 'serial' in navigator;
}

const browserRuntime = (): RuntimeLike | null =>
  (globalThis as { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime ?? null;

/** Bytes for a request, as the helper reads them: base64, as Go encodes a []byte. */
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function fromBase64(text: string | undefined): Uint8Array {
  // A loop, not Uint8Array.from with a mapping function: a USB download arrives half a megabyte at a time
  const binary = atob(text ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class HelperClient {
  private port: PortLike | null = null;
  private counter = 0;
  private readonly pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly eventListeners = new Set<(event: HelperEvent) => void>();
  private readonly snapshotListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();
  private readonly found = new Map<string, ScannedTag>();
  private snapshot: HelperSnapshot = { state: { status: 'checking', version: null, detail: null }, scanning: false, nearby: [] };
  private starting: Promise<void> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private bluetoothTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly runtime: () => RuntimeLike | null;
  private readonly chromium: () => boolean;
  private readonly bluetoothRecheckMs: number;

  /**
   * `runtime` and `chromium` are the browser's, except in tests. While Bluetooth is off or not allowed,
   * the helper is asked again every `bluetoothRecheckMs`, so turning it on or allowing it is noticed
   * without anyone having to try again.
   */
  constructor(runtime: () => RuntimeLike | null = browserRuntime, chromium: () => boolean = isChromium, bluetoothRecheckMs = 5000) {
    this.runtime = runtime;
    this.chromium = chromium;
    this.bluetoothRecheckMs = bluetoothRecheckMs;
  }

  // --- What a page reads -------------------------------------------------------------------------

  getSnapshot = (): HelperSnapshot => this.snapshot;

  /** Hear of any change: the helper's state, or a scan finding or losing a tag. */
  subscribe = (listener: () => void): (() => void) => {
    this.snapshotListeners.add(listener);
    return () => { this.snapshotListeners.delete(listener); };
  };

  /** Hear only of changes to the helper's state, which is what decides whether tags can be reached through it. */
  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /** Hear what the helper says unprompted: notifications from tags, dropped connections, and the helper stopping. */
  onEvent(listener: (event: HelperEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  get ready(): boolean {
    return this.snapshot.state.status === 'ready';
  }

  // --- Starting ----------------------------------------------------------------------------------

  /** Reach the helper and start Bluetooth, once; later calls wait for the same attempt. */
  start(): Promise<void> {
    this.starting ??= this.connect();
    return this.starting;
  }

  /** Let go of the helper: its process ends, and with it every scan and connection it held. */
  stop(): void {
    this.scanStopped();
    this.closePort();
    this.starting = null;
    const { status, version } = this.snapshot.state;
    if (status !== 'absent' && status !== 'unsupported') this.setState({ status: 'failed', version, detail: 'The TotTag Helper was stopped.' });
  }

  /** Try again after the helper failed, was installed since, or Bluetooth was turned on. */
  retry(): Promise<void> {
    this.closePort();
    this.starting = null;
    return this.start();
  }

  private async connect(): Promise<void> {
    const runtime = this.runtime();
    if (!runtime?.connect) {
      this.setState({ status: this.chromium() ? 'absent' : 'unsupported', version: null, detail: null });
      return;
    }
    this.setState({ status: 'checking', version: null, detail: null });
    let port: PortLike;
    try {
      port = runtime.connect(HELPER_EXTENSION_ID);
    } catch (error) {
      this.setState({ status: 'absent', version: null, detail: String(error) });
      return;
    }
    this.port = port;
    port.onMessage.addListener((message) => this.received(port, message as Reply));
    port.onDisconnect.addListener(() => this.lost(port, 'helper-failed', 'The TotTag Helper extension closed the connection.'));

    let version: string | null = null;
    try {
      const identity = await this.request<{ version: string; protocol: number }>('identify', {}, IDENTIFY_TIMEOUT_MS);
      version = identity.version;
      if ((identity.protocol ?? 0) < HELPER_PROTOCOL) {
        this.setState({ status: 'outdated', version, detail: null });
        this.closePort();
        return;
      }
      this.setState({ status: 'starting-bluetooth', version, detail: null });
      // No deadline: the first time, starting Bluetooth waits on the system asking the person
      const hello = await this.request<{ bluetooth: string }>('hello', {}, null);
      if (hello.bluetooth === 'ready') {
        this.setState({ status: 'ready', version, detail: null });
      } else {
        this.setState({ status: 'no-bluetooth', version, detail: hello.bluetooth });
        this.checkBluetoothLater();
      }
    } catch (error) {
      // A helper that stopped has already said why; anything else is a fault in reaching it
      if (this.snapshot.state.status === 'checking' || this.snapshot.state.status === 'starting-bluetooth') {
        const code = error instanceof HelperError ? error.code : 'helper-failed';
        this.setState({ status: code === 'helper-not-installed' ? 'not-installed' : 'failed', version, detail: (error as Error).message });
      }
      this.closePort();
    }
  }

  /** Ask whether Bluetooth is available yet, again in a moment and for as long as it is not. */
  private checkBluetoothLater() {
    if (this.bluetoothTimer) return;
    this.bluetoothTimer = setTimeout(() => {
      this.bluetoothTimer = null;
      if (this.snapshot.state.status !== 'no-bluetooth' || !this.port) return;
      this.request<{ bluetooth: string }>('hello', {}, null).then((hello) => {
        if (this.snapshot.state.status !== 'no-bluetooth') return;
        const { version } = this.snapshot.state;
        if (hello.bluetooth === 'ready') {
          this.setState({ status: 'ready', version, detail: null });
          return;
        }
        if (hello.bluetooth !== this.snapshot.state.detail) this.setState({ status: 'no-bluetooth', version, detail: hello.bluetooth });
        this.checkBluetoothLater();
      }, () => { /* the helper has stopped, and lost() has said so */ });
    }, this.bluetoothRecheckMs);
  }

  // --- Talking to it -----------------------------------------------------------------------------

  /**
   * One request, and its reply. Rejects with the helper's own words when it refuses, and when the
   * helper is not there or stops. `timeoutMs` null waits for as long as the helper does.
   */
  request<T extends object>(op: string, fields: Record<string, unknown> = {}, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
    const port = this.port;
    if (!port) return Promise.reject(new HelperError('The TotTag Helper is not running.', 'not-running'));
    const id = `r${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new HelperError(`The TotTag Helper did not answer within ${timeoutMs / 1000} seconds.`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: (reply) => resolve(reply as unknown as T), reject, timer });
      try {
        port.postMessage({ ...fields, id, op });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(new HelperError(String(error), 'helper-failed'));
      }
    });
  }

  private received(port: PortLike, message: Reply) {
    if (port !== this.port || !message || typeof message !== 'object') return;
    if (typeof message.id === 'string' && this.pending.has(message.id)) {
      const waiting = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (waiting.timer) clearTimeout(waiting.timer);
      if (message.ok === true) waiting.resolve(message);
      else waiting.reject(new HelperError(message.error ?? 'The TotTag Helper refused.', message.code ?? 'failed'));
      return;
    }
    switch (message.event) {
      case 'device':
        this.foundTag({ id: String(message.device), name: String(message.name ?? ''), rssi: Number(message.rssi ?? 0), seenAt: Date.now() });
        return;
      case 'scanStopped':
        this.scanStopped();
        return;
      case 'helperStopped':
        this.lost(port, String(message.code ?? 'helper-failed'), String(message.error ?? 'The TotTag Helper stopped.'));
        return;
      case 'notification':
      case 'disconnected':
      case 'usbData':
      case 'usbClosed':
        for (const listener of [...this.eventListeners]) listener(message as unknown as HelperEvent);
        return;
      default:
    }
  }

  /** The helper or its extension stopped: everything waiting on it fails, and every tag it held is gone. */
  private lost(port: PortLike, code: string, error: string) {
    if (port !== this.port) return;
    this.port = null;
    for (const [id, waiting] of this.pending) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(new HelperError(error, code));
      this.pending.delete(id);
    }
    for (const listener of [...this.eventListeners]) listener({ event: 'helperStopped', code, error });
    this.scanStopped();
    const status: HelperStatus = code === 'helper-not-installed' ? 'not-installed' : 'failed';
    this.setState({ status, version: this.snapshot.state.version, detail: error });
  }

  private closePort() {
    if (this.bluetoothTimer) clearTimeout(this.bluetoothTimer);
    this.bluetoothTimer = null;
    const port = this.port;
    this.port = null;
    try { port?.disconnect(); } catch { /* already gone */ }
    // Nothing will answer what is still waiting
    for (const [id, waiting] of this.pending) {
      if (waiting.timer) clearTimeout(waiting.timer);
      waiting.reject(new HelperError('The TotTag Helper is not running.', 'not-running'));
      this.pending.delete(id);
    }
  }

  // --- Scanning ----------------------------------------------------------------------------------

  /** Look for tags nearby, starting the list afresh, until stopped. */
  async startScan(): Promise<void> {
    if (this.snapshot.scanning) return;
    this.found.clear();
    await this.request('scanStart', { namePrefix: 'TotTag' });
    this.snapshot = { ...this.snapshot, scanning: true, nearby: [] };
    this.pruneTimer ??= setInterval(() => this.prune(), 1000);
    this.notify();
  }

  async stopScan(): Promise<void> {
    if (!this.snapshot.scanning) return;
    try {
      await this.request('scanStop');
    } finally {
      this.scanStopped();
    }
  }

  private foundTag(tag: ScannedTag) {
    this.found.set(tag.id, tag);
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null;
      this.publishNearby();
    }, SCAN_NOTIFY_MS);
  }

  /** While scanning, a tag not heard from for a while has gone; the last scan's list stays once it stops. */
  private prune() {
    const cutoff = Date.now() - NEARBY_FOR_MS;
    let changed = false;
    for (const [id, tag] of this.found) {
      if (tag.seenAt < cutoff) {
        this.found.delete(id);
        changed = true;
      }
    }
    if (changed) this.publishNearby();
  }

  private publishNearby() {
    const nearby = [...this.found.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.snapshot = { ...this.snapshot, nearby };
    this.notify();
  }

  private scanStopped() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (!this.snapshot.scanning) return;
    this.snapshot = { ...this.snapshot, scanning: false };
    this.notify();
  }

  // --- Telling the page --------------------------------------------------------------------------

  private setState(state: HelperState) {
    this.snapshot = { ...this.snapshot, state };
    for (const listener of [...this.stateListeners]) listener();
    this.notify();
  }

  private notify() {
    for (const listener of [...this.snapshotListeners]) listener();
  }
}

/** The one helper connection the page shares. */
export const helper = new HelperClient();

/** What to tell someone about the helper's state, or null when it needs no words. */
export function describeHelper(state: HelperState): string | null {
  switch (state.status) {
    case 'ready': return `The TotTag Helper${state.version ? ` ${state.version}` : ''} finds tags nearby and plugged in.`;
    case 'starting-bluetooth': return 'The TotTag Helper is starting Bluetooth. If the system asks, allow it.';
    case 'no-bluetooth': return `The TotTag Helper cannot use Bluetooth: ${state.detail ?? 'it is off, or not allowed'}. Turn Bluetooth on, or allow the TotTag Helper in the system's privacy settings, then try again.`;
    case 'not-installed': return 'The TotTag Helper extension is installed, but its program is not.';
    case 'outdated': return `The TotTag Helper${state.version ? ` ${state.version}` : ''} is older than this page needs.`;
    // The detail is often a sentence of its own, already ending in a full stop
    case 'failed': return `The TotTag Helper is not working: ${(state.detail ?? 'it stopped').replace(/\.$/, '')}.`;
    default: return null;
  }
}
