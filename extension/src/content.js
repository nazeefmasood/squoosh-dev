// Content script for Gemini and ChatGPT.
//
// Watches the chat stream for generated images and attaches action buttons
// (Remove watermark / Compress). Clicking a button fetches the image, hands
// the blob to the extension worker for processing, then auto-downloads the
// result. Everything runs locally.
const SITE = location.hostname.includes('chatgpt')
  ? 'chatgpt'
  : location.hostname.includes('gemini')
  ? 'gemini'
  : null;

if (SITE) {
  init();
}

// Gemini's images carry an invisible watermark; ChatGPT's don't. Both can be
// compressed. The available actions per site:
const ACTIONS = {
  gemini: [
    {
      mode: 'watermark',
      format: 'image/png',
      label: 'Remove watermark',
      variant: 'primary',
    },
    {
      mode: 'compress',
      format: 'image/webp',
      label: 'Compress',
      variant: 'ghost',
    },
  ],
  chatgpt: [
    {
      mode: 'compress',
      format: 'image/webp',
      label: 'Compress',
      variant: 'primary',
    },
  ],
}[SITE];

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  const url = chrome.runtime.getURL('worker.js');
  worker = new Worker(url, { type: 'module' });
  worker.onmessage = (e) => {
    const { id, blob, error } = e.data || {};
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(error ? { error } : { blob });
  };
  worker.onerror = (e) => {
    // Fail every pending job — the worker is dead.
    for (const [, resolve] of pending)
      resolve({ error: e.message || 'worker error' });
    pending.clear();
    worker = null;
  };
  return worker;
}

function process(blob, action) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage(
      {
        id,
        blob,
        mode: action.mode,
        options: { format: action.format, quality: 0.9 },
      },
      [blob],
    );
  });
}

/** Only treat sizeable in-chat images as targets (skip avatars, icons, emojis). */
function isGeneratedImage(img) {
  if (!img.src) return false;
  const r = img.getBoundingClientRect();
  if (r.width < 160 || r.height < 160) return false;
  // Avoid tiny UI sprites and the app chrome.
  if (img.closest('svg')) return false;
  return true;
}

function attach(img) {
  if (img.dataset.smoosh) return;
  img.dataset.smoosh = '1';
  // Wrap so the button can be positioned over the image and follow layout.
  const wrap =
    img.parentElement?.dataset?.smooshWrap === '1'
      ? img.parentElement
      : makeWrap(img);
  mountButtons(wrap);
}

function makeWrap(img) {
  const parent = img.parentElement;
  const wrap = document.createElement('div');
  wrap.dataset.smooshWrap = '1';
  wrap.style.cssText = 'position:relative;display:inline-block;max-width:100%';
  parent.insertBefore(wrap, img);
  wrap.appendChild(img);
  return wrap;
}

function mountButtons(wrap) {
  const bar = document.createElement('div');
  bar.className = 'smoosh-bar';
  for (const action of ACTIONS) {
    const btn = document.createElement('button');
    btn.className =
      'smoosh-btn' + (action.variant === 'ghost' ? ' smoosh-btn--ghost' : '');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onAction(wrap, action, btn);
    });
    bar.appendChild(btn);
  }
  wrap.appendChild(bar);
}

async function onAction(wrap, action, btn) {
  const img = wrap.querySelector('img');
  if (!img || btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const original = btn.textContent;
  btn.textContent = 'Working…';
  try {
    const blob = await fetchImage(img);
    const result = await process(blob, action);
    if (result.error) throw new Error(result.error);
    download(result.blob, img, action);
  } catch (err) {
    console.error('[Smoosh]', err);
    btn.textContent = 'Failed';
    setTimeout(() => (btn.textContent = original), 1500);
  } finally {
    btn.dataset.busy = '';
    if (btn.textContent === 'Working…') btn.textContent = original;
  }
}

async function fetchImage(img) {
  // Prefer the current src; fall back to the densest srcset candidate.
  let url = img.currentSrc || img.src;
  if (!url && img.srcset) {
    const candidates = img.srcset.split(',').map((s) => s.trim().split(' ')[0]);
    url = candidates[candidates.length - 1];
  }
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return res.blob();
}

function download(blob, img, action) {
  const ext = extForType(blob.type);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const tag = action.mode === 'watermark' ? 'clean' : 'compressed';
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `smoosh-${tag}-${stamp}${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function extForType(type) {
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  return '.png';
}

function scan(root = document.body) {
  for (const img of root.querySelectorAll('img')) {
    if (isGeneratedImage(img)) attach(img);
  }
}

function init() {
  injectStyles();
  scan();
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG' && isGeneratedImage(node)) attach(node);
        else if (node.querySelectorAll) scan(node);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function injectStyles() {
  if (document.getElementById('smoosh-style')) return;
  const css = document.createElement('style');
  css.id = 'smoosh-style';
  // Mirrors the Smoosh site design system (see src/shared/prerendered-app/colors.css):
  // brand-gradient pill with ink-black text for primary actions, hairline-bordered
  // ghost for secondary, weight 400 (never bold), Switzer/Inter type.
  css.textContent = `
.smoosh-bar{position:absolute;left:10px;bottom:10px;display:flex;gap:8px;opacity:0;transition:opacity .15s ease;z-index:2147483646}
[data-smoosh-wrap="1"]:hover .smoosh-bar,[data-smoosh-wrap="1"]:focus-within .smoosh-bar{opacity:1}
.smoosh-btn{appearance:none;-webkit-appearance:none;font-family:'Switzer','Inter','Söhne',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:400;line-height:1;color:#000;background:linear-gradient(135deg,#4ecdc4 0%,#45b7d1 28%,#ff6b6b 58%,#ffa07a 80%,#ffd700 100%);border:0;border-radius:999px;padding:8px 16px;cursor:pointer;white-space:nowrap;box-shadow:0 0 0 1px rgba(255,255,255,.35),0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease,filter .15s ease}
.smoosh-btn:hover{transform:translateY(-1px);filter:saturate(1.12) brightness(1.03)}
.smoosh-btn:active{transform:none}
.smoosh-btn[data-busy="1"]{opacity:.65;cursor:progress;transform:none;filter:grayscale(.3)}
.smoosh-btn--ghost{background:rgba(255,254,247,.9);backdrop-filter:blur(6px);color:#666;border:1px solid #aaa}
.smoosh-btn--ghost:hover{color:#000;border-color:#000;filter:none}
`;
  document.head.appendChild(css);
}
