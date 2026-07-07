import { h, Component, Fragment } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import logoIcon from 'url:static-build/assets/brand/smoosh-icon.png';
import WorkerBridge from '../worker-bridge';
import { decodeImage, compressImage } from '../pipeline';
import { encoderMap, EncoderType, EncoderState } from '../feature-meta';
import { removeWatermarkFromImage } from 'vendor/gwm';
import { readMeta, stripMeta, MetaResult } from 'vendor/exif';
import { removeBackground, preloadModel } from 'vendor/bgremove';
import type SnackBarElement from 'shared/custom-els/snack-bar';

export type ToolMode =
  | 'compress'
  | 'watermark'
  | 'edit'
  | 'metadata'
  | 'favicon'
  | 'bgremove';

interface Props {
  files: File[];
  mode: ToolMode;
  onModeChange: (mode: ToolMode) => void;
  onBack: () => void;
  showSnack: SnackBarElement['showSnackbar'];
}

const ALL_FORMATS: EncoderType[] = [
  'mozJPEG',
  'webP',
  'avif',
  'oxiPNG',
  'browserPNG',
];
const SINGLE_FORMATS: EncoderType[] = [...ALL_FORMATS];

type SubMode = 'single' | 'all';
type Status = 'pending' | 'processing' | 'done' | 'error';

interface Result {
  key: string; // encoder type, or 'cleaned'
  label: string;
  status: Status;
  file?: File;
  url?: string;
  applied?: boolean;
  error?: string;
  lossless?: boolean;
}

interface Item {
  id: string;
  file: File;
  previewUrl: string;
  results: Result[];
  /** Detected metadata (metadata tool). */
  meta?: MetaResult;
}

interface State {
  items: Item[];
  subMode: SubMode;
  encoderType: EncoderType;
  quality: number;
  processing: boolean;
  processedCount: number;
  modalId?: string;
  comparePct: number;
  /** Background-remover model download progress (first load only). */
  modelDl?: { loaded: number; total: number };
  /** True once the model is downloaded and ORT is building the session. */
  modelPreparing?: boolean;
}

/** Files above this size get a heads-up that processing may be slow. */
const LARGE_FILE_BYTES = 40 * 1024 * 1024;

let idCounter = 0;
const nextId = () => `t-${idCounter++}`;

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Encoders that expose a 0–100 `quality` option we can drive from the UI. */
function encoderHasQuality(type: EncoderType): boolean {
  return 'quality' in ((encoderMap[type].meta as any).defaultOptions ?? {});
}

/**
 * Build an SEO-friendly, filesystem-safe filename: lowercase, spaces and
 * any non-alphanumerics (including emoji) collapsed to single hyphens,
 * diacritics stripped, extension preserved and lowercased.
 */
function seoName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext =
    dot > 0
      ? filename
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      : '';
  const slug =
    base
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-') || 'image';
  return ext ? `${slug}.${ext}` : slug;
}

function encoderStateFor(type: EncoderType, quality?: number): EncoderState {
  const options = { ...(encoderMap[type].meta as any).defaultOptions };
  if (quality != null && 'quality' in options) options.quality = quality;
  return { type, options } as EncoderState;
}

/**
 * Pick an encoder that preserves the source file's format so tools like the
 * metadata stripper don't silently change formats. Unknown types → PNG.
 */
function encoderForFile(file: File): EncoderType {
  const type = file.type.toLowerCase();
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  if (type === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg')
    return 'mozJPEG';
  if (type === 'image/webp' || ext === 'webp') return 'webP';
  if (type === 'image/avif' || ext === 'avif') return 'avif';
  if (type === 'image/png' || ext === 'png') return 'oxiPNG';
  return 'browserPNG';
}

/** Human label for a result key. */
function labelForKey(key: string): string {
  if (key === 'cleaned') return 'Cleaned';
  if (key === 'stripped') return 'Stripped';
  if (key === 'cutout') return 'Cutout';
  return encoderMap[key as EncoderType].meta.label;
}

/** The done result with the smallest output file for an item, if any. */
function smallestResult(item: Item): Result | undefined {
  let best: Result | undefined;
  for (const r of item.results) {
    if (r.status !== 'done' || !r.file) continue;
    if (!best || r.file!.size < best.file!.size) best = r;
  }
  return best;
}

function newItem(file: File): Item {
  return {
    id: nextId(),
    file,
    previewUrl: URL.createObjectURL(file),
    results: [],
  };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

function canvasToPngFile(canvas: any, name: string): Promise<File> {
  const out = name.replace(/.[^.]*$/, '') + '-clean.png';
  if (typeof canvas.convertToBlob === 'function') {
    return canvas
      .convertToBlob({ type: 'image/png' })
      .then((blob: Blob) => new File([blob], out, { type: 'image/png' }));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob: Blob | null) => {
      if (!blob) {
        reject(new Error('encode'));
        return;
      }
      resolve(new File([blob], out, { type: 'image/png' }));
    }, 'image/png');
  });
}

/** Result "targets" for the current mode. */
function targetsFor(
  mode: ToolMode,
  subMode: SubMode,
  encoderType: EncoderType,
): Result[] {
  if (mode === 'watermark') {
    return [{ key: 'cleaned', label: 'Cleaned', status: 'pending' }];
  }
  if (mode === 'metadata') {
    return [{ key: 'stripped', label: 'Stripped', status: 'pending' }];
  }
  if (mode === 'bgremove') {
    return [{ key: 'cutout', label: 'Cutout', status: 'pending' }];
  }
  const formats = subMode === 'all' ? ALL_FORMATS : [encoderType];
  return formats.map((f) => ({
    key: f,
    label: encoderMap[f].meta.label,
    status: 'pending',
  }));
}

export default class Tool extends Component<Props, State> {
  state: State = {
    items: this.props.files.map(newItem),
    subMode: 'single',
    encoderType: 'mozJPEG',
    quality: 75,
    processing: false,
    processedCount: 0,
    comparePct: 50,
  };

  private workerBridge = new WorkerBridge();
  private abortController?: AbortController;
  private fileInput?: HTMLInputElement;
  private modelWarmed = false;

  componentDidUpdate(prevProps: Props) {
    // Clearing results when the tool mode switches keeps the UI consistent.
    if (prevProps.mode !== this.props.mode && this.state.items.length) {
      for (const it of this.state.items)
        for (const r of it.results) if (r.url) URL.revokeObjectURL(r.url);
      this.setState((prev) => ({
        items: prev.items.map((i) => ({ ...i, results: [] })),
      }));
    }
  }

  componentWillUnmount() {
    this.abortController?.abort();
    for (const item of this.state.items) {
      URL.revokeObjectURL(item.previewUrl);
      for (const r of item.results) if (r.url) URL.revokeObjectURL(r.url);
    }
  }

  private onEncoderChange = (e: Event) =>
    this.setState({
      encoderType: (e.target as HTMLSelectElement).value as EncoderType,
    });
  private onSubModeChange = (sm: SubMode) => {
    if (this.state.processing) return;
    this.setState({ subMode: sm });
  };
  private onQualityChange = (e: Event) =>
    this.setState({ quality: +(e.target as HTMLInputElement).value });

  private addFiles = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    this.setState((prev) => ({ items: [...prev.items, ...imgs.map(newItem)] }));
  };
  private onAddFilesClick = () => this.fileInput?.click();
  private onDrop = (e: DragEvent) => {
    e.preventDefault();
    this.addFiles(Array.from(e.dataTransfer?.files ?? []));
  };
  private onDragOver = (e: DragEvent) => e.preventDefault();
  private onDragLeave = (e: DragEvent) => e.preventDefault();
  private onFileChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    this.addFiles(files);
  };

  private removeItem = (id: string) => {
    this.setState((prev) => {
      const item = prev.items.find((i) => i.id === id);
      if (item) {
        URL.revokeObjectURL(item.previewUrl);
        for (const r of item.results) if (r.url) URL.revokeObjectURL(r.url);
      }
      return { items: prev.items.filter((i) => i.id !== id) };
    });
  };
  private clearAll = () => {
    if (this.state.processing) return;
    for (const item of this.state.items) {
      URL.revokeObjectURL(item.previewUrl);
      for (const r of item.results) if (r.url) URL.revokeObjectURL(r.url);
    }
    this.setState({ items: [] });
  };

  private putResult = (itemId: string, key: string, patch: Partial<Result>) => {
    this.setState((prev) => ({
      items: prev.items.map((i) =>
        i.id === itemId
          ? {
              ...i,
              results: i.results.some((r) => r.key === key)
                ? i.results.map((r) => (r.key === key ? { ...r, ...patch } : r))
                : [
                    ...i.results,
                    {
                      key,
                      label: labelForKey(key),
                      status: 'pending',
                      ...patch,
                    },
                  ],
            }
          : i,
      ),
    }));
  };

  private putMeta = (itemId: string, meta: MetaResult) => {
    this.setState((prev) => ({
      items: prev.items.map((i) => (i.id === itemId ? { ...i, meta } : i)),
    }));
  };

  private processAll = async () => {
    if (this.state.processing) return;
    const { mode, subMode, encoderType } =
      this.props.mode === 'watermark'
        ? {
            mode: this.props.mode,
            subMode: 'single' as SubMode,
            encoderType: 'mozJPEG' as EncoderType,
          }
        : {
            mode: this.props.mode,
            subMode: this.state.subMode,
            encoderType: this.state.encoderType,
          };
    const targets = targetsFor(this.props.mode, subMode, encoderType);

    if (this.state.items.some((i) => i.file.size > LARGE_FILE_BYTES)) {
      this.props.showSnack(
        'Large images detected — processing may take a moment.',
      );
    }

    this.abortController = new AbortController();
    this.setState({ processing: true, processedCount: 0 });

    try {
      for (const item of this.state.items) {
        if (this.abortController.signal.aborted) break;
        const signal = this.abortController.signal;

        if (this.props.mode === 'watermark') {
          this.putResult(item.id, 'cleaned', {
            status: 'processing',
            error: undefined,
          });
          try {
            const img = await loadImage(item.file);
            const { canvas, meta } = await removeWatermarkFromImage(img);
            const resultFile = await canvasToPngFile(
              canvas,
              seoName(item.file.name),
            );
            const url = URL.createObjectURL(resultFile);
            this.putResult(item.id, 'cleaned', {
              status: 'done',
              file: resultFile,
              url,
              applied: !!(meta && (meta as any).applied),
            });
          } catch {
            this.putResult(item.id, 'cleaned', {
              status: 'error',
              error: 'Failed',
            });
          }
          this.setState((p) => ({ processedCount: p.processedCount + 1 }));
          continue;
        }

        if (this.props.mode === 'metadata') {
          // Read detected metadata first (shown as the "before"), then strip.
          let detected: MetaResult;
          try {
            detected = await readMeta(item.file);
          } catch {
            detected = {
              format: 'other',
              fields: [],
              hasGps: false,
              metaBytes: 0,
            };
          }
          this.putMeta(item.id, detected);
          this.putResult(item.id, 'stripped', {
            status: 'processing',
            error: undefined,
          });
          try {
            let resultFile: File;
            let lossless: boolean;
            const stripped = await stripMeta(item.file);
            if (stripped) {
              // Lossless byte rewrite (jpeg/png).
              resultFile = stripped.file;
              lossless = stripped.lossless;
            } else {
              // Other formats: decode → re-encode in source format (also strips).
              const data = await decodeImage(
                signal,
                item.file,
                this.workerBridge,
              );
              resultFile = await compressImage(
                signal,
                data,
                encoderStateFor(encoderForFile(item.file)),
                seoName(item.file.name),
                this.workerBridge,
              );
              lossless = false;
            }
            const url = URL.createObjectURL(resultFile);
            this.putResult(item.id, 'stripped', {
              status: 'done',
              file: resultFile,
              url,
              lossless,
            });
          } catch {
            this.putResult(item.id, 'stripped', {
              status: 'error',
              error: 'Failed',
            });
          }
          this.setState((p) => ({ processedCount: p.processedCount + 1 }));
          continue;
        }

        if (this.props.mode === 'bgremove') {
          // Warm the model once (first image pays the load cost).
          if (!this.modelWarmed) {
            this.putResult(item.id, 'cutout', {
              status: 'processing',
              error: undefined,
            });
            try {
              await preloadModel((loaded, total) => {
                if (total > 0 && loaded >= total) {
                  // Download done — ORT is now building the session.
                  this.setState({ modelDl: undefined, modelPreparing: true });
                } else {
                  this.setState({ modelDl: { loaded, total } });
                }
              });
              this.modelWarmed = true;
              this.setState({ modelDl: undefined, modelPreparing: false });
            } catch {
              this.putResult(item.id, 'cutout', {
                status: 'error',
                error: 'Model failed',
              });
              this.setState((p) => ({ processedCount: p.processedCount + 1 }));
              continue;
            }
          } else {
            this.putResult(item.id, 'cutout', {
              status: 'processing',
              error: undefined,
            });
          }
          try {
            const src = await decodeImage(signal, item.file, this.workerBridge);
            const { imageData } = await removeBackground(src);
            // Encode cutout as PNG (preserves transparency).
            const enc = encoderMap['oxiPNG'];
            const resultFile = await compressImage(
              signal,
              imageData,
              {
                type: 'oxiPNG',
                options: { ...(enc.meta as any).defaultOptions },
              } as EncoderState,
              seoName(item.file.name).replace(/\.[^.]+$/, '') + '-cutout.png',
              this.workerBridge,
            );
            const url = URL.createObjectURL(resultFile);
            this.putResult(item.id, 'cutout', {
              status: 'done',
              file: resultFile,
              url,
            });
          } catch (err) {
            const msg =
              err instanceof Error && err.name === 'AbortError'
                ? 'Cancelled'
                : 'Failed';
            this.putResult(item.id, 'cutout', { status: 'error', error: msg });
          }
          this.setState((p) => ({ processedCount: p.processedCount + 1 }));
          continue;
        }

        // compress: decode once, encode each format
        let imageData: ImageData;
        try {
          imageData = await decodeImage(signal, item.file, this.workerBridge);
        } catch {
          for (const t of targets)
            this.putResult(item.id, t.key, {
              status: 'error',
              error: 'Decode',
            });
          continue;
        }
        for (const t of targets) {
          if (this.abortController.signal.aborted) break;
          this.putResult(item.id, t.key, {
            status: 'processing',
            error: undefined,
          });
          try {
            const result = await compressImage(
              signal,
              imageData,
              encoderStateFor(t.key as EncoderType, this.state.quality),
              seoName(item.file.name),
              this.workerBridge,
            );
            const url = URL.createObjectURL(result);
            this.putResult(item.id, t.key, {
              status: 'done',
              file: result,
              url,
            });
          } catch (err) {
            const msg =
              err instanceof Error && err.name === 'AbortError'
                ? 'Cancelled'
                : 'Failed';
            this.putResult(item.id, t.key, { status: 'error', error: msg });
          }
        }
        this.setState((p) => ({ processedCount: p.processedCount + 1 }));
      }
    } finally {
      this.setState({ processing: false });
    }
  };

  private cancel = () => {
    this.abortController?.abort();
    this.setState({ processing: false });
  };
  private triggerDownload(r: Result) {
    if (!r.url || !r.file) return;
    const a = document.createElement('a');
    a.href = r.url;
    a.download = r.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  private downloadAll = () => {
    for (const item of this.state.items)
      for (const r of item.results)
        if (r.status === 'done') this.triggerDownload(r);
  };

  private openModal = (id: string) =>
    this.setState({ modalId: id, comparePct: 50 });
  private closeModal = () => this.setState({ modalId: undefined });
  private onCompareChange = (e: Event) =>
    this.setState({ comparePct: +(e.target as HTMLInputElement).value });

  render(
    { onBack, mode, onModeChange }: Props,
    {
      items,
      subMode,
      encoderType,
      quality,
      processing,
      processedCount,
      modalId,
      comparePct,
      modelDl,
      modelPreparing,
    }: State,
  ) {
    const isWatermark = mode === 'watermark';
    const isMetadata = mode === 'metadata';
    const isBgRemove = mode === 'bgremove';
    const doneCount = items.reduce(
      (s, i) => s + i.results.filter((r) => r.status === 'done').length,
      0,
    );
    const totalResult = items.reduce(
      (s, i) =>
        s +
        i.results
          .filter((r) => r.status === 'done')
          .reduce((x, r) => x + (r.file?.size ?? 0), 0),
      0,
    );
    const totalOriginal = items.reduce((s, i) => s + i.file.size, 0);
    const saved =
      totalResult > 0 ? Math.round((1 - totalResult / totalOriginal) * 100) : 0;
    const targets = targetsFor(mode, subMode, encoderType);

    return (
      <div class={style.page}>
        <input
          ref={(el: HTMLInputElement | null) => {
            this.fileInput = el ?? undefined;
          }}
          class={style.hide}
          type="file"
          multiple
          accept="image/*"
          onChange={this.onFileChange}
        />

        <nav class={style.nav}>
          <a class={style.wordmark} href="/" onClick={onBack}>
            <img
              class={style.markImg}
              src={logoIcon}
              alt=""
              width="34"
              height="34"
            />
            <span class={style.wordmarkText}>Smoosh</span>
          </a>
          <div class={style.tabs} role="tablist" aria-label="Tool">
            <button
              class={style.tab}
              role="tab"
              aria-selected={false}
              onClick={() => onModeChange('edit')}
            >
              Edit
            </button>
            <button
              class={`${style.tab}${
                mode === 'compress' ? ' ' + style.tabActive : ''
              }`}
              role="tab"
              aria-selected={mode === 'compress'}
              onClick={() => onModeChange('compress')}
            >
              Compress
            </button>
            <button
              class={`${style.tab}${
                mode === 'watermark' ? ' ' + style.tabActive : ''
              }`}
              role="tab"
              aria-selected={mode === 'watermark'}
              onClick={() => onModeChange('watermark')}
            >
              Watermark remover
            </button>
            <button
              class={`${style.tab}${
                mode === 'metadata' ? ' ' + style.tabActive : ''
              }`}
              role="tab"
              aria-selected={mode === 'metadata'}
              onClick={() => onModeChange('metadata')}
            >
              EXIF strip
            </button>
            <button
              class={`${style.tab}${
                mode === 'bgremove' ? ' ' + style.tabActive : ''
              }`}
              role="tab"
              aria-selected={mode === 'bgremove'}
              onClick={() => onModeChange('bgremove')}
            >
              Background remover
            </button>
            <button
              class={style.navLink}
              onClick={onBack}
              aria-label="Back to home"
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M15 6l-6 6 6 6"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
        </nav>

        <section class={style.hero}>
          <h1>
            {isWatermark ? (
              <Fragment>
                Remove <span class={style.accent}>Gemini watermarks</span>,
                right in your browser.
              </Fragment>
            ) : isMetadata ? (
              <Fragment>
                Strip <span class={style.accent}>EXIF & metadata</span>, keep
                every pixel.
              </Fragment>
            ) : isBgRemove ? (
              <Fragment>
                Remove <span class={style.accent}>backgrounds</span>, right in
                your browser.
              </Fragment>
            ) : (
              <Fragment>
                Compress into <span class={style.accent}>any format</span>, all
                at once.
              </Fragment>
            )}
          </h1>
          <p class={style.heroSub}>
            {isWatermark
              ? 'Drop your Gemini-generated images and Smoosh cleanly removes the watermark using reverse alpha blending — mathematically exact, fully private, batch supported.'
              : isMetadata
              ? 'Drop images and Smoosh removes EXIF, GPS, camera and timestamp data — losslessly for JPEG & PNG, so quality is untouched. See exactly what was removed. Fully private, batch supported.'
              : isBgRemove
              ? 'Drop images and Smoosh removes the background using the RMBG-1.4 model running locally via WebAssembly. The model (~176 MB) downloads once on first use, then results are instant. Nothing is uploaded.'
              : 'Drop images and export each to a single format — or to all formats at once. Everything runs locally in your browser.'}
          </p>

          {items.length > 0 && (
            <div class={style.controls}>
              {mode === 'compress' && (
                <div class={style.modeToggle}>
                  <button
                    class={`${style.modeTab}${
                      subMode === 'single' ? ' ' + style.modeTabActive : ''
                    }`}
                    onClick={() => this.onSubModeChange('single')}
                  >
                    One format
                  </button>
                  <button
                    class={`${style.modeTab}${
                      subMode === 'all' ? ' ' + style.modeTabActive : ''
                    }`}
                    onClick={() => this.onSubModeChange('all')}
                  >
                    All formats
                  </button>
                </div>
              )}
              {mode === 'compress' && subMode === 'single' && (
                <label class={style.encoderField}>
                  <span>Format</span>
                  <select
                    value={encoderType}
                    onChange={this.onEncoderChange}
                    disabled={processing}
                  >
                    {SINGLE_FORMATS.map((t) => (
                      <option value={t}>{encoderMap[t].meta.label}</option>
                    ))}
                  </select>
                </label>
              )}
              {mode === 'compress' &&
                (subMode === 'all' || encoderHasQuality(encoderType)) && (
                  <label class={style.qualityField}>
                    <span>Quality</span>
                    <input
                      class={style.qualityRange}
                      type="range"
                      min="0"
                      max="100"
                      value={quality}
                      onInput={this.onQualityChange}
                      disabled={processing}
                      aria-label="Quality"
                    />
                    <span class={style.qualityVal}>{quality}</span>
                  </label>
                )}
              <div class={style.spacer} />
              <button
                class={style.btnAdd}
                onClick={this.onAddFilesClick}
                aria-label="Add images"
                title="Add images"
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M12 5v14M5 12h14"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              {items.length > 0 && !processing && (
                <button class={style.btnGhost} onClick={this.clearAll}>
                  Clear all
                </button>
              )}
              {processing ? (
                <Fragment>
                  {modelDl ? (
                    <span class={style.modelDl}>
                      <span class={style.modelDlLabel}>
                        Downloading model{' '}
                        {modelDl.total
                          ? `${Math.min(
                              100,
                              Math.round(
                                (modelDl.loaded / modelDl.total) * 100,
                              ),
                            )}%`
                          : `${prettyBytes(modelDl.loaded)}`}
                      </span>
                      <span class={style.modelDlBar}>
                        <span
                          class={style.modelDlFill}
                          style={{
                            width: modelDl.total
                              ? `${Math.min(
                                  100,
                                  (modelDl.loaded / modelDl.total) * 100,
                                )}%`
                              : '0%',
                          }}
                        />
                      </span>
                    </span>
                  ) : modelPreparing ? (
                    <span class={style.progress}>
                      <span class={style.spinner} aria-hidden="true" />
                      Preparing model…
                    </span>
                  ) : (
                    <span class={style.progress}>
                      <span class={style.spinner} aria-hidden="true" />
                      Processing {Math.min(processedCount + 1, items.length)}/
                      {items.length}…
                    </span>
                  )}
                  <button class={style.btnGhost} onClick={this.cancel}>
                    Cancel
                  </button>
                </Fragment>
              ) : (
                <button class={style.btnPrimary} onClick={this.processAll}>
                  {isWatermark
                    ? `Remove watermarks (${items.length})`
                    : isMetadata
                    ? `Strip metadata (${items.length})`
                    : isBgRemove
                    ? `Remove backgrounds (${items.length})`
                    : subMode === 'all'
                    ? `Convert to all formats (${items.length})`
                    : `Process all (${items.length})`}
                </button>
              )}
            </div>
          )}
        </section>

        <section class={style.toolArea}>
          {items.length === 0 ? (
            <button
              class={style.dropzone}
              onClick={this.onAddFilesClick}
              onDrop={this.onDrop}
              onDragOver={this.onDragOver}
              onDragLeave={this.onDragLeave}
            >
              <div class={style.dropIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 16V4m0 0L8 8m4-4 4 4"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <path
                    d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </div>
              <div class={style.dropTitle}>
                {isWatermark
                  ? 'Drop Gemini-generated images'
                  : isMetadata
                  ? 'Drop images to scrub'
                  : isBgRemove
                  ? 'Drop images to cut out'
                  : 'Drop images to compress'}
              </div>
              <div class={style.dropHint}>
                or <span>browse files</span> · batch supported
              </div>
            </button>
          ) : (
            <div class={style.list}>
              {doneCount > 0 && !processing && (
                <div class={style.listHeader}>
                  <div class={style.listHeaderInfo}>
                    {totalResult > 0 && !isWatermark ? (
                      <Fragment>
                        <span>
                          Total: {prettyBytes(totalOriginal)} →{' '}
                          <strong>{prettyBytes(totalResult)}</strong> across{' '}
                          {doneCount} file{doneCount === 1 ? '' : 's'}
                        </span>
                        {saved > 0 && (
                          <span class={style.savedBadge}>{saved}% smaller</span>
                        )}
                      </Fragment>
                    ) : (
                      <span>
                        {doneCount} result{doneCount === 1 ? '' : 's'} ready
                      </span>
                    )}
                  </div>
                  <button class={style.btnPrimary} onClick={this.downloadAll}>
                    Download all ({doneCount})
                  </button>
                </div>
              )}
              {items.map((item) => {
                const byKey = new Map(item.results.map((r) => [r.key, r]));
                const doneResults = item.results.filter(
                  (r) => r.status === 'done',
                );
                const best =
                  !isWatermark && doneResults.length > 1
                    ? smallestResult(item)
                    : undefined;
                return (
                  <div class={style.row}>
                    <img
                      class={style.thumb}
                      src={item.previewUrl}
                      alt={item.file.name}
                      onClick={() => this.openModal(item.id)}
                    />
                    <div class={style.rowMeta}>
                      <div class={style.rowName}>{item.file.name}</div>
                      <div class={style.rowSizes}>
                        {prettyBytes(item.file.size)}
                      </div>
                      <div class={style.formatGrid}>
                        {targets.map((t) => {
                          const r = byKey.get(t.key);
                          return (
                            <div
                              class={style.formatChip}
                              data-status={r?.status}
                              data-best={best && r && r.key === best.key}
                            >
                              <span class={style.formatLabel}>
                                {t.label}
                                {best && r && r.key === best.key && (
                                  <span class={style.bestTag}>smallest</span>
                                )}
                              </span>
                              {r?.status === 'processing' && (
                                <span class={style.formatMeta}>…</span>
                              )}
                              {r?.status === 'done' && r.file && (
                                <a
                                  class={style.formatDl}
                                  href={r.url}
                                  download={r.file.name}
                                  title={prettyBytes(r.file.size)}
                                >
                                  {prettyBytes(r.file.size)} ↓
                                </a>
                              )}
                              {r?.status === 'error' && (
                                <span class={style.formatMeta}>{r.error}</span>
                              )}
                              {!r && <span class={style.formatMeta}>—</span>}
                            </div>
                          );
                        })}
                      </div>
                      {isWatermark && item.results[0]?.status === 'done' && (
                        <div class={style.detected}>
                          {item.results[0].applied === false
                            ? 'No watermark detected — output unchanged'
                            : 'Watermark removed'}
                        </div>
                      )}
                      {isMetadata && item.meta && (
                        <div class={style.metaBox}>
                          {item.meta.fields.length === 0 ? (
                            <div class={style.metaEmpty}>
                              No metadata found — image is already clean
                              {item.meta.format === 'other'
                                ? ' (lossless strip not supported for this format; re-encode will be used)'
                                : ''}
                              .
                            </div>
                          ) : (
                            <Fragment>
                              <div class={style.metaHead}>
                                <span>
                                  Removed {item.meta.fields.length} field
                                  {item.meta.fields.length === 1 ? '' : 's'}
                                  {item.meta.metaBytes > 0
                                    ? ` · ${prettyBytes(item.meta.metaBytes)}`
                                    : ''}
                                </span>
                                {item.results[0]?.status === 'done' && (
                                  <span class={style.metaBadge}>
                                    {item.results[0].lossless
                                      ? 'Lossless'
                                      : 'Re-encoded'}
                                  </span>
                                )}
                                {item.meta.hasGps && (
                                  <span class={style.metaGps}>
                                    incl. GPS location
                                  </span>
                                )}
                              </div>
                              <dl class={style.metaList}>
                                {item.meta.fields.map((f) => (
                                  <div class={style.metaRow}>
                                    <dt class={style.metaKey}>{f.label}</dt>
                                    <dd class={style.metaVal}>{f.value}</dd>
                                  </div>
                                ))}
                              </dl>
                            </Fragment>
                          )}
                        </div>
                      )}
                    </div>
                    {!processing && (
                      <button
                        class={style.removeBtn}
                        onClick={() => this.removeItem(item.id)}
                        aria-label={`Remove ${item.file.name}`}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {modalId &&
          (() => {
            const item = items.find((i) => i.id === modalId);
            if (!item) return null;
            const done = item.results.filter((r) => r.url);
            return (
              <div
                class={style.modalOverlay}
                onClick={this.closeModal}
                role="dialog"
                aria-modal="true"
              >
                <div class={style.modal} onClick={(e) => e.stopPropagation()}>
                  <div class={style.modalHead}>
                    <span class={style.modalTitle}>{item.file.name}</span>
                    <button
                      class={style.modalClose}
                      onClick={this.closeModal}
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>
                  {isWatermark && done.length > 0 ? (
                    <div class={style.compare}>
                      <img
                        class={style.compareImg}
                        src={done[0]!.url}
                        alt="after"
                      />
                      <img
                        class={style.compareBefore}
                        src={item.previewUrl}
                        alt="before"
                        style={{
                          clipPath: `inset(0 ${100 - comparePct}% 0 0)`,
                        }}
                      />
                      <div
                        class={style.compareHandle}
                        style={{ left: `${comparePct}%` }}
                      >
                        <span class={style.compareBadge}>Before</span>
                      </div>
                      <span class={`${style.compareBadge} ${style.afterBadge}`}>
                        After
                      </span>
                      <input
                        class={style.compareRange}
                        type="range"
                        min="0"
                        max="100"
                        value={comparePct}
                        onInput={this.onCompareChange}
                        aria-label="Before / after slider"
                      />
                    </div>
                  ) : (
                    <div class={style.modalPreview}>
                      <img
                        src={(done[0] && done[0].url) || item.previewUrl}
                        alt={item.file.name}
                      />
                    </div>
                  )}
                  <div class={style.modalFormats}>
                    <a
                      class={style.modalOrig}
                      href={item.previewUrl}
                      download={seoName(item.file.name)}
                    >
                      Original · {prettyBytes(item.file.size)}
                    </a>
                    {done.map((r) => (
                      <a
                        class={style.formatDl}
                        href={r.url}
                        download={r.file?.name}
                      >
                        {r.label} · {r.file ? prettyBytes(r.file.size) : ''}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
      </div>
    );
  }
}
