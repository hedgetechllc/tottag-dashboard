// What a TotTag says about itself in its Bluetooth advertisement, before anything connects to it. Pure.
//
// Its manufacturer-specific data is three bytes: the company ID, little-endian, then the role it is in.
// The firmware sets that role to ROLE_ASLEEP on entering maintenance mode, which is what a tag on its
// charger is in (app_task_maintenance.c), and to its ranging role whenever it is ranging. Only in
// maintenance mode does a tag accept a deployment or a cancel, or serve its log, so the role is how a
// list of tags nearby can leave out the ones that would refuse.

import { SCHEDULE_ROLE } from './constants.ts';

/** The company ID a TotTag files its manufacturer data under: BLUETOOTH_COMPANY_ID in app_config.h, `0xe0,0x02`. */
export const TOTTAG_COMPANY_ID = 0x02e0;

/** One company's manufacturer-specific data from an advertisement. */
export interface ManufacturerData {
  readonly company: number;
  readonly data: Uint8Array;
}

/** The role a tag advertises, or null when its advertisement carries none. */
export function advertisedRole(manufacturer: readonly ManufacturerData[]): number | null {
  const ours = manufacturer.find((entry) => entry.company === TOTTAG_COMPANY_ID);
  return ours && ours.data.length ? ours.data[0]! : null;
}

/**
 * Whether a tag is on its charger, as its advertisement says: true or false, or null when it does not say,
 * as from a TotTag Helper too old to pass manufacturer data on.
 */
export function onChargerFromAdvertisement(manufacturer: readonly ManufacturerData[] | null): boolean | null {
  if (!manufacturer) return null;
  const role = advertisedRole(manufacturer);
  return role === null ? null : role === SCHEDULE_ROLE.ROLE_ASLEEP;
}
