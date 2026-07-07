import { h } from 'preact';

import * as style from './style.css';
import 'add-css:./style.css';
import logoIcon from 'url:static-build/assets/brand/smoosh-icon.png';
import type { ToolMode } from '../Tool';

/** Every tool in the app, in nav order. Single source of truth. */
export const TOOLS: { mode: ToolMode; label: string }[] = [
  { mode: 'edit', label: 'Edit' },
  { mode: 'compress', label: 'Compress' },
  { mode: 'bgremove', label: 'Background remover' },
  { mode: 'watermark', label: 'Watermark remover' },
  { mode: 'metadata', label: 'EXIF strip' },
  { mode: 'favicon', label: 'Favicon' },
];

interface Props {
  active: ToolMode;
  onModeChange: (mode: ToolMode) => void;
  onBack: () => void;
}

/**
 * Shared top nav for every tool page. Centered to the design-system max-width
 * with the homepage gutter, and a horizontally-scrollable pill row so the tab
 * set never overflows as tools are added. This replaces the three duplicated
 * navs that previously lived in Tool / Editor / Favicon.
 */
export default function ToolNav({ active, onModeChange, onBack }: Props) {
  return (
    <nav class={style.nav}>
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

      <div class={style.tabsWrap}>
        <div class={style.tabs} role="tablist" aria-label="Tool">
          {TOOLS.map((t) => (
            <button
              class={`${style.tab}${
                active === t.mode ? ' ' + style.tabActive : ''
              }`}
              role="tab"
              aria-selected={active === t.mode}
              onClick={() => onModeChange(t.mode)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <button class={style.navLink} onClick={onBack} aria-label="Back to home">
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
    </nav>
  );
}
