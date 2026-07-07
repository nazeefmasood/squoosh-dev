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

  return { finalUrl, title, icons, manifestIcons };
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
