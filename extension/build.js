// Bundles the extension sources with esbuild.
//
// - worker.js: the heavy image-processing worker. It imports the vendored
//   Gemini watermark remover (../src/vendor/gwm) and bundles it into one file
//   so the extension ships a single self-contained worker with no module
//   resolution at runtime.
// - content.js / background.js / popup.js: plain ES modules, copied through.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(__dirname, 'src');
const out = path.join(__dirname, 'dist');

if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });

// The gwm still-image chain is pure JS and doesn't import the optional
// onnxruntime-web / node:* modules at all, so tree-shaking keeps them out.
// Listed as externals only as a safety net in case something reaches them.
const external = [
  'onnxruntime-web',
  'onnxruntime-web/wasm',
  'node:fs',
  'node:path',
];

const watch = process.argv.includes('--watch');

/** Copy static files into dist/ so dist/ is a directly-loadable extension. */
function copyStatic() {
  fs.copyFileSync(
    path.join(__dirname, 'manifest.json'),
    path.join(out, 'manifest.json'),
  );
  const iconsOut = path.join(out, 'icons');
  if (!fs.existsSync(iconsOut)) fs.mkdirSync(iconsOut, { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) {
    fs.copyFileSync(path.join(__dirname, 'icons', f), path.join(iconsOut, f));
  }
}

/** Files that only need to be passed through (not bundled off a gwm import). */
const passThrough = ['content.js', 'background.js'];

async function build() {
  const ctxOptions = (entry, outfile, extra = {}) => ({
    entryPoints: [path.join(src, entry)],
    bundle: true,
    outfile: path.join(out, outfile),
    format: 'iife',
    target: ['chrome115', 'firefox115'],
    platform: 'browser',
    external,
    logLevel: 'info',
    ...extra,
  });

  const builds = [
    // Worker: bundled, imports gwm from the host repo.
    {
      ...ctxOptions('worker.js', 'worker.js', { format: 'esm' }),
      alias: { gwm: path.join(root, 'src/vendor/gwm/sdk/image-data.js') },
    },
  ];
  for (const f of passThrough) {
    builds.push(ctxOptions(f, f));
  }

  if (watch) {
    copyStatic();
    const ctxs = [];
    for (const o of builds) ctxs.push(await esbuild.context(o));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('watching…');
  } else {
    await Promise.all(builds.map((o) => esbuild.build(o)));
    copyStatic();
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
