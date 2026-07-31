/**
 * Server-only SSRF guard for caller-controlled URLs.
 *
 * Several resource routes take a URL (or a hostname fragment) from the caller
 * and fetch it server-side: api.git-proxy.$, api.web-search. Authentication
 * alone is not enough for those — an authenticated caller must still not be
 * able to make the server reach loopback, link-local, cloud-metadata, or
 * RFC1918 addresses, nor speak non-HTTP protocols.
 *
 * This module is the single place that decides whether a destination is
 * fetchable. Routes call `validateExternalUrl` (or `safeFetch`, which layers
 * redirect re-validation on top) instead of hand-rolling their own checks.
 *
 * This module MUST stay under app/lib/.server so Remix never bundles it into
 * the browser (Vite treats `.server` as a server-only boundary).
 *
 * Known limitation: this is a name/literal-level check. It cannot stop DNS
 * rebinding, where a public hostname resolves to a private address at connect
 * time. Blocking that needs resolve-then-pin at the socket layer, which is not
 * available in the Workers fetch runtime.
 */

export type UrlGuardCode =
  | 'url_unparseable'
  | 'url_protocol_blocked'
  | 'url_credentials_blocked'
  | 'url_host_missing'
  | 'url_host_blocked'
  | 'url_redirect_blocked'
  | 'url_too_many_redirects';

export type UrlRejection = {
  ok: false;
  code: UrlGuardCode;
  reason: string;
};

export type UrlAcceptance = {
  ok: true;
  url: URL;
};

export type UrlGuardResult = UrlAcceptance | UrlRejection;

/** Only these two schemes may ever be fetched on behalf of a caller. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostnames that are never fetchable, matched exactly (lowercased). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '[::]',
  '[::1]',
  '[0:0:0:0:0:0:0:1]',
  '[0000:0000:0000:0000:0000:0000:0000:0001]',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/**
 * Suffixes that are never fetchable. `.internal` covers the GCP/AWS metadata
 * names, `.local` covers mDNS, `.localhost` covers the reserved TLD, and
 * `.home.arpa` covers RFC 8375 home networks.
 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.internal', '.local', '.home.arpa'];

/**
 * Private / reserved IPv4 ranges. Note the WHATWG URL parser already
 * canonicalizes hex, octal and integer host forms (`0x7f.0.0.1`, `2130706433`,
 * `017700000001` all become `127.0.0.1`), so matching dotted-quad is enough.
 */
const BLOCKED_IPV4_PATTERNS = [
  /^0\./, // "this network" 0.0.0.0/8
  /^10\./, // RFC1918 class A
  /^127\./, // loopback 127.0.0.0/8
  /^169\.254\./, // link-local, incl. 169.254.169.254 cloud metadata
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 class B
  /^192\.168\./, // RFC1918 class C
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC6598 carrier-grade NAT
  /^192\.0\.0\./, // IETF protocol assignments
  /^198\.1[89]\./, // benchmarking
  /^2(2[4-9]|3\d)\./, // multicast 224.0.0.0/4
  /^2(4[0-9]|5[0-5])\./, // reserved 240.0.0.0/4 + broadcast
];

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isBlockedIpv4(hostname: string): boolean {
  const match = hostname.match(IPV4_RE);

  if (!match) {
    return false;
  }

  // Reject malformed quads outright rather than letting them through.
  for (let i = 1; i <= 4; i++) {
    if (Number(match[i]) > 255) {
      return true;
    }
  }

  return BLOCKED_IPV4_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * Expand a (possibly `::`-compressed) IPv6 literal into its eight 16-bit
 * groups. Returns null when the literal is not parseable, in which case the
 * caller treats it as blocked.
 */
function expandIpv6(literal: string): number[] | null {
  let body = literal;

  // An IPv4-mapped tail such as ::ffff:127.0.0.1 becomes two hex groups.
  const tail = body.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (tail) {
    const octets = [Number(tail[1]), Number(tail[2]), Number(tail[3]), Number(tail[4])];

    if (octets.some((octet) => octet > 255)) {
      return null;
    }

    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    body = body.slice(0, tail.index) + `${hi}:${lo}`;
  }

  const halves = body.split('::');

  if (halves.length > 2) {
    return null;
  }

  const parse = (part: string): number[] | null => {
    if (part.length === 0) {
      return [];
    }

    const groups: number[] = [];

    for (const chunk of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) {
        return null;
      }

      groups.push(parseInt(chunk, 16));
    }

    return groups;
  };

  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];

  if (!head || !rest) {
    return null;
  }

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const fill = 8 - head.length - rest.length;

  if (fill < 0) {
    return null;
  }

  return [...head, ...new Array(fill).fill(0), ...rest];
}

function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
    return false;
  }

  // Strip brackets and any zone id (fe80::1%eth0).
  const literal = hostname.slice(1, -1).split('%')[0].toLowerCase();
  const groups = expandIpv6(literal);

  if (!groups) {
    // Unparseable IPv6 literal: fail closed.
    return true;
  }

  const [g0, g1, , , , g5, g6, g7] = groups;

  // :: (unspecified) and ::1 (loopback)
  if (groups.slice(0, 7).every((g) => g === 0) && (g7 === 0 || g7 === 1)) {
    return true;
  }

  // fc00::/7 unique-local
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) {
    return true;
  }

  // ::ffff:0:0/96 IPv4-mapped — re-check the embedded IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isBlockedIpv4(v4);
  }

  // 64:ff9b::/96 NAT64 — re-check the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isBlockedIpv4(v4);
  }

  return false;
}

function reject(code: UrlGuardCode, reason: string): UrlRejection {
  return { ok: false, code, reason };
}

/**
 * Decide whether a caller-supplied destination may be fetched server-side.
 *
 * Rejects: unparseable input, any protocol other than http/https, embedded
 * credentials, and hostnames that resolve to the local host, a private
 * network, or a cloud metadata endpoint.
 */
export function validateExternalUrl(input: string | URL, base?: string | URL): UrlGuardResult {
  let url: URL;

  try {
    url = base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return reject('url_unparseable', 'Destination is not a valid absolute URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return reject('url_protocol_blocked', 'Only http and https destinations are allowed.');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return reject('url_credentials_blocked', 'Destination must not embed credentials.');
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname.length === 0) {
    return reject('url_host_missing', 'Destination has no hostname.');
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return reject('url_host_blocked', 'Destination host is not publicly routable.');
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return reject('url_host_blocked', 'Destination host is not publicly routable.');
  }

  if (isBlockedIpv4(hostname) || isBlockedIpv6(hostname)) {
    return reject('url_host_blocked', 'Destination host is not publicly routable.');
  }

  return { ok: true, url };
}

/**
 * Build the 400 JSON body for a rejected destination. Shape is
 * `{ error, code }` so callers keep a human-readable `error` while machines
 * can branch on `code`.
 */
export function urlGuardErrorResponse(rejection: UrlRejection, status = 400): Response {
  return new Response(JSON.stringify({ error: rejection.reason, code: rejection.code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export type SafeFetchResult =
  | { ok: true; response: Response; finalUrl: string; redirected: boolean }
  | { ok: false; rejection: UrlRejection };

export type SafeFetchOptions = {
  /**
   * Follow 3xx responses ourselves, re-validating every hop. Set false when
   * the request carries a streamed body that cannot be replayed — the caller
   * then receives the validated 3xx and decides what to do with it.
   */
  followRedirects?: boolean;
  maxRedirects?: number;
};

/**
 * Fetch a caller-supplied destination with SSRF checks on every hop.
 *
 * `redirect` is forced to 'manual' because a permitted host is free to answer
 * with a 302 to 127.0.0.1 or 169.254.169.254; letting the runtime follow it
 * would bypass the validation done on the original URL.
 */
export async function safeFetch(
  target: string | URL,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const first = validateExternalUrl(target);

  if (!first.ok) {
    return { ok: false, rejection: first };
  }

  const follow = opts.followRedirects ?? true;
  const maxRedirects = opts.maxRedirects ?? 5;

  let current = first.url;
  let redirected = false;

  for (let hop = 0; ; hop++) {
    const response = await fetch(current.toString(), { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400;

    if (!isRedirect || location === null) {
      return { ok: true, response, finalUrl: current.toString(), redirected };
    }

    // Re-validate the hop target before we are willing to follow or expose it.
    const next = validateExternalUrl(location, current);

    if (!next.ok) {
      return {
        ok: false,
        rejection: reject('url_redirect_blocked', 'Destination redirected to a host that is not publicly routable.'),
      };
    }

    if (!follow) {
      return { ok: true, response, finalUrl: current.toString(), redirected };
    }

    if (hop >= maxRedirects) {
      return { ok: false, rejection: reject('url_too_many_redirects', 'Destination exceeded the redirect limit.') };
    }

    current = next.url;
    redirected = true;
  }
}
