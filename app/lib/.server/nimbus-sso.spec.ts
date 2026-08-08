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
  serializeNimbusSessionCookie,
  NIMBUS_COOKIE_NAME,
  requireBuilderAuth,
  scopeEnvToCustomer,
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
    const token = await mintNimbusSessionToken({ sub: 'cus_test', email: 'test@example.com' } as never, SECRET, -60);

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
    /*
     * NIMBUS_SSO_DISABLED is a deliberate operator action, unlike an absent
     * secret which is usually an accident.
     */
    const denied = await requireBuilderAuth(
      requestWithCookie(),
      ctx({ NODE_ENV: 'production', NIMBUS_SSO_DISABLED: 'true' }),
    );

    expect(denied).toBeNull();
  });
});

describe('getNimbusApiKey — whose balance pays', () => {
  /*
   * The claim on the wire stays snake_case (`nimbus_key`); only the local
   * parameter is camelCase, which is what the naming rule governs.
   */
  const sessionWith = (nimbusKey?: string) =>
    ({ token: 't', payload: { sub: 'cus_1', ...(nimbusKey ? { nimbus_key: nimbusKey } : {}) } }) as never;

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
    /*
     * With SSO off there are no sessions at all, so a container key is the
     * only way to run Builder locally.
     */
    expect(getNimbusApiKey({ NIMBUS_API_KEY: 'sk-operator', NIMBUS_SSO_DISABLED: 'true' }, null)).toBe('sk-operator');
  });
});

describe('session lifetime', () => {
  it('issues an 8-hour session, not a week', async () => {
    const token = await mintNimbusSessionToken({ sub: 'cus_1' } as never, SECRET);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const ttl = payload.exp - payload.iat;

    expect(ttl).toBe(60 * 60 * 8);
  });

  it('keeps the Domain attribute so the dashboard-minted cookie still works', () => {
    /*
     * PR #11 pairs the shorter TTL with a `__Host-` prefix. Not adopted:
     * `__Host-` forbids Domain, and this cookie is deliberately scoped to
     * `.nimbusapi.net` so Builder can honour a session minted by the dashboard
     * (nimbus-v2 sets `nimbus_session` in its OAuth callbacks; _index.tsx
     * accepts "either ours or the dashboard's"). The prefix would break that
     * path and invalidate every live session.
     */
    const cookie = serializeNimbusSessionCookie('tok', {});

    expect(cookie).toContain('Domain=.nimbusapi.net');
    expect(cookie).not.toContain('__Host-');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');

    /*
     * Lax, not Strict: the handoff arrives as a top-level redirect from the
     * dashboard, which Strict would drop.
     */
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${60 * 60 * 8}`);
  });
});

describe('scopeEnvToCustomer — the chat path bills the right person', () => {
  /*
   * The claim on the wire stays snake_case (`nimbus_key`); only the local
   * parameter is camelCase, which is what the naming rule governs.
   */
  const sessionWith = (nimbusKey?: string) =>
    ({ token: 't', payload: { sub: 'cus_1', ...(nimbusKey ? { nimbus_key: nimbusKey } : {}) } }) as never;

  it("substitutes the customer's own key", () => {
    const scoped = scopeEnvToCustomer(
      { NIMBUS_API_KEY: 'sk-operator', NIMBUS_API_BASE_URL: 'https://api.nimbusapi.net/v1' },
      sessionWith('sk-nim-live-customer'),
    );

    expect(scoped.NIMBUS_API_KEY).toBe('sk-nim-live-customer');

    // Everything else must survive — the provider also reads the base URL.
    expect(scoped.NIMBUS_API_BASE_URL).toBe('https://api.nimbusapi.net/v1');
  });

  it('REMOVES the key when the session has none, rather than leaking the operator key', () => {
    /*
     * The load-bearing case. api.chat hands this env straight to the LLM
     * provider, which reads `serverEnv.NIMBUS_API_KEY` directly and never
     * consults getNimbusApiKey — so without this, every customer's chat
     * inference would bill to the operator the moment a container key exists.
     */
    const scoped = scopeEnvToCustomer({ NIMBUS_API_KEY: 'sk-operator' }, sessionWith());

    expect('NIMBUS_API_KEY' in scoped).toBe(false);
  });

  it('deletes rather than setting undefined', () => {
    /*
     * convertEnvToRecord stringifies values, so an undefined would reach the
     * provider as the literal "undefined" — a truthy key that fails upstream
     * with a confusing 401 instead of the provider's own sign-in message.
     */
    const scoped = scopeEnvToCustomer({ NIMBUS_API_KEY: 'sk-operator' }, null) as Record<string, unknown>;

    expect(Object.values(scoped)).not.toContain(undefined);
    expect(JSON.stringify(scoped)).not.toContain('undefined');
  });

  it('still honours the container key when SSO is disabled (local dev)', () => {
    const scoped = scopeEnvToCustomer({ NIMBUS_API_KEY: 'sk-operator', NIMBUS_SSO_DISABLED: 'true' }, null);

    expect(scoped.NIMBUS_API_KEY).toBe('sk-operator');
  });
});
