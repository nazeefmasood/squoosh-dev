/**
 * Favicon image proxy — serverless.
 *
 * The target site's icons are cross-origin and won't carry CORP/CORS headers,
 * so the browser can't load them directly under the app's COEP: require-corp.
 * This same-origin proxy streams the bytes back with a permissive CORP header
 * so the client can <img> and download them.
 *
 * GET ?url=<absolute icon url>
 */
import { assertSafeUrl } from './_ssrf';

export default async function handler(req: any, res: any) {
  const url = (req.query && req.query.url) || '';
  let parsed: URL;
  try {
    parsed = assertSafeUrl(url);
  } catch (e: any) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing or invalid url' }));
    return;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const upstream = await fetch(parsed.href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SmooshFaviconBot/1.0)',
      },
    });
    // Re-check the final URL after redirects (block metadata rebinds).
    try {
      assertSafeUrl(upstream.url);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Blocked target' }));
      return;
    }
    if (!upstream.ok) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Upstream unavailable' }));
      return;
    }
    const ct =
      upstream.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('Content-Type', ct);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(buf);
  } catch {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Fetch failed' }));
  } finally {
    clearTimeout(t);
  }
}
