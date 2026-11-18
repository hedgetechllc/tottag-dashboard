#!/usr/bin/env node
/**
 * Builds the Go TotTag Helper and runs one of its commands, on any platform.
 *
 *   npm run helper:build                     → tottag-helper/dist/tottag-helper[.exe]
 *   npm run install-helper [-- --extension-id <id>]
 *   npm run helper-doctor
 *   node tools/helper.mjs check-extension-id   the helper allows the extension the key pins
 *
 * A wrapper rather than a shell line because npm runs scripts in cmd.exe on Windows, which
 * neither finds a program by a forward-slash path nor adds `.exe` to it.
 *
 * On macOS the helper carries an Info.plist in its executable, saying why it wants Bluetooth:
 * macOS ends a program that uses Bluetooth without saying. The linker is given it from the
 * system's temporary folder, because a path with a space in it, as this repository's may have,
 * cannot be passed through -extldflags.
 *
 * For an installer instead, see tottag-helper/packaging and the tottag-helper-release workflow.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tottag-helper');
const binary = join(root, 'dist', process.platform === 'win32' ? 'tottag-helper.exe' : 'tottag-helper');
const [command = 'build', ...args] = process.argv.slice(2);

/*
  The extension's ID is pinned by the public key in its manifest: the first 32 hex digits of the
  key's SHA-256, written a–p. The helper's registration allows only that ID (install.ExtensionID,
  which the Linux package's manifests are also made from), so a new key without a new helper
  would leave the extension unable to start it.
*/
if (command === 'check-extension-id') {
  const manifest = JSON.parse(readFileSync(join(root, '..', 'extension', 'manifest.json'), 'utf8'));
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const fromKey = [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  const source = readFileSync(join(root, 'internal', 'install', 'install.go'), 'utf8');
  const inHelper = /^const ExtensionID = "([a-p]{32})"$/m.exec(source)?.[1];
  if (inHelper !== fromKey) {
    console.error(`✗ The extension's key pins ID ${fromKey}, but install.ExtensionID is ${inHelper ?? 'missing'}.`);
    process.exit(1);
  }
  console.log(`✓ The helper allows the extension's ID, ${fromKey}`);
  process.exit(0);
}

function run(program, programArgs, cwd) {
  const result = spawnSync(program, programArgs, { cwd, stdio: 'inherit' });
  if (result.error) {
    console.error(program === 'go' ? 'The TotTag Helper is written in Go; install Go 1.22 or later from https://go.dev/dl/.' : String(result.error));
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/*
  Named after the release it was built from, and how far past it: "0.2.0" on the tag itself,
  "0.2.0-3-gab12cd3" three commits later, with "-dirty" for uncommitted changes. So `doctor`
  and the dashboard say exactly what is installed.
*/
function version() {
  const result = spawnSync('git', ['describe', '--tags', '--match', 'tottag-helper-v*', '--dirty'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().replace(/^tottag-helper-v/, '') : '0.0.0-dev';
}

let ldflags = `-X main.version=${version()}`;
let staging = null;
if (process.platform === 'darwin') {
  staging = mkdtempSync(join(tmpdir(), 'tottag-helper-'));
  const plist = join(staging, 'Info.plist');
  copyFileSync(join(root, 'packaging', 'macos', 'Info.plist'), plist);
  ldflags += ` -linkmode=external -extldflags=-Wl,-sectcreate,__TEXT,__info_plist,${plist}`;
}
try {
  run('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', binary, './cmd/tottag-helper'], root);
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
}
if (command === 'build') {
  console.log(`✓ built ${binary}`);
} else {
  run(binary, [command, ...args]);
}
