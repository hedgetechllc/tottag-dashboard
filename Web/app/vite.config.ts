import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The newest TotTag Helper released, from this repository's `tottag-helper-v*` tags, or '' when there
 * is none or git is not at hand. The site is rebuilt after every helper release (pages.yml), so the
 * page always knows what to offer and when an installed helper is out of date.
 */
function latestHelperRelease(): string {
  if (process.env.VITE_HELPER_RELEASE !== undefined) return process.env.VITE_HELPER_RELEASE;
  let tags = '';
  try {
    tags = execFileSync('git', ['tag', '--list', 'tottag-helper-v*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
  const versions = tags
    .split('\n')
    .map((tag) => /^tottag-helper-v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match.slice(1).map(Number))
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
  return versions.at(-1)?.join('.') ?? '';
}

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_HELPER_RELEASE': JSON.stringify(latestHelperRelease()),
  },
  // The schema package ships TypeScript sources with no build step, which is deliberate: it keeps
  // the package dependency-free and lets `node --experimental-strip-types` run its tests directly.
  // Excluding it from dependency pre-bundling makes Vite treat it as source, so a change there is
  // picked up without a rebuild and type errors surface in the app's own typecheck.
  optimizeDeps: { exclude: ['@tottag/schema'] },
  // Published by GitHub Pages at app.tottag.net. A relative base keeps the build working wherever it
  // is mounted.
  base: './',
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173 },
});
