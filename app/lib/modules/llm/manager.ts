import type { IProviderSetting } from '~/types/model';
import { BaseProvider } from './base-provider';
import type { ModelInfo, ProviderInfo } from './types';
import * as providers from './registry';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('LLMManager');

/**
 * Resolve the current NIMBUS_ONLY flag from every source we might see it in:
 * Cloudflare/ACA env passed to getInstance(), plain process.env on Node, and
 * (for the browser bundle) the Vite-inlined import.meta.env value. First
 * truthy wins.
 */
function resolveNimbusOnly(env: Record<string, string> = {}): boolean {
  if (env.NIMBUS_ONLY === 'true') {
    return true;
  }

  if (typeof process !== 'undefined' && process.env?.NIMBUS_ONLY === 'true') {
    return true;
  }

  try {
    // import.meta.env is inlined by Vite at build time — the NIMBUS_ONLY
    // prefix is whitelisted in vite.config.ts so this value is present in
    // the browser bundle when the deployment ships with NIMBUS_ONLY=true.
    const viteEnv = (import.meta as any)?.env;
    if (viteEnv?.NIMBUS_ONLY === 'true' || viteEnv?.VITE_NIMBUS_ONLY === 'true') {
      return true;
    }
  } catch {
    // import.meta not available in the current runtime — ignore.
  }

  return false;
}

export class LLMManager {
  private static _instance: LLMManager;
  private _providers: Map<string, BaseProvider> = new Map();
  private _modelList: ModelInfo[] = [];
  private _env: Record<string, string> = {};

  private constructor(_env: Record<string, string>) {
    this._env = _env;
    this._registerProvidersFromDirectory();
  }

  static getInstance(env: Record<string, string> = {}): LLMManager {
    if (!LLMManager._instance) {
      LLMManager._instance = new LLMManager(env);
    } else if (Object.keys(env).length > 0) {
      LLMManager._instance._env = env;

      // Registration is now UNCONDITIONAL — every provider always registers
      // so code paths compile and the "Advanced — bring your own key" panel
      // can reach them. The NIMBUS_ONLY flag no longer changes registration
      // scope; the UI filters instead (see getPrimaryProviders /
      // getAdvancedProviders below).
    }

    return LLMManager._instance;
  }
  get env() {
    return this._env;
  }

  private async _registerProvidersFromDirectory() {
    try {
      /*
       * Look for exported classes that extend BaseProvider. Every provider
       * registers unconditionally — the NIMBUS_ONLY deployment flag only
       * affects UI visibility. Keeping upstream providers registered means
       * the "Advanced — bring your own key" panel can wire them up when the
       * customer supplies their own API key.
       */
      for (const exportedItem of Object.values(providers)) {
        if (typeof exportedItem === 'function' && exportedItem.prototype instanceof BaseProvider) {
          const provider = new exportedItem();

          try {
            this.registerProvider(provider);
          } catch (error: any) {
            logger.warn('Failed To Register Provider: ', provider.name, 'error:', error.message);
          }
        }
      }
    } catch (error) {
      logger.error('Error registering providers:', error);
    }
  }

  registerProvider(provider: BaseProvider) {
    if (this._providers.has(provider.name)) {
      logger.warn(`Provider ${provider.name} is already registered. Skipping.`);
      return;
    }

    logger.info('Registering Provider: ', provider.name);
    this._providers.set(provider.name, provider);
    this._modelList = [...this._modelList, ...provider.staticModels];
  }

  getProvider(name: string): BaseProvider | undefined {
    return this._providers.get(name);
  }

  getAllProviders(): BaseProvider[] {
    return Array.from(this._providers.values());
  }

  /**
   * `true` when the deployment is customer-facing Nimbus — the primary
   * picker MUST show only the Nimbus provider and non-Nimbus providers move
   * behind the "Advanced — bring your own key" panel.
   */
  isNimbusOnlyMode(): boolean {
    return resolveNimbusOnly(this._env);
  }

  /**
   * Providers that render in the primary picker. In NIMBUS_ONLY mode this is
   * the Nimbus provider only; otherwise it is every registered provider so
   * self-hosters get the full catalog by default.
   */
  getPrimaryProviders(): BaseProvider[] {
    const all = this.getAllProviders();
    if (!this.isNimbusOnlyMode()) {
      return all;
    }

    return all.filter((p) => p.isNimbus);
  }

  /**
   * Providers that render inside the "Advanced — bring your own key" panel.
   * Empty when NIMBUS_ONLY mode is off (the primary picker already lists
   * them). When on, this is every non-Nimbus provider.
   */
  getAdvancedProviders(): BaseProvider[] {
    if (!this.isNimbusOnlyMode()) {
      return [];
    }

    return this.getAllProviders().filter((p) => !p.isNimbus);
  }

  /**
   * True when the server has a resolved API token for the given provider —
   * either via a Cloudflare/ACA env binding OR a plain process.env var. Used
   * by the client to decide whether to suppress the "Not set" API-key prompt
   * (Nimbus keys are managed server-side on the hosted product).
   */
  hasServerApiKey(providerName: string): boolean {
    const provider = this._providers.get(providerName);
    if (!provider) {
      return false;
    }

    const tokenKey = provider.config?.apiTokenKey;
    if (!tokenKey) {
      return false;
    }

    if (this._env?.[tokenKey]) {
      return true;
    }

    if (typeof process !== 'undefined' && process.env?.[tokenKey]) {
      return true;
    }

    return false;
  }

  getModelList(): ModelInfo[] {
    return this._modelList;
  }

  async updateModelList(options: {
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
    serverEnv?: Record<string, string>;
  }): Promise<ModelInfo[]> {
    const { apiKeys, providerSettings, serverEnv } = options;

    let enabledProviders = Array.from(this._providers.values()).map((p) => p.name);

    if (providerSettings && Object.keys(providerSettings).length > 0) {
      enabledProviders = enabledProviders.filter((p) => providerSettings[p].enabled);
    }

    // Get dynamic models from all providers that support them
    const dynamicModels = await Promise.all(
      Array.from(this._providers.values())
        .filter((provider) => enabledProviders.includes(provider.name))
        .filter(
          (provider): provider is BaseProvider & Required<Pick<ProviderInfo, 'getDynamicModels'>> =>
            !!provider.getDynamicModels,
        )
        .map(async (provider) => {
          const cachedModels = provider.getModelsFromCache(options);

          if (cachedModels) {
            return cachedModels;
          }

          const dynamicModels = await provider
            .getDynamicModels(apiKeys, providerSettings?.[provider.name], serverEnv)
            .then((models) => {
              logger.info(`Caching ${models.length} dynamic models for ${provider.name}`);
              provider.storeDynamicModels(options, models);

              return models;
            })
            .catch((err) => {
              logger.error(`Error getting dynamic models ${provider.name} :`, err);
              return [];
            });

          return dynamicModels;
        }),
    );
    const staticModels = Array.from(this._providers.values()).flatMap((p) => p.staticModels || []);
    const dynamicModelsFlat = dynamicModels.flat();
    const dynamicModelKeys = dynamicModelsFlat.map((d) => `${d.name}-${d.provider}`);
    const filteredStaticModels = staticModels.filter((m) => !dynamicModelKeys.includes(`${m.name}-${m.provider}`));

    // Combine static and dynamic models
    const modelList = [...dynamicModelsFlat, ...filteredStaticModels];
    modelList.sort((a, b) => a.name.localeCompare(b.name));
    this._modelList = modelList;

    return modelList;
  }
  getStaticModelList() {
    return [...this._providers.values()].flatMap((p) => p.staticModels || []);
  }
  async getModelListFromProvider(
    providerArg: BaseProvider,
    options: {
      apiKeys?: Record<string, string>;
      providerSettings?: Record<string, IProviderSetting>;
      serverEnv?: Record<string, string>;
    },
  ): Promise<ModelInfo[]> {
    const provider = this._providers.get(providerArg.name);

    if (!provider) {
      throw new Error(`Provider ${providerArg.name} not found`);
    }

    const staticModels = provider.staticModels || [];

    if (!provider.getDynamicModels) {
      return staticModels;
    }

    const { apiKeys, providerSettings, serverEnv } = options;

    const cachedModels = provider.getModelsFromCache({
      apiKeys,
      providerSettings,
      serverEnv,
    });

    if (cachedModels) {
      logger.info(`Found ${cachedModels.length} cached models for ${provider.name}`);
      return [...cachedModels, ...staticModels];
    }

    logger.info(`Getting dynamic models for ${provider.name}`);

    const dynamicModels = await provider
      .getDynamicModels?.(apiKeys, providerSettings?.[provider.name], serverEnv)
      .then((models) => {
        logger.info(`Got ${models.length} dynamic models for ${provider.name}`);
        provider.storeDynamicModels(options, models);

        return models;
      })
      .catch((err) => {
        logger.error(`Error getting dynamic models ${provider.name} :`, err);
        return [];
      });
    const dynamicModelsName = dynamicModels.map((d) => d.name);
    const filteredStaticList = staticModels.filter((m) => !dynamicModelsName.includes(m.name));
    const modelList = [...dynamicModels, ...filteredStaticList];
    modelList.sort((a, b) => a.name.localeCompare(b.name));

    return modelList;
  }
  getStaticModelListFromProvider(providerArg: BaseProvider) {
    const provider = this._providers.get(providerArg.name);

    if (!provider) {
      throw new Error(`Provider ${providerArg.name} not found`);
    }

    return [...(provider.staticModels || [])];
  }

  /**
   * The default provider is Nimbus when NIMBUS_ONLY mode is on (so a fresh
   * session lands on Nimbus, not the first alphabetical upstream provider).
   * Otherwise it is the first registered provider (upstream behavior).
   */
  getDefaultProvider(): BaseProvider {
    if (this.isNimbusOnlyMode()) {
      const nimbus = this.getAllProviders().find((p) => p.isNimbus);
      if (nimbus) {
        return nimbus;
      }
    }

    const firstProvider = this._providers.values().next().value;

    if (!firstProvider) {
      throw new Error('No providers registered');
    }

    return firstProvider;
  }
}
