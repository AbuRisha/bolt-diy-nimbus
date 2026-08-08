/**
 * Guards for the SSRF checks.
 *
 * The four "already blocked" cases at the bottom are not padding. Alternate
 * IPv4 encodings were reported as a live bypass and are not one — WHATWG
 * `new URL()` normalises `2130706433`, `0x7f000001`, `0177.0.0.1` and `127.1`
 * to `127.0.0.1` before any check runs. They are pinned here so nobody
 * "fixes" them again by hand-rolling an inet_aton parser the platform already
 * provides, and so the day a runtime stops normalising, this fails loudly.
 */
import { describe, expect, it } from 'vitest';

import { isAllowedUrl, safeFetch } from './url';

describe('isAllowedUrl — IPv6, which is where the real bypasses were', () => {
  it.each([
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback — loopback wearing a different hat'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped cloud metadata'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped RFC1918'],
    ['http://[fc00::1]/', 'unique-local fc00::/7'],
    ['http://[fd12:3456::1]/', 'unique-local, fd variant'],
    ['http://[fe80::1]/', 'link-local fe80::/10'],
    ['http://[feb0::1]/', 'link-local, top of the /10'],
    ['http://[::1]/', 'loopback'],
    ['http://[::]/', 'unspecified'],
  ])('blocks %s (%s)', (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });

  it('still allows public IPv6', () => {
    // fe00:: is outside fe80::/10; 2606:: is ordinary global unicast. Blocking
    // these would break legitimate fetches, which is the opposite failure.
    expect(isAllowedUrl('http://[2606:4700::1111]/')).toBe(true);
    expect(isAllowedUrl('http://[fe00::1]/')).toBe(true);
  });
});

describe('isAllowedUrl — IPv4', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://100.127.255.255/',
  ])('blocks %s', (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });

  it('allows public addresses and hostnames', () => {
    expect(isAllowedUrl('http://example.com/')).toBe(true);
    expect(isAllowedUrl('https://8.8.8.8/')).toBe(true);
    // 100.63 and 100.128 sit just outside CGNAT — an off-by-one here would
    // silently block real hosts.
    expect(isAllowedUrl('http://100.63.255.255/')).toBe(true);
    expect(isAllowedUrl('http://100.128.0.1/')).toBe(true);
  });

  it('blocks non-HTTP schemes and localhost', () => {
    expect(isAllowedUrl('gopher://127.0.0.1/')).toBe(false);
    expect(isAllowedUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedUrl('http://localhost/')).toBe(false);
    expect(isAllowedUrl('not a url')).toBe(false);
  });

  it('already blocks alternate IPv4 encodings via URL normalisation', () => {
    // Reported as bypasses; they are not. `new URL()` canonicalises each of
    // these to 127.0.0.1 before the patterns run.
    for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/']) {
      expect(isAllowedUrl(u), u).toBe(false);
    }

    expect(isAllowedUrl('http://[0:0:0:0:0:0:0:1]/')).toBe(false);
  });
});

describe('safeFetch — the redirect hole', () => {
  const withFetch = async (impl: typeof globalThis.fetch, run: () => Promise<unknown>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;

    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it('refuses a redirect that lands on internal space', async () => {
    // The live shape: a public host answers 302 pointing at cloud metadata.
    // Plain fetch would follow it and the guard would never run again.
    await withFetch(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
      async () => {
        await expect(safeFetch('http://example.com/')).rejects.toThrow('Blocked URL');
      },
    );
  });

  it('refuses a redirect to an IPv6 internal address', async () => {
    await withFetch(
      async () => new Response(null, { status: 301, headers: { location: 'http://[::ffff:127.0.0.1]/' } }),
      async () => {
        await expect(safeFetch('http://example.com/')).rejects.toThrow('Blocked URL');
      },
    );
  });

  it('follows a redirect that stays public', async () => {
    let hop = 0;
    await withFetch(
      async () => {
        hop++;
        return hop === 1
          ? new Response(null, { status: 302, headers: { location: 'https://example.org/final' } })
          : new Response('ok', { status: 200 });
      },
      async () => {
        const res = (await safeFetch('http://example.com/')) as Response;
        expect(res.status).toBe(200);
        expect(hop).toBe(2);
      },
    );
  });

  it('resolves a relative Location against the current hop before checking', async () => {
    let hop = 0;
    await withFetch(
      async () => {
        hop++;
        return hop === 1
          ? new Response(null, { status: 302, headers: { location: '/next' } })
          : new Response('ok', { status: 200 });
      },
      async () => {
        const res = (await safeFetch('https://example.com/start')) as Response;
        expect(res.status).toBe(200);
      },
    );
  });

  it('rejects the initial URL before making any request', async () => {
    let called = false;
    await withFetch(
      async () => {
        called = true;
        return new Response('ok');
      },
      async () => {
        await expect(safeFetch('http://169.254.169.254/')).rejects.toThrow('Blocked URL');
        expect(called, 'must not connect to a blocked target').toBe(false);
      },
    );
  });

  it('gives up on a redirect loop instead of hanging', async () => {
    await withFetch(
      async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }),
      async () => {
        await expect(safeFetch('https://example.com/loop')).rejects.toThrow('Too many redirects');
      },
    );
  });
});
