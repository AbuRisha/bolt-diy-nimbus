/**
 * GET /api/export-api-keys
 *
 * Exports the caller's OWN bring-your-own-key credentials so they can be saved
 * or migrated. Backs the "Export API Keys" action in Settings > Data
 * (app/lib/hooks/useDataOperations.ts).
 *
 * SECURITY
 * --------
 * This loader previously iterated every registered provider's `apiTokenKey`
 * and returned whatever it found in `context.cloudflare.env`, `process.env`, or
 * `llmManager.env`. Because Remix resource routes do not run the `_index`
 * loader, no session check applied, so the operator's server-side provider
 * credentials were served in plaintext to any unauthenticated GET.
 *
 * Two independent changes close it, and both are load-bearing:
 *   1. A valid `aud='builder'` session is required, via the shared guard.
 *   2. Server environment variables are never consulted here at all. Only the
 *      keys the caller themselves supplied via cookie are returned. A user's
 *      own key is theirs to export; the operator's key is not, and holding a
 *      session must not grant it.
 *
 * Do NOT reintroduce an env-var lookup in this file. If a caller needs to know
 * whether the server has a key configured for a provider, that is a boolean
 * question — `/api/check-env-key` answers it with `{ isSet }` and never
 * discloses a value.
 */
import type { LoaderFunction } from '@remix-run/cloudflare';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

export const loader: LoaderFunction = async ({ context, request }) => {
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  const apiKeysFromCookie = getApiKeysFromCookie(request.headers.get('Cookie'));

  return new Response(JSON.stringify(apiKeysFromCookie ?? {}), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Never let a shared cache hold one caller's credentials.
      'Cache-Control': 'private, no-store',
    },
  });
};
