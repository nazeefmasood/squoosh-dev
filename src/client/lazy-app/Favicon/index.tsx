import { h, Component, Fragment } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import ToolNav from '../ToolNav';
import Footer from '../Footer';
import type { ToolMode } from '../Tool';
import { zipFiles } from 'vendor/zip';
import { buildIco } from 'vendor/ico';
import type SnackBarElement from 'shared/custom-els/snack-bar';

interface Props {
  onModeChange: (mode: ToolMode) => void;
  onBack: () => void;
  showSnack: SnackBarElement['showSnackbar'];
  /** Files handed over from the homepage drop/file-picker. */
  files?: File[];
}

type InputMode = 'text' | 'emoji' | 'image' | 'check';
type Shape = 'square' | 'rounded' | 'circle';

interface State {
  inputMode: InputMode;
  text: string;
  emoji: string;
  fontFamily: string;
  textColor: string;
  bgColor: string;
  bgEnabled: boolean;
  shape: Shape;
  imageSrc?: string; // object URL
  imageName?: string;
  generating: boolean;
  // Favicon checker
  checkUrl: string;
  checkLoading: boolean;
  checkResult?: {
    finalUrl: string;
    title: string;
    icons: { rel?: string; href: string; sizes?: string; type?: string }[];
    manifestIcons: { href: string; sizes?: string; type?: string }[];
  };
  checkError?: string;
}

// Canvas fillText cannot resolve CSS variables, so these are concrete font
// stacks (no var(--…)).
const FONTS = [
  {
    label: 'Sans',
    value: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', value: 'ui-monospace, Menlo, monospace' },
  {
    label: 'Rounded',
    value: '"SF Pro Rounded", "Avenir Next", system-ui, sans-serif',
  },
];

// Render the master at 1024 so every downscaled size stays crisp; the
// largest emitted file is still 512 (android-chrome-512), matching favicon.io.
const MASTER = 1024;
const SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512];
// Actual-size preview strip under the main preview.
const MINI_SIZES = [64, 48, 32, 16];

const HTML_SNIPPET = `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="manifest" href="/site.webmanifest">`;

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('encode'));
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)));
    }, 'image/png');
  });
}

/**
 * Downscale by repeated halving instead of one giant jump (1024 → 16 in a
 * single drawImage aliases badly); each step stays within 2× so the bilinear
 * filter keeps edges clean.
 */
function scaleTo(source: HTMLCanvasElement, size: number): HTMLCanvasElement {
  let cur = source;
  while (cur.width / 2 > size) {
    const half = document.createElement('canvas');
    half.width = Math.max(size, Math.round(cur.width / 2));
    half.height = half.width;
    const hctx = half.getContext('2d')!;
    hctx.imageSmoothingEnabled = true;
    (hctx as any).imageSmoothingQuality = 'high';
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  (ctx as any).imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, size, size);
  return out;
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img'));
    img.src = src;
  });
}

export default class Favicon extends Component<Props, State> {
  state: State = {
    inputMode: 'text',
    text: 'S',
    emoji: '🚀',
    fontFamily: FONTS[0].value,
    textColor: '#ffffff',
    bgColor: '#000000',
    bgEnabled: true,
    shape: 'rounded',
    generating: false,
    checkUrl: '',
    checkLoading: false,
  };
  private preview?: HTMLCanvasElement;
  private fileInput?: HTMLInputElement;

  componentDidMount() {
    this.adoptIncomingFile();
    this.drawPreview();
  }
  componentDidUpdate(prevProps: Props, prev: State) {
    if (this.props.files !== prevProps.files) this.adoptIncomingFile();
    const keys: (keyof State)[] = [
      'inputMode',
      'text',
      'emoji',
      'fontFamily',
      'textColor',
      'bgColor',
      'bgEnabled',
      'shape',
      'imageSrc',
    ];
    if (keys.some((k) => (this.state as any)[k] !== (prev as any)[k])) {
      this.drawPreview();
    }
  }
  componentWillUnmount() {
    if (this.state.imageSrc) URL.revokeObjectURL(this.state.imageSrc);
  }

  /** Use an image handed over from the homepage (drop / file picker). */
  private adoptIncomingFile() {
    const file = this.props.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (this.state.imageSrc) URL.revokeObjectURL(this.state.imageSrc);
    this.setState({
      imageSrc: URL.createObjectURL(file),
      imageName: file.name,
      inputMode: 'image',
    });
  }

  /** Render the master favicon (1024×1024) with current settings. */
  private async renderMaster(): Promise<HTMLCanvasElement> {
    const canvas = document.createElement('canvas');
    canvas.width = MASTER;
    canvas.height = MASTER;
    const ctx = canvas.getContext('2d')!;
    const s = this.state;
    this.applyShape(ctx, s.shape);
    if (s.bgEnabled) {
      ctx.fillStyle = s.bgColor;
      ctx.fillRect(0, 0, MASTER, MASTER);
    }

    if (s.inputMode === 'image') {
      if (s.imageSrc) {
        const img = await loadImageEl(s.imageSrc);
        // Contain: keep the whole image visible at its own aspect ratio.
        const scale = Math.min(MASTER / img.width, MASTER / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.imageSmoothingEnabled = true;
        (ctx as any).imageSmoothingQuality = 'high';
        ctx.drawImage(img, (MASTER - w) / 2, (MASTER - h) / 2, w, h);
      }
      ctx.restore();
      return canvas;
    }

    const content = s.inputMode === 'text' ? s.text : s.emoji;
    if (!content) {
      ctx.restore();
      return canvas;
    }
    // Measure the actual ink box of the glyphs and scale it to fit the icon,
    // then center on the measured ascent/descent. Emoji in particular render
    // far larger than their nominal font size, so a fixed factor overflows.
    const box = MASTER * (s.inputMode === 'emoji' ? 0.72 : 0.68);
    const base = MASTER / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${base}px ${s.fontFamily}`;
    const m = ctx.measureText(content);
    const inkW = Math.max(
      (m.actualBoundingBoxLeft ?? 0) + (m.actualBoundingBoxRight ?? 0),
      m.width,
      1,
    );
    const inkH = Math.max(
      (m.actualBoundingBoxAscent ?? base * 0.8) +
        (m.actualBoundingBoxDescent ?? 0),
      1,
    );
    const size = (base * box) / Math.max(inkW, inkH);
    ctx.font = `${Math.round(size)}px ${s.fontFamily}`;
    const m2 = ctx.measureText(content);
    const asc = m2.actualBoundingBoxAscent ?? size * 0.8;
    const desc = m2.actualBoundingBoxDescent ?? 0;
    ctx.fillStyle = s.textColor;
    ctx.fillText(content, MASTER / 2, MASTER / 2 + (asc - desc) / 2);
    ctx.restore();
    return canvas;
  }

  /** Clip the canvas to the chosen background shape. */
  private applyShape(ctx: CanvasRenderingContext2D, shape: Shape) {
    ctx.save();
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(MASTER / 2, MASTER / 2, MASTER / 2, 0, Math.PI * 2);
      ctx.clip();
    } else if (shape === 'rounded') {
      const r = MASTER * 0.22;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(MASTER, 0, MASTER, MASTER, r);
      ctx.arcTo(MASTER, MASTER, 0, MASTER, r);
      ctx.arcTo(0, MASTER, 0, 0, r);
      ctx.arcTo(0, 0, MASTER, 0, r);
      ctx.closePath();
      ctx.clip();
    }
  }

  // Guards against overlapping async draws landing out of order.
  private drawToken = 0;

  private async drawPreview() {
    const token = ++this.drawToken;
    const master = await this.renderMaster();
    if (token !== this.drawToken) return;
    const c = this.preview;
    if (c) {
      // Render at device-pixel resolution: a low-res canvas stretched onto a
      // retina screen is what made text/emoji edges look distorted. 256 CSS px
      // on a 2× screen is a true 512-pixel render — the largest emitted asset.
      const display = 256;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const px = Math.round(display * dpr);
      c.width = px;
      c.height = px;
      c.style.width = `${display}px`;
      c.style.height = `${display}px`;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(scaleTo(master, px), 0, 0);
    }
    this.miniCanvases = this.miniCanvases.filter((mc) => mc.el.isConnected);
    for (const { size, el } of this.miniCanvases) {
      const ctx = el.getContext('2d')!;
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(scaleTo(master, size), 0, 0);
    }
  }

  private onPickImage = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    if (this.state.imageSrc) URL.revokeObjectURL(this.state.imageSrc);
    this.setState({
      imageSrc: URL.createObjectURL(file),
      imageName: file.name,
      inputMode: 'image',
    });
  };

  private generate = async () => {
    if (this.state.generating) return;
    this.setState({ generating: true });
    try {
      const master = await this.renderMaster();
      const pngs: { size: number; bytes: Uint8Array }[] = [];
      for (const size of SIZES) {
        pngs.push({
          size,
          bytes: await canvasToPngBytes(scaleTo(master, size)),
        });
      }
      const bySize = new Map(pngs.map((p) => [p.size, p]));
      const ico = buildIco([
        { size: 16, png: bySize.get(16)!.bytes },
        { size: 32, png: bySize.get(32)!.bytes },
        { size: 48, png: bySize.get(48)!.bytes },
      ]);
      const manifest = {
        name: 'My App',
        short_name: 'My App',
        icons: [
          {
            src: '/android-chrome-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/android-chrome-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
        theme_color: this.state.bgEnabled ? this.state.bgColor : '#ffffff',
        background_color: this.state.bgEnabled ? this.state.bgColor : '#ffffff',
        display: 'standalone',
      };
      const zip = zipFiles([
        { name: 'favicon.ico', data: ico },
        { name: 'favicon-16x16.png', data: bySize.get(16)!.bytes },
        { name: 'favicon-32x32.png', data: bySize.get(32)!.bytes },
        { name: 'favicon-48x48.png', data: bySize.get(48)!.bytes },
        { name: 'favicon-64x64.png', data: bySize.get(64)!.bytes },
        { name: 'favicon-128x128.png', data: bySize.get(128)!.bytes },
        { name: 'favicon-256x256.png', data: bySize.get(256)!.bytes },
        { name: 'apple-touch-icon.png', data: bySize.get(180)!.bytes },
        { name: 'android-chrome-192x192.png', data: bySize.get(192)!.bytes },
        { name: 'android-chrome-512x512.png', data: bySize.get(512)!.bytes },
        {
          name: 'site.webmanifest',
          data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        },
      ]);
      const blob = new Blob([zip], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'favicons.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.props.showSnack('Favicon package downloaded');
    } catch {
      this.props.showSnack('Could not generate favicons');
    } finally {
      this.setState({ generating: false });
    }
  };

  private copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(HTML_SNIPPET);
      this.props.showSnack('HTML snippet copied');
    } catch {
      this.props.showSnack('Copy failed — select the snippet manually');
    }
  };

  private runCheck = async () => {
    const url = this.state.checkUrl.trim();
    if (!url || this.state.checkLoading) return;
    this.setState({
      checkLoading: true,
      checkError: undefined,
      checkResult: undefined,
    });
    try {
      const res = await fetch('/api/favicon-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      // The /api function only exists on the deployed (Vercel) site. On a
      // static dev server the request falls through to index.html, so guard
      // against a non-JSON response instead of crashing on JSON.parse.
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        throw new Error(
          'The favicon checker runs on the deployed site — it’s not available on this local static server.',
        );
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Check failed');
      this.setState({ checkResult: data });
    } catch (e: any) {
      this.setState({ checkError: e?.message || 'Could not check that site' });
    } finally {
      this.setState({ checkLoading: false });
    }
  };

  /** Download a found icon via the same-origin proxy (works under COEP). */
  private downloadIcon = async (href: string) => {
    try {
      const res = await fetch(
        '/api/favicon-img?url=' + encodeURIComponent(href),
      );
      if (!res.ok) throw new Error('Fetch failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = href.split('/').pop()?.split('?')[0] || 'favicon';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      this.props.showSnack("Couldn't download that icon");
    }
  };

  render({ onModeChange, onBack }: Props, s: State) {
    return (
      <div class={style.page}>
        <input
          ref={(el: HTMLInputElement | null) => {
            this.fileInput = el ?? undefined;
          }}
          type="file"
          accept="image/*"
          class={style.hide}
          onChange={this.onPickImage}
        />
        <ToolNav active="favicon" onModeChange={onModeChange} onBack={onBack} />

        <div class={style.toolbar}>
          <div
            class={style.modeToggle}
            role="tablist"
            aria-label="Favicon mode"
          >
            {(['text', 'emoji', 'image', 'check'] as InputMode[]).map((m) => (
              <button
                class={`${style.modeTab}${
                  s.inputMode === m ? ' ' + style.modeTabActive : ''
                }`}
                role="tab"
                aria-selected={s.inputMode === m}
                onClick={() => this.setState({ inputMode: m })}
              >
                {m === 'text'
                  ? 'Text'
                  : m === 'emoji'
                  ? 'Emoji'
                  : m === 'image'
                  ? 'Image'
                  : 'Check site'}
              </button>
            ))}
          </div>
        </div>

        <section class={style.body}>
          {s.inputMode === 'check' ? (
            <div class={style.checker}>
              <div class={style.checkForm}>
                <input
                  class={style.checkInput}
                  type="text"
                  placeholder="example.com or https://example.com"
                  value={s.checkUrl}
                  onInput={(e: Event) =>
                    this.setState({
                      checkUrl: (e.target as HTMLInputElement).value,
                    })
                  }
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter') this.runCheck();
                  }}
                />
                <button
                  class={style.checkBtn}
                  onClick={this.runCheck}
                  disabled={s.checkLoading || !s.checkUrl.trim()}
                >
                  {s.checkLoading ? 'Checking…' : 'Check'}
                </button>
              </div>
              <p class={style.checkNote}>
                Fetches the site server-side and lists every favicon it declares
                — including apple-touch-icon, SVG, and the PWA manifest. The
                target URL passes through Smoosh's server, not your browser's
                history.
              </p>

              {s.checkError && (
                <div class={style.checkError}>{s.checkError}</div>
              )}

              {s.checkResult && (
                <div class={style.checkResults}>
                  <div class={style.checkMeta}>
                    <strong>
                      {s.checkResult.title || s.checkResult.finalUrl}
                    </strong>
                    <span>{s.checkResult.finalUrl}</span>
                  </div>
                  <div class={style.iconGrid}>
                    {s.checkResult.icons.map((ic) => (
                      <div class={style.iconCard}>
                        <img
                          class={style.iconImg}
                          src={
                            '/api/favicon-img?url=' +
                            encodeURIComponent(ic.href)
                          }
                          alt={ic.rel || 'icon'}
                          onError={(e: Event) => {
                            (
                              e.currentTarget as HTMLImageElement
                            ).style.opacity = '0.2';
                          }}
                        />
                        <div class={style.iconInfo}>
                          <span class={style.iconRel}>{ic.rel || 'icon'}</span>
                          <span class={style.iconSize}>
                            {ic.sizes || ic.type || '—'}
                          </span>
                        </div>
                        <button
                          class={style.iconDl}
                          onClick={() => this.downloadIcon(ic.href)}
                        >
                          ↓
                        </button>
                      </div>
                    ))}
                    {s.checkResult.manifestIcons.map((ic) => (
                      <div class={style.iconCard}>
                        <img
                          class={style.iconImg}
                          src={
                            '/api/favicon-img?url=' +
                            encodeURIComponent(ic.href)
                          }
                          alt="manifest icon"
                          onError={(e: Event) => {
                            (
                              e.currentTarget as HTMLImageElement
                            ).style.opacity = '0.2';
                          }}
                        />
                        <div class={style.iconInfo}>
                          <span class={style.iconRel}>manifest</span>
                          <span class={style.iconSize}>
                            {ic.sizes || ic.type || '—'}
                          </span>
                        </div>
                        <button
                          class={style.iconDl}
                          onClick={() => this.downloadIcon(ic.href)}
                        >
                          ↓
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Fragment>
              <div class={style.previewCol}>
                <div class={style.previewStage}>
                  <canvas
                    class={style.preview}
                    ref={(el: HTMLCanvasElement | null) => {
                      this.preview = el ?? undefined;
                    }}
                  />
                </div>
                <div class={style.sizeRow}>
                  {MINI_SIZES.map((sz) => (
                    <div class={style.sizeTile}>
                      <canvas ref={(e: any) => this.bindMini(e, sz)} />
                    </div>
                  ))}
                </div>
                <p class={style.previewHint}>
                  Live preview · 512 px master (shown at 256) · 64 / 48 / 32 /
                  16 px actual size
                </p>
              </div>

              <aside class={style.panel}>
                <div class={style.panelBody}>
                  <h3 class={style.panelTitle}>
                    {s.inputMode === 'text'
                      ? 'Text favicon'
                      : s.inputMode === 'emoji'
                      ? 'Emoji favicon'
                      : 'Image favicon'}
                  </h3>

                  {s.inputMode === 'text' && (
                    <label class={style.field}>
                      <span>Text</span>
                      <input
                        class={style.textInput}
                        type="text"
                        maxLength={4}
                        value={s.text}
                        onInput={(e: Event) =>
                          this.setState({
                            text: (e.target as HTMLInputElement).value,
                          })
                        }
                        placeholder="1–4 chars"
                      />
                    </label>
                  )}
                  {s.inputMode === 'emoji' && (
                    <label class={style.field}>
                      <span>Emoji</span>
                      <input
                        class={style.textInput}
                        type="text"
                        value={s.emoji}
                        onInput={(e: Event) =>
                          this.setState({
                            emoji: (e.target as HTMLInputElement).value,
                          })
                        }
                      />
                    </label>
                  )}
                  {s.inputMode === 'image' && (
                    <button
                      class={style.uploadBtn}
                      onClick={() => this.fileInput?.click()}
                    >
                      {s.imageName ? `Change: ${s.imageName}` : 'Choose image'}
                    </button>
                  )}

                  {s.inputMode === 'text' && (
                    <label class={style.field}>
                      <span>Font</span>
                      <select
                        class={style.select}
                        value={s.fontFamily}
                        onChange={(e: Event) =>
                          this.setState({
                            fontFamily: (e.target as HTMLSelectElement).value,
                          })
                        }
                      >
                        {FONTS.map((f) => (
                          <option value={f.value}>{f.label}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {s.inputMode === 'text' && (
                    <label class={style.field}>
                      <span>Text color</span>
                      <input
                        class={style.colorInput}
                        type="color"
                        value={s.textColor}
                        onInput={(e: Event) =>
                          this.setState({
                            textColor: (e.target as HTMLInputElement).value,
                          })
                        }
                      />
                    </label>
                  )}
                  <label class={style.checkRow}>
                    <input
                      type="checkbox"
                      checked={s.bgEnabled}
                      onChange={() =>
                        this.setState({ bgEnabled: !s.bgEnabled })
                      }
                    />
                    <span>Background fill</span>
                  </label>
                  {s.bgEnabled && (
                    <label class={style.field}>
                      <span>Background</span>
                      <input
                        class={style.colorInput}
                        type="color"
                        value={s.bgColor}
                        onInput={(e: Event) =>
                          this.setState({
                            bgColor: (e.target as HTMLInputElement).value,
                          })
                        }
                      />
                    </label>
                  )}
                  <div class={style.shapeRow}>
                    <span class={style.shapeLabel}>Shape</span>
                    {(['square', 'rounded', 'circle'] as Shape[]).map((sh) => (
                      <button
                        class={`${style.shapeBtn}${
                          s.shape === sh ? ' ' + style.shapeBtnActive : ''
                        }`}
                        onClick={() => this.setState({ shape: sh })}
                      >
                        {sh}
                      </button>
                    ))}
                  </div>

                  <div class={style.snippetBox}>
                    <div class={style.snippetHead}>
                      <span>HTML for your &lt;head&gt;</span>
                      <button class={style.copyBtn} onClick={this.copySnippet}>
                        Copy
                      </button>
                    </div>
                    <pre class={style.snippet}>{HTML_SNIPPET}</pre>
                  </div>
                </div>

                <div class={style.exportBox}>
                  <button
                    class={style.generateBtn}
                    onClick={this.generate}
                    disabled={s.generating}
                  >
                    {s.generating
                      ? 'Generating…'
                      : 'Download favicon package (.zip)'}
                  </button>
                  <p class={style.includes}>
                    favicon.ico (16/32/48) · PNG 16–256 px · apple-touch-icon
                    180 · android 192/512 · webmanifest
                  </p>
                </div>
              </aside>
            </Fragment>
          )}
        </section>

        <Footer onOpenTool={onModeChange} />
      </div>
    );
  }

  // Mini canvases for the actual-size preview row. Refs re-run every render,
  // so registration must dedupe and drop disconnected canvases (switching to
  // the "Check site" tab and back remounts them all).
  private miniCanvases: { size: number; el: HTMLCanvasElement }[] = [];
  private miniRaf = 0;
  private bindMini(el: HTMLCanvasElement | null, size: number) {
    if (!el || this.miniCanvases.some((mc) => mc.el === el)) return;
    el.width = size;
    el.height = size;
    el.style.width = `${Math.max(size, 24)}px`;
    el.style.height = `${Math.max(size, 24)}px`;
    this.miniCanvases = this.miniCanvases.filter((mc) => mc.el.isConnected);
    this.miniCanvases.push({ size, el });
    cancelAnimationFrame(this.miniRaf);
    this.miniRaf = requestAnimationFrame(() => this.drawPreview());
  }
}
