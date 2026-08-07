/**
 * Guards for `requireBuilderAuth`.
 *
 * Written because the failure modes point in opposite directions and both are
 * bad:
 *
 *   - Too permissive, and `/api/chat` stays reachable by anyone — the hole
 *     this guard exists to close.
 *   - Too strict, and every Builder user is locked out of a working product,
 *     which is worse than the hole. The dev/CI hatch and the "valid session is
 *     admitted" case are therefore tested as carefully as the denial.
 *
 * The tokens here are minted with the module's own `mintNimbusSessionToken`
 * against a throwaway secret, so nothing depends on a real environment.
 */
import { describe, expect, it } from 'vitest';

import {
  getNimbusApiKey,
  mintNimbusSessionToken,
  NIMBUS_COOKIE_NAME,
  requireBuilderAuth,
} from './nimbus-sso';

const SECRET = 'test-secret-not-a-real-one';

function ctx(env: Record<string, string>) {
  return { cloudflare: { env } };
}

function requestWithCookie(cookie?: string) {
  return new Request('https://builder.nimbusapi.net/api/chat', {
    method: 'POST',
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function validSessionCookie(overrides: Record<string, unknown> = {}) {
  const token = await mintNimbusSessionToken(
    {
      sub: 'cus_test',
      email: 'test@example.com',
      aud: 'builder',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    } as never,
    SECRET,
  );

  return `${NIMBUS_COOKIE_NAME}=${token}`;
}

describe('requireBuilderAuth', () => {
  it('denies an anonymous request with 401 and no-store', async () => {
    const denied = await requireBuilderAuth(requestWithCookie(), ctx({ NIMBUS_SSO_SHARED_SECRET: SECRET }));

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
    expect(denied!.headers.get('Cache-Control')).toBe('no-store');
    expect(denied!.headers.get('WWW-Authenticate')).toContain('nimbus-builder');
  });

  it('admits a request carrying a valid session cookie', async () => {
    // The load-bearing case: if this ever fails, real users are locked out.
    const denied = await requireBuilderAuth(
      requestWithCookie(await validSessionCookie()),
      ctx({ NIMBUS_SSO_SHARED_SECRET: SECRET }),
    );

    expect(denied).toBeNull();
  });

  it('denies a cookie signed with a different secret', async () => {
    const token = await mintNimbusSessionToken(
      { sub: 'cus_x', aud: 'builder', exp: Math.floor(Date.now() / 1000) + 3600 } as never,
      'a-completely-different-secret',
    );

    const denied = await requireBuilderAuth(
      requestWithCookie(`${NIMBUS_COOKIE_NAME}=${token}`),
      ctx({ NIMBUS_SSO_SHARED_SECRET: SECRET }),
    );

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
  });

  it('denies a tampered signature', async () => {
    /*
     * Flip a character in the MIDDLE of the signature, not the last one. An
     * HMAC-SHA256 signature is 32 bytes -> 43 base64url chars carrying 258
     * bits, so the final character's low 2 bits are padding and decode to
     * nothing: 'A' -> 'B' there yields identical bytes and still verifies.
     * A test that flips the last character passes vacuously.
     */
    const cookie = await validSessionCookie();
    const [name, token] = cookie.split('=');
    const parts = token.split('.');
    const sig = parts[2];
    const mid = Math.floor(sig.length / 2);
    const flipped = sig.slice(0, mid) + (sig[mid] === 'A' ? 'B' : 'A') + sig.slice(mid + 1);

    const denied = await requireBuilderAuth(
      requestWithCookie(`${name}=${parts[0]}.${parts[1]}.${flipped}`),
      ctx({ NIMBUS_SSO_SHARED_SECRET: SECRET }),
    );

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
  });

  it('denies an expired session', async () => {
    /*
     * Expiry must come from the ttl argument, not from an `exp` in the
     * payload. `mintNimbusSessionToken` calls `.setExpirationTime(now + ttl)`
     * itself and forwards only email / name / nimbus_key / sub / aud, so a
     * payload `exp` is silently discarded — this test first "failed" by
     * minting a full 7-day token and asserting it was expired. The code was
     * right; the test was measuring nothing.
     */
    const token = await mintNimbusSessionToken(
      { sub: 'cus_test', email: 'test@example.com' } as never,
      SECRET,
      -60,
    );

    const denied = await requireBuilderAuth(
      requestWithCookie(`${NIMBUS_COOKIE_NAME}=${token}`),
      ctx({ NIMBUS_SSO_SHARED_SECRET: SECRET }),
    );

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
  });

  it('allows everything when SSO is explicitly disabled (local dev / CI)', async () => {
    const denied = await requireBuilderAuth(
      requestWithCookie(),
      ctx({ NIMBUS_SSO_DISABLED: 'true', NIMBUS_SSO_SHARED_SECRET: SECRET }),
    );

    expect(denied).toBeNull();
  });

  it('allows a missing secret OUTSIDE production, so dev and CI still run', async () => {
    const denied = await requireBuilderAuth(requestWithCookie(), ctx({ NODE_ENV: 'development' }));

    expect(denied).toBeNull();
  });

  it('DENIES a missing secret in production', async () => {
    /*
     * This assertion is the reverse of what it said an hour earlier. The first
     * version failed open on a missing secret, reasoning that a secretless
     * container should degrade rather than 401 everything. PR #11 argued the
     * opposite and is right: on an auth control, "could not verify" must not
     * mean "allowed", and failing open is silent — nobody would notice the
     * Builder had gone unauthenticated.
     *
     * Production has the secret today, so this only decides which way the
     * failure goes when the mount breaks.
     */
    const denied = await requireBuilderAuth(requestWithCookie(), ctx({ NODE_ENV: 'production' }));

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
  });

  it('still honours the explicit disable flag even in production', async () => {
    // NIMBUS_SSO_DISABLED is a deliberate operator action, unlike an absent
    // secret which is usually an accident.
    const denied = await requireBuilderAuth(
      requestWithCookie(),
      ctx({ NODE_ENV: 'production', NIMBUS_SSO_DISABLED: 'true' }),
    );

    expect(denied).toBeNull();
  });
});

describe('getNimbusApiKey — whose balance pays', () => {
  const sessionWith = (nimbus_key?: string) =>
    ({ token: 't', payload: { sub: 'cus_1', ...(nimbus_key ? { nimbus_key } : {}) } }) as never;

  it("uses the customer's own key when the session carries one", () => {
    expect(getNimbusApiKey({ NIMBUS_API_KEY: 'sk-operator' }, sessionWith('sk-nim-live-customer'))).toBe(
      'sk-nim-live-customer',
    );
  });

  it('refuses to fall back to the operator key for a signed-in customer', () => {
    /*
     * The load-bearing assertion. This used to return 'sk-operator', so any
     * customer whose session lacked a per-user key billed their inference to
     * us with nothing in the request to show it. Inert today only because the
     * container has no NIMBUS_API_KEY — which is one config change away from
     * being set.
     */
    expect(getNimbusApiKey({ NIMBUS_API_KEY: 'sk-operator' }, sessionWith())).toBeUndefined();
    expect(getNimbusApiKey({ NIMBUS_API_KEY: 'sk-operator' }, null)).toBeUndefined();
  });

  it('still allows the container key when SSO is disabled (local dev)', () => {
    // With SSO off there are no sessions at all, so a container key is the
    // only way to run Builder locally.
    expect(getNimbusApiKey({ NIMBUS_API_KEY: 'sk-operator', NIMBUS_SSO_DISABLED: 'true' }, null)).toBe('sk-operator');
  });
});
