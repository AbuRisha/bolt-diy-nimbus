/**
 * Server-only Nimbus SSO helpers.
 *
 * Auto-inherits a nimbusapi.net session so the Builder never asks the user for
 * an API key or a login. Flow:
 *
 *   1. nimbus-v2 dashboard mints a short-lived HS256 JWT (via
 *      /api/auth/chat-token) and hands the user off to builder.nimbusapi.net.
 *   2. Either the browser arrives with `?nimbus_token=<jwt>` on the root
 *      route, or it already carries a `nimbus_session` cookie scoped to
 *      `.nimbusapi.net` (set on the dashboard side).
 *   3. This module verifies the JWT with NIMBUS_SSO_SHARED_SECRET, and — for
 *      the bootstrap-token path — persists it as a first-party cookie so
 *      subsequent navigations don't need the URL parameter.
 *   4. Server routes read the resulting session with
 *      `readNimbusSessionFromRequest` and pull the upstream API key via
 *      `getNimbusApiKey` (per-session key from the JWT if the mint embedded
 *      one, otherwise the container-wide NIMBUS_API_KEY).
 *
 * This module MUST stay under app/lib/.server so Remix never bundles it into
 * the browser (Vite treats `.server` as a server-only boundary).
 */
import { jwtVerify, type JWTPayload } from 'jose';

export const NIMBUS_COOKIE_NAME = 'nimbus_session';
export const NIMBUS_TOKEN_PARAM = 'nimbus_token';
export const NIMBUS_DASHBOARD_DEFAULT = 'https://nimbusapi.net/dashboard';

const NIMBUS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // one week
const NIMBUS_COOKIE_MIN_AGE_SECONDS = 60; // never issue a sub-minute cookie

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

export function getNimbusDashboardUrl(env: NimbusEnv): string {
  return getEnvVal(env, 'NIMBUS_DASHBOARD_URL') ?? NIMBUS_DASHBOARD_DEFAULT;
}

export function getNimbusSharedSecret(env: NimbusEnv): string | undefined {
  return getEnvVal(env, 'NIMBUS_SSO_SHARED_SECRET');
}

/**
 * Cookie Domain for the first-party session cookie we mint after consuming a
 * `?nimbus_token=` bootstrap. Defaults to `.nimbusapi.net` so the cookie is
 * shared with the dashboard and any other builder-adjacent subdomains; set
 * NIMBUS_SSO_COOKIE_DOMAIN="" to scope it to the current host instead (useful
 * on staging deploys under a non-nimbusapi.net origin).
 */
export function getNimbusCookieDomain(env: NimbusEnv): string | undefined {
  const val = getEnvVal(env, 'NIMBUS_SSO_COOKIE_DOMAIN');

  if (val == null) {
    return '.nimbusapi.net';
  }

  return val.length === 0 ? undefined : val;
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

export async function verifyNimbusToken(token: string, secret: string): Promise<NimbusSession | null> {
  if (!token || !secret) {
    return null;
  }

  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });

    return { token, payload: payload as NimbusJwtPayload };
  } catch {
    return null;
  }
}

export async function readNimbusSessionFromRequest(
  request: Request,
  env: NimbusEnv,
): Promise<NimbusSession | null> {
  const secret = getNimbusSharedSecret(env);

  if (!secret) {
    return null;
  }

  const cookies = parseCookieHeader(request.headers.get('Cookie'));
  const token = cookies[NIMBUS_COOKIE_NAME];

  if (!token) {
    return null;
  }

  return verifyNimbusToken(token, secret);
}

export function serializeNimbusSessionCookie(
  token: string,
  env: NimbusEnv,
  opts: { maxAgeSeconds?: number } = {},
): string {
  const domain = getNimbusCookieDomain(env);
  const requestedAge = opts.maxAgeSeconds ?? NIMBUS_COOKIE_MAX_AGE_SECONDS;
  const maxAge = Math.max(NIMBUS_COOKIE_MIN_AGE_SECONDS, Math.min(requestedAge, NIMBUS_COOKIE_MAX_AGE_SECONDS));

  const parts = [
    `${NIMBUS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];

  if (domain) {
    parts.push(`Domain=${domain}`);
  }

  return parts.join('; ');
}

export function buildNimbusDashboardRedirect(env: NimbusEnv, nextSlug = 'builder'): string {
  const dashboard = new URL(getNimbusDashboardUrl(env));
  dashboard.searchParams.set('next', nextSlug);

  return dashboard.toString();
}

/**
 * Resolve the upstream API key. Prefers a per-user key embedded in the JWT (so
 * per-user usage/quotas stay accurate) and falls back to the container-wide
 * NIMBUS_API_KEY that ships with every deployment.
 */
export function getNimbusApiKey(env: NimbusEnv, session?: NimbusSession | null): string | undefined {
  const embedded = session?.payload?.nimbus_key;

  if (typeof embedded === 'string' && embedded.length > 0) {
    return embedded;
  }

  return getEnvVal(env, 'NIMBUS_API_KEY');
}

/** Upstream Nimbus OpenAI-compatible base URL (no trailing slash). */
export function getNimbusUpstreamBase(env: NimbusEnv): string {
  const raw = getEnvVal(env, 'NIMBUS_API_BASE_URL') ?? 'https://api.nimbusapi.net/v1';

  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}
