import { type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { MCPService } from '~/lib/services/mcpService';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

const logger = createScopedLogger('api.mcp-check');

export async function loader({ request, context }: LoaderFunctionArgs) {
  /*
   * Auth guard: resource routes never run the _index page loader, so the SSO
   * check there does not apply here. Probing opens server-side connections to
   * every configured MCP server and discloses their tool inventory, so it must
   * be gated before the service is touched. Kept outside the try/catch below
   * so a 401 can never be downgraded into the catch-all error response.
   */
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  /*
   * Note on SSRF: this route takes no URL from the request. The hosts it
   * probes come from the MCP server config held in the MCPService singleton,
   * which is written by api.mcp-update-config (already auth-gated). The
   * caller-controlled URL ingestion point is therefore that route, not this
   * one, and the shared url-guard validator is deliberately NOT applied to
   * these destinations: operator-configured MCP servers are commonly reachable
   * only on loopback, so rejecting private addresses here would break a
   * legitimate feature for authenticated users. See the handoff notes.
   */
  try {
    const mcpService = MCPService.getInstance();
    const serverTools = await mcpService.checkServersAvailabilities();

    return Response.json(serverTools);
  } catch (error) {
    logger.error('Error checking MCP servers:', error);
    return Response.json({ error: 'Failed to check MCP servers' }, { status: 500 });
  }
}
