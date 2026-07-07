import { h, Component, Fragment } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import logoIcon from 'url:static-build/assets/brand/smoosh-icon.png';
import type { ToolMode } from '../Tool';
import { zipFiles } from 'vendor/zip';
import { buildIco } from 'vendor/ico';
import type SnackBarElement from 'shared/custom-els/snack-bar';

interface Props {
  onModeChange: (mode: ToolMode) => void;
  onBack: () => void;
  showSnack: SnackBarElement['showSnackbar'];
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

const FONTS = [
  { label: 'Sans', value: 'var(--font-switzer), system-ui, sans-serif' },
  { label: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono', value: 'ui-monospace, Menlo, monospace' },
  {
    label: 'Rounded',
    value: '"SF Pro Rounded", "Avenir Next", system-ui, sans-serif',
  },
];

const MASTER = 512;
const SIZES = [16, 32, 48, 180, 192, 512];

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
    this.drawPreview();
  }
  componentDidUpdate(_: Props, prev: State) {
    const keys: (keyof State)[] = [
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

  /** Render the master favicon (512×512) with current settings. */
  private async renderMaster(): Promise<HTMLCanvasElement> {
    const canvas = document.createElement('canvas');
    canvas.width = MASTER;
    canvas.height = MASTER;
    const ctx = canvas.getContext('2d')!;
    const s = this.state;
    this.applyShape(ctx, s.shape);
    if (s.bgEnabled && s.inputMode !== 'image') {
      ctx.fillStyle = s.bgColor;
      ctx.fillRect(0, 0, MASTER, MASTER);
    } else if (s.inputMode === 'image' && s.imageSrc) {
      const img = await loadImageEl(s.imageSrc);
      // cover
      const scale = Math.max(MASTER / img.width, MASTER / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (MASTER - w) / 2, (MASTER - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, MASTER, MASTER);
    }

    if (s.inputMode === 'image') {
      ctx.restore();
      return canvas;
    }
    const content = s.inputMode === 'text' ? s.text : s.emoji;
    if (!content) {
      ctx.restore();
      return canvas;
    }
    // Auto-fit font size to the content width.
    ctx.fillStyle = s.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = MASTER * (s.inputMode === 'emoji' ? 0.8 : 0.62);
    if (s.inputMode === 'text' && content.length > 1)
      size *= 2 / content.length;
    ctx.font = `${Math.round(size)}px ${s.fontFamily}`;
    ctx.fillText(content, MASTER / 2, MASTER / 2 + size * 0.05);
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

  private async drawPreview() {
    const master = await this.renderMaster();
    const c = this.preview;
    if (!c) return;
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    (ctx as any).imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, 128, 128);
    ctx.drawImage(master, 0, 0, 128, 128);
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
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingEnabled = true;
        (ctx as any).imageSmoothingQuality = 'high';
        ctx.drawImage(master, 0, 0, size, size);
        pngs.push({ size, bytes: await canvasToPngBytes(c) });
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
      a.download = 'favicon-package.zip';
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
        <nav class={style.topnav}>
          <a
            class={style.wordmark}
            href="/"
            onClick={(e: Event) => {
              e.preventDefault();
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
              Favicon
            </button>
            <button
              class={style.tab}
              role="tab"
              onClick={() => onModeChange('edit')}
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
                  <div class={style.sizeTile}>
                    <canvas ref={(e: any) => this.bindMini(e, 48)} />
                  </div>
                  <div class={style.sizeTile}>
                    <canvas ref={(e: any) => this.bindMini(e, 32)} />
                  </div>
                  <div class={style.sizeTile}>
                    <canvas ref={(e: any) => this.bindMini(e, 16)} />
                  </div>
                </div>
                <p class={style.previewHint}>
                  Live preview · 128 / 48 / 32 / 16 px
                </p>
              </div>

              <aside class={style.panel}>
                <div class={style.panelBody}>
                  <h3 class={style.panelTitle}>Favicon generator</h3>
                  <div class={style.segToggle}>
                    {(['text', 'emoji', 'image', 'check'] as InputMode[]).map(
                      (m) => (
                        <button
                          class={`${style.segBtn}${
                            s.inputMode === m ? ' ' + style.segBtnActive : ''
                          }`}
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
                      ),
                    )}
                  </div>

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

                  {s.inputMode !== 'image' && (
                    <Fragment>
                      {s.inputMode === 'text' && (
                        <label class={style.field}>
                          <span>Font</span>
                          <select
                            class={style.select}
                            value={s.fontFamily}
                            onChange={(e: Event) =>
                              this.setState({
                                fontFamily: (e.target as HTMLSelectElement)
                                  .value,
                              })
                            }
                          >
                            {FONTS.map((f) => (
                              <option value={f.value}>{f.label}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label class={style.field}>
                        <span>
                          {s.inputMode === 'text' ? 'Text color' : 'Color'}
                        </span>
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
                        {(['square', 'rounded', 'circle'] as Shape[]).map(
                          (sh) => (
                            <button
                              class={`${style.shapeBtn}${
                                s.shape === sh ? ' ' + style.shapeBtnActive : ''
                              }`}
                              onClick={() => this.setState({ shape: sh })}
                            >
                              {sh}
                            </button>
                          ),
                        )}
                      </div>
                    </Fragment>
                  )}

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
                    favicon.ico · 16/32 px PNG · apple-touch-icon · android
                    192/512 · webmanifest
                  </p>
                </div>
              </aside>
            </Fragment>
          )}
        </section>
      </div>
    );
  }

  // Mini canvases for the size preview row (rendered post-mount via effect).
  private miniCanvases: { size: number; el: HTMLCanvasElement }[] = [];
  private bindMini(el: HTMLCanvasElement | null, size: number) {
    if (!el) return;
    el.width = size;
    el.height = size;
    el.style.width = `${Math.max(size, 24)}px`;
    el.style.height = `${Math.max(size, 24)}px`;
    this.miniCanvases.push({ size, el });
    requestAnimationFrame(() => this.drawMinis());
  }
  private async drawMinis() {
    const master = await this.renderMaster();
    for (const { size, el } of this.miniCanvases) {
      const ctx = el.getContext('2d')!;
      ctx.imageSmoothingEnabled = true;
      (ctx as any).imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(master, 0, 0, size, size);
    }
  }
}
