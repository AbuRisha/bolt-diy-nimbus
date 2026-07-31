import { json, type ActionFunction } from '@remix-run/cloudflare';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

export const action: ActionFunction = async ({ request, context }) => {
  /*
   * Auth guard: resource routes never run the _index page loader, so the SSO
   * check there does not apply here. This is an update/deployment endpoint, so
   * it must be gated before anything else runs.
   */
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  return json(
    {
      error: 'Updates must be performed manually in a server environment',
      instructions: [
        '1. Navigate to the project directory',
        '2. Run: git fetch upstream',
        '3. Run: git pull upstream main',
        '4. Run: pnpm install',
        '5. Run: pnpm run build',
      ],
    },
    { status: 400 },
  );
};
