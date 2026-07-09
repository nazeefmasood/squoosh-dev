/**
 * Favicon checker — serverless.
 *
 * Same-origin under the app's COEP header, so the client can fetch this and
 * display results. Fetches the target site server-side, parses <link> icon
 * tags + the webmanifest, and returns the list of favicons found. The client
 * can't fetch the (cross-origin) icons directly under require-corp, so icon
 * display/download goes through /api/favicon-img.
 *
 * POST { url }  or  GET ?url=
 * -> { finalUrl, title, icons: [{rel,href,sizes,type}], manifestIcons: [...] }
 */
import { assertSafeUrl } from './_ssrf';

export interface FaviconIcon {
  rel?: string;
  href: string;
  sizes?: string;
  type?: string;
  /** Actual byte size, when the icon was fetched for measurement. */
  bytes?: number;
}

export interface CheckResult {
  finalUrl: string;
  title: string;
  icons: FaviconIcon[];
  manifestIcons: FaviconIcon[];
}

function normalizeUrl(input: string): string {
  let u = (input || '').trim();
  if (!u) throw new Error('Empty URL');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function extractIcons(html: string, baseUrl: string): FaviconIcon[] {
  const icons: FaviconIcon[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
    if (!/icon|apple-touch|mask|fluid|shortcut/i.test(rel)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const sizes = (tag.match(/sizes=["']([^"']+)["']/i) || [])[1] || '';
    const type = (tag.match(/type=["']([^"']+)["']/i) || [])[1] || '';
    try {
      icons.push({
        rel: rel.trim(),
        href: new URL(href, baseUrl).href,
        sizes,
        type,
      });
    } catch {
      /* ignore bad hrefs */
    }
  }
  const seen = new Set<string>();
  return icons.filter((i) =>
    seen.has(i.href) ? false : (seen.add(i.href), true),
  );
}

// Well-known icon locations sites often serve without declaring — this is
// where the high-res variants usually live.
const PROBE_PATHS = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/apple-touch-icon-180x180.png',
  '/favicon.svg',
  '/favicon-96x96.png',
  '/favicon-192x192.png',
  '/favicon-512x512.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/mstile-150x150.png',
];

/** Sniff pixel dimensions from the first bytes of PNG/GIF/ICO/JPEG/SVG. */
function imageDims(buf: Uint8Array, contentType: string): string {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    // PNG — IHDR width/height at offsets 16/20
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return `${dv.getUint32(16)}x${dv.getUint32(20)}`;
  }
  if (
    buf.length > 10 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    // GIF
    return `${buf[6] | (buf[7] << 8)}x${buf[8] | (buf[9] << 8)}`;
  }
  if (
    buf.length > 6 &&
    buf[0] === 0 &&
    buf[1] === 0 &&
    buf[2] === 1 &&
    buf[3] === 0
  ) {
    // ICO — list every embedded size
    const n = buf[4] | (buf[5] << 8);
    const sizes: string[] = [];
    for (let i = 0; i < n && 6 + i * 16 + 16 <= buf.length; i++) {
      const o = 6 + i * 16;
      sizes.push(`${buf[o] || 256}x${buf[o + 1] || 256}`);
    }
    return sizes.join(' ');
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG — scan for a SOF marker
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return `${(buf[i + 7] << 8) | buf[i + 8]}x${
          (buf[i + 5] << 8) | buf[i + 6]
        }`;
      }
      i += 2 + ((buf[i + 2] << 8) | buf[i + 3]);
    }
    return '';
  }
  if (/svg/i.test(contentType)) return 'SVG · scalable';
  return '';
}

/** Largest pixel area an icon advertises; SVG sorts above everything. */
function iconArea(sizes: string | undefined): number {
  if (!sizes) return 0;
  if (/svg/i.test(sizes)) return Number.MAX_SAFE_INTEGER;
  let best = 0;
  for (const m of sizes.matchAll(/(\d+)x(\d+)/gi)) {
    best = Math.max(best, +m[1] * +m[2]);
  }
  return best;
}

/**
 * Fetch an icon and fill in its real dimensions + byte size. Returns null
 * when the URL doesn't resolve to an image.
 */
async function measureIcon(icon: FaviconIcon): Promise<FaviconIcon | null> {
  try {
    assertSafeUrl(icon.href);
    const res = await fetchWithTimeout(icon.href, 6000);
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
    // Some servers return HTML soft-404s with 200 — sniff before trusting.
    const dims = imageDims(buf, ct);
    if (!dims && !ct.startsWith('image/')) return null;
    return { ...icon, sizes: dims || icon.sizes || '', bytes: buf.length };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SmooshFaviconBot/1.0)',
      },
    });
  } finally {
    clearTimeout(t);
  }
}

async function check(input: string): Promise<CheckResult> {
  const url = normalizeUrl(input);
  assertSafeUrl(url); // SSRF guard
  const res = await fetchWithTimeout(url, 10000);
  if (!res.ok) throw new Error('Unreachable');
  const finalUrl = res.url;
  assertSafeUrl(finalUrl); // re-check after redirects
  const html = await res.text();
  const title = (
    (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || ''
  ).trim();
  let icons = extractIcons(html, finalUrl);

  // Always include the conventional /favicon.ico fallback.
  const icoUrl = new URL('/favicon.ico', finalUrl).href;
  if (!icons.some((i) => i.href === icoUrl)) {
    icons.push({ rel: 'icon', href: icoUrl, sizes: '', type: 'image/x-icon' });
  }

  // Probe the well-known high-res locations sites serve without declaring.
  const declared = new Set(icons.map((i) => i.href));
  const probes: FaviconIcon[] = [];
  for (const p of PROBE_PATHS) {
    try {
      const href = new URL(p, finalUrl).href;
      if (!declared.has(href)) probes.push({ rel: 'discovered', href });
    } catch {
      /* ignore */
    }
  }

  // Resolve the webmanifest, if declared, for the full PWA icon set.
  const mani = icons.find((i) => /manifest/i.test(i.rel || ''));
  let manifestIcons: FaviconIcon[] = [];
  if (mani) {
    try {
      assertSafeUrl(mani.href); // SSRF guard on manifest URL too
      const mj = await (await fetchWithTimeout(mani.href, 8000)).json();
      manifestIcons = (mj.icons || [])
        .map((i: any) => {
          const href = new URL(i.src, finalUrl).href;
          return { href, sizes: i.sizes || '', type: i.type || '' };
        })
        .filter((i: any) => {
          try {
            assertSafeUrl(i.href);
            return true;
          } catch {
            return false;
          }
        });
    } catch {
      /* manifest unreachable — ignore */
    }
  }

  // Fetch everything in parallel to confirm it exists and measure the real
  // pixel dimensions, then sort so the HD icons come first. The manifest
  // link itself isn't an image — keep it out of the measured grid.
  const linkIcons = icons.filter((i) => !/manifest/i.test(i.rel || ''));
  const seenHref = new Set(linkIcons.map((i) => i.href));
  manifestIcons = manifestIcons.filter(
    (i) => (seenHref.has(i.href) ? false : (seenHref.add(i.href), true)), // dedupe
  );
  const [measuredIcons, measuredProbes, measuredManifest] = await Promise.all([
    Promise.all(linkIcons.map(measureIcon)),
    Promise.all(probes.filter((p) => !seenHref.has(p.href)).map(measureIcon)),
    Promise.all(manifestIcons.map(measureIcon)),
  ]);
  const byAreaDesc = (a: FaviconIcon, b: FaviconIcon) =>
    iconArea(b.sizes) - iconArea(a.sizes);
  const finalIcons = [
    ...measuredIcons.filter((i): i is FaviconIcon => !!i),
    ...measuredProbes.filter((i): i is FaviconIcon => !!i),
  ].sort(byAreaDesc);
  const finalManifest = measuredManifest
    .filter((i): i is FaviconIcon => !!i)
    .sort(byAreaDesc);

  return {
    finalUrl,
    title,
    icons: finalIcons,
    manifestIcons: finalManifest,
  };
}

export default async function handler(req: any, res: any) {
  // CORS / CORP — same-origin, but be explicit.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Type', 'application/json');

  let input = '';
  if (req.method === 'POST') {
    try {
      input =
        (typeof req.body === 'string' ? JSON.parse(req.body) : req.body).url ||
        '';
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
  } else {
    input = (req.query && req.query.url) || '';
  }
  if (!input) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Missing url' }));
    return;
  }

  try {
    const result = await check(input);
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e: any) {
    // Don't echo internal/SSRF details back to the client.
    const msg = e?.message || '';
    const safe = /Unreachable|Blocked target|Invalid URL|Only http/.test(msg)
      ? msg
      : 'Could not fetch site';
    res.statusCode = /Blocked target|Invalid URL|Only http/.test(msg)
      ? 400
      : 502;
    res.end(JSON.stringify({ error: safe }));
  }
}
