/**
 * SSRF guard for the reference-URL research flow.
 *
 * `POST /api/plan { referenceUrl }` fetches whatever this returns, follows
 * redirects, parses the body and hands the extracted content back to the
 * caller — so an unvalidated target is a read primitive against anything the
 * container can reach.
 *
 * Verified live against production on 2026-08-07, before the fix:
 *
 *   referenceUrl: http://example.com/   -> 200, title and headings extracted
 *   referenceUrl: http://127.0.0.1/     -> "did not respond (status unreachable)"
 *
 * The loopback case failing was not a control — nothing happened to be
 * listening on port 80 in that container. The fetch was attempted.
 *
 * This file rolled its own `safeFetch` (timeout only, `redirect: 'follow'`)
 * rather than using `~/utils/url`, which is exactly why an audit of
 * `isAllowedUrl` callers did not surface it. The lesson worth keeping: auditing
 * a guard's callers only finds code that already opted in.
 */
import { describe, expect, it } from 'vitest';

import { normalizeReferenceUrl } from './research';

describe('normalizeReferenceUrl', () => {
  it.each([
    ['http://127.0.0.1/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.0.0.1/', 'RFC1918 class A'],
    ['http://172.16.0.1/', 'RFC1918 class B'],
    ['http://192.168.1.1/', 'RFC1918 class C'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fd00::1]/', 'IPv6 unique-local'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['localhost', 'bare localhost — note the scheme is added before checking'],
    ['http://2130706433/', 'loopback as a decimal integer'],
  ])('rejects %s (%s)', (url) => {
    expect(normalizeReferenceUrl(url)).toBeNull();
  });

  it('still accepts public references, with and without a scheme', () => {
    // The failure that matters in the other direction: over-blocking would
    // silently break the "clone this vibe" flow for every legitimate URL.
    expect(normalizeReferenceUrl('https://example.com/')).not.toBeNull();
    expect(normalizeReferenceUrl('http://example.com/pricing')).not.toBeNull();
    expect(normalizeReferenceUrl('stripe.com')).not.toBeNull();
    expect(normalizeReferenceUrl('  https://linear.app/  ')).not.toBeNull();
  });

  it('keeps rejecting non-HTTP schemes, credentials and odd ports', () => {
    // Pre-existing checks; pinned so the SSRF fix cannot regress them.
    expect(normalizeReferenceUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeReferenceUrl('gopher://example.com/')).toBeNull();
    expect(normalizeReferenceUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeReferenceUrl('https://user:pass@example.com/')).toBeNull();
    expect(normalizeReferenceUrl('http://example.com:8080/')).toBeNull();
  });
});
