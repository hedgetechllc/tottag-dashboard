// The tags this browser remembers: one entry for each tag and transport, holding the handle that reaches it.
//
// The browser's handle for a tag changes when the operating system forgets the device, as clearing macOS's
// Bluetooth device cache makes it do. A remembered list that kept the old handle beside the new one sent
// every row to the dead handle, so the tag asked to be picked again however many times it was picked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readKnownTags, rememberTag, routeFor, type KnownTag } from '../src/features/useKnownTags.ts';

const EUI_A = [0x0a, 0x02, 0x42, 0xe5, 0x98, 0xc0];
const EUI_B = [0x0b, 0x02, 0x42, 0xe5, 0x98, 0xc0];

const tag = (handle: string, eui: number[], seen: string, transport: KnownTag['transport'] = 'bluetooth'): KnownTag =>
  ({ handle, transport, eui, firstSeen: seen, lastSeen: seen });

test('picking a tag under a new handle replaces its old entry, so the new handle is the one used', () => {
  const before = [tag('old-a', EUI_A, '2026-01-01T00:00:00.000Z'), tag('b', EUI_B, '2026-01-02T00:00:00.000Z')];
  const after = rememberTag(before, tag('new-a', EUI_A, '2026-11-18T00:00:00.000Z'));

  assert.deepEqual(after.map((entry) => entry.handle), ['new-a', 'b'], 'replaced in place, not appended');
  assert.equal(routeFor(after, EUI_A)?.handle, 'new-a');
  assert.equal(after[0]!.firstSeen, '2026-01-01T00:00:00.000Z', 'when the tag was first seen is kept');
});

test('a tag picked just now wins even when the clock says an older entry was seen later', () => {
  // The handle just returned by the chooser is the one known to work, whatever the computer's clock says
  const after = rememberTag([tag('old-a', EUI_A, '2026-12-01T00:00:00.000Z')], tag('new-a', EUI_A, '2026-11-18T00:00:00.000Z'));
  assert.deepEqual(after.map((entry) => entry.handle), ['new-a']);
});

test('the same tag known over Bluetooth and over USB keeps one entry for each', () => {
  const after = rememberTag([tag('ble-a', EUI_A, '2026-01-01T00:00:00.000Z')], tag('usb:a', EUI_A, '2026-11-18T00:00:00.000Z', 'serial'));
  assert.deepEqual(after.map((entry) => entry.handle), ['ble-a', 'usb:a']);
  assert.equal(routeFor(after, EUI_A)?.handle, 'ble-a', 'Bluetooth is still preferred');
});

test('a saved list holding an old and a new handle for one tag loads as the most recently seen', () => {
  const stale = tag('old-a', EUI_A, '2026-01-01T00:00:00.000Z');
  const live = tag('new-a', EUI_A, '2026-11-18T00:00:00.000Z');
  const other = tag('b', EUI_B, '2026-06-01T00:00:00.000Z');

  for (const saved of [[stale, other, live], [live, other, stale]]) {
    const loaded = readKnownTags(JSON.parse(JSON.stringify(saved)));
    assert.equal(loaded.length, 2);
    assert.equal(routeFor(loaded, EUI_A)?.handle, 'new-a');
    assert.equal(loaded.find((entry) => entry.handle === 'new-a')?.firstSeen, '2026-01-01T00:00:00.000Z');
  }
});
