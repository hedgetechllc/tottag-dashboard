// Which tags the Bluetooth adapter offers to reach without the chooser.
//
// After a reload, a tag remembered by this browser can be reached only if `getDevices()` still returns it.
// The API existing is not enough: offering every remembered tag as one click away, and then failing to reach
// the ones without a grant, is the mistake this guards against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATT_SYSTEM_ID_UUID } from '@tottag/schema';
import { webBluetoothTransport } from '../src/adapters/webBluetooth.ts';

function fakeDevice(id: string) {
  const service = { getCharacteristic: async () => { throw new Error('not exposed'); } };
  const info = {
    getCharacteristic: async (uuid: string | number) => {
      if (uuid !== GATT_SYSTEM_ID_UUID) throw new Error('not exposed');
      return { readValue: async () => new DataView(Uint8Array.of(0x0a, 0x11, 0x22, 0xfe, 0xff, 0x33, 0x44, 0x55).buffer) };
    },
  };
  const server = { connected: true, getPrimaryService: async (uuid: string | number) => (uuid === 0x180a ? info : service), disconnect() {} };
  return { id, gatt: { connect: async () => server }, addEventListener() {}, removeEventListener() {} };
}

test('only tags the browser still holds a grant for are reachable after a reload, and a picked one becomes reachable', async () => {
  const granted = fakeDevice('granted');
  const picked = fakeDevice('picked');
  let answer: (devices: unknown[]) => void = () => {};
  Object.defineProperty(globalThis.navigator, 'bluetooth', {
    configurable: true,
    value: {
      getDevices: () => new Promise((resolve) => { answer = resolve; }),
      requestDevice: async () => picked,
    },
  });

  let changes = 0;
  const unsubscribe = webBluetoothTransport.onReachabilityChange(() => { changes += 1; });

  // Nothing is offered before the browser has said what it still holds grants for
  assert.equal(webBluetoothTransport.canReachWithoutChooser('granted'), false);

  answer([granted]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(changes, 1);
  assert.equal(webBluetoothTransport.canReachWithoutChooser('granted'), true);
  assert.equal(webBluetoothTransport.canReachWithoutChooser('picked'), false, 'remembered but no longer granted');
  assert.equal(webBluetoothTransport.canReachWithoutChooser('forgotten'), false);

  const connection = await webBluetoothTransport.requestDevice();
  assert.ok(connection);
  assert.equal(changes, 2);
  assert.equal(webBluetoothTransport.canReachWithoutChooser('picked'), true);

  unsubscribe();
});
