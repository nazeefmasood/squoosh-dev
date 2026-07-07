/**
 * SSRF guard for the favicon serverless functions.
 *
 * These functions fetch user-supplied URLs server-side, which is inherently
 * SSRF-shaped. This blocks the high-value targets: link-local/cloud-metadata
 * endpoints (169.254.169.254 etc. — the main cloud-credential-leak vector),
 * loopback, and private/internal hostnames. Literal-hostname blocking covers
 * the common cases; a determined DNS-rebinding attack would need DNS-level
 * resolution, which is out of scope for a favicon tool.
 *
 * Returns true if the URL is safe to fetch.
 */

const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i;

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.test(h)) return true;
  // IPv4
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 loopback / link-local / unique-local
  if (
    h === '::1' ||
    h === '::' ||
    h.startsWith('fe80:') ||
    h.startsWith('fc') ||
    h.startsWith('fd')
  ) {
    return true;
  }
  return false;
}

export function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) allowed');
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error('Blocked target');
  }
  return u;
}
