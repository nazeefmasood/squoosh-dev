import { h, Component, Fragment } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import logoIcon from 'url:static-build/assets/brand/smoosh-icon.png';
import WorkerBridge from '../worker-bridge';
import { compressImage } from '../pipeline';
import { encoderMap, EncoderType, EncoderState } from '../feature-meta';
import type { ToolMode } from '../Tool';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import {
  CropRect,
  ResizeOpts,
  FULL_CROP,
  DEFAULT_RESIZE,
  CROP_ASPECTS,
  resolveAspectRatio,
  centeredRectForAspect,
  clampCrop,
  applyCropDrag,
  computeResizeTarget,
} from './geometry';

interface Props {
  files: File[];
  onModeChange: (mode: ToolMode) => void;
  onBack: () => void;
  showSnack: SnackBarElement['showSnackbar'];
}

type EditTool = 'crop' | 'resize' | 'rotate' | 'flip';
type Rotation = 0 | 90 | 180 | 270;
type ExportFormat = 'original' | 'jpeg' | 'png' | 'webp' | 'avif';

/** All transforms for a single image, composed rotate → flip → crop → resize. */
interface EditState {
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  crop: CropRect;
  resize: ResizeOpts;
}

interface EditItem {
  id: string;
  file: File;
  url: string;
}

interface State {
  items: EditItem[];
  activeId: string;
  tool: EditTool;
  edits: { [id: string]: EditState };
  natSizes: { [id: string]: { w: number; h: number } };
  cropAspect: string;
  format: ExportFormat;
  quality: number;
  exporting: boolean;
}

let idCounter = 0;
const nextId = () => `e-${idCounter++}`;

function defaultEdit(): EditState {
  return {
    rotate: 0,
    flipH: false,
    flipV: false,
    crop: { ...FULL_CROP },
    resize: { ...DEFAULT_RESIZE },
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

/** SEO-friendly, filesystem-safe filename with the extension swapped. */
function seoName(filename: string, ext: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const slug =
    base
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-') || 'image';
  return `${slug}.${ext}`;
}

/** Choose the encoder for the requested export format (or keep the source). */
function encoderForExport(file: File, format: ExportFormat): EncoderType {
  if (format === 'jpeg') return 'mozJPEG';
  if (format === 'png') return 'oxiPNG';
  if (format === 'webp') return 'webP';
  if (format === 'avif') return 'avif';
  // original
  const type = file.type.toLowerCase();
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  if (type === 'image/png' || ext === 'png') return 'oxiPNG';
  if (type === 'image/webp' || ext === 'webp') return 'webP';
  if (type === 'image/avif' || ext === 'avif') return 'avif';
  if (type === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg')
    return 'mozJPEG';
  return 'oxiPNG';
}

function encoderHasQuality(type: EncoderType): boolean {
  return 'quality' in ((encoderMap[type].meta as any).defaultOptions ?? {});
}

function encoderStateFor(type: EncoderType, quality: number): EncoderState {
  const options = { ...(encoderMap[type].meta as any).defaultOptions };
  if ('quality' in options) options.quality = quality;
  return { type, options } as EncoderState;
}

/** Oriented (post-rotation) dimensions of a natural w×h image. */
function orientedSize(w: number, h: number, rotate: Rotation) {
  const swap = rotate === 90 || rotate === 270;
  return { w: swap ? h : w, h: swap ? w : h };
}

/** Draw the image into a canvas with rotate + flip applied. */
function drawOriented(
  canvas: HTMLCanvasElement,
  img: CanvasImageSource,
  natW: number,
  natH: number,
  rotate: Rotation,
  flipH: boolean,
  flipV: boolean,
) {
  const { w: cw, h: ch } = orientedSize(natW, natH, rotate);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.imageSmoothingEnabled = true;
  (ctx as any).imageSmoothingQuality = 'high';
  ctx.drawImage(img, -natW / 2, -natH / 2, natW, natH);
  ctx.restore();
}

export default class Editor extends Component<Props, State> {
  private workerBridge = new WorkerBridge();
  private canvas?: HTMLCanvasElement;
  private wrap?: HTMLDivElement;
  private img?: HTMLImageElement;
  private drag?: { mode: string; px: number; py: number; start: CropRect };
  private fileInput?: HTMLInputElement;

  private onAddFilesClick = () => this.fileInput?.click();
  private onFileChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    this.addFiles(files);
  };
  private addFiles = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const fresh = imgs.map((file) => ({
      id: nextId(),
      file,
      url: URL.createObjectURL(file),
    }));
    this.setState((s) => {
      const edits = { ...s.edits };
      for (const it of fresh) edits[it.id] = defaultEdit();
      return {
        items: [...s.items, ...fresh],
        edits,
        activeId: s.activeId || fresh[0].id,
      };
    });
  };
  private onDrop = (e: DragEvent) => {
    e.preventDefault();
    this.addFiles(Array.from(e.dataTransfer?.files ?? []));
  };
  private onDragOver = (e: DragEvent) => e.preventDefault();
  private onDragLeave = (e: DragEvent) => e.preventDefault();

  constructor(props: Props) {
    super(props);
    const items = props.files.map((file) => ({
      id: nextId(),
      file,
      url: URL.createObjectURL(file),
    }));
    const edits: State['edits'] = {};
    for (const it of items) edits[it.id] = defaultEdit();
    this.state = {
      items,
      activeId: items[0]?.id ?? '',
      tool: 'crop',
      edits,
      natSizes: {},
      cropAspect: 'free',
      format: 'original',
      quality: 90,
      exporting: false,
    };
  }

  componentDidMount() {
    this.loadActive();
  }
  componentDidUpdate(_: Props, prev: State) {
    if (prev.activeId !== this.state.activeId) {
      this.loadActive();
    } else {
      this.redraw();
    }
  }
  componentWillUnmount() {
    for (const it of this.state.items) URL.revokeObjectURL(it.url);
    this.removeDragListeners();
  }

  private activeItem(): EditItem | undefined {
    return this.state.items.find((i) => i.id === this.state.activeId);
  }
  private activeEdit(): EditState {
    return this.state.edits[this.state.activeId] || defaultEdit();
  }
  private activeNat(): { w: number; h: number } {
    return this.state.natSizes[this.state.activeId] || { w: 0, h: 0 };
  }

  private patchEdit(patch: Partial<EditState>) {
    const id = this.state.activeId;
    this.setState((s) => ({
      edits: {
        ...s.edits,
        [id]: { ...(s.edits[id] || defaultEdit()), ...patch },
      },
    }));
  }

  private async loadActive() {
    const item = this.activeItem();
    if (!item) return;
    try {
      const img = await loadImage(item.url);
      this.img = img;
      this.setState(
        (s) => ({
          natSizes: {
            ...s.natSizes,
            [item.id]: { w: img.naturalWidth, h: img.naturalHeight },
          },
        }),
        () => this.redraw(),
      );
    } catch {
      this.props.showSnack("Couldn't load image");
    }
  }

  private redraw() {
    const c = this.canvas;
    const img = this.img;
    if (!c || !img) return;
    const e = this.activeEdit();
    drawOriented(
      c,
      img,
      img.naturalWidth,
      img.naturalHeight,
      e.rotate,
      e.flipH,
      e.flipV,
    );
  }

  // ---- Crop overlay dragging ----
  private ratioNormalized(): number | null {
    const { w, h } = this.orientedNat();
    const a = resolveAspectRatio(this.state.cropAspect, w, h);
    if (!a || !w) return null;
    return (a * h) / w;
  }
  private orientedNat(): { w: number; h: number } {
    const n = this.activeNat();
    return orientedSize(n.w, n.h, this.activeEdit().rotate);
  }
  private onCropDown = (e: PointerEvent, mode: string) => {
    e.preventDefault();
    e.stopPropagation();
    this.drag = {
      mode,
      px: e.clientX,
      py: e.clientY,
      start: this.activeEdit().crop,
    };
    window.addEventListener('pointermove', this.onCropMove);
    window.addEventListener('pointerup', this.onCropUp);
  };
  private onCropMove = (e: PointerEvent) => {
    if (!this.drag || !this.wrap) return;
    const b = this.wrap.getBoundingClientRect();
    const dx = (e.clientX - this.drag.px) / b.width;
    const dy = (e.clientY - this.drag.py) / b.height;
    const crop = clampCrop(
      applyCropDrag(
        this.drag.mode,
        this.drag.start,
        dx,
        dy,
        this.ratioNormalized(),
      ),
    );
    this.patchEdit({ crop });
  };
  private onCropUp = () => {
    this.drag = undefined;
    this.removeDragListeners();
  };
  private removeDragListeners() {
    window.removeEventListener('pointermove', this.onCropMove);
    window.removeEventListener('pointerup', this.onCropUp);
  }

  // ---- Tool actions ----
  private setTool = (tool: EditTool) => this.setState({ tool });
  private setAspect = (key: string) => {
    const { w, h } = this.orientedNat();
    const ratio = resolveAspectRatio(key, w, h);
    this.setState({ cropAspect: key });
    this.patchEdit({ crop: centeredRectForAspect(w, h, ratio) });
  };
  private resetCrop = () => {
    this.setState({ cropAspect: 'free' });
    this.patchEdit({ crop: { ...FULL_CROP } });
  };
  private rotateBy = (delta: 90 | -90) => {
    const e = this.activeEdit();
    const next = ((e.rotate + delta + 360) % 360) as Rotation;
    // Rotating swaps the oriented axes; reset crop to full to avoid a skewed box.
    this.patchEdit({ rotate: next, crop: { ...FULL_CROP } });
    this.setState({ cropAspect: 'free' });
  };
  private toggleFlipH = () =>
    this.patchEdit({ flipH: !this.activeEdit().flipH });
  private toggleFlipV = () =>
    this.patchEdit({ flipV: !this.activeEdit().flipV });

  private setResize = (patch: Partial<ResizeOpts>) =>
    this.patchEdit({ resize: { ...this.activeEdit().resize, ...patch } });

  /** Cropped (pre-resize) pixel size for the active image. */
  private croppedSize(): { w: number; h: number } {
    const { w, h } = this.orientedNat();
    const c = this.activeEdit().crop;
    return { w: Math.round(c.w * w), h: Math.round(c.h * h) };
  }

  // ---- Export ----
  private async renderFile(item: EditItem, e: EditState): Promise<File> {
    const img = await loadImage(item.url);
    // 1. oriented (rotate + flip)
    const oriented = document.createElement('canvas');
    drawOriented(
      oriented,
      img,
      img.naturalWidth,
      img.naturalHeight,
      e.rotate,
      e.flipH,
      e.flipV,
    );
    // 2. crop
    const ow = oriented.width;
    const oh = oriented.height;
    const cx = Math.round(e.crop.x * ow);
    const cy = Math.round(e.crop.y * oh);
    const cw = Math.max(1, Math.round(e.crop.w * ow));
    const ch = Math.max(1, Math.round(e.crop.h * oh));
    const cropped = document.createElement('canvas');
    cropped.width = cw;
    cropped.height = ch;
    const cctx = cropped.getContext('2d')!;
    cctx.drawImage(oriented, cx, cy, cw, ch, 0, 0, cw, ch);
    let imageData = cctx.getImageData(0, 0, cw, ch);
    // 3. resize (high-quality Lanczos via the WASM worker)
    const target = computeResizeTarget(cw, ch, e.resize);
    const signal = new AbortController().signal;
    if (target.width !== cw || target.height !== ch) {
      imageData = await this.workerBridge.resize(signal, imageData, {
        width: target.width,
        height: target.height,
        method: 'lanczos3',
        fitMethod: 'stretch',
        premultiply: true,
        linearRGB: true,
      });
    }
    // 4. encode
    const encType = encoderForExport(item.file, this.state.format);
    const enc = encoderMap[encType];
    return compressImage(
      signal,
      imageData,
      encoderStateFor(encType, this.state.quality),
      seoName(item.file.name, enc.meta.extension),
      this.workerBridge,
    );
  }

  private triggerDownload(file: File) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  private exportActive = async () => {
    const item = this.activeItem();
    if (!item || this.state.exporting) return;
    this.setState({ exporting: true });
    try {
      const file = await this.renderFile(item, this.activeEdit());
      this.triggerDownload(file);
    } catch {
      this.props.showSnack('Export failed');
    } finally {
      this.setState({ exporting: false });
    }
  };

  private exportAll = async () => {
    if (this.state.exporting) return;
    this.setState({ exporting: true });
    try {
      for (const item of this.state.items) {
        const e = this.state.edits[item.id] || defaultEdit();
        const file = await this.renderFile(item, e);
        this.triggerDownload(file);
      }
    } catch {
      this.props.showSnack('Export failed');
    } finally {
      this.setState({ exporting: false });
    }
  };

  private onWidthInput = (ev: Event) => {
    const v = (ev.target as HTMLInputElement).value;
    this.setResize({ width: v === '' ? '' : Math.max(1, Math.round(+v)) });
  };
  private onHeightInput = (ev: Event) => {
    const v = (ev.target as HTMLInputElement).value;
    this.setResize({ height: v === '' ? '' : Math.max(1, Math.round(+v)) });
  };

  render(
    { onModeChange, onBack }: Props,
    { items, activeId, tool, cropAspect, format, quality, exporting }: State,
  ) {
    const item = this.activeItem();
    const e = this.activeEdit();
    const nat = this.orientedNat();
    const crop = e.crop;
    const cropped = this.croppedSize();
    const target =
      nat.w && nat.h
        ? computeResizeTarget(cropped.w, cropped.h, e.resize)
        : { width: 0, height: 0 };
    const pct = (n: number) => `${n * 100}%`;
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    const handleClass: Record<string, string> = {
      nw: style.hNw,
      n: style.hN,
      ne: style.hNe,
      e: style.hE,
      se: style.hSe,
      s: style.hS,
      sw: style.hSw,
      w: style.hW,
    };
    const encType = item ? encoderForExport(item.file, format) : 'oxiPNG';
    const showQuality = encoderHasQuality(encType);

    const tools: { key: EditTool; label: string; icon: h.JSX.Element }[] = [
      {
        key: 'crop',
        label: 'Crop',
        icon: (
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        ),
      },
      {
        key: 'resize',
        label: 'Resize',
        icon: (
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        ),
      },
      {
        key: 'rotate',
        label: 'Rotate',
        icon: (
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M21 3v5h-5"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        ),
      },
      {
        key: 'flip',
        label: 'Flip',
        icon: (
          <svg viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3v18M7 8 4 12l3 4M17 8l3 4-3 4"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        ),
      },
    ];

    return (
      <div class={style.page}>
        <input
          ref={(el: HTMLInputElement | null) => {
            this.fileInput = el ?? undefined;
          }}
          type="file"
          multiple
          accept="image/*"
          class={style.hide}
          onChange={this.onFileChange}
        />
        <nav class={style.topnav}>
          <a
            class={style.wordmark}
            href="/"
            onClick={(ev: Event) => {
              ev.preventDefault();
              onBack();
            }}
          >
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
              class={`${style.tab} ${style.tabActive}`}
              role="tab"
              aria-selected={true}
            >
              Edit
            </button>
            <button
              class={style.tab}
              role="tab"
              onClick={() => onModeChange('compress')}
            >
              Compress
            </button>
            <button
              class={style.tab}
              role="tab"
              onClick={() => onModeChange('watermark')}
            >
              Watermark remover
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

        <div class={style.editor}>
          {/* Left tool rail */}
          <nav class={style.rail} aria-label="Edit tools">
            {tools.map((t) => (
              <button
                class={`${style.railBtn}${
                  tool === t.key ? ' ' + style.railBtnActive : ''
                }`}
                onClick={() => this.setTool(t.key)}
                aria-pressed={tool === t.key}
                title={t.label}
              >
                <span class={style.railIcon}>{t.icon}</span>
                <span class={style.railLabel}>{t.label}</span>
              </button>
            ))}
          </nav>

          {/* Center canvas */}
          <div class={style.canvasArea}>
            {item ? (
              <div class={style.stageWrap}>
                <div
                  class={style.canvasBox}
                  ref={(el: HTMLDivElement | null) => {
                    this.wrap = el ?? undefined;
                  }}
                >
                  <canvas
                    class={style.canvas}
                    ref={(el: HTMLCanvasElement | null) => {
                      this.canvas = el ?? undefined;
                    }}
                  />
                  {tool === 'crop' && nat.w > 0 && (
                    <Fragment>
                      <div
                        class={style.cropShade}
                        style={{
                          left: pct(crop.x),
                          top: pct(crop.y),
                          width: pct(crop.w),
                          height: pct(crop.h),
                        }}
                      />
                      <div
                        class={style.cropBox}
                        style={{
                          left: pct(crop.x),
                          top: pct(crop.y),
                          width: pct(crop.w),
                          height: pct(crop.h),
                        }}
                        onPointerDown={(ev: PointerEvent) =>
                          this.onCropDown(ev, 'move')
                        }
                      >
                        {handles.map((hk) => (
                          <span
                            class={`${style.cropHandle} ${handleClass[hk]}`}
                            onPointerDown={(ev: PointerEvent) =>
                              this.onCropDown(ev, hk)
                            }
                          />
                        ))}
                      </div>
                    </Fragment>
                  )}
                </div>
                <div class={style.stageInfo}>
                  <span>
                    {nat.w} × {nat.h}
                  </span>
                  <span class={style.stageArrow}>→</span>
                  <span class={style.stageInfoOut}>
                    {target.width} × {target.height} px
                  </span>
                </div>
              </div>
            ) : (
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
                <div class={style.dropTitle}>Drop an image to edit</div>
                <div class={style.dropHint}>
                  or <span>browse files</span>
                </div>
              </button>
            )}

            {items.length > 1 && (
              <div class={style.filmstrip} role="tablist" aria-label="Images">
                {items.map((it) => (
                  <button
                    class={`${style.filmThumb}${
                      it.id === activeId ? ' ' + style.filmThumbActive : ''
                    }`}
                    role="tab"
                    aria-selected={it.id === activeId}
                    title={it.file.name}
                    onClick={() => this.setState({ activeId: it.id })}
                  >
                    <img src={it.url} alt={it.file.name} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right properties panel */}
          <aside class={style.panel}>
            <div class={style.panelBody}>
              {tool === 'crop' && (
                <Fragment>
                  <h3 class={style.panelTitle}>Crop</h3>
                  <div class={style.aspectGrid}>
                    {CROP_ASPECTS.map((a) => (
                      <button
                        class={`${style.aspectBtn}${
                          cropAspect === a.key
                            ? ' ' + style.aspectBtnActive
                            : ''
                        }`}
                        onClick={() => this.setAspect(a.key)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                  <button class={style.ghostBtn} onClick={this.resetCrop}>
                    Reset crop
                  </button>
                  <p class={style.hint}>
                    Drag the box or its handles on the image.
                  </p>
                </Fragment>
              )}

              {tool === 'resize' && (
                <Fragment>
                  <h3 class={style.panelTitle}>Resize</h3>
                  <div class={style.segToggle}>
                    <button
                      class={`${style.segBtn}${
                        e.resize.mode === 'percent'
                          ? ' ' + style.segBtnActive
                          : ''
                      }`}
                      onClick={() => this.setResize({ mode: 'percent' })}
                    >
                      Percentage
                    </button>
                    <button
                      class={`${style.segBtn}${
                        e.resize.mode === 'dimensions'
                          ? ' ' + style.segBtnActive
                          : ''
                      }`}
                      onClick={() => this.setResize({ mode: 'dimensions' })}
                    >
                      Dimensions
                    </button>
                  </div>
                  {e.resize.mode === 'percent' ? (
                    <label class={style.field}>
                      <span>Scale</span>
                      <input
                        class={style.range}
                        type="range"
                        min="1"
                        max="200"
                        value={e.resize.percent}
                        onInput={(ev: Event) =>
                          this.setResize({
                            percent: Math.max(
                              1,
                              Math.round(
                                +(ev.target as HTMLInputElement).value,
                              ),
                            ),
                          })
                        }
                      />
                      <span class={style.fieldVal}>{e.resize.percent}%</span>
                    </label>
                  ) : (
                    <Fragment>
                      <label class={style.field}>
                        <span>Width</span>
                        <input
                          class={style.numInput}
                          type="number"
                          min="1"
                          placeholder={String(cropped.w)}
                          value={e.resize.width}
                          onInput={this.onWidthInput}
                        />
                        <span class={style.unit}>px</span>
                      </label>
                      <label class={style.field}>
                        <span>Height</span>
                        <input
                          class={style.numInput}
                          type="number"
                          min="1"
                          placeholder={String(cropped.h)}
                          value={e.resize.height}
                          onInput={this.onHeightInput}
                          disabled={e.resize.lockAspect}
                        />
                        <span class={style.unit}>px</span>
                      </label>
                      <label class={style.checkRow}>
                        <input
                          type="checkbox"
                          checked={e.resize.lockAspect}
                          onChange={() =>
                            this.setResize({ lockAspect: !e.resize.lockAspect })
                          }
                        />
                        <span>Lock aspect ratio</span>
                      </label>
                    </Fragment>
                  )}
                  <p class={style.hint}>
                    From cropped {cropped.w} × {cropped.h} → {target.width} ×{' '}
                    {target.height} px
                  </p>
                </Fragment>
              )}

              {tool === 'rotate' && (
                <Fragment>
                  <h3 class={style.panelTitle}>Rotate</h3>
                  <div class={style.btnRow}>
                    <button
                      class={style.actionBtn}
                      onClick={() => this.rotateBy(-90)}
                    >
                      ⟲ 90° left
                    </button>
                    <button
                      class={style.actionBtn}
                      onClick={() => this.rotateBy(90)}
                    >
                      ⟳ 90° right
                    </button>
                  </div>
                  <p class={style.hint}>Current: {e.rotate}°</p>
                </Fragment>
              )}

              {tool === 'flip' && (
                <Fragment>
                  <h3 class={style.panelTitle}>Flip</h3>
                  <div class={style.btnRow}>
                    <button
                      class={`${style.actionBtn}${
                        e.flipH ? ' ' + style.actionBtnActive : ''
                      }`}
                      onClick={this.toggleFlipH}
                    >
                      ↔ Horizontal
                    </button>
                    <button
                      class={`${style.actionBtn}${
                        e.flipV ? ' ' + style.actionBtnActive : ''
                      }`}
                      onClick={this.toggleFlipV}
                    >
                      ↕ Vertical
                    </button>
                  </div>
                </Fragment>
              )}
            </div>

            {/* Export footer */}
            <div class={style.exportBox}>
              <label class={style.field}>
                <span>Format</span>
                <select
                  class={style.select}
                  value={format}
                  onChange={(ev: Event) =>
                    this.setState({
                      format: (ev.target as HTMLSelectElement)
                        .value as ExportFormat,
                    })
                  }
                >
                  <option value="original">Original</option>
                  <option value="jpeg">JPEG</option>
                  <option value="png">PNG</option>
                  <option value="webp">WebP</option>
                  <option value="avif">AVIF</option>
                </select>
              </label>
              {showQuality && (
                <label class={style.field}>
                  <span>Quality</span>
                  <input
                    class={style.range}
                    type="range"
                    min="1"
                    max="100"
                    value={quality}
                    onInput={(ev: Event) =>
                      this.setState({
                        quality: +(ev.target as HTMLInputElement).value,
                      })
                    }
                  />
                  <span class={style.fieldVal}>{quality}</span>
                </label>
              )}
              <button
                class={style.exportBtn}
                onClick={this.exportActive}
                disabled={exporting || !item}
              >
                {exporting ? 'Exporting…' : 'Export image'}
              </button>
              {items.length > 1 && (
                <button
                  class={style.exportAllBtn}
                  onClick={this.exportAll}
                  disabled={exporting}
                >
                  Export all ({items.length})
                </button>
              )}
            </div>
          </aside>
        </div>
      </div>
    );
  }
}
