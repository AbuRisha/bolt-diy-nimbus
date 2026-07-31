/**
 * URL validation utilities with SSRF protection.
 *
 * The earlier version compared `url.hostname` against a handful of
 * dotted-quad regexes. That let four classes of address through:
 *
 *   1. Alternate IPv4 encodings — `2130706433`, `0177.0.0.1`, `0x7f.1` and
 *      friends all resolve to 127.0.0.1 but match none of the patterns.
 *   2. IPv6 beyond the literal `[::1]` — IPv4-mapped `[::ffff:127.0.0.1]`,
 *      unique-local `fd00::/8`, link-local `fe80::/10`.
 *   3. Hostnames that resolve into private space. A DNS name is not an IP, so
 *      no literal check can catch it; `isAllowedUrl` is a syntactic filter and
 *      cannot close this alone.
 *   4. Redirects. A public URL that answers 302 to an internal address defeats
 *      any check applied only to the original input.
 *
 * (1) and (2) are fixed here. (3) and (4) cannot be — they need the resolved
 * address and every hop, which only the caller has. Callers that fetch a
 * user-supplied URL must use `safeFetch` below rather than `fetch` directly.
 */

/** Decode the four IPv4 text forms `inet_aton` accepts, or null if not an IPv4 literal. */
function parseIpv4(host: string): number | null {
  const parts = host.split('.');

  if (parts.length === 0 || parts.length > 4) {
    return null;
  }

  const nums: number[] = [];

  for (const part of parts) {
    if (part.length === 0) {
      return null;
    }

    let value: number;

    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) {
      value = parseInt(part, 10);
    } else {
      return null;
    }

    if (!Number.isFinite(value) || value < 0) {
      return null;
    }

    nums.push(value);
  }

  /*
   * Short forms pack the trailing octets into the last field: `a.b.c` means
   * a.b.<c as 16 bits>, `a` alone means the whole 32-bit address.
   */
  const last = nums[nums.length - 1];
  const leading = nums.slice(0, -1);
  const remainingOctets = 4 - leading.length;

  if (last >= 2 ** (8 * remainingOctets)) {
    return null;
  }

  if (leading.some((n) => n > 255)) {
    return null;
  }

  let result = last;

  for (let i = 0; i < leading.length; i++) {
    result += leading[i] * 2 ** (8 * (3 - i));
  }

  return result >>> 0;
}

/** True when a 32-bit IPv4 address falls in a range that must never be fetched. */
export function isPrivateIpv4(addr: number): boolean {
  const a = (addr >>> 24) & 0xff;
  const b = (addr >>> 16) & 0xff;

  return (
    a === 0 || // 0.0.0.0/8 unspecified
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  );
}

/** True when an IPv6 literal (brackets already stripped) must never be fetched. */
export function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();

  if (h === '::' || h === '::1') {
    return true;
  }

  // IPv4-mapped / IPv4-compatible: defer to the IPv4 rules.
  const mapped = h.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);

  if (mapped) {
    const addr = parseIpv4(mapped[1]);
    return addr === null ? true : isPrivateIpv4(addr);
  }

  return (
    /^f[cd]/.test(h) || // fc00::/7 unique-local
    /^fe[89ab]/.test(h) // fe80::/10 link-local
  );
}

export function isValidUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Syntactic check: rejects http(s) URLs whose host is a literal address in a
 * private range, in any encoding. A hostname that *resolves* into private
 * space still passes — see `safeFetch`.
 */
export function isAllowedUrl(input: string): boolean {
  if (!isValidUrl(input)) {
    return false;
  }

  const url = new URL(input);

  /*
   * Credentials in the URL. `https://user:pass@evil.tld` would send those to
   * the upstream, and the userinfo section is also a classic way to disguise
   * the real host from a human reviewer — `https://gitlab.com@127.0.0.1/`
   * has a hostname of 127.0.0.1, not gitlab.com.
   */
  if (url.username !== '' || url.password !== '') {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname.length === 0 || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return false;
  }

  /*
   * Internal naming suffixes. These resolve only inside a private network, so
   * a request for one is either a mistake or a probe. `.home.arpa` is the
   * RFC 8375 home-network suffix; `.internal` is what GCP hands out.
   */
  if (
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.home.arpa') ||
    hostname === 'metadata.google.internal'
  ) {
    return false;
  }

  // URL keeps IPv6 literals bracketed.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return !isPrivateIpv6(hostname.slice(1, -1));
  }

  const ipv4 = parseIpv4(hostname);

  if (ipv4 !== null) {
    return !isPrivateIpv4(ipv4);
  }

  return true;
}

/**
 * Normalise a caller-supplied API base URL, or return null if it is not safe
 * to fetch.
 *
 * Callers build request URLs by concatenation (`${base}/api/v4/...`), which is
 * exploitable on its own even when the host is allowed: a base of
 * `https://attacker.tld/collect?x=#` swallows the appended path into a
 * fragment, so the server requests the attacker's URL instead of the intended
 * endpoint. Returning origin + pathname only — with the query, fragment and
 * any trailing slash removed — makes that impossible.
 *
 * Returns null rather than throwing so the caller can answer 400 rather than
 * surfacing an exception.
 */
export function apiBaseFromUserInput(input: string): string | null {
  if (typeof input !== 'string' || input.trim() === '' || !isAllowedUrl(input)) {
    return null;
  }

  const url = new URL(input);
  const path = url.pathname.replace(/\/+$/, '');

  return `${url.origin}${path}`;
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Redirect hops to follow. Each hop is revalidated. */
  maxRedirects?: number;
}

/**
 * Fetch a user-supplied URL with the redirect hole closed.
 *
 * `fetch` follows redirects internally, so validating only the input URL is no
 * protection: a public host can answer 302 with an internal Location and the
 * guard never runs again. This drives redirects manually and revalidates every
 * hop with `isAllowedUrl`.
 *
 * This does NOT defend against a hostname that resolves to a private address,
 * including DNS rebinding — that needs resolve-then-pin at the socket layer,
 * which is not reachable from this runtime. Treat it as raising the cost, not
 * as a complete boundary, and never point it at anything trusted by network
 * position.
 */
export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { headers, signal, maxRedirects = 3 } = options;

  let target = input;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedUrl(target)) {
      throw new Error('URL is not allowed');
    }

    const response = await fetch(target, { headers, signal, redirect: 'manual' });

    if (response.status < 300 || response.status > 399) {
      return response;
    }

    const location = response.headers.get('location');

    if (!location) {
      return response;
    }

    // A relative Location resolves against the hop we just made.
    target = new URL(location, target).toString();
  }

  throw new Error('Too many redirects');
}
