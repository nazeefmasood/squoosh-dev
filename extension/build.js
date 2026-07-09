// Bundles the extension sources with esbuild.
//
// The extension no longer does image processing itself — it hands images off
// to the Smoosh website. So there's no gwm bundle; every file is a plain
// pass-through (content scripts + background + popup).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'src');
const out = path.join(__dirname, 'dist');

if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });

const watch = process.argv.includes('--watch');

const passThrough = [
  'content.js',
  'site-handoff.js',
  'background.js',
  'popup.js',
];

/** Copy static files into dist/ so dist/ is a directly-loadable extension. */
function copyStatic() {
  fs.copyFileSync(
    path.join(__dirname, 'manifest.json'),
    path.join(out, 'manifest.json'),
  );
  for (const f of ['popup.html', 'popup.css']) {
    fs.copyFileSync(path.join(__dirname, 'src', f), path.join(out, f));
  }
  const iconsOut = path.join(out, 'icons');
  if (!fs.existsSync(iconsOut)) fs.mkdirSync(iconsOut, { recursive: true });
  for (const f of fs.readdirSync(path.join(__dirname, 'icons'))) {
    fs.copyFileSync(path.join(__dirname, 'icons', f), path.join(iconsOut, f));
  }
}

async function build() {
  const opts = (entry) => ({
    entryPoints: [path.join(src, entry)],
    bundle: true,
    outfile: path.join(out, entry),
    format: 'iife',
    target: ['chrome115', 'firefox115'],
    platform: 'browser',
    logLevel: 'info',
  });

  const builds = passThrough.map((f) => opts(f));

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
