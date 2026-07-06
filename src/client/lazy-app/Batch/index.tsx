import { h, Component } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import WorkerBridge from '../worker-bridge';
import { decodeImage, compressImage } from '../pipeline';
import { encoderMap, EncoderType, EncoderState } from '../feature-meta';
import type SnackBarElement from 'shared/custom-els/snack-bar';

/** Encoders surfaced in the batch UI (default options used). */
const BATCH_ENCODERS: EncoderType[] = [
  'mozJPEG',
  'webP',
  'avif',
  'oxiPNG',
  'browserPNG',
];

interface Props {
  files: File[];
  showSnack: SnackBarElement['showSnackbar'];
  onBack: () => void;
  onAddFiles?: (files: File[]) => void;
}

type ItemStatus = 'pending' | 'processing' | 'done' | 'error';

interface BatchItem {
  id: string;
  file: File;
  previewUrl: string;
  status: ItemStatus;
  resultFile?: File;
  resultUrl?: string;
  error?: string;
}

interface State {
  items: BatchItem[];
  encoderType: EncoderType;
  processing: boolean;
}

let idCounter = 0;
const nextId = () => `item-${idCounter++}`;

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function encoderStateFor(type: EncoderType): EncoderState {
  // defaultOptions is present on every encoder meta.
  return {
    type,
    options: (encoderMap[type].meta as any).defaultOptions,
  } as EncoderState;
}

export default class Batch extends Component<Props, State> {
  state: State = {
    items: this.props.files.map((file) => ({
      id: nextId(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'pending' as ItemStatus,
    })),
    encoderType: 'mozJPEG',
    processing: false,
  };

  private workerBridge = new WorkerBridge();
  private abortController?: AbortController;
  private fileInput?: HTMLInputElement;

  componentWillUnmount() {
    this.abortController?.abort();
    for (const item of this.state.items) {
      URL.revokeObjectURL(item.previewUrl);
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    }
  }

  private onEncoderChange = (e: Event) => {
    const select = e.target as HTMLSelectElement;
    this.setState({ encoderType: select.value as EncoderType });
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

  private updateItem = (id: string, patch: Partial<BatchItem>) => {
    this.setState((prev) => ({
      items: prev.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));
  };

  private processAll = async () => {
    if (this.state.processing) return;
    const encoderState = encoderStateFor(this.state.encoderType);
    this.abortController = new AbortController();
    this.setState({ processing: true });

    try {
      for (const item of this.state.items) {
        if (this.abortController.signal.aborted) break;
        if (item.status === 'done') continue;
        this.updateItem(item.id, { status: 'processing', error: undefined });
        try {
          const signal = this.abortController.signal;
          const imageData = await decodeImage(
            signal,
            item.file,
            this.workerBridge,
          );
          const result = await compressImage(
            signal,
            imageData,
            encoderState,
            item.file.name,
            this.workerBridge,
          );
          const resultUrl = URL.createObjectURL(result);
          this.setState((prev) => ({
            items: prev.items.map((i) =>
              i.id === item.id
                ? {
                    ...i,
                    status: 'done',
                    resultFile: result,
                    resultUrl: i.resultUrl
                      ? (URL.revokeObjectURL(i.resultUrl), resultUrl)
                      : resultUrl,
                  }
                : i,
            ),
          }));
        } catch (err) {
          const msg =
            err instanceof Error && err.name === 'AbortError'
              ? 'Cancelled'
              : 'Failed';
          this.updateItem(item.id, { status: 'error', error: msg });
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
      if (item.status === 'done' && item.resultUrl) {
        const a = document.createElement('a');
        a.href = item.resultUrl;
        a.download = item.resultFile?.name ?? item.file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }
  };

  render({ onBack }: Props, { items, encoderType, processing }: State) {
    const doneCount = items.filter((i) => i.status === 'done').length;
    const allDone = doneCount === items.length && items.length > 0;
    const totalOriginal = items.reduce((s, i) => s + i.file.size, 0);
    const totalResult = items.reduce(
      (s, i) => s + (i.resultFile?.size ?? 0),
      0,
    );
    const saved =
      totalResult > 0 ? Math.round((1 - totalResult / totalOriginal) * 100) : 0;

    return (
      <div class={style.batch}>
        <header class={style.topbar}>
          <button class={style.iconBtn} onClick={onBack} aria-label="Back">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M15 6l-6 6 6 6"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <div class={style.topbarTitle}>
            <strong>Batch compress</strong>
            <span>
              {items.length} image{items.length === 1 ? '' : 's'}
              {doneCount > 0 ? ` · ${doneCount} done` : ''}
            </span>
          </div>
          <div class={style.topbarActions}>
            <label class={style.encoderField}>
              <span>Format</span>
              <select
                value={encoderType}
                onChange={this.onEncoderChange}
                disabled={processing}
              >
                {BATCH_ENCODERS.map((t) => (
                  <option value={t}>{encoderMap[t].meta.label}</option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <div class={style.toolbar}>
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
          <button class={style.btnGhost} onClick={this.onAddFilesClick}>
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
            items.length > 0 && (
              <button class={style.btnPrimary} onClick={this.processAll}>
                {allDone ? 'Re-process all' : `Process all (${items.length})`}
              </button>
            )
          )}
          {doneCount > 0 && (
            <button class={style.btnPrimary} onClick={this.downloadAll}>
              Download all ({doneCount})
            </button>
          )}
        </div>

        {totalResult > 0 && (
          <div class={style.summary}>
            <span>
              Total: {prettyBytes(totalOriginal)} →{' '}
              <strong>{prettyBytes(totalResult)}</strong>
            </span>
            <span class={style.savedBadge}>{saved}% smaller</span>
          </div>
        )}

        {items.length === 0 ? (
          <div class={style.empty}>
            <p>No images in the queue.</p>
            <button class={style.btnPrimary} onClick={this.onAddFilesClick}>
              Add images
            </button>
          </div>
        ) : (
          <div class={style.list}>
            {items.map((item) => {
              const reduced =
                item.resultFile && item.resultFile.size < item.file.size
                  ? Math.round(
                      (1 - item.resultFile.size / item.file.size) * 100,
                    )
                  : undefined;
              return (
                <div class={style.row} data-status={item.status}>
                  <img
                    class={style.thumb}
                    src={item.previewUrl}
                    alt={item.file.name}
                  />
                  <div class={style.rowMeta}>
                    <div class={style.rowName}>{item.file.name}</div>
                    <div class={style.rowSizes}>
                      {prettyBytes(item.file.size)}
                      {item.resultFile && (
                        <span>
                          {' → '}
                          <strong>{prettyBytes(item.resultFile.size)}</strong>
                          {reduced !== undefined && (
                            <span
                              class={reduced >= 0 ? style.saved : style.grew}
                            >
                              {' '}
                              ({reduced >= 0 ? '−' : '+'}
                              {Math.abs(reduced)}%)
                            </span>
                          )}
                        </span>
                      )}
                    </div>
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
                        download={item.resultFile?.name ?? item.file.name}
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
              );
            })}
          </div>
        )}
      </div>
    );
  }
}
