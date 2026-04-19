// Minimal esbuild driver for the Chrome MV3 extension.
// Bundles each TS entry to its own JS in dist/, copies static assets,
// and emits dist/manifest.json from src/manifest.json.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, 'src');
const DIST = resolve(__dirname, 'dist');

await mkdir(DIST, { recursive: true });

await build({
  entryPoints: [
    resolve(SRC, 'background.ts'),
    resolve(SRC, 'content.ts'),
    resolve(SRC, 'options/options.ts'),
    resolve(SRC, 'popup/popup.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  outdir: DIST,
  outbase: SRC,
  sourcemap: true,
  minify: false,
});

// Copy manifest + html assets.
const manifest = JSON.parse(await readFile(resolve(SRC, 'manifest.json'), 'utf-8'));
await writeFile(resolve(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

for (const html of ['options/options.html', 'popup/popup.html']) {
  const target = resolve(DIST, html);
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(resolve(SRC, html))) {
    await copyFile(resolve(SRC, html), target);
  }
}

console.log('built →', DIST);
