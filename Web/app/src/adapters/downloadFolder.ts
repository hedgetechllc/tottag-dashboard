// The folder logs downloaded from tags are saved into: chosen once, and kept between visits.
//
// A log pulled off a tag exists nowhere else until it is on disk, and a save button on each card is
// easy to forget once the card shows everything it found. So the folder is chosen before downloading,
// and every log is written into it the moment it arrives.
//
// The File System Access API's directory picker chooses it. Its handle is kept in IndexedDB, so the
// same folder is offered after a reload; whether the page may still write there is the browser's to
// say, and asking again needs a click of its own (`allow`). Chromium only, like Web Bluetooth and Web
// Serial: where there is no picker, downloads fall back to each card's Save button.

import type { LoadedRecordFile } from '../ports/logSource.ts';

/** The parts of a directory handle used here. */
export interface FolderHandle {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    getFile(): Promise<File>;
    createWritable(): Promise<{ write(data: BufferSource | Blob | string): Promise<void>; close(): Promise<void> }>;
  }>;
  entries(): AsyncIterable<[string, { kind: 'file' | 'directory'; getFile?: () => Promise<File> }]>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

type Picker = (options: { mode: 'readwrite'; id?: string }) => Promise<FolderHandle>;
const picker = (): Picker | undefined => (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;

export const canChooseFolder = (): boolean => typeof window !== 'undefined' && typeof picker() === 'function';

// --- Keeping the handle between visits ------------------------------------------------------------

const DB = 'tottag-dashboard';
const STORE = 'handles';
const KEY = 'download-folder';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function keep(handle: FolderHandle): Promise<void> {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(handle, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  } catch { /* the folder is then asked for again next visit, which is all this saves */ }
}

/** The folder chosen on an earlier visit, or null. */
export async function rememberedFolder(): Promise<FolderHandle | null> {
  if (!canChooseFolder() || typeof indexedDB === 'undefined') return null;
  try {
    const db = await database();
    const handle = await new Promise<FolderHandle | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve((request.result as FolderHandle | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

// --- Choosing it, and permission -------------------------------------------------------------------

/** Ask which folder to save into; null when the picker was dismissed. Must be called from a click. */
export async function chooseFolder(): Promise<FolderHandle | null> {
  const pick = picker();
  if (!pick) return null;
  try {
    // The id makes the picker open where it was last used for this
    const handle = await pick({ mode: 'readwrite', id: 'tottag-downloads' });
    await keep(handle);
    return handle;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/** Whether the page may write into the folder now, without asking. */
export async function canWrite(handle: FolderHandle): Promise<boolean> {
  try {
    return (await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Ask the browser for permission to write into the folder again. Must be called from a click. */
export async function allowWriting(handle: FolderHandle): Promise<boolean> {
  try {
    return (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

// --- Using it ----------------------------------------------------------------------------------------

async function exists(handle: FolderHandle, name: string): Promise<boolean> {
  try {
    await handle.getFileHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return false;
    throw error;
  }
}

/**
 * Write `bytes` into the folder as `name`, or, when a file of that name is already there, as
 * `name (2)`, `name (3)` and so on: a log already saved is never replaced. Returns the name written.
 */
export async function writeNew(handle: FolderHandle, name: string, bytes: Uint8Array): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let chosen = name;
  for (let copy = 2; await exists(handle, chosen); copy += 1) chosen = `${stem} (${copy})${extension}`;
  const file = await handle.getFileHandle(chosen, { create: true });
  const writable = await file.createWritable();
  await writable.write(new Blob([bytes as BlobPart]));
  await writable.close();
  return chosen;
}

/** Every deployment record (.json) directly inside the folder, to open with what is downloaded into it. */
export async function folderRecords(handle: FolderHandle): Promise<LoadedRecordFile[]> {
  const records: LoadedRecordFile[] = [];
  try {
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'file' && name.toLowerCase().endsWith('.json') && entry.getFile) {
        records.push({ name, text: await (await entry.getFile()).text() });
      }
    }
  } catch { /* unreadable now: the records are only a convenience */ }
  return records;
}
