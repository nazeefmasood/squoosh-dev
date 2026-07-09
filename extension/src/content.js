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

// Gemini's images carry an invisible watermark; ChatGPT's don't. Both can be
// compressed. Each action hands the image off to the Smoosh website, which
// already has proven watermark-removal and compression tools.
const ACTIONS = {
  gemini: [
    {
      tool: 'watermark',
      label: 'Remove watermark',
      variant: 'primary',
    },
    {
      tool: 'compress',
      label: 'Compress',
      variant: 'ghost',
    },
  ],
  chatgpt: [
    {
      tool: 'compress',
      label: 'Compress',
      variant: 'primary',
    },
  ],
}[SITE];

// Hand the image to the Smoosh website: stash the bytes in extension storage,
// then ask the background to open the site in the right tool. A content script
// on smoosh-dev.vercel.app picks the image up and drops it into the site's
// own file handler — reusing the site's proven pipeline end to end.
async function handoff(blob, el, action) {
  const buffer = await blob.arrayBuffer();
  await chrome.storage.local.set({
    smooshHandoff: {
      buffer,
      mimeType: blob.type || 'image/png',
      name: nameFor(el, blob),
      tool: action.tool,
    },
  });
  await new Promise((resolve) =>
    chrome.runtime.sendMessage(
      { type: 'smoosh-open-site', tool: action.tool },
      () => resolve(),
    ),
  );
}

function nameFor(el, blob) {
  const url = srcOf(el) || '';
  const fromUrl = url.split('/').pop()?.split('?')[0];
  const ext =
    (blob.type.includes('png') && '.png') ||
    (blob.type.includes('webp') && '.webp') ||
    (blob.type.includes('jpeg') && '.jpg') ||
    '.png';
  if (fromUrl && /\.[a-z0-9]{2,5}$/i.test(fromUrl)) return fromUrl;
  return `smoosh-image${ext}`;
}

/**
 * A candidate generated image: sizeable (<img> with real layout, or a big
 * background-image element) that isn't an avatar/icon. SPAs like Gemini lazy-
 * layout images, so an element may need a few frames before it qualifies —
 * the periodic rescan retries it.
 */
const MIN = 140;
function isCandidate(el) {
  if (!el || el.closest?.('[data-smoosh-wrap="1"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < MIN || r.height < MIN) return false;
  if (el.tagName === 'IMG') {
    if (!el.src && !el.currentSrc && !el.srcset) return false;
    return true;
  }
  // Background-image on a non-img node (some chat UIs render art this way).
  const bg = getComputedStyle(el).backgroundImage;
  if (bg && bg !== 'none' && bg.includes('url')) return true;
  return false;
}

function srcOf(el) {
  if (el.tagName === 'IMG') {
    return (
      el.currentSrc ||
      el.src ||
      (el.srcset && el.srcset.split(',')[0].trim().split(' ')[0]) ||
      ''
    );
  }
  const m = (getComputedStyle(el).backgroundImage.match(
    /url\((['"]?)([^'")]+)\1\)/,
  ) || [])[2];
  return m || '';
}

function attach(el) {
  if (el.dataset?.smoosh) return;
  if (el.dataset) el.dataset.smoosh = '1';
  else el.setAttribute('data-smoosh', '1');
  const wrap =
    el.parentElement?.dataset?.smooshWrap === '1'
      ? el.parentElement
      : makeWrap(el);
  mountButtons(wrap, el);
}

function makeWrap(el) {
  const parent = el.parentElement;
  const wrap = document.createElement('div');
  wrap.dataset.smooshWrap = '1';
  wrap.style.cssText = 'position:relative;display:inline-block;max-width:100%';
  parent.insertBefore(wrap, el);
  wrap.appendChild(el);
  return wrap;
}

function mountButtons(wrap, el) {
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
      onAction(el, action, btn);
    });
    bar.appendChild(btn);
  }
  wrap.appendChild(bar);
}

async function onAction(el, action, btn) {
  if (btn.dataset.busy) return;
  btn.dataset.busy = '1';
  const original = btn.textContent;
  btn.textContent = 'Opening…';
  try {
    const blob = await fetchImage(el);
    await handoff(blob, el, action);
    btn.textContent = 'Opened in Smoosh ✓';
    setTimeout(() => (btn.textContent = original), 1800);
  } catch (err) {
    console.error('[Smoosh]', err);
    btn.textContent = 'Failed';
    setTimeout(() => (btn.textContent = original), 1800);
  } finally {
    btn.dataset.busy = '';
    if (btn.textContent === 'Opening…') btn.textContent = original;
  }
}

async function fetchImage(el) {
  const url = srcOf(el);
  if (!url) throw new Error('no image src');
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return res.blob();
}

/** Collect candidate elements, piercing open shadow roots (Gemini uses them). */
function deepQueryAll(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || !node.querySelectorAll) continue;
    for (const el of node.querySelectorAll(
      'img, [style*="background-image"], [style*="background"]',
    )) {
      out.push(el);
    }
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }
  return out;
}

function scan() {
  let attached = 0;
  for (const el of deepQueryAll(document.body)) {
    if (isCandidate(el) && !el.dataset?.smoosh) {
      attach(el);
      attached++;
    }
  }
  return attached;
}

/** Diagnostics for the popup. */
function stats() {
  const imgs = deepQueryAll(document.body);
  let big = 0;
  for (const el of imgs) {
    const r = el.getBoundingClientRect();
    if (r.width >= MIN && r.height >= MIN) big++;
  }
  let buttons = document.querySelectorAll('.smoosh-btn').length;
  return {
    site: SITE,
    host: location.host,
    images: imgs.filter((e) => e.tagName === 'IMG').length,
    bigCandidates: big,
    buttonsAttached: buttons,
  };
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

/**
 * Debounce scanning. Gemini/ChatGPT fire hundreds of mutations per second;
 * running a full DOM walk on each one freezes the page. Coalesce into one
 * pass after things settle, scheduled when the browser is idle.
 */
let scanTimer = null;
function scheduleScan(delay = 300) {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    const run = () => scan();
    if ('requestIdleCallback' in window)
      window.requestIdleCallback(run, { timeout: 800 });
    else run();
  }, delay);
}

function init() {
  injectStyles();
  scheduleScan(0);
  // Only watch structural changes + image source swaps. Watching `style` on
  // the subtree is the single biggest source of mutation noise on these SPAs
  // and is not needed — layout settling is handled by the periodic fallback.
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length) {
        scheduleScan();
        break;
      }
      if (m.type === 'attributes') {
        scheduleScan();
        break;
      }
    }
  });
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset'],
  });
  // Slow fallback for images that gain layout without a mutation
  // (rare, but cheap at this cadence).
  setInterval(() => scheduleScan(0), 4000);
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'smoosh-ping') reply({ ok: true, site: SITE });
    if (msg?.type === 'smoosh-scan')
      reply({ attached: scan(), stats: stats() });
    return true;
  });
}

if (SITE) {
  init();
  // In case the document was already idle before injection, kick a scan.
  setTimeout(() => scheduleScan(0), 1500);
}

// Always answer pings even off-site, so the popup can detect "not on a page".
if (!SITE) {
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'smoosh-ping') reply({ ok: true, site: null });
    if (msg?.type === 'smoosh-scan') reply({ site: null });
    return true;
  });
}
