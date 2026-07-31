import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { MCPService, type MCPConfig } from '~/lib/services/mcpService';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

const logger = createScopedLogger('api.mcp-update-config');

export async function action({ request, context }: ActionFunctionArgs) {
  /*
   * Auth guard: resource routes never run the _index page loader, so the SSO
   * check there does not apply here. This endpoint MUTATES the server-side MCP
   * server configuration, so it must be gated before the body is parsed.
   */
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  try {
    const mcpConfig = (await request.json()) as MCPConfig;

    if (!mcpConfig || typeof mcpConfig !== 'object') {
      return Response.json({ error: 'Invalid MCP servers configuration' }, { status: 400 });
    }

    const mcpService = MCPService.getInstance();
    const serverTools = await mcpService.updateConfig(mcpConfig);

    return Response.json(serverTools);
  } catch (error) {
    logger.error('Error updating MCP config:', error);
    return Response.json({ error: 'Failed to update MCP config' }, { status: 500 });
  }
}
