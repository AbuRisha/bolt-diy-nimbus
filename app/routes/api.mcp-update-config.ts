import { type ActionFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { MCPService, type MCPConfig } from '~/lib/services/mcpService';
import { requireBuilderAuth } from '~/lib/.server/nimbus-sso';

const logger = createScopedLogger('api.mcp-update-config');

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
