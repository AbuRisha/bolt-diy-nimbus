/**
 * Route-enumeration auth test — the regression net for the whole lockdown.
 *
 * THE BUG CLASS THIS CATCHES
 * --------------------------
 * Remix resource routes (`app/routes/api.*.ts`) never run the `_index` page
 * loader, so the Nimbus SSO check that lives there has never applied to them.
 * At the time of the audit, 34 of 35 resource routes on
 * builder.nimbusapi.net were reachable with no session at all, and one of them
 * was live-leaking the operator's provider credentials to the public internet.
 *
 * Guarding those 34 routes once is not enough: the next person to add
 * `app/routes/api.something.ts` re-opens the hole silently, because nothing in
 * the build fails. THIS FILE IS THAT FAILING BUILD.
 *
 * HOW IT WORKS
 * ------------
 *   1. It reads `app/routes/` off disk AT TEST TIME (`readdirSync`). The route
 *      list is never hardcoded — a brand new `api.*.ts` file is picked up on
 *      the very first run after it lands.
 *   2. Anything not in `PUBLIC_ROUTES` must answer an unauthenticated request
 *      with 401.
 *   3. The check is BEHAVIORAL: it imports the route module and actually
 *      invokes its `loader` / `action` with a session-less Request. It is not
 *      a source grep.
 *
 * WHY BEHAVIORAL AND NOT A GREP
 * -----------------------------
 * A grep for `requireBuilderAuth` gets both directions wrong:
 *
 *   - FALSE POSITIVE (grep says "unguarded", route is fine):
 *     `app/routes/api.models.$provider.ts` is literally
 *         import { loader } from './api.models';
 *         export { loader };
 *     It contains no guard of its own and inherits `api.models`'s guard
 *     transitively. Invoking the export proves the guard is reached.
 *
 *   - FALSE NEGATIVE (grep says "guarded", route is wide open):
 *     several routes in this repo wrap their body in a fail-open
 *     `try { ... } catch { return json(..., 200) }`. A guard placed INSIDE
 *     that try block has its 401 swallowed and downgraded to a 200 — a route
 *     that greps clean and is still fully public. Only calling the handler and
 *     reading the status code catches that. This has been observed twice in
 *     this repo, which is the whole reason this suite exists.
 *
 * WHAT A FAILURE MEANS
 * --------------------
 * If this suite fails, do NOT add the route to `PUBLIC_ROUTES` to make it go
 * green. Add the guard. `PUBLIC_ROUTES` is for endpoints that are deliberately
 * anonymous, and every entry needs a justification comment.
 *
 * Every secret in this file is fake and test-only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/** Obviously fake. Never a real NIMBUS_SSO_SHARED_SECRET. */
const TEST_SECRET = 'vitest-only-fake-sso-secret-DO-NOT-USE-2f4b';

// ── The allowlist ───────────────────────────────────────────────────────
/**
 * Resource routes that are intentionally reachable without a builder session.
 * Keep this as short as it is. Each entry must say WHY it is safe to be
 * anonymous — i.e. what it does not disclose and what it does not spend.
 *
 * NOTE ON THE SSO BOOTSTRAP: the `?nimbus_token=` handoff from the nimbusapi.net
 * dashboard is handled by `app/routes/_index.tsx`, which is a PAGE route, not
 * an `api.*.ts` resource route. Page routes do run their own loader, so the SSO
 * check applies there natively and it is correctly out of scope for this
 * suite's enumeration. There is no `api.*` bootstrap endpoint to allowlist.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  /*
   * Container liveness probe. Hit by ACA health checks, the Caddy front door
   * and external uptime monitoring, none of which carry a session cookie.
   * Returns only `{status, timestamp}` — reads no env, touches no credential,
   * makes no upstream call, and reflects nothing from the request. Requiring
   * auth here would take the deployment down.
   */
  'api.health.ts': 'container liveness probe; discloses only a literal status string and a timestamp',
};

// ── The static-check escape hatch ───────────────────────────────────────
/**
 * Routes whose handler genuinely cannot be invoked in-process (a module-load
 * side effect that needs a real worker runtime, a native binding, etc.), so we
 * fall back to reading the source.
 *
 * This is STRICTLY WEAKER than the behavioral check — a source scan cannot see
 * whether the guard sits above or inside a fail-open try/catch, and it cannot
 * see a guard inherited transitively through a re-export. Keep this map empty
 * if at all possible, and never move a route here just to silence a failure.
 */
const STATIC_FALLBACK_ROUTES: Record<string, string> = {};

// ── Enumeration ─────────────────────────────────────────────────────────
const ROUTES_DIR = fileURLToPath(new URL('../../routes/', import.meta.url));

/**
 * Read the directory at test time. This MUST NOT become a hardcoded list —
 * the entire value of this suite is that a route added tomorrow is covered
 * without anyone remembering to update a fixture.
 */
const ROUTE_FILES: string[] = readdirSync(ROUTES_DIR)
  .filter((name) => name.startsWith('api.') && name.endsWith('.ts'))
  .filter((name) => !name.endsWith('.spec.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
  .sort();

/**
 * Vite resolves this glob when it transforms the file, i.e. on every run, so
 * it tracks the directory too. It is cross-checked against `ROUTE_FILES`
 * below: if the two ever disagree, the suite fails loudly rather than
 * silently skipping a route.
 */
const ROUTE_MODULE_LOADERS = import.meta.glob('../../routes/api.*.ts') as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

function moduleKeyFor(routeFile: string): string {
  return `../../routes/${routeFile}`;
}

// ── Request construction ────────────────────────────────────────────────
/**
 * `api.system.disk-info.ts` -> `/api/system/disk-info`
 * `api.models.$provider.ts` -> `/api/models/enumeration-probe`
 * `api.git-proxy.$.ts`      -> `/api/git-proxy/`
 */
function routeFileToPathname(routeFile: string): string {
  const segments = routeFile
    .replace(/\.ts$/, '')
    .split('.')
    .map((segment) => {
      if (segment === '$') {
        return '';
      }

      return segment.startsWith('$') ? 'enumeration-probe' : segment;
    });

  return `/${segments.join('/')}`;
}

/** Dynamic-segment values, so a route that reads `params` sees something sane. */
function paramsFor(routeFile: string): Record<string, string> {
  const params: Record<string, string> = {};

  for (const segment of routeFile.replace(/\.ts$/, '').split('.')) {
    if (segment === '$') {
      params['*'] = '';
    } else if (segment.startsWith('$')) {
      params[segment.slice(1)] = 'enumeration-probe';
    }
  }

  return params;
}

/**
 * A shared secret IS configured. That matters: it means a 401 proves the
 * session check rejected the caller, not that the deployment is misconfigured
 * and failing closed by accident.
 */
function guardEnv(): Record<string, string> {
  return { NIMBUS_SSO_SHARED_SECRET: TEST_SECRET };
}

/** No `nimbus_session` cookie, no Authorization header. A drive-by request. */
function unauthenticatedRequest(routeFile: string, method: 'GET' | 'POST'): Request {
  const url = `https://builder.nimbusapi.net${routeFileToPathname(routeFile)}`;

  if (method === 'GET') {
    return new Request(url, { method });
  }

  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

type RouteHandler = (args: unknown) => unknown;

async function callHandler(handler: RouteHandler, routeFile: string, method: 'GET' | 'POST'): Promise<Response> {
  const args = {
    request: unauthenticatedRequest(routeFile, method),
    params: paramsFor(routeFile),
    context: { cloudflare: { env: guardEnv() } },
  };

  try {
    return (await handler(args)) as Response;
  } catch (thrown) {
    /*
     * Remix handlers signal some responses by throwing them
     * (`throw redirect(...)`, `throw new Response(...)`). A thrown 401 is
     * still a 401, so unwrap it. Anything else is a real crash and is
     * re-thrown — a handler that crashes on an anonymous request has not
     * denied it, it has just failed messily, and that must not read as a pass.
     */
    if (thrown instanceof Response) {
      return thrown;
    }

    throw thrown;
  }
}

// ── Environment isolation ───────────────────────────────────────────────
/**
 * `getEnvVal` in nimbus-sso falls back to `process.env`, and vite.config.ts
 * dotenv-loads `.env` / `.env.local` into this process. A developer with
 * NIMBUS_SSO_DISABLED=true in their local env would otherwise see every route
 * fail here for the wrong reason.
 */
const MANAGED_ENV_KEYS = ['NIMBUS_SSO_SHARED_SECRET', 'NIMBUS_SSO_DISABLED'] as const;

let savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

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

/**
 * The guard has to run before any upstream call, so an unauthenticated request
 * must never reach the network. Anything that does get here throws, the throw
 * propagates out of `callHandler`, and the route's test fails — which is the
 * point: a guard placed after the fetch is not a guard.
 */
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(
      `network call to ${String(input)} during an unauthenticated request — ` +
        'the auth guard must run before any upstream call',
    );
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ── Meta-assertions: the enumeration itself must be trustworthy ─────────
describe('route enumeration', () => {
  it('finds the api.* resource routes on disk', () => {
    /*
     * Anti-vacuity guard. If ROUTES_DIR ever resolves wrong, `ROUTE_FILES`
     * goes empty, zero per-route tests are generated, and the suite passes
     * while checking nothing at all. That failure mode is worse than no test,
     * so pin a floor. The audit counted 35 resource routes.
     */
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(30);
    expect(ROUTE_FILES).toContain('api.health.ts');
  });

  it('has a loadable module for every enumerated route', () => {
    const missing = ROUTE_FILES.filter((routeFile) => !ROUTE_MODULE_LOADERS[moduleKeyFor(routeFile)]);

    expect(
      missing,
      `these routes exist on disk but import.meta.glob did not pick them up, so they would be silently ` +
        `skipped: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has no stale PUBLIC_ROUTES entries', () => {
    const stale = Object.keys(PUBLIC_ROUTES).filter((routeFile) => !ROUTE_FILES.includes(routeFile));

    expect(
      stale,
      `PUBLIC_ROUTES allowlists routes that no longer exist: ${stale.join(', ')}. ` +
        'Remove them — a stale entry can silently un-gate a future route that reuses the name.',
    ).toEqual([]);
  });

  it('has no stale or double-booked STATIC_FALLBACK_ROUTES entries', () => {
    const stale = Object.keys(STATIC_FALLBACK_ROUTES).filter((routeFile) => !ROUTE_FILES.includes(routeFile));
    expect(stale, `STATIC_FALLBACK_ROUTES references routes that no longer exist: ${stale.join(', ')}`).toEqual([]);

    const doubleBooked = Object.keys(STATIC_FALLBACK_ROUTES).filter((routeFile) => routeFile in PUBLIC_ROUTES);
    expect(
      doubleBooked,
      `these routes are in both PUBLIC_ROUTES and STATIC_FALLBACK_ROUTES: ${doubleBooked.join(', ')}. ` +
        'A route is either intentionally public or expected to be guarded — not both.',
    ).toEqual([]);
  });

  it('justifies every public route', () => {
    for (const [routeFile, reason] of Object.entries(PUBLIC_ROUTES)) {
      expect(reason.length, `PUBLIC_ROUTES['${routeFile}'] needs a real justification, not a placeholder`).
        toBeGreaterThan(20);
    }
  });
});

// ── The main event ──────────────────────────────────────────────────────
const GUARDED_ROUTES = ROUTE_FILES.filter((routeFile) => !(routeFile in PUBLIC_ROUTES));

describe('every non-public api.* resource route rejects an unauthenticated request', () => {
  for (const routeFile of GUARDED_ROUTES) {
    const staticReason = STATIC_FALLBACK_ROUTES[routeFile];

    if (staticReason) {
      // Weaker fallback — see STATIC_FALLBACK_ROUTES.
      it(`${routeFile} references an auth guard in source (static fallback: ${staticReason})`, () => {
        const source = readFileSync(new URL(moduleKeyFor(routeFile), import.meta.url), 'utf8');
        const importsGuard = source.includes('nimbus-sso');
        const callsGuard = /requireBuilderAuth\s*\(|requireNimbusSession\s*\(|withSecurity\s*\(/.test(source);

        expect(
          importsGuard && callsGuard,
          `${routeFile} is not in PUBLIC_ROUTES and could not be exercised behaviorally, and its source ` +
            'does not reference the shared auth guard — add a guard or justify it in the allowlist.',
        ).toBe(true);
      });

      continue;
    }

    it(`${routeFile} returns 401 to a session-less caller`, async () => {
      const mod = await ROUTE_MODULE_LOADERS[moduleKeyFor(routeFile)]();

      const handlers: Array<{ name: 'loader' | 'action'; method: 'GET' | 'POST'; fn: RouteHandler }> = [];

      if (typeof mod.loader === 'function') {
        handlers.push({ name: 'loader', method: 'GET', fn: mod.loader as RouteHandler });
      }

      if (typeof mod.action === 'function') {
        handlers.push({ name: 'action', method: 'POST', fn: mod.action as RouteHandler });
      }

      /*
       * A resource route with neither export is not reachable, so there is
       * nothing to guard — but it is far more likely that the export was
       * renamed and this suite just lost its grip on the route. Fail.
       */
      expect(
        handlers.length,
        `${routeFile} exports neither a loader nor an action, so this suite cannot verify it. ` +
          'If it is genuinely not a resource route, move it out of app/routes/api.*.',
      ).toBeGreaterThan(0);

      for (const { name, method, fn } of handlers) {
        const response = await callHandler(fn, routeFile, method);

        expect(
          response,
          `${routeFile} ${name} did not return a Response for an unauthenticated ${method}`,
        ).toBeInstanceOf(Response);

        /*
         * Status only. The shared guard answers
         * {error:'unauthorized', code:'no_builder_session'}, but a couple of
         * routes predate it and answer with their own 401 envelope
         * (api.nimbus-proxy returns {error:'nimbus_sso_required'}). Pinning
         * the body here would make this suite about response shapes instead of
         * about reachability.
         */
        expect(
          response.status,
          `${routeFile} is not in PUBLIC_ROUTES but did not return 401 for an unauthenticated request ` +
            `(${name} answered ${method} ${routeFileToPathname(routeFile)} with ${response.status}) — ` +
            'add a guard or justify it in the allowlist. If the guard IS present, check it is not sitting ' +
            'inside a fail-open try/catch that downgrades the 401 to a 200.',
        ).toBe(401);
      }
    });
  }
});

// ── The allowlist is deliberate, not accidental ─────────────────────────
describe('public routes stay public', () => {
  it('api.health.ts answers an unauthenticated GET', async () => {
    const mod = await ROUTE_MODULE_LOADERS[moduleKeyFor('api.health.ts')]();
    const response = await callHandler(mod.loader as RouteHandler, 'api.health.ts', 'GET');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'healthy' });
  });
});
