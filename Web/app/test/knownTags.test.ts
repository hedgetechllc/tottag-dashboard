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

test('a tag known several ways is reached through the helper, then the browser, then USB, among the ways usable now', () => {
  const known = [
    tag('usb:a', EUI_A, '2026-11-01T00:00:00.000Z', 'serial'),
    tag('ble-a', EUI_A, '2026-11-02T00:00:00.000Z', 'bluetooth'),
    tag('helper-a', EUI_A, '2026-11-03T00:00:00.000Z', 'helper'),
  ];
  assert.equal(routeFor(known, EUI_A)?.handle, 'helper-a');
  assert.equal(routeFor(known, EUI_A, (transport) => transport !== 'helper')?.handle, 'ble-a', 'the helper is not running');
  assert.equal(routeFor(known, EUI_A, (transport) => transport === 'serial')?.handle, 'usb:a', 'only USB is usable');
  // Known only through the helper, which is not running: still returned, so the page can say what to do
  assert.equal(routeFor([known[2]!], EUI_A, (transport) => transport !== 'helper')?.handle, 'helper-a');
});

test('the lists offer the ten tags used most recently, each once on Bluetooth and once on USB', async () => {
  const { RECENT_TAGS, recentlyUsed, unlistedNote } = await import('../src/lib/tagAccess.ts');
  const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const many = Array.from({ length: 14 }, (_, n) => tag(`t${n}`, [n + 1, 0x02, 0x42, 0xe5, 0x98, 0xc0], day(n + 1)));
  // t3 was reached through the TotTag Helper since, and over USB before: one tag on Bluetooth, and one on USB
  many.push(tag('helper-t3', [4, 0x02, 0x42, 0xe5, 0x98, 0xc0], day(20), 'helper'));
  many.push(tag('usb:t3', [4, 0x02, 0x42, 0xe5, 0x98, 0xc0], day(19), 'serial'));
  const recent = recentlyUsed(many);
  assert.equal(recent.length, RECENT_TAGS);
  assert.deepEqual(recent.map((each) => each.handle), ['helper-t3', 'usb:t3', 't13', 't12', 't11', 't10', 't9', 't8', 't7', 't6']);
  assert.equal(unlistedNote(many, 10), null, 'tags past the ten most recent were counted as missing from the list');
  assert.match(unlistedNote(many, 8) ?? '', /^2 tags used recently are not listed/);
});
