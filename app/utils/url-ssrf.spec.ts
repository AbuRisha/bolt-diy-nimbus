/**
 * SSRF guard coverage for the additions made alongside the GitLab hardening.
 *
 * The GitLab routes accept a caller-supplied `gitlabUrl` because self-hosted
 * GitLab is a legitimate configuration, so the host cannot be pinned. That
 * makes `isAllowedUrl` / `apiBaseFromUserInput` the only thing standing between
 * an authenticated caller and the server's own network position.
 *
 * These cases are the ones that were NOT covered before: userinfo smuggling,
 * internal naming suffixes, and base-URL concatenation truncation.
 */
import { describe, expect, it } from 'vitest';
import { apiBaseFromUserInput, isAllowedUrl } from './url';

describe('isAllowedUrl — credentials in the URL', () => {
  it('rejects a userinfo section even when the host is public', () => {
    expect(isAllowedUrl('https://user:pass@gitlab.com')).toBe(false);
  });

  it('rejects a username with no password', () => {
    expect(isAllowedUrl('https://token@gitlab.com')).toBe(false);
  });

  /*
   * The host here is 127.0.0.1; "gitlab.com" is the username. This reads as
   * legitimate to a human skimming a config value, which is the whole point.
   */
  it('rejects userinfo used to disguise a loopback host', () => {
    expect(isAllowedUrl('https://gitlab.com@127.0.0.1/')).toBe(false);
  });
});

describe('isAllowedUrl — internal naming suffixes', () => {
  it.each([
    'http://gitlab.internal',
    'http://build.local',
    'http://router.home.arpa',
    'http://metadata.google.internal/computeMetadata/v1/',
  ])('rejects %s', (input) => {
    expect(isAllowedUrl(input)).toBe(false);
  });
});

describe('isAllowedUrl — still allows legitimate hosts', () => {
  it.each(['https://gitlab.com', 'https://gitlab.example.com', 'https://gitlab.example.com:8443'])(
    'allows %s',
    (input) => {
      expect(isAllowedUrl(input)).toBe(true);
    },
  );

  /* `.localhost` is blocked, but a real domain merely containing it is not. */
  it('does not over-match a public host containing "local"', () => {
    expect(isAllowedUrl('https://localstack.example.com')).toBe(true);
  });
});

describe('apiBaseFromUserInput', () => {
  it('strips a query string that would otherwise swallow the appended path', () => {
    /*
     * Without normalisation, `${base}/api/v4/projects` on this input produces
     * https://attacker.tld/collect?x=#/api/v4/projects — the appended path
     * lands in the fragment and the server requests the attacker's endpoint.
     */
    expect(apiBaseFromUserInput('https://attacker.tld/collect?x=#')).toBe('https://attacker.tld/collect');
  });

  it('strips a trailing slash so concatenation cannot double it', () => {
    expect(apiBaseFromUserInput('https://gitlab.example.com/')).toBe('https://gitlab.example.com');
  });

  it('preserves a subpath, which self-hosted GitLab behind a prefix needs', () => {
    expect(apiBaseFromUserInput('https://example.com/gitlab')).toBe('https://example.com/gitlab');
  });

  it('preserves a non-default port', () => {
    expect(apiBaseFromUserInput('https://gitlab.example.com:8443')).toBe('https://gitlab.example.com:8443');
  });

  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'https://user:pass@gitlab.com',
    'file:///etc/passwd',
    'not-a-url',
    '',
  ])('returns null for %s', (input) => {
    expect(apiBaseFromUserInput(input)).toBeNull();
  });

  it('returns null for alternate encodings of loopback', () => {
    // 2130706433 === 0x7f000001 === 127.0.0.1
    expect(apiBaseFromUserInput('http://2130706433/')).toBeNull();
    expect(apiBaseFromUserInput('http://0177.0.0.1/')).toBeNull();
  });

  it('returns null rather than throwing on a non-string', () => {
    expect(apiBaseFromUserInput(undefined as unknown as string)).toBeNull();
  });
});
