// What the Bluetooth adapter reads to identify a tag, and when.
//
// Identifying a tag is three reads from Device Information on every connection, and none of it changes
// while the page is open unless the tag is reflashed. So a tag is identified when it is picked in the
// chooser, and a reconnect later in the same page session uses what that read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATT_SYSTEM_ID_UUID } from '@tottag/schema';
import { webBluetoothTransport } from '../src/adapters/webBluetooth.ts';

function installTag(id: string) {
  const counts = { identityReads: 0 };
  const service = { getCharacteristic: async () => { throw new Error('not exposed'); } };
  const info = {
    getCharacteristic: async (uuid: string | number) => {
      if (uuid !== GATT_SYSTEM_ID_UUID) throw new Error('not exposed');
      return {
        readValue: async () => {
          counts.identityReads += 1;
          return new DataView(Uint8Array.of(0x31, 0x02, 0x42, 0xfe, 0xff, 0xe5, 0x98, 0xc0).buffer);
        },
      };
    },
  };
  const server = { connected: true, getPrimaryService: async (uuid: string | number) => (uuid === 0x180a ? info : service), disconnect() {} };
  const device = { id, gatt: { connect: async () => server }, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis.navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
  return counts;
}

test('a tag is identified when picked, and a reconnect in the same page session uses that', async () => {
  const counts = installTag('tag');
  let picked = 0;

  const first = await webBluetoothTransport.requestDevice(() => { picked += 1; });
  assert.ok(first);
  assert.equal(picked, 1, 'the page is told once the tag is picked, so it can say it is connecting');
  assert.equal(counts.identityReads, 1);
  await first.disconnect();

  const again = await webBluetoothTransport.connect('tag');
  assert.ok(again);
  assert.equal(counts.identityReads, 1, 'reconnecting does not read the identity again');
  assert.deepEqual([...again.identity.eui], [...first.identity.eui]);
  await again.disconnect();

  // Picking it again reads it again, which is how a reflashed tag's new firmware revision is seen
  const repicked = await webBluetoothTransport.requestDevice();
  assert.ok(repicked);
  assert.equal(counts.identityReads, 2);
  await repicked.disconnect();
});

test('a dismissed chooser is not reported as a pick', async () => {
  Object.defineProperty(globalThis.navigator, 'bluetooth', {
    configurable: true,
    value: { requestDevice: async () => { throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'); } },
  });
  let picked = false;
  assert.equal(await webBluetoothTransport.requestDevice(() => { picked = true; }), null);
  assert.equal(picked, false);
});
