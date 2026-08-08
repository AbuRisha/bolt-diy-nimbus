import { json, type ActionFunction } from '@remix-run/cloudflare';
import { requireBuilderAuth } from '~/lib/.server/nimbus-sso';

export const action: ActionFunction = async ({ request, context }) => {
  /*
   * Route-level auth — SSO lived in the page loader only, so calling this
   * route directly skipped it. See requireBuilderAuth in lib/.server/nimbus-sso.
   */
  {
    const denied = await requireBuilderAuth(request, context);

    if (denied) {
      return denied;
    }
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
