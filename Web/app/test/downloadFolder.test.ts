// Saving downloads straight into a chosen folder: never over a log already there, and opening the
// deployment records found beside them. Against a stand-in folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderRecords, writeNew, type FolderHandle } from '../src/adapters/downloadFolder.ts';

function fakeFolder(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([name, text]) => [name, new TextEncoder().encode(text)]));
  const handle: FolderHandle = {
    kind: 'directory',
    name: 'newtest',
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException(`${name} not found`, 'NotFoundError');
        files.set(name, new Uint8Array());
      }
      return {
        getFile: async () => new File([files.get(name)! as BlobPart], name),
        createWritable: async () => {
          const parts: Uint8Array[] = [];
          return {
            write: async (data) => { parts.push(new Uint8Array(await new Response(data as BodyInit).arrayBuffer())); },
            close: async () => { files.set(name, Uint8Array.from(parts.flatMap((part) => [...part]))); },
          };
        },
      };
    },
    async *entries() {
      for (const name of files.keys()) yield [name, { kind: 'file' as const, getFile: async () => new File([files.get(name)! as BlobPart], name) }];
    },
  };
  return { handle, files };
}

test('a download is written under its own name, and never over a log already saved', async () => {
  const { handle, files } = fakeFolder({ '02-31_1794981600.ttg': 'the first download' });
  assert.equal(await writeNew(handle, '02-0B_1794981600.ttg', Uint8Array.of(1, 2, 3)), '02-0B_1794981600.ttg');
  assert.deepEqual([...files.get('02-0B_1794981600.ttg')!], [1, 2, 3]);
  assert.equal(await writeNew(handle, '02-31_1794981600.ttg', Uint8Array.of(4)), '02-31_1794981600 (2).ttg');
  assert.equal(await writeNew(handle, '02-31_1794981600.ttg', Uint8Array.of(5)), '02-31_1794981600 (3).ttg');
  assert.equal(new TextDecoder().decode(files.get('02-31_1794981600.ttg')), 'the first download', 'a saved log was replaced');
});

test('the deployment records in the folder are found, and nothing else', async () => {
  const { handle } = fakeFolder({ 'Test-2026-11-18.json': '{"format":"tottag-deployment"}', '02-31_1794981600.ttg': 'log', 'notes.txt': 'x' });
  const records = await folderRecords(handle);
  assert.deepEqual(records.map((record) => record.name), ['Test-2026-11-18.json']);
  assert.equal(records[0]!.text, '{"format":"tottag-deployment"}');
});
