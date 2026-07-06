import { h, Component } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import logoIcon from 'url:static-build/assets/brand/smoosh-icon.png';
import WorkerBridge from '../worker-bridge';
import { decodeImage, compressImage } from '../pipeline';
import { encoderMap, EncoderType, EncoderState } from '../feature-meta';
import type SnackBarElement from 'shared/custom-els/snack-bar';

interface Props {
  files: File[];
  showSnack: SnackBarElement['showSnackbar'];
  onBack: () => void;
}

/** Formats produced in "all formats" mode. */
const ALL_FORMATS: EncoderType[] = [
  'mozJPEG',
  'webP',
  'avif',
  'oxiPNG',
  'browserPNG',
];
const SINGLE_FORMATS: EncoderType[] = [
  'mozJPEG',
  'webP',
  'avif',
  'oxiPNG',
  'browserPNG',
];

type Mode = 'single' | 'all';
type ItemStatus = 'pending' | 'processing' | 'done' | 'error';

interface FormatResult {
  format: EncoderType;
  status: ItemStatus;
  file?: File;
  url?: string;
  error?: string;
}

interface BatchItem {
  id: string;
  file: File;
  previewUrl: string;
  results: FormatResult[];
}

interface State {
  items: BatchItem[];
  encoderType: EncoderType;
  mode: Mode;
  processing: boolean;
  modalId?: string;
}

let idCounter = 0;
const nextId = () => `item-${idCounter++}`;

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function encoderStateFor(type: EncoderType): EncoderState {
  return {
    type,
    options: (encoderMap[type].meta as any).defaultOptions,
  } as EncoderState;
}

function formatsFor(mode: Mode, encoderType: EncoderType): EncoderType[] {
  return mode === 'all' ? ALL_FORMATS : [encoderType];
}

function newItem(file: File): BatchItem {
  return {
    id: nextId(),
    file,
    previewUrl: URL.createObjectURL(file),
    results: [],
  };
}

export default class Batch extends Component<Props, State> {
  state: State = {
    items: this.props.files.map(newItem),
    encoderType: 'mozJPEG',
    mode: 'single',
    processing: false,
  };

  private workerBridge = new WorkerBridge();
  private abortController?: AbortController;
  private fileInput?: HTMLInputElement;

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
  private onModeChange = (mode: Mode) => {
    if (this.state.processing) return;
    this.setState({ mode });
  };

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

  private setFormat = (
    itemId: string,
    format: EncoderType,
    patch: Partial<FormatResult>,
  ) => {
    this.setState((prev) => ({
      items: prev.items.map((i) =>
        i.id === itemId
          ? {
              ...i,
              results: i.results.some((r) => r.format === format)
                ? i.results.map((r) =>
                    r.format === format ? { ...r, ...patch } : r,
                  )
                : [...i.results, { format, status: 'pending', ...patch }],
            }
          : i,
      ),
    }));
  };

  private processAll = async () => {
    if (this.state.processing) return;
    const targets = formatsFor(this.state.mode, this.state.encoderType);
    this.abortController = new AbortController();
    this.setState({ processing: true });

    try {
      for (const item of this.state.items) {
        if (this.abortController.signal.aborted) break;
        const signal = this.abortController.signal;
        // Decode once per image.
        let imageData: ImageData;
        try {
          imageData = await decodeImage(signal, item.file, this.workerBridge);
        } catch {
          for (const f of targets)
            this.setFormat(item.id, f, { status: 'error', error: 'Decode' });
          continue;
        }
        for (const format of targets) {
          if (this.abortController.signal.aborted) break;
          this.setFormat(item.id, format, {
            status: 'processing',
            error: undefined,
          });
          try {
            const result = await compressImage(
              signal,
              imageData,
              encoderStateFor(format),
              item.file.name,
              this.workerBridge,
            );
            const url = URL.createObjectURL(result);
            this.setState((prev) => ({
              items: prev.items.map((i) =>
                i.id === item.id
                  ? {
                      ...i,
                      results: i.results.some((r) => r.format === format)
                        ? i.results.map((r) =>
                            r.format === format
                              ? {
                                  ...r,
                                  status: 'done' as ItemStatus,
                                  file: result,
                                  url: r.url
                                    ? (URL.revokeObjectURL(r.url!), url)
                                    : url,
                                }
                              : r,
                          )
                        : [
                            ...i.results,
                            {
                              format,
                              status: 'done' as ItemStatus,
                              file: result,
                              url,
                            },
                          ],
                    }
                  : i,
              ),
            }));
          } catch (err) {
            const msg =
              err instanceof Error && err.name === 'AbortError'
                ? 'Cancelled'
                : 'Failed';
            this.setFormat(item.id, format, { status: 'error', error: msg });
          }
        }
      }
    } finally {
      this.setState({ processing: false });
    }
  };

  private cancel = () => {
    this.abortController?.abort();
    this.setState({ processing: false });
  };

  private downloadAll = () => {
    for (const item of this.state.items) {
      for (const r of item.results) {
        if (r.status === 'done' && r.url && r.file) {
          const a = document.createElement('a');
          a.href = r.url;
          a.download = r.file.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      }
    }
  };

  private openModal = (id: string) => this.setState({ modalId: id });
  private closeModal = () => this.setState({ modalId: undefined });

  render(
    { onBack }: Props,
    { items, encoderType, mode, processing, modalId }: State,
  ) {
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
    const targets = formatsFor(mode, encoderType);

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
          </div>
        </nav>

        <section class={style.hero}>
          <h1>
            Batch compress into <span class={style.accent}>any format</span>,
            all at once.
          </h1>
          <p class={style.heroSub}>
            Drop a folder of images and export each one to a single format — or
            to <strong>all formats at once</strong>. Everything runs locally in
            your browser.
          </p>

          {items.length > 0 && (
            <div class={style.controls}>
              <div class={style.modeToggle}>
                <button
                  class={`${style.modeTab}${
                    mode === 'single' ? ' ' + style.modeTabActive : ''
                  }`}
                  onClick={() => this.onModeChange('single')}
                >
                  One format
                </button>
                <button
                  class={`${style.modeTab}${
                    mode === 'all' ? ' ' + style.modeTabActive : ''
                  }`}
                  onClick={() => this.onModeChange('all')}
                >
                  All formats
                </button>
              </div>
              {mode === 'single' && (
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
              <div class={style.spacer} />
              <button class={style.btnAdd} onClick={this.onAddFilesClick}>
                + Add images
              </button>
              {items.length > 0 && !processing && (
                <button class={style.btnGhost} onClick={this.clearAll}>
                  Clear all
                </button>
              )}
              {processing ? (
                <button class={style.btnGhost} onClick={this.cancel}>
                  Cancel
                </button>
              ) : (
                <button class={style.btnPrimary} onClick={this.processAll}>
                  {mode === 'all'
                    ? `Convert to all formats (${items.length})`
                    : `Process all (${items.length})`}
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
              <div class={style.dropTitle}>Drop images to compress</div>
              <div class={style.dropHint}>
                or <span>browse files</span> · one format or all at once
              </div>
            </button>
          ) : (
            <div class={style.list}>
              {totalResult > 0 && (
                <div class={style.summary}>
                  <span>
                    Total: {prettyBytes(totalOriginal)} →{' '}
                    <strong>{prettyBytes(totalResult)}</strong> across{' '}
                    {doneCount} file{doneCount === 1 ? '' : 's'}
                  </span>
                  <span class={style.savedBadge}>{saved}% smaller</span>
                </div>
              )}
              {items.map((item) => {
                const resultsByFormat = new Map(
                  item.results.map((r) => [r.format, r]),
                );
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
                        {targets.map((format) => {
                          const r = resultsByFormat.get(format);
                          return (
                            <div
                              class={style.formatChip}
                              data-status={r?.status}
                            >
                              <span class={style.formatLabel}>
                                {encoderMap[format].meta.label}
                              </span>
                              {r?.status === 'processing' && (
                                <span class={style.formatMeta}>…</span>
                              )}
                              {r?.status === 'done' && r.file && (
                                <a
                                  class={style.formatDl}
                                  href={r.url}
                                  download={r.file.name}
                                  title={`${
                                    encoderMap[format].meta.label
                                  } · ${prettyBytes(r.file.size)}`}
                                >
                                  {prettyBytes(r.file.size)} ↓
                                </a>
                              )}
                              {r?.status === 'error' && (
                                <span class={style.formatMeta}>failed</span>
                              )}
                              {!r && <span class={style.formatMeta}>—</span>}
                            </div>
                          );
                        })}
                      </div>
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
                  <div class={style.modalPreview}>
                    <img
                      src={(done[0] && done[0].url) || item.previewUrl}
                      alt={item.file.name}
                    />
                  </div>
                  <div class={style.modalFormats}>
                    <a
                      class={style.modalOrig}
                      href={item.previewUrl}
                      download={item.file.name}
                    >
                      Original · {prettyBytes(item.file.size)}
                    </a>
                    {done.map((r) => (
                      <a
                        class={style.formatDl}
                        href={r.url}
                        download={r.file?.name}
                      >
                        {encoderMap[r.format].meta.label} ·{' '}
                        {r.file ? prettyBytes(r.file.size) : ''}
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
