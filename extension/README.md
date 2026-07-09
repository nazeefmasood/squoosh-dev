# Smoosh — AI image cleaner (browser extension)

Adds **Remove watermark** and **Compress** buttons to AI-generated images inside
Gemini and ChatGPT. All processing runs locally in your browser — images never
leave the page.

- **Gemini**: the invisible SynthID-style sparkle watermark is removed via the
  same reverse-alpha-blending engine as smoosh-dev, then offered as PNG;
  plus a one-click WebP compress.
- **ChatGPT**: a one-click WebP compress (ChatGPT images carry no watermark).

The watermark engine is the vendored `@pilio/gemini-watermark-remover` (MIT),
bundled from `../src/vendor/gwm` into a single Web Worker by esbuild.

## Build

```bash
cd extension
npm install
npm run build      # -> dist/   (loadable extension)
npm run watch      # rebuild on change
```

## Load (Chrome / Edge / Brave)

1. `npm run build`
2. Visit `chrome://extensions`
3. Enable **Developer mode** (top-right)
4. **Load unpacked** → select `extension/dist`
5. Open a Gemini or ChatGPT chat with a generated image and hover it.

## Load (Firefox)

1. `npm run build`
2. Visit `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on…** → select `extension/dist/manifest.json`

(Temporary add-ons are removed on restart; for permanent install the extension
must be signed via addons.mozilla.org.)

## Architecture

```
content.js   injected on gemini.google.com / chatgpt.com
             MutationObserver → finds chat images → mounts button bar
             on click: fetch(blob) → postMessage → worker → download
worker.js    bundled (gwm + encoders). Decodes via createImageBitmap,
             removes watermark on ImageData, re-encodes, returns blob.
background.js service worker (no-op for now)
manifest.json MV3, Chrome + Firefox
```

## Status

- [x] Watermark removal — ported, bundled, verified end-to-end in Node.
- [x] Compression v1 — browser canvas encoders (PNG/WebP/JPEG), zero WASM.
- [ ] Compression v2 — bundle MozJPEG/WebP WASM from `../codecs` for output
      parity with the site (larger extension, planned).
- [ ] Cross-browser QA on live Gemini / ChatGPT DOM.

```

```
