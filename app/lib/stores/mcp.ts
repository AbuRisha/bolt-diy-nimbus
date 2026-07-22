import { create } from 'zustand';
import type { MCPConfig, MCPServerTools } from '~/lib/services/mcpService';

const MCP_SETTINGS_KEY = 'mcp_settings';
const isBrowser = typeof window !== 'undefined';
const LEGACY_HOSTED_CHROME_BRIDGE = '/app/nimbus-chrome-mcp/bridge/index.js';

type MCPSettings = {
  mcpConfig: MCPConfig;
  maxLLMSteps: number;
};

const defaultSettings = {
  maxLLMSteps: 5,
  mcpConfig: {
    /**
     * Default Nimbus MCP server seed — parity with LibreChat at chat.nimbusapi.net.
     * Users can override or extend from the Settings panel; the defaults ship so
     * new users get the same hosted-safe baseline without any setup.
     *
     * All 4 servers boot from tools that ship in the bolt.diy Docker image:
     *   - uvx / uv installed via apt in the base stage
     *   - node available (obviously)
     *
     * Browser-control MCP is intentionally not seeded here. A bridge running
     * inside the hosted container cannot reach a customer's local Chrome.
     */
    mcpServers: {
      fetch: {
        type: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch'],
      },
      'sequential-thinking': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      },
      time: {
        type: 'stdio',
        command: 'uvx',
        args: ['mcp-server-time', '--local-timezone=UTC'],
      },
      'persistent-memory': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
    },
  },
} satisfies MCPSettings;

export function removeLegacyHostedChromeBridge(settings: MCPSettings): MCPSettings {
  const chromeConfig = settings.mcpConfig.mcpServers['nimbus-chrome'];

  if (
    !chromeConfig ||
    !('command' in chromeConfig) ||
    chromeConfig.command !== 'node' ||
    chromeConfig.args?.length !== 1 ||
    chromeConfig.args[0] !== LEGACY_HOSTED_CHROME_BRIDGE
  ) {
    return settings;
  }

  const { ['nimbus-chrome']: _legacyHostedBridge, ...mcpServers } = settings.mcpConfig.mcpServers;

  return {
    ...settings,
    mcpConfig: {
      ...settings.mcpConfig,
      mcpServers,
    },
  };
}

type Store = {
  isInitialized: boolean;
  settings: MCPSettings;
  serverTools: MCPServerTools;
  error: string | null;
  isUpdatingConfig: boolean;
};

type Actions = {
  initialize: () => Promise<void>;
  updateSettings: (settings: MCPSettings) => Promise<void>;
  checkServersAvailabilities: () => Promise<void>;
};

export const useMCPStore = create<Store & Actions>((set, get) => ({
  isInitialized: false,
  settings: defaultSettings,
  serverTools: {},
  error: null,
  isUpdatingConfig: false,
  initialize: async () => {
    if (get().isInitialized) {
      return;
    }

    if (isBrowser) {
      const savedConfig = localStorage.getItem(MCP_SETTINGS_KEY);

      if (savedConfig) {
        try {
          const parsedSettings = JSON.parse(savedConfig) as MCPSettings;
          const settings = removeLegacyHostedChromeBridge(parsedSettings);

          if (settings !== parsedSettings) {
            localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(settings));
          }

          const serverTools = await updateServerConfig(settings.mcpConfig);
          set(() => ({ settings, serverTools }));
        } catch (error) {
          console.error('Error parsing saved mcp config:', error);
          set(() => ({
            error: `Error parsing saved mcp config: ${error instanceof Error ? error.message : String(error)}`,
          }));
        }
      } else {
        localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(defaultSettings));
      }
    }

    set(() => ({ isInitialized: true }));
  },
  updateSettings: async (newSettings: MCPSettings) => {
    if (get().isUpdatingConfig) {
      return;
    }

    try {
      set(() => ({ isUpdatingConfig: true }));

      const serverTools = await updateServerConfig(newSettings.mcpConfig);

      if (isBrowser) {
        localStorage.setItem(MCP_SETTINGS_KEY, JSON.stringify(newSettings));
      }

      set(() => ({ settings: newSettings, serverTools }));
    } catch (error) {
      throw error;
    } finally {
      set(() => ({ isUpdatingConfig: false }));
    }
  },
  checkServersAvailabilities: async () => {
    const response = await fetch('/api/mcp-check', {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
    }

    const serverTools = (await response.json()) as MCPServerTools;

    set(() => ({ serverTools }));
  },
}));

async function updateServerConfig(config: MCPConfig) {
  const response = await fetch('/api/mcp-update-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as MCPServerTools;

  return data;
}
