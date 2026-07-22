import { describe, expect, it } from 'vitest';
import type { MCPConfig } from '~/lib/services/mcpService';
import { removeLegacyHostedChromeBridge } from './mcp';

function settings(mcpServers: MCPConfig['mcpServers']) {
  return { maxLLMSteps: 5, mcpConfig: { mcpServers } };
}

describe('removeLegacyHostedChromeBridge', () => {
  it('removes only the v19 hosted Chrome bridge and preserves other servers', () => {
    const original = settings({
      fetch: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
      'nimbus-chrome': {
        type: 'stdio',
        command: 'node',
        args: ['/app/nimbus-chrome-mcp/bridge/index.js'],
      },
    });

    const migrated = removeLegacyHostedChromeBridge(original);

    expect(migrated).not.toBe(original);
    expect(migrated.mcpConfig.mcpServers).toEqual({
      fetch: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    });
  });

  it('preserves custom Chrome MCP configurations', () => {
    const original = settings({
      'nimbus-chrome': {
        type: 'streamable-http',
        url: 'https://example.test/mcp',
      },
    });

    expect(removeLegacyHostedChromeBridge(original)).toBe(original);
  });
});
