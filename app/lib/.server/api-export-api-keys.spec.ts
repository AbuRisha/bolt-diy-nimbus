/**
 * Regression test for the /api/export-api-keys credential leak.
 *
 * NOTE ON LOCATION: this spec lives here rather than next to the route because
 * the Remix flat-route scanner turns every top-level file in `app/routes/` into
 * a route, and vite.config.ts sets no `ignoredRouteFiles`. A spec file dropped
 * in `app/routes/` would register a bogus `/api/export-api-keys/spec` route.
 *
 * THE ORIGINAL BUG
 * ----------------
 * This loader used to walk every registered provider's `apiTokenKey` and return
 * whatever it found in `context.cloudflare.env`, `process.env`, or
 * `llmManager.env`. Remix resource routes never run the `_index` page loader, so
 * the SSO check there did not apply and the route had no gate of its own: any
 * unauthenticated GET dumped the operator's server-side provider credentials in
 * plaintext.
 *
 * WHAT THIS SUITE PINS
 * --------------------
 *   1. Server environment variables are NEVER echoed into the response body —
 *      not even to a fully authenticated aud='builder' caller, and not when the
 *      NIMBUS_SSO_DISABLED dev escape hatch is on. The canary value
 *      `FAKE_TEST_KEY_DO_NOT_USE` is planted in both env sources the old code
 *      read; if anyone reintroduces the env walk, these tests fail.
 *   2. The route is gated: unauthenticated -> 401, aud='chat' -> 401 (the
 *      cross-surface replay case), aud='builder' -> 200.
 *   3. The gate runs before any cookie parse or env read, so a denied caller
 *      gets back nothing but the error envelope.
 *
 * Every secret in this file is fake and test-only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { loader } from '~/routes/api.export-api-keys';
import { BUILDER_AUDIENCE, NIMBUS_COOKIE_NAME, type NimbusEnv } from './nimbus-sso';

/** Obviously fake. Never a real NIMBUS_SSO_SHARED_SECRET. */
const TEST_SECRET = 'vitest-only-fake-sso-secret-DO-NOT-USE-2f4b';

/**
 * Canary values planted in the server environment. The whole point of this file
 * is that none of these may ever appear in a response body. The shared prefix
 * makes a single substring assertion catch all of them.
 */
const CANARY_PREFIX = 'FAKE_TEST_KEY_DO_NOT_USE';
const CANARY_OPENAI = `${CANARY_PREFIX}-openai-3b82fe`;
const CANARY_ANTHROPIC = `${CANARY_PREFIX}-anthropic-9d41c7`;
const CANARY_NIMBUS = `${CANARY_PREFIX}-nimbus-7c05ad`;

/** The caller's OWN bring-your-own key. This one IS legitimately exportable. */
const CALLER_OWN_OPENAI_KEY = 'caller-supplied-openai-key-vitest-only';

/**
 * `getEnvVal` falls back to `process.env`, and vite.config.ts dotenv-loads
 * `.env` / `.env.local` into this process. Clear + restore every key we assert
 * on so a developer's local environment cannot flip these results.
 */
const MANAGED_ENV_KEYS = [
  'NIMBUS_SSO_SHARED_SECRET',
  'NIMBUS_SSO_DISABLED',
  'NIMBUS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

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

/** Plant the canaries in both env sources the vulnerable version read. */
function plantServerSideKeys(): NimbusEnv {
  // Path 2 of the old lookup: process.env (.env.local on a self-hosted box).
  process.env.OPENAI_API_KEY = CANARY_OPENAI;
  process.env.NIMBUS_API_KEY = CANARY_NIMBUS;

  // Path 1 of the old lookup: the Cloudflare env binding.
  return {
    NIMBUS_SSO_SHARED_SECRET: TEST_SECRET,
    ANTHROPIC_API_KEY: CANARY_ANTHROPIC,
  };
}

async function mintToken(aud: string | string[] = BUILDER_AUDIENCE): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({ email: 'builder-test@example.invalid' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user_vitest_0001')
    .setAudience(aud)
    .setIssuedAt(nowSeconds - 5)
    .setExpirationTime(nowSeconds + 300)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function cookieHeader(parts: { token?: string; apiKeys?: Record<string, string> }): string | undefined {
  const items: string[] = [];

  if (parts.token) {
    items.push(`${NIMBUS_COOKIE_NAME}=${parts.token}`);
  }

  if (parts.apiKeys) {
    items.push(`apiKeys=${encodeURIComponent(JSON.stringify(parts.apiKeys))}`);
  }

  return items.length > 0 ? items.join('; ') : undefined;
}

async function invokeLoader(cookie: string | undefined, cloudflareEnv: NimbusEnv): Promise<Response> {
  const headers = new Headers();

  if (cookie) {
    headers.set('Cookie', cookie);
  }

  const request = new Request('https://builder.nimbusapi.net/api/export-api-keys', { headers });

  const args = {
    request,
    params: {},
    context: { cloudflare: { env: cloudflareEnv } },
  } as unknown as Parameters<typeof loader>[0];

  return (await loader(args)) as unknown as Response;
}

describe('GET /api/export-api-keys — server credentials never leave the server', () => {
  it('does not return a server-side provider key to an authenticated builder session', async () => {
    const cloudflareEnv = plantServerSideKeys();
    const cookie = cookieHeader({
      token: await mintToken(),
      apiKeys: { OpenAI: CALLER_OWN_OPENAI_KEY },
    });

    const response = await invokeLoader(cookie, cloudflareEnv);
    expect(response.status).toBe(200);

    const raw = await response.text();

    /*
     * The load-bearing assertion. The vulnerable version added
     * `Anthropic: <ANTHROPIC_API_KEY>` and `Nimbus: <NIMBUS_API_KEY>` here
     * because neither provider was present in the caller's cookie.
     */
    expect(raw).not.toContain(CANARY_PREFIX);
    expect(raw).not.toContain(CANARY_OPENAI);
    expect(raw).not.toContain(CANARY_ANTHROPIC);
    expect(raw).not.toContain(CANARY_NIMBUS);

    // Only the caller's own key comes back, and the response shape is unchanged.
    expect(JSON.parse(raw)).toEqual({ OpenAI: CALLER_OWN_OPENAI_KEY });
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('returns an empty object when the caller supplied no keys of their own', async () => {
    const cloudflareEnv = plantServerSideKeys();
    const cookie = cookieHeader({ token: await mintToken() });

    const response = await invokeLoader(cookie, cloudflareEnv);
    expect(response.status).toBe(200);

    const raw = await response.text();

    /*
     * A configured server has keys for many providers. If the env walk ever
     * comes back, this body stops being `{}` and starts being a credential dump.
     */
    expect(raw).not.toContain(CANARY_PREFIX);
    expect(JSON.parse(raw)).toEqual({});
  });

  it('still refuses to disclose env keys when NIMBUS_SSO_DISABLED is on', async () => {
    const cloudflareEnv = { ...plantServerSideKeys(), NIMBUS_SSO_DISABLED: 'true' };

    // No session at all — the dev escape hatch lets the request through the gate.
    const response = await invokeLoader(undefined, cloudflareEnv);
    expect(response.status).toBe(200);

    const raw = await response.text();

    // The escape hatch must not double as a credential dump.
    expect(raw).not.toContain(CANARY_PREFIX);
    expect(JSON.parse(raw)).toEqual({});
  });
});

describe('GET /api/export-api-keys — auth gate', () => {
  it('rejects an unauthenticated request with 401 no_builder_session', async () => {
    const cloudflareEnv = plantServerSideKeys();

    const response = await invokeLoader(undefined, cloudflareEnv);
    expect(response.status).toBe(401);

    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: 'unauthorized', code: 'no_builder_session' });
    expect(raw).not.toContain(CANARY_PREFIX);
  });

  it("rejects a token minted for another surface (aud='chat')", async () => {
    const cloudflareEnv = plantServerSideKeys();
    const cookie = cookieHeader({
      token: await mintToken('chat'),
      apiKeys: { OpenAI: CALLER_OWN_OPENAI_KEY },
    });

    const response = await invokeLoader(cookie, cloudflareEnv);
    expect(response.status).toBe(401);

    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: 'unauthorized', code: 'no_builder_session' });

    // The gate runs before the cookie parse, so nothing at all comes back.
    expect(raw).not.toContain(CANARY_PREFIX);
    expect(raw).not.toContain(CALLER_OWN_OPENAI_KEY);
  });

  it("accepts a valid aud='builder' session", async () => {
    const cloudflareEnv = plantServerSideKeys();
    const cookie = cookieHeader({
      token: await mintToken(BUILDER_AUDIENCE),
      apiKeys: { OpenAI: CALLER_OWN_OPENAI_KEY },
    });

    const response = await invokeLoader(cookie, cloudflareEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ OpenAI: CALLER_OWN_OPENAI_KEY });
  });
});
