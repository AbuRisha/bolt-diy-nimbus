import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';

interface NimbusModelsResponse {
  data: Array<{ id: string; owned_by?: string }>;
}

/**
 * Nimbus provider — routes every request to api.nimbusapi.net/v1 (SpiderSense
 * reseller catalog). Uses OpenAI-compatible protocol so we lean on the shared
 * getOpenAILikeModel helper. Set NIMBUS_API_KEY (sk-nim-*) in the environment
 * or per-user provider settings.
 */
export default class NimbusProvider extends BaseProvider {
  name = 'Nimbus';
  getApiKeyLink = 'https://nimbusapi.net/dashboard/keys';

  config = {
    baseUrlKey: 'NIMBUS_API_BASE_URL',
    apiTokenKey: 'NIMBUS_API_KEY',
    baseUrl: 'https://api.nimbusapi.net/v1',
  };

  // Curated flagship set — user still gets the full /models list dynamically.
  staticModels: ModelInfo[] = [
    { name: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Nimbus', maxTokenAllowed: 200000 },
    { name: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', provider: 'Nimbus', maxTokenAllowed: 200000 },
    { name: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', provider: 'Nimbus', maxTokenAllowed: 200000 },
    { name: 'anthropic/claude-fable-5', label: 'Claude Fable 5', provider: 'Nimbus', maxTokenAllowed: 200000 },
    { name: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'Nimbus', maxTokenAllowed: 128000 },
    { name: 'openai/gpt-5-codex', label: 'GPT-5 Codex', provider: 'Nimbus', maxTokenAllowed: 128000 },
    { name: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'Nimbus', maxTokenAllowed: 128000 },
    { name: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'Nimbus', maxTokenAllowed: 128000 },
    { name: 'moonshotai/kimi-k3', label: 'Kimi K3', provider: 'Nimbus', maxTokenAllowed: 200000 },
    { name: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'Nimbus', maxTokenAllowed: 200000 },
    { name: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Nimbus', maxTokenAllowed: 1000000 },
    { name: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', provider: 'Nimbus', maxTokenAllowed: 1000000 },
    { name: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', provider: 'Nimbus', maxTokenAllowed: 1000000 },
  ];

  async getDynamicModels(
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: settings,
      serverEnv,
      defaultBaseUrlKey: 'NIMBUS_API_BASE_URL',
      defaultApiTokenKey: 'NIMBUS_API_KEY',
    });

    const resolvedBase = baseUrl || this.config.baseUrl;
    if (!resolvedBase || !apiKey) {
      return [];
    }

    try {
      const response = await fetch(`${resolvedBase}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: this.createTimeoutSignal(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const res = (await response.json()) as NimbusModelsResponse;

      return res.data.map((model) => ({
        name: model.id,
        label: model.id,
        provider: this.name,
        maxTokenAllowed: 128000,
      }));
    } catch (error) {
      logger.info(`${this.name}: /models fetch failed, using static catalog`, error);
      return this.staticModels;
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;
    const envRecord = this.convertEnvToRecord(serverEnv);

    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: envRecord,
      defaultBaseUrlKey: 'NIMBUS_API_BASE_URL',
      defaultApiTokenKey: 'NIMBUS_API_KEY',
    });

    const resolvedBase = baseUrl || this.config.baseUrl;
    if (!resolvedBase || !apiKey) {
      throw new Error('Nimbus provider: missing NIMBUS_API_KEY (get one at https://nimbusapi.net/dashboard/keys).');
    }

    return getOpenAILikeModel(resolvedBase, apiKey, model);
  }
}
