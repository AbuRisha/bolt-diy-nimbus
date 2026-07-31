import { json, type ActionFunctionArgs } from '@remix-run/cloudflare';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

/*
 * This route is a pass-through: the CALLER supplies their own Supabase
 * management token in the body and receives their own project's keys back.
 * It never reads a server-side credential, so it is not the same class of
 * problem as the key-export route was. It still needs a session, otherwise
 * anonymous callers can use the server as an unattributed proxy to
 * api.supabase.com.
 *
 * The guard sits outside the try/catch below — inside, the catch would turn
 * a 401 into a 500.
 */
export async function action({ request, context }: ActionFunctionArgs) {
  const nimbusEnv = resolveNimbusEnv((context as any)?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, nimbusEnv);

  if (denied) {
    return denied;
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
