import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';

interface NimbusModelsResponse {
  data: Array<{
    id: string;
    owned_by?: string;

    /**
     * Real context window, passed through by the gateway from upstream.
     *
     * Optional because the gateway OMITS it when upstream did not publish one
     * — a missing value is an honest "unknown". Never default it to a literal
     * here: doing exactly that is what made every row in the picker read
     * "128K tokens".
     */
    context_length?: number;
    pricing?: { type?: string };
  }>;
}

/**
 * Nimbus provider — routes every request to api.nimbusapi.net/v1 (the Nimbus
 * OpenAI-compatible gateway). Uses the OpenAI-compatible protocol so we lean
 * on the shared `getOpenAILikeModel` helper.
 *
 * Key resolution (SSO-first):
 *   - Server-side chat runs through `api.chat.ts` in this repo, which passes
 *     a `serverEnv` map into this provider. NIMBUS_API_KEY from the container
 *     env (or nimbus-v2's SSO handoff) is used automatically.
 *   - The client is never asked for a key. The Nimbus dashboard SSO gate on
 *     `/` (see `app/routes/_index.tsx`) ensures every visitor is
 *     authenticated before they can reach the chat surface.
 *   - For direct browser-side calls (e.g. arbitrary fetch to `/models` or
 *     `/chat/completions`) use `/api/nimbus-proxy/...` — that route injects
 *     the server-side key so the browser never touches it.
 *
 * The static rosters below are the CUSTOMER-FACING allowlist. Do NOT expose
 * upstream vendor names (Azure, OpenRouter, SS reseller, etc.) in labels.
 * Grouped by modality so the Chat / Image / Video surfaces can filter
 * independently.
 */
export default class NimbusProvider extends BaseProvider {
  name = 'Nimbus';
  isNimbus = true;
  getApiKeyLink = 'https://nimbusapi.net/dashboard/keys';

  config = {
    baseUrlKey: 'NIMBUS_API_BASE_URL',
    apiTokenKey: 'NIMBUS_API_KEY',
    baseUrl: 'https://api.nimbusapi.net/v1',
  };

  /**
   * Chat / completion catalog. This is the exact allowlist that renders in
   * the primary picker on the customer-facing hosted deployment.
   */
  private chatModels: ModelInfo[] = [
    /*
     * Context windows below are the REAL ones, cross-checked against the
     * billing catalog (nimbus-v2 lib/models.ts) on 2026-08-01. Seven of these
     * ten were previously wrong — claude-sonnet-5, claude-opus-4.8 and kimi-k3
     * were declared 200000 against a real 1M; gpt-5.4-mini, gpt-5.3-codex,
     * deepseek-v4-pro and deepseek-v4-flash were declared 128000 against
     * 400K / 400K / 1M / 256K.
     *
     * These are only a FALLBACK now: the gateway passes through upstream's
     * context_length and that wins. Keep them accurate anyway — a fallback
     * nobody checks is how the 128K bug survived.
     */
    {
      name: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5',
      provider: 'Nimbus',
      maxTokenAllowed: 1000000,
      modality: 'chat',
    },
    {
      name: 'anthropic/claude-opus-4.8',
      label: 'Claude Opus 4.8',
      provider: 'Nimbus',
      maxTokenAllowed: 1000000,
      modality: 'chat',
    },
    {
      name: 'anthropic/claude-haiku-4.5',
      label: 'Claude Haiku 4.5',
      provider: 'Nimbus',
      maxTokenAllowed: 200000,
      modality: 'chat',
    },
    {
      name: 'openai/gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      provider: 'Nimbus',
      maxTokenAllowed: 400000,
      modality: 'chat',
    },
    {
      name: 'openai/gpt-5.3-codex',
      label: 'GPT-5.3 Codex',
      provider: 'Nimbus',
      maxTokenAllowed: 400000,
      modality: 'chat',
    },
    {
      name: 'deepseek/deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      provider: 'Nimbus',
      maxTokenAllowed: 1000000,
      modality: 'chat',
    },
    {
      name: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      provider: 'Nimbus',
      maxTokenAllowed: 256000,
      modality: 'chat',
    },
    { name: 'moonshotai/kimi-k3', label: 'Kimi K3', provider: 'Nimbus', maxTokenAllowed: 1000000, modality: 'chat' },
    {
      name: 'google/gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro Preview',
      provider: 'Nimbus',
      maxTokenAllowed: 1000000,
      modality: 'chat',
    },
    {
      name: 'google/gemini-3-flash-preview',
      label: 'Gemini 3 Flash Preview',
      provider: 'Nimbus',
      maxTokenAllowed: 1000000,
      modality: 'chat',
    },
  ];

  /**
   * Image-generation catalog for the /image surface tab. Non-streaming — the
   * caller POSTs a prompt and expects one or more image URLs back.
   */
  private imageModels: ModelInfo[] = [
    { name: 'openai/gpt-image-2', label: 'GPT Image 2', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    {
      name: 'google/gemini-3.1-flash-image',
      label: 'Gemini 3.1 Flash Image',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'image',
    },
    {
      name: 'midjourney-fast-imagine',
      label: 'Midjourney (fast /imagine)',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'image',
    },
    { name: 'grok-imagine-image', label: 'Grok Imagine', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    {
      name: 'grok-imagine-image-quality',
      label: 'Grok Imagine (Quality)',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'image',
    },
    { name: 'wan2.7-image', label: 'WAN 2.7 Image', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'Qwen-Image', label: 'Qwen Image', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'seedream-4.5', label: 'Seedream 4.5', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    {
      name: 'seedream-5.0-lite',
      label: 'Seedream 5.0 Lite',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'image',
    },
    {
      name: 'seedream-5.0-pro',
      label: 'Seedream 5.0 Pro',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'image',
    },
  ];

  /**
   * Video-generation catalog for the /video surface tab. ASYNC — the caller
   * submits a prompt, receives a job id, polls until the URL is ready.
   */
  private videoModels: ModelInfo[] = [
    {
      name: 'google/veo-3.1-1080p-audio',
      label: 'Veo 3.1 1080p (audio)',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'video',
    },
    {
      name: 'google/veo-3.1-720p-audio',
      label: 'Veo 3.1 720p (audio)',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'video',
    },
    {
      name: 'google/veo-3.1-fast-720p-audio',
      label: 'Veo 3.1 Fast 720p (audio)',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'video',
    },
    {
      name: 'google/veo-3-1080p-audio',
      label: 'Veo 3 1080p (audio)',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'video',
    },
    { name: 'kling-v3-t2v', label: 'Kling v3 T2V', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'video' },
    { name: 'Wan2.6-T2V', label: 'WAN 2.6 T2V', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'video' },
    { name: 'viduq3-pro', label: 'Vidu Q3 Pro', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'video' },
  ];

  /**
   * `staticModels` is what LLMManager and the primary chat picker consume.
   * It is intentionally chat-only — the /image and /video surfaces read
   * from getImageModels() / getVideoModels() so that surface pickers never
   * let the user accidentally send an image prompt to a chat model or vice
   * versa.
   */
  staticModels: ModelInfo[] = this.chatModels;

  /**
   * All static entries across every modality — used by generic pickers that
   * want the full Nimbus roster and will filter themselves.
   */
  getAllStaticModels(): ModelInfo[] {
    return [...this.chatModels, ...this.imageModels, ...this.videoModels];
  }

  getImageModels(): ModelInfo[] {
    return this.imageModels;
  }

  getVideoModels(): ModelInfo[] {
    return this.videoModels;
  }

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
      /*
       * No key configured — fall back to the static chat catalog so the UI
       * still renders something meaningful.
       */
      return this.staticModels;
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

      /*
       * The gateway's /v1/models IS the customer-facing catalog, so it is the
       * source of truth here rather than something to be filtered.
       *
       * This previously intersected the response with `chatModels` and then
       * re-added any static entry the gateway had NOT returned. Both halves
       * were backwards, and together they produced exactly the picker the
       * owner reported on 2026-08-01: 15 models offered out of 55 served.
       *
       *   - intersecting meant a model could never appear unless it was
       *     already hardcoded, so 35 live models — including the flagship
       *     anthropic/claude-opus-5 — were unreachable from the UI;
       *   - re-adding the difference meant a model could never disappear, so
       *     anthropic/claude-fable-5 stayed in the picker after the upstream
       *     stopped serving it and returned model_not_found on selection.
       *
       * The original comment justified the intersection as "never surface
       * undisclosed models". That risk is real but it belongs upstream, and
       * it is handled there: the gateway only advertises priced, routable,
       * customer-facing ids.
       *
       * Media models are excluded by pricing type rather than by name so the
       * chat picker cannot offer a video or image model. /image and /video
       * read getImageModels() / getVideoModels() and are unaffected.
       * Indexed under BOTH the prefixed name and its bare suffix.
       *
       * The static roster is keyed on provider-prefixed names
       * ('anthropic/claude-sonnet-5') while the gateway's canonical surface is
       * BARE ids ('claude-sonnet-5'). A bare id can never match a prefixed
       * key, so before this every lookup missed — which is why every row fell
       * back to the hardcoded token count AND rendered its raw id instead of a
       * human label. Prefixed entries are inserted first so an exact match
       * always wins over a suffix collision.
       */
      const staticByName = new Map<string, (typeof this.chatModels)[number]>();

      for (const m of this.chatModels) {
        staticByName.set(m.name, m);
      }

      for (const m of this.chatModels) {
        const bare = m.name.includes('/') ? m.name.slice(m.name.lastIndexOf('/') + 1) : m.name;

        if (!staticByName.has(bare)) {
          staticByName.set(bare, m);
        }
      }

      const models = res.data
        .filter((model) => {
          /*
           * Read `pricing` off the interface rather than through a local cast.
           * The cast used to be load-bearing, but `pricing` is now declared on
           * NimbusModelsResponse, which makes it a no-op that actively hides
           * future breakage: if the declared shape is ever corrected to match
           * the gateway (e.g. a per-token price object), a cast would keep
           * compiling against the stale local shape, `kind` would silently go
           * undefined for every row, and the media filter below would degrade
           * to "everything passes" with no type error anywhere.
           */
          const kind = model.pricing?.type;
          return kind === undefined || kind === 'token';
        })
        .map((model) => {
          const staticHit = staticByName.get(model.id);
          return {
            name: model.id,

            /*
             * Static entries stay useful as presentation metadata: they carry
             * the human label and real context window. Anything the gateway
             * adds later still shows, just under its raw id until labelled.
             */
            label: staticHit?.label ?? model.id,
            provider: this.name,

            /*
             * Upstream's real context window wins. The static roster is a
             * fallback for ids upstream did not describe, and 128000 is the
             * last resort for ones we know nothing about.
             *
             * Order matters: reading the gateway FIRST is the whole fix. It
             * used to be `staticHit?.maxTokenAllowed ?? 128000`, with no
             * gateway read at all, so the picker advertised 128K on models
             * with a 1M window.
             */
            /*
             * `> 0` rather than `??`. Nullish coalescing only falls through on
             * null/undefined, so a gateway returning `context_length: 0` — or a
             * negative, or a numeric string — would land straight in
             * maxTokenAllowed instead of falling back. `response.json()` is
             * asserted, not validated, so nothing upstream of here would catch
             * it. The sibling provider guards the same way (fireworks.ts:111
             * uses `||`).
             *
             * This is defensive rather than a known bug: the gateway omits the
             * field when upstream is silent. But an unexamined fallback is
             * exactly what let "128K tokens" survive on every row for weeks,
             * so this one gets a real check.
             */
            maxTokenAllowed:
              typeof model.context_length === 'number' && model.context_length > 0
                ? model.context_length
                : (staticHit?.maxTokenAllowed ?? 128000),
            modality: 'chat' as const,
          };
        });

      /*
       * A gateway that answers with an empty list is far more likely to be
       * misconfigured than to genuinely sell nothing, so keep the static
       * catalog rather than render an empty picker.
       */
      return models.length > 0 ? models : this.staticModels;
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
      throw new Error(
        'Nimbus provider: no upstream API key available. Sign in at https://nimbusapi.net/dashboard so the Builder inherits your session (this usually means the server is missing NIMBUS_API_KEY or the SSO cookie has expired).',
      );
    }

    return getOpenAILikeModel(resolvedBase, apiKey, model);
  }
}
