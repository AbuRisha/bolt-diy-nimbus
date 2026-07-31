import type { LoaderFunctionArgs } from '@remix-run/cloudflare';
import { createScopedLogger } from '~/utils/logger';
import { MCPService } from '~/lib/services/mcpService';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

const logger = createScopedLogger('api.mcp-check');

export async function loader({ request, context }: LoaderFunctionArgs) {
  const __nimbusDenied = await requireBuilderAuth(request, resolveNimbusEnv(context?.cloudflare?.env));

  if (__nimbusDenied) {
    return __nimbusDenied;
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
