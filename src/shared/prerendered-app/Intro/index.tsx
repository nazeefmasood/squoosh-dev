import { h, Component } from 'preact';

import logoIcon from 'url:static-build/assets/brand/smoosh-icon.png';
import logoFull from 'url:static-build/assets/brand/smoosh-full.png';
import * as style from './style.css';

const githubLogoInline =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  );

const currentYear = new Date().getFullYear();
import type SnackBarElement from 'shared/custom-els/snack-bar';
import 'shared/custom-els/snack-bar';

const supportedFormats = ['JPEG', 'PNG', 'WebP', 'AVIF', 'JXL', 'WP2', 'GIF'];

const installButtonSource = 'introInstallButton-Purple';
const supportsClipboardAPI =
  !__PRERENDER__ && navigator.clipboard && navigator.clipboard.read;

async function getImageClipboardItem(
  items: ClipboardItem[],
): Promise<undefined | Blob> {
  for (const item of items) {
    const type = item.types.find((type) => type.startsWith('image/'));
    if (type) return item.getType(type);
  }
}

type Tool = 'compress' | 'watermark';

interface Props {
  tool?: Tool;
  onToolChange?: (tool: Tool) => void;
  onFile?: (file: File) => void;
  onFiles?: (files: File[]) => void;
  showSnack?: SnackBarElement['showSnackbar'];
}
interface State {
  beforeInstallEvent?: BeforeInstallPromptEvent;
  dragging: boolean;
}

export default class Intro extends Component<Props, State> {
  state: State = { dragging: false };
  private fileInput?: HTMLInputElement;
  private installingViaButton = false;

  componentDidMount() {
    window.addEventListener(
      'beforeinstallprompt',
      this.onBeforeInstallPromptEvent,
    );
    window.addEventListener('appinstalled', this.onAppInstalled);
  }

  componentWillUnmount() {
    window.removeEventListener(
      'beforeinstallprompt',
      this.onBeforeInstallPromptEvent,
    );
    window.removeEventListener('appinstalled', this.onAppInstalled);
  }

  private emitFiles(files: File[]) {
    if (!files.length) return;
    if (this.props.onFiles) {
      this.props.onFiles(files);
    } else {
      this.props.onFile!(files[0]);
    }
  }

  private onFileChange = (event: Event): void => {
    const fileInput = event.target as HTMLInputElement;
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    this.fileInput!.value = '';
    this.emitFiles(files);
  };

  private onOpenClick = () => {
    this.fileInput!.click();
  };

  private onDrop = (event: DragEvent) => {
    event.preventDefault();
    this.setState({ dragging: false });
    const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    );
    this.emitFiles(files);
  };

  private onDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (!this.state.dragging) this.setState({ dragging: true });
  };

  private onDragLeave = (event: DragEvent) => {
    event.preventDefault();
    this.setState({ dragging: false });
  };

  private onBeforeInstallPromptEvent = (event: BeforeInstallPromptEvent) => {
    event.preventDefault();
    this.setState({ beforeInstallEvent: event });
    const gaEventInfo = {
      eventCategory: 'pwa-install',
      eventAction: 'promo-shown',
      nonInteraction: true,
    };
    ga('send', 'event', gaEventInfo);
  };

  private onInstallClick = async () => {
    const beforeInstallEvent = this.state.beforeInstallEvent;
    if (!beforeInstallEvent) return;
    this.installingViaButton = true;
    beforeInstallEvent.prompt();
    const { outcome } = await beforeInstallEvent.userChoice;
    const gaEventInfo = {
      eventCategory: 'pwa-install',
      eventAction: 'promo-clicked',
      eventLabel: installButtonSource,
      eventValue: outcome === 'accepted' ? 1 : 0,
    };
    ga('send', 'event', gaEventInfo);
    if (outcome === 'dismissed') {
      this.installingViaButton = false;
    }
  };

  private onAppInstalled = () => {
    this.setState({ beforeInstallEvent: undefined });
    if (document.hidden) return;
    const source = this.installingViaButton ? installButtonSource : 'browser';
    ga('send', 'event', 'pwa-install', 'installed', source);
    this.installingViaButton = false;
  };

  private onPasteClick = async () => {
    let clipboardItems: ClipboardItem[];
    try {
      clipboardItems = await navigator.clipboard.read();
    } catch (err) {
      this.props.showSnack!(`No permission to access clipboard`);
      return;
    }
    const blob = await getImageClipboardItem(clipboardItems);
    if (!blob) {
      this.props.showSnack!(`No image found in the clipboard`);
      return;
    }
    this.emitFiles([new File([blob], 'image.unknown')]);
  };

  render(
    { tool = 'compress', onToolChange }: Props,
    { beforeInstallEvent, dragging }: State,
  ) {
    return (
      <div class={style.intro}>
        <input
          class={style.hide}
          ref={(el: HTMLInputElement | null) => {
            this.fileInput = el ?? undefined;
          }}
          type="file"
          multiple
          accept="image/*"
          onChange={this.onFileChange}
        />

        <nav class={style.nav}>
          <a class={style.wordmark} href="/">
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
            {supportsClipboardAPI && (
              <button class={style.pasteBtn} onClick={this.onPasteClick}>
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect
                    x="8"
                    y="3"
                    width="8"
                    height="4"
                    rx="1.5"
                    stroke="currentColor"
                    stroke-width="2"
                  />
                  <path
                    d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linejoin="round"
                  />
                </svg>
                Paste
              </button>
            )}
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
            Compress images. <span class={style.accent}>Fast, private,</span>{' '}
            pixel-perfect.
          </h1>
          <p class={style.heroSub}>
            Smoosh shrinks and converts images with industry codecs — right in
            your browser. Your files never leave your device. Compare codecs
            side by side and batch a whole folder at once.
          </p>

          {onToolChange && (
            <div class={style.toolToggle} role="tablist" aria-label="Tool">
              <button
                class={`${style.toolTab}${
                  tool === 'compress' ? ' ' + style.toolTabActive : ''
                }`}
                role="tab"
                aria-selected={tool === 'compress'}
                onClick={() => onToolChange('compress')}
              >
                Compress
              </button>
              <button
                class={`${style.toolTab}${
                  tool === 'watermark' ? ' ' + style.toolTabActive : ''
                }`}
                role="tab"
                aria-selected={tool === 'watermark'}
                onClick={() => onToolChange('watermark')}
              >
                Watermark remover
              </button>
            </div>
          )}

          <div
            class={`${style.dropzone}${dragging ? ' ' + style.dragging : ''}`}
            onClick={this.onOpenClick}
            onDrop={this.onDrop}
            onDragOver={this.onDragOver}
            onDragLeave={this.onDragLeave}
            role="button"
            tabIndex={0}
          >
            <div class={style.dropzoneInner}>
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
              <div class={style.dropTitle}>Drop images here</div>
              <div class={style.dropHint}>
                or <span class={style.browse}>browse files</span>
                {supportsClipboardAPI ? ' · paste from clipboard' : ''}
              </div>
              <div class={style.dropActions}>
                <button
                  class={`${style.btn} ${style.btnPrimary}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    this.onOpenClick();
                  }}
                >
                  Select images
                </button>
              </div>
              <div class={style.formats}>
                {supportedFormats.map((f) => (
                  <span class={style.format}>{f}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section class={style.features}>
          <div class={style.featuresGrid}>
            <div class={style.feature}>
              <div class={style.featureIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4M12 4v10m0 0 4-4m-4 4-4-4"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
              <h3>Dramatically smaller</h3>
              <p>
                Cut file sizes by up to 90% with modern codecs like AVIF, WebP
                and JXL — without the visible quality loss.
              </p>
            </div>
            <div class={style.feature}>
              <div class={style.featureIcon} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M8 3H6a2 2 0 0 0-2 2v2m12-4h2a2 2 0 0 1 2 2v2M8 21H6a2 2 0 0 1-2-2v-2m12 4h2a2 2 0 0 0 2-2v-2"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  />
                  <path
                    d="m9 12 2 2 4-4"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
              <h3>Compare side by side</h3>
              <p>
                A built-in before / after slider shows exactly what each codec
                and quality setting costs you, pixel for pixel.
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
                Every conversion runs locally with WebAssembly. No uploads, no
                servers, no tracking — your images stay on your machine.
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
                height="40"
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

        {beforeInstallEvent && (
          <button class={style.installBtn} onClick={this.onInstallClick}>
            Install
          </button>
        )}
      </div>
    );
  }
}
