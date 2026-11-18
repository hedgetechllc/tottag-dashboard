// The TotTag Helper as the page sees it: the client that talks to it through the extension, and the
// adapters that reach tags through it, over Bluetooth and USB. Against a stand-in helper behind a
// stand-in extension port, answering as the real one does (Web/tottag-helper/internal/ble and usb).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLE_MAINTENANCE_DOWNLOAD_LOG, BLE_UUID, GATT_FIRMWARE_REVISION_UUID, GATT_SYSTEM_ID_UUID, USB_PID, USB_VID } from '@tottag/schema';
import { HelperClient, HelperError, fromBase64, toBase64, type PortLike, type RuntimeLike } from '../src/lib/helper.ts';
import { HelperTags } from '../src/adapters/helperBluetooth.ts';
import { HelperUsb } from '../src/adapters/helperUsb.ts';

type Request = Record<string, unknown> & { id: string; op: string };
type Answer = Record<string, unknown> | undefined;

/**
 * An extension port to a stand-in helper. `answer` replies to each request: an object is a success,
 * one with `ok: false` a refusal, and undefined no reply at all. `say` sends something unasked.
 */
function fakeHelper(answer: (request: Request, say: (message: unknown) => void) => Answer, options: { installed?: boolean } = {}) {
  const requests: Request[] = [];
  let say: (message: unknown) => void = () => {};
  const runtime: RuntimeLike = {
    connect: (): PortLike => {
      const listeners: Array<(message: unknown) => void> = [];
      say = (message) => queueMicrotask(() => { for (const listener of [...listeners]) listener(message); });
      if (options.installed === false) {
        say({ event: 'helperStopped', code: 'helper-not-installed', error: 'The TotTag Helper program is not installed on this computer.' });
      }
      return {
        postMessage: (message) => {
          const request = message as Request;
          requests.push(request);
          const reply = answer(request, say);
          if (reply) say({ ok: true, ...reply, id: request.id });
        },
        disconnect: () => {},
        onMessage: { addListener: (listener) => { listeners.push(listener); } },
        onDisconnect: { addListener: () => {} },
      };
    },
  };
  return { runtime, requests, say: (message: unknown) => say(message) };
}

const identifyAndHello = (bluetooth = 'ready', protocol = 2) => (request: Request): Answer => {
  if (request.op === 'identify') return { version: '0.1.0', platform: 'darwin/arm64', protocol };
  if (request.op === 'hello') return { version: '0.1.0', platform: 'darwin/arm64', protocol, bluetooth };
  return undefined;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The client -----------------------------------------------------------------------------------

test('without the extension, the helper is absent in Chrome and unsupported elsewhere', async () => {
  const chrome = new HelperClient(() => null, () => true);
  await chrome.start();
  assert.equal(chrome.getSnapshot().state.status, 'absent');
  const safari = new HelperClient(() => null, () => false);
  await safari.start();
  assert.equal(safari.getSnapshot().state.status, 'unsupported');
});

test('an extension whose program is not installed is told apart from one that failed', async () => {
  const { runtime } = fakeHelper(() => undefined, { installed: false });
  const client = new HelperClient(() => runtime, () => true);
  await client.start();
  assert.equal(client.getSnapshot().state.status, 'not-installed');
});

test('a helper older than the page is not used', async () => {
  // Protocol 1 knew nothing of USB
  const { runtime, requests } = fakeHelper(identifyAndHello('ready', 1));
  const client = new HelperClient(() => runtime, () => true);
  await client.start();
  assert.equal(client.getSnapshot().state.status, 'outdated');
  assert.deepEqual(requests.map((request) => request.op), ['identify'], 'it was asked to start Bluetooth anyway');
});

test('the helper is ready once Bluetooth has started, and says why when it cannot', async () => {
  const ready = new HelperClient(() => fakeHelper(identifyAndHello()).runtime, () => true);
  await ready.start();
  assert.deepEqual(ready.getSnapshot().state, { status: 'ready', version: '0.1.0', detail: null });
  assert.equal(ready.ready, true);

  const refused = new HelperClient(() => fakeHelper(identifyAndHello('bluetooth is not authorized for this app')).runtime, () => true);
  await refused.start();
  assert.equal(refused.getSnapshot().state.status, 'no-bluetooth');
  assert.equal(refused.getSnapshot().state.detail, 'bluetooth is not authorized for this app');
  refused.stop();
});

test('Bluetooth turned on or allowed later is noticed without trying again', async () => {
  let answers = 0;
  const { runtime } = fakeHelper((request) => {
    if (request.op !== 'hello') return identifyAndHello()(request);
    answers += 1;
    return identifyAndHello(answers < 3 ? 'bluetooth is powered off' : 'ready')(request);
  });
  const client = new HelperClient(() => runtime, () => true, 10);
  await client.start();
  assert.equal(client.getSnapshot().state.status, 'no-bluetooth');
  await pause(100);
  assert.equal(client.getSnapshot().state.status, 'ready');
  assert.equal(answers, 3);
});

test('a refusal comes back in the helper\'s words, and a reply goes to the request that asked', async () => {
  const { runtime } = fakeHelper((request) => {
    if (request.op === 'read') return { ok: false, error: 'That tag is no longer connected.', code: 'not-connected' };
    return identifyAndHello()(request) ?? { echo: request.op };
  });
  const client = new HelperClient(() => runtime, () => true);
  await client.start();
  const [first, second] = await Promise.all([client.request<{ echo: string }>('one'), client.request<{ echo: string }>('two')]);
  assert.deepEqual([first.echo, second.echo], ['one', 'two']);
  await assert.rejects(client.request('read'), (error: HelperError) => error.code === 'not-connected' && /no longer connected/.test(error.message));
});

test('a scan lists each tag once, by name, with what was last heard from it', async () => {
  const fake = fakeHelper((request) => identifyAndHello()(request) ?? {});
  const client = new HelperClient(() => fake.runtime, () => true);
  await client.start();
  await client.startScan();
  assert.equal(client.getSnapshot().scanning, true);
  fake.say({ event: 'device', device: 'b', name: 'TotTag 02:F3', rssi: -70 });
  fake.say({ event: 'device', device: 'a', name: 'TotTag 02:0B', rssi: -62 });
  fake.say({ event: 'device', device: 'b', name: 'TotTag 02:F3', rssi: -64 });
  await pause(500);
  assert.deepEqual(client.getSnapshot().nearby.map((tag) => [tag.name, tag.rssi]), [['TotTag 02:0B', -62], ['TotTag 02:F3', -64]]);
  await client.stopScan();
  assert.equal(client.getSnapshot().scanning, false);
  assert.equal(client.getSnapshot().nearby.length, 2, 'the last scan\'s list stays once it stops');
});

test('when the helper stops, everything waiting on it fails and the page hears it', async () => {
  const fake = fakeHelper((request) => identifyAndHello()(request));
  const client = new HelperClient(() => fake.runtime, () => true);
  await client.start();
  const heard: string[] = [];
  client.onEvent((event) => heard.push(event.event));
  const waiting = client.request('connect', { device: 'a' });
  fake.say({ event: 'helperStopped', code: 'helper-failed', error: 'The TotTag Helper stopped.' });
  await assert.rejects(waiting, /stopped/);
  assert.deepEqual(heard, ['helperStopped']);
  assert.equal(client.getSnapshot().state.status, 'failed');
});

// --- Tags through it ------------------------------------------------------------------------------

const uuid16 = (n: number) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const DEVICE_INFO = uuid16(0x180a);
const LIVE = BLE_UUID.BLE_LIVE_STATS_SERVICE_ID.uuid;
const MAINTENANCE = BLE_UUID.BLE_MAINTENANCE_SERVICE_ID.uuid;
const fixture = new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../packages/tottag-schema/test/fixtures/boot.ttg')));

/** A stand-in helper connected to one tag, 02:31, which answers as a tag on its charger does. */
function helperWithATag() {
  const reads: string[] = [];
  let notifying = false;
  const fake = fakeHelper((request, say) => {
    const known = identifyAndHello()(request);
    if (known) return known;
    switch (request.op) {
      case 'connect': {
        const services = request.services as string[];
        const characteristics: Record<string, string[]> = {
          [LIVE]: [BLE_UUID.BLE_LIVE_STATS_BATTERY_CHAR.uuid, BLE_UUID.BLE_LIVE_STATS_TIMESTAMP_CHAR.uuid,
            BLE_UUID.BLE_LIVE_STATS_RANGING_CHAR.uuid, BLE_UUID.BLE_LIVE_STATS_RADIO_CHAR.uuid],
          [MAINTENANCE]: [BLE_UUID.BLE_MAINTENANCE_EXPERIMENT_CHAR.uuid, BLE_UUID.BLE_MAINTENANCE_COMMAND_CHAR.uuid, BLE_UUID.BLE_MAINTENANCE_DATA_CHAR.uuid],
          [DEVICE_INFO]: [GATT_SYSTEM_ID_UUID, GATT_FIRMWARE_REVISION_UUID],
        };
        if (request.device === 'out-of-range') return { ok: false, error: 'timeout on Connect', code: 'connect-failed' };
        return { connection: 'c1', services: services.map((uuid) => ({ uuid, characteristics: characteristics[uuid] ?? [] })) };
      }
      case 'read': {
        reads.push(String(request.characteristic));
        const value = {
          [GATT_SYSTEM_ID_UUID]: Uint8Array.of(0x31, 0x02, 0x42, 0xfe, 0xff, 0xe5, 0x98, 0xc0),
          [GATT_FIRMWARE_REVISION_UUID]: new TextEncoder().encode('Commit 10eb533a'),
          [BLE_UUID.BLE_LIVE_STATS_BATTERY_CHAR.uuid]: Uint8Array.of(0x04, 0x10),
          [BLE_UUID.BLE_LIVE_STATS_TIMESTAMP_CHAR.uuid]: Uint8Array.of(0x00, 0x00, 0x00, 0x6b),
        }[String(request.characteristic)];
        return value ? { data: toBase64(value) } : { ok: false, error: 'The tag has no deployment.', code: 'failed' };
      }
      case 'notify':
        notifying = request.on === true;
        return {};
      case 'write': {
        const data = fromBase64(request.data as string);
        if (request.characteristic === BLE_UUID.BLE_MAINTENANCE_COMMAND_CHAR.uuid && data[0] === BLE_MAINTENANCE_DOWNLOAD_LOG && notifying) {
          // As the tag sends a log: a byte to start, the header, the details, the pages cut at the MTU, and 0xFF
          const notify = (bytes: Uint8Array) => say({ event: 'notification', connection: 'c1', service: MAINTENANCE,
            characteristic: BLE_UUID.BLE_MAINTENANCE_DATA_CHAR.uuid, data: toBase64(bytes) });
          const details = 16 + new DataView(fixture.buffer, fixture.byteOffset).getUint16(6, true);
          notify(Uint8Array.of(0));
          notify(fixture.subarray(0, 16));
          notify(fixture.subarray(16, details));
          for (let at = details; at < fixture.length; at += 244) notify(fixture.subarray(at, Math.min(fixture.length, at + 244)));
          notify(Uint8Array.of(0xff));
        }
        return {};
      }
      default:
        return {};
    }
  });
  return { ...fake, reads };
}

async function startedClient(fake: ReturnType<typeof helperWithATag>) {
  const client = new HelperClient(() => fake.runtime, () => true);
  await client.start();
  return client;
}

test('a tag reached through the helper says who it is, and reads as it would over Web Bluetooth', async () => {
  const fake = helperWithATag();
  const tags = new HelperTags(await startedClient(fake));
  const tag = await tags.open('a86f0191', 'fresh');
  assert.deepEqual([...tag.identity.eui], [0x31, 0x02, 0x42, 0xe5, 0x98, 0xc0]);
  assert.equal(tag.identity.firmware, 'Commit 10eb533a');
  assert.equal(tag.identity.transport, 'helper');
  assert.equal(tag.identity.handle, 'a86f0191');
  const snapshot = await tag.readSnapshot();
  assert.equal(snapshot.batteryMv, 0x1004);
  assert.equal(snapshot.experiment, null, 'a tag with no deployment');
});

test('a tag identified once is reached again without looking for its identity', async () => {
  const fake = helperWithATag();
  const tags = new HelperTags(await startedClient(fake));
  await (await tags.open('a86f0191', 'fresh')).disconnect();
  fake.reads.length = 0;
  const again = await tags.open('a86f0191', 'remembered');
  assert.deepEqual([...again.identity.eui], [0x31, 0x02, 0x42, 0xe5, 0x98, 0xc0]);
  assert.ok(!fake.reads.includes(GATT_SYSTEM_ID_UUID), 'it read the identity again');
  const connect = fake.requests.filter((request) => request.op === 'connect').at(-1)!;
  assert.ok(!(connect.services as string[]).includes(DEVICE_INFO), 'it looked for the Device Information service anyway');
});

test('a log downloads through the helper byte for byte', async () => {
  const fake = helperWithATag();
  const tag = await new HelperTags(await startedClient(fake)).open('a86f0191', 'fresh');
  const bytes = await tag.downloadLog(null, () => {});
  assert.deepEqual(bytes, fixture);
});

test('a connection the tag dropped is heard as dropped', async () => {
  const fake = helperWithATag();
  const tag = await new HelperTags(await startedClient(fake)).open('a86f0191', 'fresh');
  let dropped = false;
  tag.liveRadio!.onDisconnect(() => { dropped = true; });
  fake.say({ event: 'disconnected', connection: 'c1' });
  await pause(0);
  assert.equal(dropped, true);
  assert.equal(tag.isConnected(), false);
});

// --- Tags plugged in by USB, through it ------------------------------------------------------------

const UID = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
const OLD_UID = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06];

/**
 * A stand-in helper with tags on USB ports, each answering as UsbCdcTask in firmware/src/tasks/usb_task.c
 * does: one-byte commands, some with payloads, replies passed on in whatever pieces they arrive in.
 * The tag on usbmodem2101 has firmware too old to say which tag it is, and another program has usbmodem3101.
 */
function helperWithTagsPluggedIn(options: { alsoBluetooth?: boolean } = {}) {
  const ports: Record<string, { uid: number[]; legacy?: boolean; busy?: boolean }> = {
    '/dev/cu.usbmodem1101': { uid: UID },
    '/dev/cu.usbmodem2101': { uid: OLD_UID, legacy: true },
    '/dev/cu.usbmodem3101': { uid: [9, 9, 9, 9, 9, 9], busy: true },
  };
  const open = new Map<string, { inbox: number[]; stored: Uint8Array; uid: number[]; legacy: boolean }>();
  let counter = 0;
  const bluetooth = options.alsoBluetooth ? helperWithATag() : null;
  const fake = fakeHelper((request, say) => {
    const known = identifyAndHello()(request);
    if (known) return known;
    switch (request.op) {
      case 'usbList':
        assert.deepEqual([request.vendorId, request.productId], [USB_VID, USB_PID], 'it asked for every USB port, not only TotTags');
        return { ports: Object.keys(ports).map((port) => ({ port, vendorId: USB_VID, productId: USB_PID })) };
      case 'usbOpen': {
        const tag = ports[String(request.port)];
        if (!tag) return { ok: false, error: 'That USB port is gone.', code: 'no-port' };
        if (tag.busy) return { ok: false, error: 'Another program is using that USB port.', code: 'port-busy' };
        const connection = `u${++counter}`;
        open.set(connection, { inbox: [], stored: new Uint8Array(239), uid: tag.uid, legacy: !!tag.legacy });
        return { connection };
      }
      case 'usbWrite': {
        const tag = open.get(String(request.connection));
        if (!tag) return { ok: false, error: 'That USB port is no longer open.', code: 'not-connected' };
        tag.inbox.push(...fromBase64(request.data as string));
        const send = (bytes: Uint8Array) => {
          for (let at = 0; at < bytes.length; at += 4093) {
            say({ event: 'usbData', connection: request.connection, data: toBase64(bytes.subarray(at, at + 4093)) });
          }
        };
        for (;;) {
          const command = tag.inbox[0];
          if (command === undefined) break;
          const need = ({ 0x14: 5, 0x01: 240, 0x04: 9 } as Record<number, number>)[command] ?? 1;
          if (tag.inbox.length < need) break;
          const bytes = tag.inbox.splice(0, need);
          if (command === 0x15 && !tag.legacy) send(Uint8Array.from([...tag.uid, 10]));
          if (command === 0x20) send(new TextEncoder().encode('Commit 10eb533a\nP\n'));
          if (command === 0x10) send(Uint8Array.of(0x10, 0x0e));
          if (command === 0x11) send(Uint8Array.of(1, 0, 0, 0));
          if (command === 0x01) tag.stored = Uint8Array.from(bytes.slice(1));
          if (command === 0x13) send(Uint8Array.from([239, 0, ...tag.stored]));
          if (command === 0x03) send(Uint8Array.from([...tag.uid, 10, 239, 0, ...fixture]));
        }
        return {};
      }
      case 'usbClose':
        open.delete(String(request.connection));
        return {};
      default:
        return bluetooth ? undefined : {};
    }
  });
  if (bluetooth) {
    // The Bluetooth tag's answers for everything that is not about USB
    const usb = fake.runtime.connect!;
    fake.runtime.connect = (id) => {
      const listeners: Array<(message: unknown) => void> = [];
      const hear = (message: unknown) => { for (const listener of listeners) listener(message); };
      const port = usb(id);
      const bluetoothPort = bluetooth.runtime.connect!(id);
      port.onMessage.addListener(hear);
      bluetoothPort.onMessage.addListener(hear);
      return {
        ...port,
        postMessage: (message) => {
          const op = (message as Request).op;
          (op.startsWith('usb') || op === 'identify' || op === 'hello' ? port : bluetoothPort).postMessage(message);
        },
        onMessage: { addListener: (listener) => { listeners.push(listener); } },
      };
    };
  }
  return { ...fake, open, ports };
}

const opened = (fake: { requests: Request[] }) => fake.requests.filter((request) => request.op === 'usbOpen').length;

test('tags plugged in are listed by which tag they are, and the ones that cannot say are not offered', async () => {
  const fake = helperWithTagsPluggedIn();
  const usb = new HelperUsb(await startedClient(fake as unknown as ReturnType<typeof helperWithATag>));
  await usb.refresh();
  const listed = usb.getSnapshot().map((tag) => [tag.port, tag.state, tag.eui ? [...tag.eui] : null]);
  assert.deepEqual(listed, [
    ['/dev/cu.usbmodem1101', 'ready', UID],
    ['/dev/cu.usbmodem2101', 'silent', null],
    ['/dev/cu.usbmodem3101', 'busy', null],
  ]);
  assert.equal(fake.open.size, 0, 'a port asked which tag it is was left open');
});

test('the ports are looked at only when asked, and asked again unless the picker is looking', async () => {
  const fake = helperWithTagsPluggedIn();
  // One tag that answers at once, so the picker's looks come every 10 ms
  delete fake.ports['/dev/cu.usbmodem2101'];
  delete fake.ports['/dev/cu.usbmodem3101'];
  const usb = new HelperUsb(await startedClient(fake as unknown as ReturnType<typeof helperWithATag>), 10);
  await pause(50);
  assert.ok(!fake.requests.some((request) => request.op.startsWith('usb')), 'it looked at the USB ports unasked');

  // Another tag plugged into the same socket gets the same port name, so what a port said is not kept
  await usb.refresh();
  fake.ports['/dev/cu.usbmodem1101'] = { uid: [0x21, 0x22, 0x23, 0x24, 0x25, 0x26] };
  await usb.refresh();
  assert.deepEqual([...usb.getSnapshot()[0]!.eui!], [0x21, 0x22, 0x23, 0x24, 0x25, 0x26]);

  // While the picker looks, every few moments, a port that stays is not asked again; and it stops when the picker closes
  const stop = usb.watch();
  await pause(60);
  const [opens, looks] = [opened(fake), fake.requests.filter((request) => request.op === 'usbList').length];
  await pause(60);
  assert.ok(fake.requests.filter((request) => request.op === 'usbList').length > looks + 2, 'the picker did not keep looking');
  assert.equal(opened(fake), opens, 'a port that stayed plugged in was asked again while the picker looked');
  stop();
  const lists = fake.requests.filter((request) => request.op === 'usbList').length;
  await pause(60);
  assert.equal(fake.requests.filter((request) => request.op === 'usbList').length, lists, 'it kept looking after the picker closed');
});

test('a tag plugged in is reached by its EUI, and takes a deployment and reads it back', async () => {
  const fake = helperWithTagsPluggedIn();
  const usb = new HelperUsb(await startedClient(fake as unknown as ReturnType<typeof helperWithATag>));
  const tag = await usb.connect('usb:66:55:44:33:22:11');
  assert.ok(tag, 'the tag plugged in was not found');
  assert.equal(tag.identity.transport, 'serial');
  assert.equal(tag.identity.firmware, 'Commit 10eb533a');
  assert.equal((await tag.readSnapshot()).batteryMv, 0x0e10);
  const config = {
    startTime: 1_900_000_000, endTime: 1_900_600_000, timezone: 'UTC', useDailyTimes: false, dailyStartTime: 0, dailyEndTime: 0,
    devices: [{ eui: Uint8Array.from(UID), label: 'a' }],
  };
  await tag.writeDeployment(config);
  await pause(5);
  const back = await tag.readExperiment();
  assert.equal(back.experimentStartTime, config.startTime);
  await tag.disconnect();
  assert.equal(fake.open.size, 0, 'the port was left open');
  assert.equal(await usb.connect('usb:AA:AA:AA:AA:AA:AA'), null);
});

test('a log downloads over USB through the helper byte for byte', async () => {
  const fake = helperWithTagsPluggedIn();
  const usb = new HelperUsb(await startedClient(fake as unknown as ReturnType<typeof helperWithATag>));
  const tag = await usb.open('/dev/cu.usbmodem1101');
  assert.deepEqual(await tag.downloadLog(null, () => {}), fixture);
  await tag.disconnect();
});

test('a tag too old to say which it is, or on a port another program has, is refused when picked', async () => {
  const fake = helperWithTagsPluggedIn();
  const usb = new HelperUsb(await startedClient(fake as unknown as ReturnType<typeof helperWithATag>));
  await assert.rejects(usb.open('/dev/cu.usbmodem2101'), /did not report its ID/);
  await assert.rejects(usb.open('/dev/cu.usbmodem3101'), /Another program/);
  assert.equal(fake.open.size, 0, 'a port was left open');
});

test('a tag unplugged while something waits on it fails that, rather than hanging', async () => {
  const fake = helperWithTagsPluggedIn();
  const usb = new HelperUsb(await startedClient(fake as unknown as ReturnType<typeof helperWithATag>));
  const tag = await usb.open('/dev/cu.usbmodem1101');
  const connection = [...fake.open.keys()][0];
  fake.say({ event: 'usbClosed', connection, error: 'The tag was unplugged.' });
  await pause(0);
  assert.equal(tag.isConnected(), false);
  await assert.rejects(tag.readExperiment(), /unplugged/);
});

test('picking several tags reaches each in turn, nearby and plugged in, and one out of range does not stop the rest', async () => {
  const fake = helperWithTagsPluggedIn({ alsoBluetooth: true });
  (globalThis as { chrome?: unknown }).chrome = { runtime: fake.runtime };
  const { helper } = await import('../src/lib/helper.ts');
  const { helperTransport, setTagPicker } = await import('../src/adapters/helperTransport.ts');
  const { helperUsb } = await import('../src/adapters/helperUsb.ts');
  const { connectTo } = await import('../src/lib/tagAccess.ts');
  await helper.start();
  await pause(50);
  assert.ok(!fake.requests.some((request) => request.op.startsWith('usb')), 'the helper starting looked at the USB ports');
  try {
    let asked: unknown = null;
    setTagPicker(async (options) => {
      asked = options;
      return [
        { kind: 'bluetooth', device: 'a86f0191' }, { kind: 'bluetooth', device: 'out-of-range' },
        { kind: 'usb', port: '/dev/cu.usbmodem1101' }, { kind: 'bluetooth', device: 'b1c2d3e4' },
      ];
    });
    let picked = 0;
    const results: Array<string> = [];
    for await (const result of helperTransport.requestDevices!((count) => { picked = count; })) {
      if (result instanceof Error) results.push(`error: ${result.message}`);
      else { results.push(`${result.identity.transport} ${result.identity.handle}`); await result.disconnect(); }
    }
    assert.deepEqual(asked, { multiple: true, usb: true });
    assert.equal(picked, 4);
    assert.deepEqual(results, ['helper a86f0191', 'error: timeout on Connect', 'serial usb:66:55:44:33:22:11', 'helper b1c2d3e4']);

    // Only Bluetooth can range, so a live radio check leaves the tags plugged in out of the list
    for await (const result of helperTransport.requestDevices!(undefined, { usb: false })) {
      if (!(result instanceof Error)) await result.disconnect();
    }
    assert.deepEqual(asked, { multiple: true, usb: false });

    // A tag plugged in is reached over USB, though it is known only over Bluetooth: plugged in, its Bluetooth is off.
    // One that is not plugged in is reached as it is known.
    const plugged = await connectTo({ handle: 'a86f0191', transport: 'helper', eui: [...UID], firstSeen: '', lastSeen: '' });
    assert.equal(plugged?.identity.handle, 'usb:66:55:44:33:22:11');
    await plugged?.disconnect();
    const nearby = await connectTo({ handle: 'a86f0191', transport: 'helper', eui: [0x31, 0x02, 0x42, 0xe5, 0x98, 0xc0], firstSeen: '', lastSeen: '' });
    assert.equal(nearby?.identity.transport, 'helper');
    await nearby?.disconnect();
    assert.equal(helperUsb.getSnapshot().length, 3, 'the look at the ports was not shared');
  } finally {
    setTagPicker(null);
    helper.stop();
  }
});
