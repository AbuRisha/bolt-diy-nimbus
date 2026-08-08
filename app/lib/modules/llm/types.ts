import type { LanguageModelV1 } from 'ai';
import type { IProviderSetting } from '~/types/model';

/**
 * A model surface — chat/completion, image generation, video generation.
 * Used by the Nimbus multi-surface picker (Chat / Image / Video tabs) to
 * filter the roster down to models that make sense for the current surface.
 */
export type ModelModality = 'chat' | 'image' | 'video';

export interface ModelInfo {
  name: string;
  label: string;
  provider: string;

  /**
   * Which surface the model belongs to. Defaults to `'chat'` when absent so
   * legacy callers keep working. Only Nimbus currently emits image/video
   * entries — surface pickers filter on this field.
   */
  modality?: ModelModality;

  /** Maximum context window size (input tokens) - how many tokens the model can process */
  maxTokenAllowed: number;

  /** Maximum completion/output tokens - how many tokens the model can generate. If not specified, falls back to provider defaults */
  maxCompletionTokens?: number;
}

export interface ProviderInfo {
  name: string;
  staticModels: ModelInfo[];

  /**
   * Opt in to keeping the order this provider returns models in.
   *
   * Off by default, and the default is the historical behaviour: LLMManager
   * alphabetises every model it has by id, which is a reasonable fallback for
   * a provider whose /models endpoint returns an arbitrary order.
   *
   * It is wrong for a provider that has curated an order. Nimbus groups its
   * catalog by vendor and sorts each group newest-first; alphabetising threw
   * all of that away and opened the picker on the oldest model in the list.
   * Opt-in rather than a global change so no other provider's picker moves.
   */
  preservesModelOrder?: boolean;
  getDynamicModels?: (
    apiKeys?: Record<string, string>,
    settings?: IProviderSetting,
    serverEnv?: Record<string, string>,
  ) => Promise<ModelInfo[]>;
  getModelInstance: (options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }) => LanguageModelV1;
  getApiKeyLink?: string;
  labelForGetApiKey?: string;
  icon?: string;

  /**
   * The Nimbus provider is the ONLY provider surfaced in the primary picker
   * on the customer-facing hosted deployment (NIMBUS_ONLY=true). Every other
   * provider is registered but hidden behind the "Advanced — bring your own
   * key" panel. This flag exists so the UI does not need to hard-code
   * `provider.name === 'Nimbus'` string comparisons.
   */
  isNimbus?: boolean;
}
export interface ProviderConfig {
  baseUrlKey?: string;
  baseUrl?: string;
  apiTokenKey?: string;
}
