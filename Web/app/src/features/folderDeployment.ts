// The deployment a download folder is for, from the deployment records saved in it. Pure.
//
// A folder is usually one study's: the record saved when its tags were set up, and the logs downloaded
// from them afterwards. So the tags that record lists are the ones a person downloading into that folder
// most likely means, and the list of tags to download from can offer those first.

import { parseManifest, shortAddress, type StudyRecord } from '@tottag/schema';
import type { LoadedRecordFile } from '../ports/logSource.ts';

export interface FolderDeployment {
  /** What to call it where the list says whose tags it is showing: its name, or the record file's. */
  readonly label: string;
  /** Its tags by the last two parts of their address, `02:31`, as the list knows them. */
  readonly ids: ReadonlySet<string>;
}

/** The last two parts of a record's address, which lists it most-significant byte first as 12 hex digits. */
const idOf = (eui: string): string =>
  shortAddress(Uint8Array.from(eui.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16)).reverse());

/** The newest deployment the folder's records describe, or null when none of its files is one. */
export function folderDeployment(files: readonly LoadedRecordFile[]): FolderDeployment | null {
  let newest: { record: StudyRecord; file: string } | null = null;
  const when = (record: StudyRecord) => record.writtenAt ?? record.startTime;
  for (const file of files) {
    const parsed = parseManifest(file.text);
    if (parsed.ok && (!newest || when(parsed.record) > when(newest.record))) newest = { record: parsed.record, file: file.name };
  }
  if (!newest) return null;
  return {
    label: newest.record.name ?? newest.file.replace(/\.json$/i, ''),
    ids: new Set(newest.record.devices.map((device) => idOf(device.eui))),
  };
}
