import type { LoaderFunction } from '@remix-run/cloudflare';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

/**
 * Returns the caller's own provider keys, as held in their cookie.
 *
 * This route deliberately does NOT read provider credentials out of the
 * server environment. It previously merged
 * `context.cloudflare.env[apiTokenKey] || process.env[apiTokenKey] ||
 * llmManager.env[apiTokenKey]` into the response, which handed every
 * server-side provider credential to the browser — and, with no auth guard,
 * to any anonymous caller.
 *
 * Server-side credentials stay server-side: the streamText pipeline and
 * api.nimbus-proxy resolve them directly from env and never round-trip them
 * through the client. If a caller needs to know whether a provider is
 * configured server-side, use `api.check-env-key`, which answers with a
 * boolean and never discloses a value.
 */
export const loader: LoaderFunction = async ({ context, request }) => {
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  const cookieHeader = request.headers.get('Cookie');
  const apiKeys: Record<string, string> = { ...getApiKeysFromCookie(cookieHeader) };

  return Response.json(apiKeys, { headers: { 'Cache-Control': 'no-store' } });
};
