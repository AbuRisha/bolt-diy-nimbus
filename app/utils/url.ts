/**
 * URL validation utilities with SSRF protection.
 *
 * DEPRECATED for server-side fetches. This check is name-level only and does
 * not cover IPv6 loopback/ULA/link-local, the `.internal` / `.local` /
 * `.localhost` suffixes, embedded credentials, or redirect hops. Server routes
 * that fetch a caller-supplied destination MUST use `validateExternalUrl` /
 * `safeFetch` from `~/lib/.server/url-guard` instead. Kept here only for
 * client-side shape checks.
 */

const PRIVATE_IP_PATTERNS = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Loopback
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Class A private
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // Class B private
  /^192\.168\.\d{1,3}\.\d{1,3}$/, // Class C private
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // Link-local
  /^0\.0\.0\.0$/, // Unspecified
];

const BLOCKED_HOSTNAMES = new Set(['localhost', '[::1]', '0.0.0.0']);

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

  if (PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return false;
  }

  return true;
}
