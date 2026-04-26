// Minimal esbuild driver for the Chrome MV3 extension.
// Bundles each TS entry to its own JS in dist/, copies static assets,
// and emits dist/manifest.json from src/manifest.json.
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
    resolve(SRC, 'options/options.ts'),
    resolve(SRC, 'popup/popup.ts'),
    resolve(SRC, 'offscreen/offscreen.ts'),
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

// chrome.offscreen.createDocument({ url: 'offscreen.html' }) resolves
// against the extension root, so the HTML lives at dist/offscreen.html
// (not nested under dist/offscreen/) — and references its bundled JS
// via the relative path "offscreen/offscreen.js" inside the script tag.
const offscreenHtmlSrc = resolve(SRC, 'offscreen/offscreen.html');
if (existsSync(offscreenHtmlSrc)) {
  await copyFile(offscreenHtmlSrc, resolve(DIST, 'offscreen.html'));
}

// Copy icons referenced by manifest.json (action.default_icon + icons.*).
const ICONS_SRC = resolve(SRC, 'icons');
if (existsSync(ICONS_SRC)) {
  const ICONS_DIST = resolve(DIST, 'icons');
  await mkdir(ICONS_DIST, { recursive: true });
  for (const f of await readdir(ICONS_SRC)) {
    if (f.startsWith('._')) continue;
    await copyFile(resolve(ICONS_SRC, f), resolve(ICONS_DIST, f));
  }
}

// Strip macOS AppleDouble metadata (`._*`) from dist. They're created
// when this repo lives on an exFAT/HFS+ volume and Chrome's MV3 loader
// rejects them as "files starting with _" reserved for the runtime.
async function stripAppleDouble(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const path = resolve(dir, e.name);
    if (e.isDirectory()) {
      await stripAppleDouble(path);
    } else if (e.name.startsWith('._')) {
      await unlink(path);
    }
  }
}
await stripAppleDouble(DIST);

console.log('built →', DIST);
