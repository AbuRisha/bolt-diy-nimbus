/**
 * Server-only Nimbus SSO helpers.
 *
 * Establishes a fail-closed Builder session from the authenticated Nimbus
 * dashboard handoff. Flow:
 *
 *   1. nimbus-v2 dashboard mints a short-lived HS256 JWT (via
 *      /api/auth/chat-token) and hands the user off to builder.nimbusapi.net.
 *   2. The Builder verifies HS256, `aud=builder`, subject, issue/expiry times,
 *      and a maximum 90-second handoff lifetime.
 *   3. A valid handoff is exchanged for a separate eight-hour, host-only,
 *      HttpOnly Builder session cookie. The one-minute URL token is never used
 *      as the long-lived session credential.
 *   4. Server routes read the resulting session with
 *      `readNimbusSessionFromRequest` and pull the upstream API key via
 *      `getNimbusApiKey` without exposing either credential to browser code.
 *
 * This module MUST stay under app/lib/.server so Remix never bundles it into
 * the browser (Vite treats `.server` as a server-only boundary).
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export const NIMBUS_COOKIE_NAME = '__Host-nimbus_builder_session';
export const NIMBUS_TOKEN_PARAM = 'nimbus_token';
export const NIMBUS_LOGIN_URL = 'https://nimbusapi.net/login?next=/dashboard/builder';

const NIMBUS_HANDOFF_AUDIENCE = 'builder';
const NIMBUS_SESSION_AUDIENCE = 'builder-session';
const NIMBUS_SESSION_ISSUER = 'nimbus-builder';
const NIMBUS_HANDOFF_MAX_AGE_SECONDS = 90;
const NIMBUS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;

export type NimbusEnv = Record<string, string | undefined>;

export type NimbusJwtPayload = JWTPayload & {
  sub?: string;
  email?: string;

  /** Optional per-user upstream API key baked into the token. */
  nimbus_key?: string;
};

export type NimbusSession = {
  token: string;
  payload: NimbusJwtPayload;
};

function getEnvVal(env: NimbusEnv | undefined, key: string): string | undefined {
  const fromArg = env?.[key];

  if (fromArg && fromArg.length > 0) {
    return fromArg;
  }

  if (typeof process !== 'undefined' && process.env) {
    const fromProcess = process.env[key];

    if (fromProcess && fromProcess.length > 0) {
      return fromProcess;
    }
  }

  return undefined;
}

/**
 * Normalize a Cloudflare Env binding or a plain object into a
 * `Record<string, string | undefined>` that we can read consistently.
 */
export function resolveNimbusEnv(cloudflareEnv?: unknown): NimbusEnv {
  const source = (cloudflareEnv as Record<string, unknown> | undefined) ?? {};
  const merged: NimbusEnv = {};

  for (const [k, v] of Object.entries(source)) {
    merged[k] = v == null ? undefined : String(v);
  }

  return merged;
}

/** Escape hatch for local dev / CI so the loader doesn't force a redirect. */
export function isNimbusSsoDisabled(env: NimbusEnv): boolean {
  return (getEnvVal(env, 'NIMBUS_SSO_DISABLED') ?? '').toLowerCase() === 'true';
}

export function getNimbusSharedSecret(env: NimbusEnv): string | undefined {
  return getEnvVal(env, 'NIMBUS_SSO_SHARED_SECRET');
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};

  if (!header) {
    return out;
  }

  for (const item of header.split(';')) {
    const trimmed = item.trim();

    if (!trimmed) {
      continue;
    }

    const eq = trimmed.indexOf('=');

    if (eq <= 0) {
      continue;
    }

    const rawName = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();

    try {
      out[decodeURIComponent(rawName)] = decodeURIComponent(rawValue);
    } catch {
      out[rawName] = rawValue;
    }
  }

  return out;
}

/** Verify the dashboard's short-lived, Builder-scoped handoff token. */
export async function verifyNimbusToken(token: string, secret: string): Promise<NimbusSession | null> {
  if (!token || !secret) {
    return null;
  }

  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      audience: NIMBUS_HANDOFF_AUDIENCE,
      clockTolerance: 5,
    });

    const now = Math.floor(Date.now() / 1000);
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;

    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof issuedAt !== 'number' ||
      typeof expiresAt !== 'number' ||
      issuedAt > now + 5 ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > NIMBUS_HANDOFF_MAX_AGE_SECONDS
    ) {
      return null;
    }

    return { token, payload: payload as NimbusJwtPayload };
  } catch {
    return null;
  }
}

/** Exchange a 60-second handoff for a host-only Builder session. */
export async function mintNimbusSessionToken(handoff: NimbusSession, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const session = new SignJWT({
    email: handoff.payload.email,
    name: handoff.payload.name,
    nimbus_key: handoff.payload.nimbus_key,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(handoff.payload.sub as string)
    .setIssuer(NIMBUS_SESSION_ISSUER)
    .setAudience(NIMBUS_SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${NIMBUS_COOKIE_MAX_AGE_SECONDS}s`);

  return session.sign(key);
}

export async function verifyNimbusSessionToken(token: string, secret: string): Promise<NimbusSession | null> {
  if (!token || !secret) {
    return null;
  }

  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      audience: NIMBUS_SESSION_AUDIENCE,
      issuer: NIMBUS_SESSION_ISSUER,
      clockTolerance: 5,
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return null;
    }

    return { token, payload: payload as NimbusJwtPayload };
  } catch {
    return null;
  }
}

export async function readNimbusSessionFromRequest(request: Request, env: NimbusEnv): Promise<NimbusSession | null> {
  const secret = getNimbusSharedSecret(env);

  if (!secret) {
    return null;
  }

  const cookies = parseCookieHeader(request.headers.get('Cookie'));
  const token = cookies[NIMBUS_COOKIE_NAME];

  if (!token) {
    return null;
  }

  return verifyNimbusSessionToken(token, secret);
}

export function serializeNimbusSessionCookie(token: string, opts: { maxAgeSeconds?: number } = {}): string {
  const requestedAge = opts.maxAgeSeconds ?? NIMBUS_COOKIE_MAX_AGE_SECONDS;
  const maxAge = Math.max(0, Math.min(requestedAge, NIMBUS_COOKIE_MAX_AGE_SECONDS));

  const parts = [
    `${NIMBUS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];

  return parts.join('; ');
}

export function buildNimbusLoginRedirect(): string {
  return NIMBUS_LOGIN_URL;
}

export function isNimbusPublicPath(pathname: string): boolean {
  return (
    pathname === '/api/health' ||
    pathname === '/favicon.svg' ||
    pathname === '/manifest.webmanifest' ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/build/') ||
    pathname.startsWith('/brand/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/mascot/')
  );
}

/**
 * Fail-closed request boundary shared by the Pages function and root loader.
 * Returns `null` only when the request may proceed.
 */
export async function enforceNimbusAuth(request: Request, env: NimbusEnv): Promise<Response | null> {
  if (isNimbusSsoDisabled(env)) {
    return null;
  }

  const secret = getNimbusSharedSecret(env);

  if (!secret) {
    return new Response(JSON.stringify({ error: 'nimbus_sso_not_configured' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }

  const url = new URL(request.url);
  const isApiRequest = url.pathname.startsWith('/api/');
  const bootstrapToken = url.searchParams.get(NIMBUS_TOKEN_PARAM);

  /*
   * Handoffs are accepted only on top-level GET navigations. API calls cannot
   * use URL tokens as a substitute for the secure Builder session cookie.
   */
  if (bootstrapToken && request.method === 'GET' && !isApiRequest) {
    const handoff = await verifyNimbusToken(bootstrapToken, secret);

    if (handoff) {
      const sessionToken = await mintNimbusSessionToken(handoff, secret);
      url.searchParams.delete(NIMBUS_TOKEN_PARAM);

      return new Response(null, {
        status: 302,
        headers: {
          Location: `${url.pathname}${url.search}` || '/',
          'Set-Cookie': serializeNimbusSessionCookie(sessionToken),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }
  }

  const session = await readNimbusSessionFromRequest(request, env);

  if (session) {
    return null;
  }

  if (isApiRequest) {
    return new Response(JSON.stringify({ error: 'nimbus_sso_required' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'NimbusSSO realm="builder.nimbusapi.net"',
      },
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: buildNimbusLoginRedirect(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/**
 * Resolve the upstream API key. Prefers a per-user key embedded in the JWT (so
 * per-user usage/quotas stay accurate) and falls back to the container-wide
 * NIMBUS_API_KEY that ships with every deployment.
 */
export function getNimbusApiKey(
  env: NimbusEnv,
  session?: NimbusSession | null,
  opts: { allowSharedKey?: boolean } = {},
): string | undefined {
  const embedded = session?.payload?.nimbus_key;

  if (typeof embedded === 'string' && embedded.length > 0) {
    return embedded;
  }

  return opts.allowSharedKey ? getEnvVal(env, 'NIMBUS_API_KEY') : undefined;
}

/**
 * Build the environment passed to Remix for this request. In hosted SSO mode,
 * the container-wide reseller key is always removed and can only be replaced
 * by a customer-scoped delegation carried in the signed Builder session.
 */
export async function scopeNimbusEnvForRequest(request: Request, env: NimbusEnv): Promise<NimbusEnv> {
  if (isNimbusSsoDisabled(env)) {
    return env;
  }

  const scopedEnv = { ...env };
  delete scopedEnv.NIMBUS_API_KEY;

  const session = await readNimbusSessionFromRequest(request, env);
  const delegatedKey = getNimbusApiKey(env, session);

  if (delegatedKey) {
    scopedEnv.NIMBUS_API_KEY = delegatedKey;
  }

  return scopedEnv;
}

/** Upstream Nimbus OpenAI-compatible base URL (no trailing slash). */
export function getNimbusUpstreamBase(env: NimbusEnv): string {
  const raw = getEnvVal(env, 'NIMBUS_API_BASE_URL') ?? 'https://api.nimbusapi.net/v1';

  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}
