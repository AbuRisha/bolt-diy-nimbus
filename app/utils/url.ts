/**
 * URL validation utilities with SSRF protection.
 *
 * ── What was actually broken, measured 2026-08-06 ──────────────────────────
 * The previous guard tested `url.hostname` against dotted-quad IPv4 regexes
 * plus a three-entry hostname blocklist. Probing the real function found four
 * live bypasses, all of which resolve to internal space:
 *
 *   http://[::ffff:127.0.0.1]/   IPv4-mapped IPv6 loopback
 *   http://[fc00::1]/            IPv6 unique-local
 *   http://[fe80::1]/            IPv6 link-local
 *   http://100.64.0.1/           CGNAT 100.64/10
 *
 * Worth recording what was NOT broken, because it was reported as broken and
 * a fix would have been wasted effort: alternate IPv4 encodings
 * (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`) and the expanded IPv6
 * loopback `[0:0:0:0:0:0:0:1]` were already blocked. WHATWG `new URL()`
 * normalises all of them — to `127.0.0.1` and `[::1]` respectively — before
 * any regex runs. The parser does that work for us; the gap was only ever the
 * ranges it does not collapse.
 *
 * ── The gap that has no regex ──────────────────────────────────────────────
 * A hostname that RESOLVES into private space — including DNS rebinding,
 * where the answer changes between the check and the connection — is still
 * not covered, and cannot be from here. Closing it needs resolve-then-pin at
 * the socket layer, which this runtime does not expose. Stated plainly rather
 * than left looking handled.
 */

const PRIVATE_IP_PATTERNS = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Loopback
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Class A private
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // Class B private
  /^192\.168\.\d{1,3}\.\d{1,3}$/, // Class C private
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // Link-local (incl. cloud metadata)
  /^0\.0\.0\.0$/, // Unspecified
  // CGNAT. Reachable inside many hosting networks and previously allowed.
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/,
];

const BLOCKED_HOSTNAMES = new Set(['localhost', '[::1]', '0.0.0.0']);

function isPrivateIpv4(host: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Is this bracketed IPv6 literal internal?
 *
 * `new URL()` has already lowercased and compressed the address, so the
 * comparisons below run against a canonical form (`[0:0:...:1]` arrives as
 * `[::1]`).
 */
function isPrivateIpv6(bracketed: string): boolean {
  const host = bracketed.slice(1, -1).toLowerCase();

  // Loopback and unspecified, in case they arrive uncompressed.
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }

  /*
   * IPv4-mapped: ::ffff:127.0.0.1 is loopback wearing a different hat, and it
   * was the sharpest of the four bypasses — it points at 127.0.0.1 while
   * looking nothing like it.
   *
   * Critically, it does not arrive in dotted form. WHATWG `new URL()` rewrites
   * the embedded IPv4 into hex hextets, so `[::ffff:127.0.0.1]` reaches us as
   * `[::ffff:7f00:1]` and `[::ffff:169.254.169.254]` as `[::ffff:a9fe:a9fe]`.
   * A first version of this guard matched only the dotted spelling and
   * therefore blocked nothing; the test suite caught it. Both spellings are
   * handled below — the hex one because it is what actually shows up, the
   * dotted one so a runtime that skips normalisation is still covered.
   */
  const dotted = host.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);

  if (dotted) {
    return isPrivateIpv4(dotted[1]);
  }

  const hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);

  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const quad = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');

    return isPrivateIpv4(quad);
  }

  const firstHextet = host.split(':')[0];

  // fc00::/7 — unique local. First byte is 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{0,2}$/.test(firstHextet)) {
    return true;
  }

  // fe80::/10 — link-local. First byte 0xfe with the top two bits of the
  // second byte clear, i.e. fe80 through febf.
  if (/^fe[89ab][0-9a-f]?$/.test(firstHextet)) {
    return true;
  }

  return false;
}

export function isValidUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isAllowedUrl(input: string): boolean {
  if (!isValidUrl(input)) {
    return false;
  }

  const url = new URL(input);
  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return false;
  }

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return !isPrivateIpv6(hostname);
  }

  return !isPrivateIpv4(hostname);
}

/**
 * `fetch` that re-checks every redirect hop.
 *
 * Validating a URL and then calling plain `fetch` is not a control: `fetch`
 * follows redirects itself, so a public host can answer 302 with
 * `Location: http://169.254.169.254/latest/meta-data/` and the guard never
 * runs again. That was live in api.web-search, which called `isAllowedUrl`
 * and then fetched with default redirect handling.
 *
 * Driving the redirects manually is the only way the check applies to the URL
 * actually connected to, rather than only to the one the caller typed.
 */
export async function safeFetch(input: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let target = input;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedUrl(target)) {
      throw new Error('Blocked URL');
    }

    const response = await fetch(target, { ...init, redirect: 'manual' });

    if (response.status < 300 || response.status > 399) {
      return response;
    }

    const location = response.headers.get('location');

    if (!location) {
      return response;
    }

    // Relative Locations are resolved against the hop we are on, then
    // re-validated like any other target.
    target = new URL(location, target).toString();
  }

  throw new Error('Too many redirects');
}
