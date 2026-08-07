import { createScopedLogger } from '~/utils/logger';
import { MCPService } from '~/lib/services/mcpService';
import { requireBuilderAuth } from '~/lib/.server/nimbus-sso';

const logger = createScopedLogger('api.mcp-check');

export async function loader(args: { request: Request; context?: unknown }) {
  // Route-level auth. See requireBuilderAuth in lib/.server/nimbus-sso.
  const denied = await requireBuilderAuth(args.request, args.context);

  if (denied) {
    return denied;
  }

  try {
    const mcpService = MCPService.getInstance();
    const serverTools = await mcpService.checkServersAvailabilities();

    return Response.json(serverTools);
  } catch (error) {
    logger.error('Error checking MCP servers:', error);
    return Response.json({ error: 'Failed to check MCP servers' }, { status: 500 });
  }
}
