import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  BUILDER_AUDIENCE,
  NIMBUS_COOKIE_NAME,
  requireBuilderAuth,
  requireNimbusSession,
  type NimbusEnv,
} from './nimbus-sso';

/*
 * Regression matrix for the Builder inference/model route guard.
 *
 * The secrets below are test fixtures generated for this file. They are not
 * credentials and are not used by any deployment.
 */
const SECRET = 'unit-test-fixture-secret-0000000000000000';
const OTHER_SECRET = 'unit-test-fixture-secret-1111111111111111';

const ENV: NimbusEnv = { NIMBUS_SSO_SHARED_SECRET: SECRET };

type MintOpts = {
  aud?: string | string[];
  secret?: string;
  expiresIn?: string;
};

async function mint({ aud, secret = SECRET, expiresIn = '1h' }: MintOpts = {}): Promise<string> {
  let builder = new SignJWT({ sub: 'user_test', email: 'test@example.invalid' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn);

  if (aud !== undefined) {
    builder = builder.setAudience(aud);
  }

  return builder.sign(new TextEncoder().encode(secret));
}

function requestWith(token?: string): Request {
  const headers = new Headers();

  if (token) {
    headers.set('Cookie', `${NIMBUS_COOKIE_NAME}=${encodeURIComponent(token)}`);
  }

  return new Request('https://builder.nimbusapi.net/api/chat', { method: 'POST', headers });
}

describe('requireBuilderAuth', () => {
  it('denies a request with no session cookie', async () => {
    const denied = await requireBuilderAuth(requestWith(), ENV);

    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
    await expect(denied!.json()).resolves.toEqual({
      error: 'unauthorized',
      code: 'no_builder_session',
    });
  });

  it('denies a token signed with the wrong secret', async () => {
    const token = await mint({ aud: BUILDER_AUDIENCE, secret: OTHER_SECRET });
    const denied = await requireBuilderAuth(requestWith(token), ENV);

    expect(denied?.status).toBe(401);
  });

  it('denies an expired token', async () => {
    const token = await mint({ aud: BUILDER_AUDIENCE, expiresIn: '-1h' });
    const denied = await requireBuilderAuth(requestWith(token), ENV);

    expect(denied?.status).toBe(401);
  });

  it('denies a correctly signed token that carries no audience', async () => {
    const token = await mint();
    const denied = await requireBuilderAuth(requestWith(token), ENV);

    expect(denied?.status).toBe(401);
  });

  it('denies a correctly signed token issued for a different audience', async () => {
    const token = await mint({ aud: 'chat' });
    const denied = await requireBuilderAuth(requestWith(token), ENV);

    expect(denied?.status).toBe(401);
  });

  it('allows a correctly signed token with aud=builder', async () => {
    const token = await mint({ aud: BUILDER_AUDIENCE });

    await expect(requireBuilderAuth(requestWith(token), ENV)).resolves.toBeNull();
  });

  it('allows a token whose audience array contains builder', async () => {
    const token = await mint({ aud: ['chat', BUILDER_AUDIENCE] });

    await expect(requireBuilderAuth(requestWith(token), ENV)).resolves.toBeNull();
  });

  it('fails closed when no shared secret is configured', async () => {
    const token = await mint({ aud: BUILDER_AUDIENCE });
    const denied = await requireBuilderAuth(requestWith(token), {});

    expect(denied?.status).toBe(401);
  });

  it('allows any request when NIMBUS_SSO_DISABLED is set (local dev escape hatch)', async () => {
    const env: NimbusEnv = { ...ENV, NIMBUS_SSO_DISABLED: 'true' };

    await expect(requireBuilderAuth(requestWith(), env)).resolves.toBeNull();
  });

  it('does not disclose credential material in the denial body or headers', async () => {
    const denied = await requireBuilderAuth(requestWith(), ENV);
    const body = await denied!.text();
    const headers = JSON.stringify([...denied!.headers.entries()]);

    expect(body).not.toContain(SECRET);
    expect(headers).not.toContain(SECRET);
    expect(denied!.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('requireNimbusSession', () => {
  it('returns the verified session for an aud=builder token', async () => {
    const token = await mint({ aud: BUILDER_AUDIENCE });
    const session = await requireNimbusSession(requestWith(token), ENV);

    expect(session?.payload.sub).toBe('user_test');
    expect(session?.token).toBe(token);
  });

  it('returns null when the audience is not builder', async () => {
    const token = await mint({ aud: 'chat' });

    await expect(requireNimbusSession(requestWith(token), ENV)).resolves.toBeNull();
  });
});
