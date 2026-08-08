import type { CacheStorage as CfCacheStorage } from '@cloudflare/workers-types';
import type { ServerBuild } from '@remix-run/cloudflare';
import { createPagesFunctionHandler } from '@remix-run/cloudflare-pages';

// Relative, not the '~' alias: this file is bundled by wrangler's esbuild pass,
// which does not read tsconfig paths the way the Vite/Remix build does.
import { requireBuilderAuth } from '../app/lib/.server/nimbus-sso';

/**
 * API paths that stay reachable without a session.
 *
 * `/api/health` is liveness and returns no data. Nothing else belongs here —
 * adding an entry is the one way to open a hole, which is the point: it is a
 * single visible list rather than 35 individual decisions.
 */
const PUBLIC_API_PATHS = new Set(['/api/health']);

/**
 * Boundary auth: every `/api/*` request is checked HERE, before Remix routes it.
 *
 * The per-route guards in app/routes stay, but they are no longer what holds
 * this together. They cannot be:
 *
 *   - A new route is unauthenticated until someone remembers to add a guard,
 *     and nothing fails if they forget.
 *   - Guards silently do nothing when wired wrong. On 2026-08-07 nine routes
 *     carried a guard that was inert, because they destructure only
 *     `{ request }` and so passed `context` as undefined; `requireBuilderAuth`
 *     then saw an empty env, found no secret, concluded it was not production
 *     and allowed the request. Tests, typecheck and build were all green.
 *     `POST /api/mcp-update-config` — an unauthenticated write — answered 200.
 *
 * Here `context` is the real Pages context, so the env is always populated and
 * cannot be dropped by a destructuring mistake. A route added tomorrow is
 * covered without its author doing anything.
 *
 * Non-API paths are left alone: the page loaders run their own SSO handshake
 * (`_index.tsx` trades a `nimbus_token` for a session cookie), and gating them
 * here would break sign-in itself.
 */
async function denyUnauthenticatedApi(context: Parameters<PagesFunction>[0]): Promise<Response | null> {
  const { pathname } = new URL(context.request.url);

  if (!pathname.startsWith('/api/') || PUBLIC_API_PATHS.has(pathname)) {
    return null;
  }

  // Shaped like the Remix load context so requireBuilderAuth reads the same
  // `context.cloudflare.env` it does everywhere else.
  return requireBuilderAuth(context.request, {
    cloudflare: { env: (context as any).cloudflare?.env ?? (context as any).env },
  });
}

export const onRequest: PagesFunction = async (context) => {
  const denied = await denyUnauthenticatedApi(context);

  if (denied) {
    return denied;
  }

  const serverBuild = (await import('../build/server')) as unknown as ServerBuild;

  const handler = createPagesFunctionHandler({
    build: serverBuild,
    /**
     * Without this, `context.cloudflare` is never populated.
     *
     * Every loader in this app reads its environment as
     * `context.cloudflare.env` (see app/routes/_index.tsx, which does
     * `resolveNimbusEnv((context as any)?.cloudflare?.env)`), and
     * load-context.ts declares exactly that shape. But the Pages adapter hands
     * the raw Cloudflare `context` through, where the bindings live on
     * `context.env` — so `context.cloudflare` was undefined, resolveNimbusEnv
     * received undefined, and every env lookup returned nothing.
     *
     * That is why Builder had no login. NIMBUS_SSO_SHARED_SECRET was set on the
     * container AND correctly emitted as a --binding by bindings.sh; the loader
     * simply could not see it, so getNimbusSharedSecret() returned undefined and
     * the SSO gate short-circuited to {enabled:false} on every request. The
     * process.env fallback in getEnvVal does not help either: under
     * `wrangler pages dev` the worker runs in workerd, where process.env is not
     * the host environment.
     *
     * Confirmed by elimination before changing this: the binding IS generated
     * (`cd /app && ./bindings.sh` emits NIMBUS_SSO_SHARED_SECRET=...), the var
     * IS in the container, NIMBUS_SSO_DISABLED is unset, PID 1 really is
     * `pnpm run dockerstart`, and requesting the container FQDN directly — with
     * Cloudflare entirely out of the path — still returned enabled:false.
     */
    /*
     * `pagesContext` is typed as the Remix load context, but at runtime the
     * Pages adapter hands through the raw Cloudflare EventContext — which is
     * the whole reason this function exists (see the note above). The two
     * shapes genuinely disagree, so the annotation says so rather than
     * pretending `.waitUntil` and `.env` are declared where they are not.
     *
     * Type-only. This was 3 of the 7 pre-existing tsc errors on main, which
     * between them kept `pnpm run typecheck` red and therefore kept CI from
     * being a usable gate.
     */
    getLoadContext: ({ context: pagesContext, request }: { context: any; request: Request }) => ({
      cloudflare: {
        env: pagesContext.cloudflare?.env ?? (pagesContext as any).env,
        cf: (request as any).cf,
        /*
         * Cast: Cloudflare's `ExecutionContext` also declares `props`, which
         * the Pages runtime does not hand us here. Loaders only ever use
         * waitUntil / passThroughOnException, so supplying those two is the
         * honest shape — asserting the full interface would be the lie.
         */
        ctx: {
          waitUntil: pagesContext.waitUntil?.bind(pagesContext),
          passThroughOnException: pagesContext.passThroughOnException?.bind(pagesContext),
        } as unknown as ExecutionContext,
        /*
         * Two different `CacheStorage` types are in scope: the DOM lib's, which
         * the global `caches` is typed as, and Cloudflare's, which additionally
         * requires `.default`. The workerd runtime object really does have
         * `default` — this is a types-package disagreement, not a missing
         * capability — so the cast asserts what is actually there.
         */
        caches: caches as unknown as CfCacheStorage,
      },
    }),
  });

  return handler(context);
};
