// What decides which tags the lists to pick from offer: whether a tag says it is on its charger, and which
// tags a download folder's deployment record lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULE_ROLE, TOTTAG_COMPANY_ID, onChargerFromAdvertisement } from '@tottag/schema';
import { folderDeployment } from '../src/features/folderDeployment.ts';
import { manufacturerFromEvent } from '../src/lib/helper.ts';

test('a device event carries manufacturer data as hex, which says whether the tag is on its charger', () => {
  const charging = manufacturerFromEvent([{ company: TOTTAG_COMPANY_ID, data: SCHEDULE_ROLE.ROLE_ASLEEP.toString(16).padStart(2, '0') }]);
  assert.deepEqual(charging, [{ company: TOTTAG_COMPANY_ID, data: Uint8Array.of(SCHEDULE_ROLE.ROLE_ASLEEP) }]);
  assert.equal(onChargerFromAdvertisement(charging), true);
  const ranging = manufacturerFromEvent([{ company: TOTTAG_COMPANY_ID, data: SCHEDULE_ROLE.ROLE_PARTICIPANT.toString(16).padStart(2, '0') }]);
  assert.equal(onChargerFromAdvertisement(ranging), false);
});

test('a helper too old to send manufacturer data leaves it unknown, and malformed entries are skipped', () => {
  assert.equal(manufacturerFromEvent(undefined), null);
  assert.deepEqual(manufacturerFromEvent([{ company: 'x', data: '0d' }, { company: 736, data: 'zz' }, null]), []);
});

const record = (name: string | null, writtenAt: string, euis: string[]) => JSON.stringify({
  kind: 'tottag.deployment-manifest', manifestVersion: 2, writtenAt, ...(name ? { name } : {}),
  deployment: { timezone: 'America/Chicago', startTime: 1795058040 },
  devices: euis.map((eui) => ({ eui })),
});

test('a folder is for the deployment its newest record describes, its tags known by the end of their address', () => {
  const found = folderDeployment([
    { name: 'Old.json', text: record('Old', '2026-11-01T00:00:00Z', ['C0:98:E5:42:02:99']) },
    { name: 'Test-2026-11-18.json', text: record('Test', '2026-11-19T03:21:29Z', ['C0:98:E5:42:02:0B', 'c098e5420231']) },
    { name: 'notes.json', text: '{"not": "a record"}' },
  ]);
  assert.equal(found?.label, 'Test');
  assert.deepEqual([...found!.ids], ['02:0B', '02:31']);
});

test('a record without a name is called after its file, and a folder without one has no deployment', () => {
  assert.equal(folderDeployment([{ name: 'Family 10051.json', text: record(null, '2026-11-19T00:00:00Z', ['C0:98:E5:42:01:05']) }])?.label, 'Family 10051');
  assert.equal(folderDeployment([{ name: 'other.json', text: '[]' }]), null);
  assert.equal(folderDeployment([]), null);
});
