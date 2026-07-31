import { describe, expect, it } from 'vitest';
import { validateExternalUrl, urlGuardErrorResponse } from './url-guard';

function expectBlocked(input: string, code?: string) {
  const result = validateExternalUrl(input);
  expect(result.ok, `expected ${input} to be blocked`).toBe(false);

  if (!result.ok && code) {
    expect(result.code).toBe(code);
  }
}

function expectAllowed(input: string) {
  const result = validateExternalUrl(input);
  expect(result.ok, `expected ${input} to be allowed`).toBe(true);
}

describe('validateExternalUrl', () => {
  it('allows ordinary public http/https destinations', () => {
    expectAllowed('https://github.com/example/repo.git');
    expectAllowed('http://example.com/page?q=1');
    expectAllowed('https://api.github.com:443/user');
  });

  it('rejects unparseable input', () => {
    expectBlocked('not a url', 'url_unparseable');
    expectBlocked('', 'url_unparseable');
  });

  it('rejects non-http protocols', () => {
    expectBlocked('file:///etc/passwd', 'url_protocol_blocked');
    expectBlocked('gopher://example.com/', 'url_protocol_blocked');
    expectBlocked('ftp://example.com/', 'url_protocol_blocked');
    expectBlocked('data:text/plain,hello', 'url_protocol_blocked');
  });

  it('rejects embedded credentials', () => {
    // Obviously fake placeholder credentials.
    expectBlocked('https://fake-user:fake-pass@example.com/', 'url_credentials_blocked');
    expectBlocked('https://fake-user@example.com/', 'url_credentials_blocked');
  });

  it('rejects loopback and unspecified hosts', () => {
    expectBlocked('http://localhost/', 'url_host_blocked');
    expectBlocked('http://LOCALHOST:8080/', 'url_host_blocked');
    expectBlocked('http://anything.localhost/', 'url_host_blocked');
    expectBlocked('http://127.0.0.1/', 'url_host_blocked');
    expectBlocked('http://127.1.2.3/', 'url_host_blocked');
    expectBlocked('http://0.0.0.0/', 'url_host_blocked');
    expectBlocked('http://[::1]/', 'url_host_blocked');
    expectBlocked('http://[::]/', 'url_host_blocked');
  });

  it('rejects obfuscated IPv4 spellings of loopback', () => {
    // The WHATWG parser canonicalizes these to 127.0.0.1 before we see them.
    expectBlocked('http://2130706433/', 'url_host_blocked');
    expectBlocked('http://0x7f.0.0.1/', 'url_host_blocked');
    expectBlocked('http://017700000001/', 'url_host_blocked');
  });

  it('rejects IPv4-mapped and NAT64 IPv6 forms of private space', () => {
    expectBlocked('http://[::ffff:127.0.0.1]/', 'url_host_blocked');
    expectBlocked('http://[::ffff:192.168.1.1]/', 'url_host_blocked');
    expectBlocked('http://[64:ff9b::169.254.169.254]/', 'url_host_blocked');
  });

  it('rejects unique-local and link-local IPv6', () => {
    expectBlocked('http://[fd00::1]/', 'url_host_blocked');
    expectBlocked('http://[fc00::1]/', 'url_host_blocked');
    expectBlocked('http://[fe80::1]/', 'url_host_blocked');

    /*
     * A zone id is not a legal URL host, so this fails closed one step
     * earlier, at the parse. Assert only that it is blocked.
     */
    expectBlocked('http://[fe80::1%25eth0]/');
  });

  it('rejects cloud metadata endpoints', () => {
    expectBlocked('http://169.254.169.254/latest/meta-data/', 'url_host_blocked');
    expectBlocked('http://metadata.google.internal/computeMetadata/v1/', 'url_host_blocked');
    expectBlocked('http://anything.internal/', 'url_host_blocked');
  });

  it('rejects RFC1918 space', () => {
    expectBlocked('http://10.0.0.5/', 'url_host_blocked');
    expectBlocked('http://172.16.0.1/', 'url_host_blocked');
    expectBlocked('http://172.31.255.255/', 'url_host_blocked');
    expectBlocked('http://192.168.1.1/', 'url_host_blocked');
  });

  it('allows public addresses adjacent to blocked ranges', () => {
    expectAllowed('http://172.15.0.1/');
    expectAllowed('http://172.32.0.1/');
    expectAllowed('http://11.0.0.1/');
    expectAllowed('http://169.253.0.1/');
  });

  it('rejects mDNS .local names', () => {
    expectBlocked('http://printer.local/', 'url_host_blocked');
  });

  it('resolves relative redirect targets against the base', () => {
    const relative = validateExternalUrl('/next', 'https://example.com/start');
    expect(relative.ok).toBe(true);

    const escaping = validateExternalUrl('//127.0.0.1/next', 'https://example.com/start');
    expect(escaping.ok).toBe(false);
  });
});

describe('urlGuardErrorResponse', () => {
  it('returns a 400 with a machine-readable code', async () => {
    const result = validateExternalUrl('http://127.0.0.1/');
    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    const response = urlGuardErrorResponse(result);
    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('url_host_blocked');
    expect(body.error.length).toBeGreaterThan(0);
  });
});
