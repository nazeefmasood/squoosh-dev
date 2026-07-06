import { h, Component } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import logoIcon from 'url:static-build/assets/brand/smoosh-icon.png';
import logoFull from 'url:static-build/assets/brand/smoosh-full.png';
import type SnackBarElement from 'shared/custom-els/snack-bar';
// Vendored engine — pure-JS reverse alpha blending (no npm dependency).
import { removeWatermarkFromImage } from 'vendor/gwm';

const currentYear = new Date().getFullYear();

const githubLogoInline =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  );

interface Props {
  files: File[];
  showSnack: SnackBarElement['showSnackbar'];
  onBack: () => void;
  onAddFiles?: (files: File[]) => void;
}

type ItemStatus = 'pending' | 'processing' | 'done' | 'error';

interface WatermarkItem {
  id: string;
  file: File;
  previewUrl: string;
  status: ItemStatus;
  resultUrl?: string;
  resultSize?: number;
  detected?: boolean;
  error?: string;
}

interface State {
  items: WatermarkItem[];
  processing: boolean;
  modalId?: string;
  comparePct: number;
}

let idCounter = 0;
const nextId = () => `wm-${idCounter++}`;

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
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
  // The engine may return an HTMLCanvasElement (toBlob) or an
  // OffscreenCanvas (convertToBlob). Handle both.
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

export default class Watermark extends Component<Props, State> {
  state: State = {
    items: this.props.files.map((file) => ({
      id: nextId(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'pending' as ItemStatus,
    })),
    processing: false,
    comparePct: 50,
  };

  private fileInput?: HTMLInputElement;
  private cancelled = false;

  componentWillUnmount() {
    this.cancelled = true;
    for (const item of this.state.items) {
      URL.revokeObjectURL(item.previewUrl);
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    }
  }

  private updateItem = (id: string, patch: Partial<WatermarkItem>) => {
    this.setState((prev) => ({
      items: prev.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));
  };

  private removeItem = (id: string) => {
    this.setState((prev) => {
      const item = prev.items.find((i) => i.id === id);
      if (item) {
        URL.revokeObjectURL(item.previewUrl);
        if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
      }
      return { items: prev.items.filter((i) => i.id !== id) };
    });
  };

  private clearAll = () => {
    if (this.state.processing) return;
    for (const item of this.state.items) {
      URL.revokeObjectURL(item.previewUrl);
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    }
    this.setState({ items: [] });
  };

  private onAddFilesClick = () => this.fileInput?.click();

  private addFiles = (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    this.setState((prev) => ({
      items: [
        ...prev.items,
        ...imgs.map((file) => ({
          id: nextId(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'pending' as ItemStatus,
        })),
      ],
    }));
  };

  private onDrop = (event: DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    this.addFiles(files);
  };

  private onDragOver = (event: DragEvent) => event.preventDefault();
  private onDragLeave = (event: DragEvent) => event.preventDefault();

  private onFileChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (!files.length) return;
    if (this.props.onAddFiles) {
      this.props.onAddFiles(files);
      return;
    }
    this.setState((prev) => ({
      items: [
        ...prev.items,
        ...files.map((file) => ({
          id: nextId(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'pending' as ItemStatus,
        })),
      ],
    }));
  };

  private processAll = async () => {
    if (this.state.processing) return;
    this.cancelled = false;
    this.setState({ processing: true });
    try {
      for (const item of this.state.items) {
        if (this.cancelled) break;
        if (item.status === 'done') continue;
        this.updateItem(item.id, { status: 'processing', error: undefined });
        try {
          const img = await loadImage(item.file);
          const { canvas, meta } = await removeWatermarkFromImage(img);
          const resultFile = await canvasToPngFile(canvas, item.file.name);
          const url = URL.createObjectURL(resultFile);
          this.setState((prev) => ({
            items: prev.items.map((i) =>
              i.id === item.id
                ? {
                    ...i,
                    status: 'done',
                    resultUrl: i.resultUrl
                      ? (URL.revokeObjectURL(i.resultUrl), url)
                      : url,
                    resultSize: resultFile.size,
                    detected: !!(meta && (meta as any).applied),
                  }
                : i,
            ),
          }));
        } catch (err) {
          this.updateItem(item.id, { status: 'error', error: 'Failed' });
        }
      }
    } finally {
      this.setState({ processing: false });
    }
  };

  private cancel = () => {
    this.cancelled = true;
    this.setState({ processing: false });
  };

  private openModal = (id: string) =>
    this.setState({ modalId: id, comparePct: 50 });
  private closeModal = () => this.setState({ modalId: undefined });
  private onCompareChange = (e: Event) =>
    this.setState({ comparePct: +(e.target as HTMLInputElement).value });

  private downloadAll = () => {
    for (const item of this.state.items) {
      if (item.status === 'done' && item.resultUrl) {
        const a = document.createElement('a');
        a.href = item.resultUrl;
        a.download = item.file.name.replace(/.[^.]*$/, '') + '-clean.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }
  };

  render({ onBack }: Props, { items, processing, modalId, comparePct }: State) {
    const doneCount = items.filter((i) => i.status === 'done').length;
    const allDone = doneCount === items.length && items.length > 0;

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
              width="28"
              height="28"
            />
            <span class={style.wordmarkText}>Smoosh</span>
          </a>
          <div class={style.navLinks}>
            <button class={style.navLink} onClick={onBack}>
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M15 6l-6 6 6 6"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <span>Back to home</span>
            </button>
            <a
              class={style.navLink}
              href="https://github.com/nazeefmasood/squoosh-dev"
              target="_blank"
              rel="noreferrer noopener"
            >
              <img src={githubLogoInline} alt="" />
              <span>GitHub</span>
            </a>
          </div>
        </nav>

        <section class={style.hero}>
          <h1>
            Remove <span class={style.accent}>Gemini watermarks</span>, right in
            your browser.
          </h1>
          <p class={style.heroSub}>
            Drop your Gemini-generated images and Smoosh cleanly removes the
            watermark using reverse alpha blending — a mathematically exact
            inversion, not AI inpainting. Batch supported, fully private.
          </p>

          {items.length > 0 && (
            <div class={style.actions}>
              <button class={style.btnAdd} onClick={this.onAddFilesClick}>
                + Add images
              </button>
              {items.length > 0 && !processing && (
                <button class={style.btnGhost} onClick={this.clearAll}>
                  Clear all
                </button>
              )}
              <div class={style.spacer} />
              {processing ? (
                <button class={style.btnGhost} onClick={this.cancel}>
                  Cancel
                </button>
              ) : (
                <button class={style.btnPrimary} onClick={this.processAll}>
                  {allDone
                    ? 'Re-process all'
                    : `Remove watermarks (${items.length})`}
                </button>
              )}
              {doneCount > 0 && (
                <button class={style.btnPrimary} onClick={this.downloadAll}>
                  Download all ({doneCount})
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
              <div class={style.dropTitle}>Drop Gemini-generated images</div>
              <div class={style.dropHint}>
                or <span>browse files</span> · batch supported
              </div>
            </button>
          ) : (
            <div class={style.list}>
              {items.map((item) => (
                <div class={style.row} data-status={item.status}>
                  <div class={style.thumbs}>
                    <img
                      class={style.thumb}
                      src={item.previewUrl}
                      alt={item.file.name}
                      onClick={() => this.openModal(item.id)}
                    />
                    {item.resultUrl && (
                      <img
                        class={style.thumb}
                        src={item.resultUrl}
                        alt={`${item.file.name} cleaned`}
                        onClick={() => this.openModal(item.id)}
                      />
                    )}
                  </div>
                  <div class={style.rowMeta}>
                    <div class={style.rowName}>{item.file.name}</div>
                    <div class={style.rowSizes}>
                      {prettyBytes(item.file.size)}
                      {item.resultSize !== undefined && (
                        <span>
                          {' → '}
                          <strong>{prettyBytes(item.resultSize)}</strong>
                        </span>
                      )}
                    </div>
                    {item.status === 'done' && (
                      <div class={style.detected}>
                        {item.detected === false
                          ? 'No watermark detected — output unchanged'
                          : 'Watermark removed'}
                      </div>
                    )}
                    {item.status === 'error' && (
                      <div class={style.rowError}>{item.error}</div>
                    )}
                  </div>
                  <div class={style.rowStatus}>
                    {item.status === 'processing' && (
                      <span class={style.statusProcessing}>Processing…</span>
                    )}
                    {item.status === 'done' && item.resultUrl && (
                      <a
                        class={style.dlLink}
                        href={item.resultUrl}
                        download={
                          item.file.name.replace(/.[^.]*$/, '') + '-clean.png'
                        }
                      >
                        Download
                      </a>
                    )}
                    {item.status === 'pending' && (
                      <span class={style.statusPending}>Queued</span>
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
              ))}
            </div>
          )}
        </section>

        <section class={style.features}>
          <div class={style.featuresGrid}>
            <div class={style.feature}>
              <div class={style.featureIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="m7 8 3 3-3 3M13 14h4"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <rect
                    x="3"
                    y="4"
                    width="18"
                    height="16"
                    rx="2"
                    stroke="currentColor"
                    stroke-width="2"
                  />
                </svg>
              </div>
              <h3>Mathematically exact</h3>
              <p>
                Uses reverse alpha blending — a precise inversion of how the
                watermark was composited — not AI inpainting that hallucinates
                pixels.
              </p>
            </div>
            <div class={style.feature}>
              <div class={style.featureIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <circle
                    cx="11"
                    cy="11"
                    r="7"
                    stroke="currentColor"
                    stroke-width="2"
                  />
                  <path
                    d="m20 20-3.5-3.5"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                </svg>
              </div>
              <h3>Auto-detects</h3>
              <p>
                Finds the Gemini watermark size and position automatically using
                a known catalog and local anchor search — no manual masking.
              </p>
            </div>
            <div class={style.feature}>
              <div class={style.featureIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3Z"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
              <h3>Completely private</h3>
              <p>
                Everything runs locally in your browser with WebAssembly. Your
                images are never uploaded to any server.
              </p>
            </div>
          </div>
        </section>

        <footer class={style.footer}>
          <div class={style.footerInner}>
            <div class={style.footerBrand}>
              <img
                class={style.footerFullLogo}
                src={logoFull}
                alt="Smoosh"
                height="104"
              />
              <p class={style.footerTag}>
                Private, in-browser image tools. Compress, convert, and clean up
                images — your files never leave your device.
              </p>
            </div>
            <div class={style.footerCols}>
              <div class={style.footerCol}>
                <h4>Tools</h4>
                <a class={style.footerLink} href="/">
                  Compress
                </a>
                <a class={style.footerLink} href="/watermark">
                  Watermark remover
                </a>
              </div>
              <div class={style.footerCol}>
                <h4>Resources</h4>
                <a
                  class={style.footerLink}
                  href="https://github.com/nazeefmasood/squoosh-dev/blob/main/README.md"
                >
                  Privacy
                </a>
                <a
                  class={style.footerLink}
                  href="https://github.com/nazeefmasood/squoosh-dev"
                >
                  GitHub
                </a>
              </div>
            </div>
          </div>
          <div class={style.footerBar}>
            <span>© {currentYear} Smoosh · Open source</span>
            <span class={style.footerMade}>Runs 100% in your browser</span>
          </div>
        </footer>

        {modalId &&
          (() => {
            const item = items.find((i) => i.id === modalId);
            if (!item || !item.resultUrl) return null;
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
                  <div class={style.compare}>
                    <img
                      class={style.compareImg}
                      src={item.resultUrl}
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
                  </div>
                  <input
                    class={style.compareRange}
                    type="range"
                    min="0"
                    max="100"
                    value={comparePct}
                    onInput={this.onCompareChange}
                    aria-label="Before / after slider"
                  />
                  <div class={style.modalActions}>
                    <a
                      class={style.btnPrimary}
                      href={item.resultUrl}
                      download={
                        item.file.name.replace(/.[^.]*$/, '') + '-clean.png'
                      }
                    >
                      Download cleaned
                    </a>
                  </div>
                </div>
              </div>
            );
          })()}
      </div>
    );
  }
}
