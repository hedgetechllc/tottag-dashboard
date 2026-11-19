// What a tag's advertisement says about it, and that the company ID it is filed under is the firmware's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SCHEDULE_ROLE, TOTTAG_COMPANY_ID, advertisedRole, onChargerFromAdvertisement } from '../src/index.ts';
import { FIRMWARE_DIR } from '../tools/spec.mjs';

test('the company ID is BLUETOOTH_COMPANY_ID from app_config.h, read little-endian as it goes over the air', () => {
  const config = readFileSync(join(FIRMWARE_DIR, 'app', 'app_config.h'), 'utf8');
  const match = /#define\s+BLUETOOTH_COMPANY_ID\s+(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)/i.exec(config);
  assert.ok(match, 'BLUETOOTH_COMPANY_ID is a pair of bytes');
  assert.equal(TOTTAG_COMPANY_ID, Number.parseInt(match[1]!, 16) | (Number.parseInt(match[2]!, 16) << 8));
});

test('a tag advertising ROLE_ASLEEP is on its charger, and one advertising a ranging role is not', () => {
  const advert = (role: number) => [{ company: TOTTAG_COMPANY_ID, data: Uint8Array.of(role) }];
  assert.equal(onChargerFromAdvertisement(advert(SCHEDULE_ROLE.ROLE_ASLEEP)), true);
  for (const role of [SCHEDULE_ROLE.ROLE_IDLE, SCHEDULE_ROLE.ROLE_MASTER, SCHEDULE_ROLE.ROLE_PARTICIPANT, SCHEDULE_ROLE.ROLE_MASTER_INELIGIBLE]) {
    assert.equal(onChargerFromAdvertisement(advert(role)), false);
  }
});

test('an advertisement that does not say leaves it unknown', () => {
  assert.equal(onChargerFromAdvertisement(null), null, 'a helper too old to pass manufacturer data on');
  assert.equal(onChargerFromAdvertisement([]), null);
  assert.equal(onChargerFromAdvertisement([{ company: 0x004c, data: Uint8Array.of(SCHEDULE_ROLE.ROLE_ASLEEP) }]), null, 'another company');
  assert.equal(advertisedRole([{ company: TOTTAG_COMPANY_ID, data: new Uint8Array() }]), null);
});
