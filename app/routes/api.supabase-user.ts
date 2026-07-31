import { json } from '@remix-run/cloudflare';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { withSecurity } from '~/lib/security';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

/*
 * NOTE: withSecurity() enforces allowedMethods and rateLimit only. Its
 * `requireAuth` option is declared in the type signature but never read by the
 * implementation, so it grants no authentication. The requireBuilderAuth calls
 * below are what actually gate these handlers.
 *
 * The token below resolves as `cookie key || server env`, so a caller sending
 * no cookie spends the container's Supabase credential. `get_api_keys` returns
 * project api_key values verbatim, which include the service_role key that
 * bypasses Row Level Security — returning that to a browser is wrong even for
 * an authenticated caller. Removing the branch is tracked separately; this
 * change closes the anonymous path.
 */

async function supabaseUserLoader({ request, context }: { request: Request; context: any }) {
  const denied = await requireBuilderAuth(request, resolveNimbusEnv(context?.cloudflare?.env));

  if (denied) {
    return denied;
  }

  try {
    // Get API keys from cookies (server-side only)
    const cookieHeader = request.headers.get('Cookie');
    const apiKeys = getApiKeysFromCookie(cookieHeader);

    // Try to get Supabase token from various sources
    const supabaseToken =
      apiKeys.VITE_SUPABASE_ACCESS_TOKEN ||
      context?.cloudflare?.env?.VITE_SUPABASE_ACCESS_TOKEN ||
      process.env.VITE_SUPABASE_ACCESS_TOKEN;

    if (!supabaseToken) {
      return json({ error: 'Supabase token not found' }, { status: 401 });
    }

    // Make server-side request to Supabase API
    const response = await fetch('https://api.supabase.com/v1/projects', {
      headers: {
        Authorization: `Bearer ${supabaseToken}`,
        'User-Agent': 'bolt.diy-app',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return json({ error: 'Invalid Supabase token' }, { status: 401 });
      }

      throw new Error(`Supabase API error: ${response.status}`);
    }

    const projects = (await response.json()) as Array<{
      id: string;
      name: string;
      region: string;
      status: string;
      organization_id: string;
      created_at: string;
    }>;

    // Get user info from the first project (all projects belong to the same user)
    const user =
      projects.length > 0
        ? {
            id: projects[0].organization_id,
            name: 'Supabase User', // Supabase doesn't provide user name in this endpoint
            email: 'user@supabase.co', // Placeholder
          }
        : null;

    return json({
      user,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        region: project.region,
        status: project.status,
        organization_id: project.organization_id,
        created_at: project.created_at,
      })),
    });
  } catch (error) {
    console.error('Error fetching Supabase user:', error);
    return json(
      {
        error: 'Failed to fetch Supabase user information',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export const loader = withSecurity(supabaseUserLoader, {
  rateLimit: true,
  allowedMethods: ['GET'],
});

async function supabaseUserAction({ request, context }: { request: Request; context: any }) {
  const denied = await requireBuilderAuth(request, resolveNimbusEnv(context?.cloudflare?.env));

  if (denied) {
    return denied;
  }

  try {
    const formData = await request.formData();
    const action = formData.get('action');

    // Get API keys from cookies (server-side only)
    const cookieHeader = request.headers.get('Cookie');
    const apiKeys = getApiKeysFromCookie(cookieHeader);

    // Try to get Supabase token from various sources
    const supabaseToken =
      apiKeys.VITE_SUPABASE_ACCESS_TOKEN ||
      context?.cloudflare?.env?.VITE_SUPABASE_ACCESS_TOKEN ||
      process.env.VITE_SUPABASE_ACCESS_TOKEN;

    if (!supabaseToken) {
      return json({ error: 'Supabase token not found' }, { status: 401 });
    }

    if (action === 'get_projects') {
      // Fetch user projects
      const response = await fetch('https://api.supabase.com/v1/projects', {
        headers: {
          Authorization: `Bearer ${supabaseToken}`,
          'User-Agent': 'bolt.diy-app',
        },
      });

      if (!response.ok) {
        throw new Error(`Supabase API error: ${response.status}`);
      }

      const projects = (await response.json()) as Array<{
        id: string;
        name: string;
        region: string;
        status: string;
        organization_id: string;
        created_at: string;
      }>;

      // Get user info from the first project
      const user =
        projects.length > 0
          ? {
              id: projects[0].organization_id,
              name: 'Supabase User',
              email: 'user@supabase.co',
            }
          : null;

      return json({
        user,
        stats: {
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            region: project.region,
            status: project.status,
            organization_id: project.organization_id,
            created_at: project.created_at,
          })),
          totalProjects: projects.length,
        },
      });
    }

    /*
     * `get_api_keys` used to proxy /v1/projects/{id}/api-keys and return the
     * key values verbatim. Those include the project's service_role key, which
     * bypasses Row Level Security entirely. It is removed: the request ran on
     * the server-resolved Supabase token, so any caller could read keys for
     * every project on the operator's account, and no session entitles a
     * browser to a service_role key. A project's anon key belongs in the
     * generated app's own configuration, not in a response from this route.
     */
    if (action === 'get_api_keys') {
      return json({ error: 'get_api_keys is no longer supported' }, { status: 410 });
    }

    return json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Error in Supabase user action:', error);
    return json(
      {
        error: 'Failed to process Supabase request',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export const action = withSecurity(supabaseUserAction, {
  rateLimit: true,
  allowedMethods: ['POST'],
});
