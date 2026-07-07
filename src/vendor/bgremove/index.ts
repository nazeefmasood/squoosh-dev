/**
 * Background remover — ONNX Runtime Web + RMBG-1.4.
 *
 * Runs entirely in the browser. The model (~176 MB fp32) and the ORT wasm
 * runtime are self-hosted as same-origin assets (COEP blocks CDN fetches).
 * Inference prefers WebGPU (fast) and falls back to multi-threaded WASM,
 * which works because the app is cross-origin isolated (SharedArrayBuffer
 * available via COOP/COEP).
 *
 * RMBG-1.4 preprocessing: resize to 1024×1024, RGB, ImageNet-normalize,
 * NCHW float32. Output is a [1,1,1024,1024] mask → sigmoid, resized back to
 * the original resolution and applied as the alpha channel.
 */
import * as ort from 'onnxruntime-web';

// Self-hosted assets (emitted same-origin by the url: rollup plugin).
import modelUrl from 'url:client/lazy-app/BgRemove/models/rmbg-1.4.onnx';
import wasmCoreUrl from 'url:onnxruntime-web/dist/ort-wasm-simd-threaded.wasm';
import wasmJsepUrl from 'url:onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm';

const MODEL_SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let usingGpu = false;

/** Lazy-load + cache the model. Returns once; reused for subsequent images. */
export function preloadModel(): Promise<ort.InferenceSession> {
  if (sessionPromise) return sessionPromise;

  // Point ORT at the self-hosted wasm files (map by filename).
  (ort.env as any).wasm.wasmPaths = {
    'ort-wasm-simd-threaded.wasm': wasmCoreUrl,
    'ort-wasm-simd-threaded.jsep.wasm': wasmJsepUrl,
  };
  ort.env.wasm.numThreads = navigator.hardwareConcurrency
    ? Math.min(4, navigator.hardwareConcurrency)
    : 1;

  sessionPromise = (async () => {
    // Prefer WebGPU when available; fall back to WASM threads.
    const providers: string[] = [];
    if (typeof navigator !== 'undefined' && (navigator as any).gpu) {
      providers.push('webgpu');
    }
    providers.push('wasm');
    try {
      const s = await ort.InferenceSession.create(modelUrl, {
        executionProviders: providers,
        graphOptimizationLevel: 'all',
      });
      usingGpu = providers[0] === 'webgpu';
      return s;
    } catch (e) {
      // Retry with WASM only if WebGPU path failed.
      const s = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      usingGpu = false;
      return s;
    }
  })();
  return sessionPromise;
}

export function isUsingGpu(): boolean {
  return usingGpu;
}

/** Resize a source ImageData to w×h using a canvas (high quality). */
function resizeImageData(src: ImageData, w: number, h: number): ImageData {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.putImageData(src, 0, 0);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  (octx as any).imageSmoothingQuality = 'high';
  octx.drawImage(c, 0, 0, w, h);
  return octx.getImageData(0, 0, w, h);
}

/** Build the [1,3,1024,1024] NCHW normalized input tensor. */
function preprocess(img: ImageData): Float32Array {
  const { data, width, height } = img;
  const out = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  const plane = MODEL_SIZE * MODEL_SIZE;
  for (let y = 0; y < MODEL_SIZE; y++) {
    for (let x = 0; x < MODEL_SIZE; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * MODEL_SIZE + x;
      out[dstIdx] = (data[srcIdx] / 255 - MEAN[0]) / STD[0]; // R
      out[plane + dstIdx] = (data[srcIdx + 1] / 255 - MEAN[1]) / STD[1]; // G
      out[2 * plane + dstIdx] = (data[srcIdx + 2] / 255 - MEAN[2]) / STD[2]; // B
    }
  }
  return out;
}

/** Sigmoid + resize the model's [1,1,H,W] mask back to targetW×targetH. */
function maskToAlpha(
  raw: Float32Array,
  maskW: number,
  maskH: number,
  targetW: number,
  targetH: number,
): Uint8ClampedArray {
  // Sigmoid into a grayscale ImageData, then canvas-resize to target.
  const small = new ImageData(maskW, maskH);
  for (let i = 0; i < maskW * maskH; i++) {
    const v = 1 / (1 + Math.exp(-raw[i])); // sigmoid
    const a = Math.round(v * 255);
    small.data[i * 4] = a;
    small.data[i * 4 + 1] = a;
    small.data[i * 4 + 2] = a;
    small.data[i * 4 + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = maskW;
  c.height = maskH;
  c.getContext('2d')!.putImageData(small, 0, 0);
  const out = document.createElement('canvas');
  out.width = targetW;
  out.height = targetH;
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  (octx as any).imageSmoothingQuality = 'high';
  octx.drawImage(c, 0, 0, targetW, targetH);
  const resized = octx.getImageData(0, 0, targetW, targetH).data;
  const alpha = new Uint8ClampedArray(targetW * targetH);
  for (let i = 0; i < alpha.length; i++) alpha[i] = resized[i * 4];
  return alpha;
}

export interface RemoveBgResult {
  /** RGBA ImageData with the background made transparent. */
  imageData: ImageData;
  width: number;
  height: number;
}

/**
 * Remove the background from an image. Loads the model on first call (a few
 * seconds), then runs segmentation and composites the mask as alpha at the
 * original resolution.
 */
export async function removeBackground(
  src: ImageData,
): Promise<RemoveBgResult> {
  const origW = src.width;
  const origH = src.height;

  const session = await preloadModel();
  const resized = resizeImageData(src, MODEL_SIZE, MODEL_SIZE);
  const tensor = new ort.Tensor('float32', preprocess(resized), [
    1,
    3,
    MODEL_SIZE,
    MODEL_SIZE,
  ]);

  const inputName = session.inputNames[0];
  const results = await session.run({ [inputName]: tensor });
  const output = results[session.outputNames[0]];
  const raw = output.data as Float32Array;
  // Output dims: [1, 1, maskH, maskW]
  const dims = output.dims;
  const maskH = dims[dims.length - 2] || MODEL_SIZE;
  const maskW = dims[dims.length - 1] || MODEL_SIZE;

  const alpha = maskToAlpha(raw, maskW, maskH, origW, origH);

  // Composite alpha onto the original RGBA pixels.
  const out = new ImageData(origW, origH);
  for (let i = 0; i < origW * origH; i++) {
    out.data[i * 4] = src.data[i * 4];
    out.data[i * 4 + 1] = src.data[i * 4 + 1];
    out.data[i * 4 + 2] = src.data[i * 4 + 2];
    out.data[i * 4 + 3] = alpha[i];
  }
  return { imageData: out, width: origW, height: origH };
}
