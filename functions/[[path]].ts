import type { ServerBuild } from '@remix-run/cloudflare';
import { createPagesFunctionHandler } from '@remix-run/cloudflare-pages';

export const onRequest: PagesFunction = async (context) => {
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
    getLoadContext: ({ context: pagesContext, request }) => ({
      cloudflare: {
        env: pagesContext.cloudflare?.env ?? (pagesContext as any).env,
        cf: (request as any).cf,
        ctx: {
          waitUntil: pagesContext.waitUntil?.bind(pagesContext),
          passThroughOnException: pagesContext.passThroughOnException?.bind(pagesContext),
        },
        caches,
      },
    }),
  });

  return handler(context);
};
