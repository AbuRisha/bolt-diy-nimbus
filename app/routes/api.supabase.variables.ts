import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { requireBuilderAuth } from '~/lib/.server/nimbus-sso';

export async function action({ request }: ActionFunctionArgs) {
  // Route-level auth — SSO lived in the page loader only, so calling this
  // route directly skipped it. See requireBuilderAuth in lib/.server/nimbus-sso.
  {
    const denied = await requireBuilderAuth(request, undefined);

    if (denied) {
      return denied;
    }
  }

  try {
    // Add proper type assertion for the request body
    const body = (await request.json()) as { projectId?: string; token?: string };
    const { projectId, token } = body;

    if (!projectId || !token) {
      return json({ error: 'Project ID and token are required' }, { status: 400 });
    }

    const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}/api-keys`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return json({ error: `Failed to fetch API keys: ${response.statusText}` }, { status: response.status });
    }

    const apiKeys = await response.json();

    return json({ apiKeys });
  } catch (error) {
    console.error('Error fetching project API keys:', error);
    return json({ error: error instanceof Error ? error.message : 'Unknown error occurred' }, { status: 500 });
  }
}
