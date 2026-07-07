/**
 * Background-removal worker — runs ORT inference off the main thread so the
 * page never freezes during the (heavy) RMBG-1.4 forward pass.
 *
 * Protocol (plain postMessage):
 *   main -> worker: { type: 'init' }
 *     worker -> main: { type: 'progress', loaded, total } (model download)
 *     worker -> main: { type: 'ready' } | { type: 'init-error', error }
 *   main -> worker: { type: 'process', id, imageData }
 *     worker -> main: { type: 'result', id, width, height, rgba }
 *                    | { type: 'process-error', id, error }
 */
import * as ort from 'onnxruntime-web';

import modelUrl from 'url:client/lazy-app/BgRemove/models/rmbg-1.4.onnx';
import wasmCoreUrl from 'url:vendor/bgremove/wasm/ort-wasm-simd-threaded.wasm';
import wasmJsepUrl from 'url:vendor/bgremove/wasm/ort-wasm-simd-threaded.jsep.wasm';
import wasmAsyncifyUrl from 'url:vendor/bgremove/wasm/ort-wasm-simd-threaded.asyncify.wasm';
import wasmJspiUrl from 'url:vendor/bgremove/wasm/ort-wasm-simd-threaded.jspi.wasm';

const MODEL_SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// This file is bundled as a Web Worker but type-checked under the client
// (DOM) lib, which lacks worker-only globals. Declare the few we use.
declare const OffscreenCanvas: any;

let session: ort.InferenceSession | null = null;

function post(msg: any) {
  (self as any).postMessage(msg);
}

async function fetchWithProgress(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('Content-Length') || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      post({ type: 'progress', loaded: received, total });
    }
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function resizeImageData(src: ImageData, w: number, h: number): ImageData {
  const c = new OffscreenCanvas(src.width, src.height);
  c.getContext('2d')!.putImageData(src, 0, 0);
  const out = new OffscreenCanvas(w, h);
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  (octx as any).imageSmoothingQuality = 'high';
  octx.drawImage(c, 0, 0, w, h);
  return octx.getImageData(0, 0, w, h);
}

function preprocess(img: ImageData): Float32Array {
  const { data, width } = img;
  const out = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  const plane = MODEL_SIZE * MODEL_SIZE;
  for (let y = 0; y < MODEL_SIZE; y++) {
    for (let x = 0; x < MODEL_SIZE; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * MODEL_SIZE + x;
      out[dstIdx] = (data[srcIdx] / 255 - MEAN[0]) / STD[0];
      out[plane + dstIdx] = (data[srcIdx + 1] / 255 - MEAN[1]) / STD[1];
      out[2 * plane + dstIdx] = (data[srcIdx + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}

function maskToAlpha(
  raw: Float32Array,
  maskW: number,
  maskH: number,
  targetW: number,
  targetH: number,
): Uint8ClampedArray {
  // RMBG-1.4's output is already a probability-like map, NOT logits — so we
  // min-max normalize it (the model's documented postprocessing), never a
  // second sigmoid. A sigmoid here would compress the range and leave the
  // background semi-opaque instead of transparent.
  let min = Infinity;
  let max = -Infinity;
  const n = maskW * maskH;
  for (let i = 0; i < n; i++) {
    const v = raw[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const small = new ImageData(maskW, maskH);
  for (let i = 0; i < n; i++) {
    const a = Math.round(((raw[i] - min) / range) * 255);
    small.data[i * 4] = a;
    small.data[i * 4 + 1] = a;
    small.data[i * 4 + 2] = a;
    small.data[i * 4 + 3] = 255;
  }
  const c = new OffscreenCanvas(maskW, maskH);
  c.getContext('2d')!.putImageData(small, 0, 0);
  const out = new OffscreenCanvas(targetW, targetH);
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  (octx as any).imageSmoothingQuality = 'high';
  octx.drawImage(c, 0, 0, targetW, targetH);
  const resized = octx.getImageData(0, 0, targetW, targetH).data;
  const alpha = new Uint8ClampedArray(targetW * targetH);
  for (let i = 0; i < alpha.length; i++) alpha[i] = resized[i * 4];
  return alpha;
}

async function init() {
  (ort.env as any).wasm.wasmPaths = {
    'ort-wasm-simd-threaded.wasm': wasmCoreUrl,
    'ort-wasm-simd-threaded.jsep.wasm': wasmJsepUrl,
    'ort-wasm-simd-threaded.asyncify.wasm': wasmAsyncifyUrl,
    'ort-wasm-simd-threaded.jspi.wasm': wasmJspiUrl,
  };
  // Multi-threaded WASM is safe here — we're already inside a dedicated
  // worker, so the deadlock that afflicted main-thread threading doesn't
  // apply. Threads cut a 1024² U-Net pass from ~50s down to a few seconds.
  ort.env.wasm.numThreads = Math.max(
    1,
    Math.min(4, (self.navigator && self.navigator.hardwareConcurrency) || 4),
  );
  ort.env.wasm.proxy = false;

  const modelBytes = await fetchWithProgress(modelUrl);
  try {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'basic',
    });
  } catch {
    session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'disabled',
    });
  }
  post({ type: 'ready' });
}

function process(imageData: ImageData) {
  if (!session) throw new Error('Not ready');
  const origW = imageData.width;
  const origH = imageData.height;
  const resized = resizeImageData(imageData, MODEL_SIZE, MODEL_SIZE);
  const tensor = new ort.Tensor('float32', preprocess(resized), [
    1,
    3,
    MODEL_SIZE,
    MODEL_SIZE,
  ]);
  const inputName = session!.inputNames[0];
  return session!.run({ [inputName]: tensor }).then((results) => {
    const output = results[session!.outputNames[0]];
    const raw = output.data as Float32Array;
    const dims = output.dims;
    const maskH = dims[dims.length - 2] || MODEL_SIZE;
    const maskW = dims[dims.length - 1] || MODEL_SIZE;
    const alpha = maskToAlpha(raw, maskW, maskH, origW, origH);
    const rgba = new Uint8ClampedArray(origW * origH * 4);
    for (let i = 0; i < origW * origH; i++) {
      rgba[i * 4] = imageData.data[i * 4];
      rgba[i * 4 + 1] = imageData.data[i * 4 + 1];
      rgba[i * 4 + 2] = imageData.data[i * 4 + 2];
      rgba[i * 4 + 3] = alpha[i];
    }
    return { width: origW, height: origH, rgba };
  });
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await init();
    } else if (msg.type === 'process') {
      const result = await process(msg.imageData);
      post({ type: 'result', id: msg.id, ...result });
    }
  } catch (err: any) {
    post({
      type: msg.type === 'init' ? 'init-error' : 'process-error',
      id: msg.id,
      error: String(err?.message || err),
    });
  }
};
