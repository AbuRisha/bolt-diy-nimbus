import { json } from '@remix-run/cloudflare';
import { LLMManager } from '~/lib/modules/llm/manager';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { ProviderInfo } from '~/types/model';
import { getApiKeysFromCookie, getProviderSettingsFromCookie } from '~/lib/api/cookies';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

interface ModelsResponse {
  modelList: ModelInfo[];
  providers: ProviderInfo[];
  defaultProvider: ProviderInfo;
}

/*
 * Provider info derives from the registry plus the NIMBUS_ONLY flag, both fixed
 * for the life of the process, so caching cannot go stale per request.
 */
let cachedProviders: ProviderInfo[] | null = null;
let cachedDefaultProvider: ProviderInfo | null = null;

type ProviderLike = {
  name: string;
  staticModels: ModelInfo[];
  getApiKeyLink?: string;
  labelForGetApiKey?: string;
  icon?: string;
};

function toProviderInfo(provider: ProviderLike): ProviderInfo {
  return {
    name: provider.name,
    staticModels: provider.staticModels,
    getApiKeyLink: provider.getApiKeyLink,
    labelForGetApiKey: provider.labelForGetApiKey,
    icon: provider.icon,
  };
}

function getProviderInfo(llmManager: LLMManager) {
  if (!cachedProviders) {
    /*
     * getPrimaryProviders() is the Nimbus provider alone under NIMBUS_ONLY, and
     * the full registry otherwise. Filtering here rather than in the UI is the
     * point: this route used to return all 23 providers and ~486 models to
     * every caller and rely on the client to hide what a customer must not
     * see, which is not a boundary.
     */
    cachedProviders = llmManager.getPrimaryProviders().map(toProviderInfo);
  }

  if (!cachedDefaultProvider) {
    cachedDefaultProvider = toProviderInfo(llmManager.getDefaultProvider());
  }

  return { providers: cachedProviders, defaultProvider: cachedDefaultProvider };
}

export async function loader({
  request,
  params,
  context,
}: {
  request: Request;
  params: { provider?: string };
  context: {
    cloudflare?: {
      env: Record<string, string>;
    };
  };
}): Promise<Response> {
  // A builder session (aud='builder') is required before any roster is returned.
  const env = resolveNimbusEnv(context.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  const llmManager = LLMManager.getInstance(context.cloudflare?.env);

  // Get client side maintained API keys and provider settings from cookies
  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);
  const providerSettings = getProviderSettingsFromCookie(cookieHeader);

  const { providers, defaultProvider } = getProviderInfo(llmManager);
  const nimbusOnly = llmManager.isNimbusOnlyMode();

  let modelList: ModelInfo[] = [];

  if (params.provider) {
    const provider = llmManager.getProvider(params.provider);

    /*
     * The per-provider route shares this loader. Under NIMBUS_ONLY a caller
     * must not be able to name a non-Nimbus provider directly and get its
     * roster back, which would walk straight around the filtering above.
     */
    if (nimbusOnly && provider && !provider.isNimbus) {
      return json({ error: 'provider_not_available' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    if (provider) {
      modelList = await llmManager.getModelListFromProvider(provider, {
        apiKeys,
        providerSettings,
        serverEnv: context.cloudflare?.env,
      });
    }
  } else {
    modelList = await llmManager.updateModelList({
      apiKeys,
      providerSettings,
      serverEnv: context.cloudflare?.env,
    });

    /*
     * updateModelList() refreshes the whole registry, including providers that
     * are not advertised under NIMBUS_ONLY. Narrow the response to the models
     * belonging to the providers we actually return.
     */
    if (nimbusOnly) {
      const exposed = new Set(providers.map((p) => p.name));
      modelList = modelList.filter((model) => exposed.has(model.provider));
    }
  }

  return json<ModelsResponse>(
    {
      modelList,
      providers,
      defaultProvider,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
