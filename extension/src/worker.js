// Image-processing worker.
//
// Receives { id, blob, mode } where mode is 'watermark' | 'compress'.
// Decodes the blob on an OffscreenCanvas, runs the requested pipeline, and
// posts back { id, blob } (or { id, error }).
//
// The Gemini watermark remover is imported from the host repo's vendored gwm
// tree and bundled into this file at build time.
import { removeWatermarkFromImageDataSync } from 'gwm';

self.onmessage = async (e) => {
  const { id, blob, mode, options } = e.data;
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    if (mode === 'watermark') {
      const imageData = ctx.getImageData(0, 0, width, height);
      removeWatermarkFromImageDataSync(imageData, options || {});
      ctx.putImageData(imageData, 0, 0);
    }

    const outBlob = await encode(canvas, options || {});
    self.postMessage({ id, blob: outBlob });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};

/** Encode the canvas. v1 uses the browser's built-in encoders (no WASM). */
async function encode(canvas, options) {
  const fmt = options.format || 'image/png';
  const quality = typeof options.quality === 'number' ? options.quality : 0.92;
  // toBlob on OffscreenCanvas; fall back to convertToBlob if needed.
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: fmt, quality });
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('encode failed'))),
      fmt,
      quality,
    ),
  );
}
