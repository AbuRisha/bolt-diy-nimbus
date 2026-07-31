/**
 * Guard semantics for the shared Nimbus SSO route guard.
 *
 * Remix resource routes (app/routes/api.*.ts) never run the `_index` page
 * loader, so the SSO check there has never applied to them. `requireBuilderAuth`
 * is the gate every resource route now calls at the very top of its
 * loader/action. This suite pins the contract that gate must keep:
 *
 *   - no session cookie                -> 401 {error:'unauthorized', code:'no_builder_session'}
 *   - a valid token minted for another
 *     surface (aud !== 'builder')      -> 401  (cross-surface replay)
 *   - a valid aud='builder' session    -> allowed
 *
 * Every token here is signed with an obviously fake, test-only secret. Nothing
 * in this file may ever be a real credential.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  BUILDER_AUDIENCE,
  NIMBUS_COOKIE_NAME,
  requireBuilderAuth,
  requireNimbusSession,
  verifyNimbusToken,
  type NimbusEnv,
} from './nimbus-sso';

/** Obviously fake. Never a real NIMBUS_SSO_SHARED_SECRET. */
const TEST_SECRET = 'vitest-only-fake-sso-secret-DO-NOT-USE-2f4b';
const OTHER_SECRET = 'vitest-only-fake-sso-secret-DO-NOT-USE-9a1c';

/**
 * `getEnvVal` inside nimbus-sso falls back to `process.env`, and vite.config.ts
 * dotenv-loads `.env` / `.env.local` into this process. Clear the keys we care
 * about so a developer's local environment cannot flip these assertions.
 */
const MANAGED_ENV_KEYS = ['NIMBUS_SSO_SHARED_SECRET', 'NIMBUS_SSO_DISABLED', 'NIMBUS_API_KEY'] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};

  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const previous = savedEnv[key];

    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

function env(overrides: NimbusEnv = {}): NimbusEnv {
  return { NIMBUS_SSO_SHARED_SECRET: TEST_SECRET, ...overrides };
}

async function mintToken(
  opts: {
    aud?: string | string[];
    secret?: string;
    /** Seconds from now. Negative values mint an already-expired token. */
    expiresInSeconds?: number;
  } = {},
): Promise<string> {
  const { aud = BUILDER_AUDIENCE, secret = TEST_SECRET, expiresInSeconds = 300 } = opts;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({ email: 'builder-test@example.invalid' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user_vitest_0001')
    .setAudience(aud)
    .setIssuedAt(nowSeconds - 5)
    .setExpirationTime(nowSeconds + expiresInSeconds)
    .sign(new TextEncoder().encode(secret));
}

function requestWithToken(token?: string): Request {
  const headers = new Headers();

  if (token) {
    headers.set('Cookie', `${NIMBUS_COOKIE_NAME}=${token}`);
  }

  return new Request('https://builder.nimbusapi.net/api/export-api-keys', { headers });
}

async function expectUnauthorized(denied: Response | null): Promise<void> {
  expect(denied).toBeInstanceOf(Response);
  expect(denied?.status).toBe(401);
  expect(denied?.headers.get('Content-Type')).toBe('application/json');
  expect(denied?.headers.get('Cache-Control')).toBe('no-store');

  const body = await (denied as Response).json();
  expect(body).toEqual({ error: 'unauthorized', code: 'no_builder_session' });
}

describe('requireBuilderAuth', () => {
  it('denies an unauthenticated request with 401 no_builder_session', async () => {
    await expectUnauthorized(await requireBuilderAuth(requestWithToken(), env()));
  });

  it("denies a token minted for another surface (aud='chat') — cross-surface replay", async () => {
    const chatToken = await mintToken({ aud: 'chat' });

    await expectUnauthorized(await requireBuilderAuth(requestWithToken(chatToken), env()));
  });

  it("denies a token whose aud array does not contain 'builder'", async () => {
    const token = await mintToken({ aud: ['chat', 'dashboard'] });

    await expectUnauthorized(await requireBuilderAuth(requestWithToken(token), env()));
  });

  it('denies a token signed with a different secret', async () => {
    const forged = await mintToken({ secret: OTHER_SECRET });

    await expectUnauthorized(await requireBuilderAuth(requestWithToken(forged), env()));
  });

  it('denies an expired builder token', async () => {
    const expired = await mintToken({ expiresInSeconds: -60 });

    await expectUnauthorized(await requireBuilderAuth(requestWithToken(expired), env()));
  });

  it('denies a token whose signature has been tampered with', async () => {
    const token = await mintToken();
    const segments = token.split('.');

    /*
     * Flip a character in the MIDDLE of the signature, not the last one. An
     * HMAC-SHA256 signature is 32 bytes, which base64url-encodes to 43
     * characters carrying 258 bits — the final character's low 2 bits are
     * padding and decode to nothing. Flipping only those (e.g. 'A' -> 'B')
     * yields the same 32 bytes, so the signature still verifies and the test
     * asserts nothing.
     */
    const sig = segments[2];
    const mid = Math.floor(sig.length / 2);
    segments[2] = sig.slice(0, mid) + (sig[mid] === 'A' ? 'B' : 'A') + sig.slice(mid + 1);

    expect(segments[2]).not.toBe(sig);

    await expectUnauthorized(await requireBuilderAuth(requestWithToken(segments.join('.')), env()));
  });

  it('denies a token whose payload has been tampered with', async () => {
    const token = await mintToken({ aud: 'chat' });
    const [header, payload, signature] = token.split('.');

    // Re-encode the payload claiming aud='builder', keeping the original signature.
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.aud = BUILDER_AUDIENCE;

    const forgedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    await expectUnauthorized(
      await requireBuilderAuth(requestWithToken([header, forgedPayload, signature].join('.')), env()),
    );
  });

  it('denies every caller when no shared secret is configured', async () => {
    const token = await mintToken();

    await expectUnauthorized(await requireBuilderAuth(requestWithToken(token), {}));
  });

  it("allows a valid aud='builder' session", async () => {
    const token = await mintToken();

    expect(await requireBuilderAuth(requestWithToken(token), env())).toBeNull();
  });

  it("allows a token whose aud array contains 'builder'", async () => {
    const token = await mintToken({ aud: ['chat', BUILDER_AUDIENCE] });

    expect(await requireBuilderAuth(requestWithToken(token), env())).toBeNull();
  });

  it('honors the NIMBUS_SSO_DISABLED local-dev escape hatch', async () => {
    const allowed = await requireBuilderAuth(requestWithToken(), env({ NIMBUS_SSO_DISABLED: 'true' }));

    expect(allowed).toBeNull();
  });

  it('does not treat any value other than "true" as disabled', async () => {
    await expectUnauthorized(await requireBuilderAuth(requestWithToken(), env({ NIMBUS_SSO_DISABLED: '1' })));
    await expectUnauthorized(await requireBuilderAuth(requestWithToken(), env({ NIMBUS_SSO_DISABLED: 'false' })));
  });
});

describe('requireNimbusSession', () => {
  it("returns the session for aud='builder'", async () => {
    const token = await mintToken();
    const session = await requireNimbusSession(requestWithToken(token), env());

    expect(session).not.toBeNull();
    expect(session?.payload.sub).toBe('user_vitest_0001');
    expect(session?.payload.aud).toBe(BUILDER_AUDIENCE);
  });

  it("returns null for aud='chat' even though the signature is valid", async () => {
    const chatToken = await mintToken({ aud: 'chat' });

    // Signature check passes...
    expect(await verifyNimbusToken(chatToken, TEST_SECRET)).not.toBeNull();

    // ...but the audience check must still reject it.
    expect(await requireNimbusSession(requestWithToken(chatToken), env())).toBeNull();
  });

  it('returns null when the cookie is absent', async () => {
    expect(await requireNimbusSession(requestWithToken(), env())).toBeNull();
  });
});
