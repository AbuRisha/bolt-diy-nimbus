import { BaseProvider, getOpenAILikeModel } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { logger } from '~/utils/logger';

interface NimbusModelsResponse {
  data: Array<{ id: string; owned_by?: string }>;
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
    { name: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Nimbus', maxTokenAllowed: 200000, modality: 'chat' },
    { name: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', provider: 'Nimbus', maxTokenAllowed: 200000, modality: 'chat' },
    { name: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', provider: 'Nimbus', maxTokenAllowed: 200000, modality: 'chat' },
    { name: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'Nimbus', maxTokenAllowed: 128000, modality: 'chat' },
    { name: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'Nimbus', maxTokenAllowed: 128000, modality: 'chat' },
    { name: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'Nimbus', maxTokenAllowed: 128000, modality: 'chat' },
    { name: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'Nimbus', maxTokenAllowed: 128000, modality: 'chat' },
    { name: 'moonshotai/kimi-k3', label: 'Kimi K3', provider: 'Nimbus', maxTokenAllowed: 200000, modality: 'chat' },
    { name: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', provider: 'Nimbus', maxTokenAllowed: 1000000, modality: 'chat' },
    { name: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', provider: 'Nimbus', maxTokenAllowed: 1000000, modality: 'chat' },
  ];

  /**
   * Image-generation catalog for the /image surface tab. Non-streaming — the
   * caller POSTs a prompt and expects one or more image URLs back.
   */
  private imageModels: ModelInfo[] = [
    { name: 'openai/gpt-image-2', label: 'GPT Image 2', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'google/gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'midjourney-fast-imagine', label: 'Midjourney (fast /imagine)', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'grok-imagine-image', label: 'Grok Imagine', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'grok-imagine-image-quality', label: 'Grok Imagine (Quality)', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'wan2.7-image', label: 'WAN 2.7 Image', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'Qwen-Image', label: 'Qwen Image', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'seedream-4.5', label: 'Seedream 4.5', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'seedream-5.0-lite', label: 'Seedream 5.0 Lite', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    { name: 'seedream-5.0-pro', label: 'Seedream 5.0 Pro', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
  ];

  /**
   * Video-generation catalog for the /video surface tab. ASYNC — the caller
   * submits a prompt, receives a job id, polls until the URL is ready.
   */
  private videoModels: ModelInfo[] = [
    { name: 'google/veo-3.1-1080p-audio', label: 'Veo 3.1 1080p (audio)', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'video' },
    { name: 'google/veo-3.1-720p-audio', label: 'Veo 3.1 720p (audio)', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'video' },
    { name: 'google/veo-3.1-fast-720p-audio', label: 'Veo 3.1 Fast 720p (audio)', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'video' },
    { name: 'google/veo-3-1080p-audio', label: 'Veo 3 1080p (audio)', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'video' },
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

  /** All static entries across every modality — used by generic pickers that
   * want the full Nimbus roster and will filter themselves. */
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
      // No key configured — fall back to the static chat catalog so the UI
      // still renders something meaningful.
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

      // The gateway's /v1/models IS the customer-facing catalog, so it is the
      // source of truth here rather than something to be filtered.
      //
      // This previously intersected the response with `chatModels` and then
      // re-added any static entry the gateway had NOT returned. Both halves
      // were backwards, and together they produced exactly the picker the
      // owner reported on 2026-08-01: 15 models offered out of 55 served.
      //
      //   - intersecting meant a model could never appear unless it was
      //     already hardcoded, so 35 live models — including the flagship
      //     anthropic/claude-opus-5 — were unreachable from the UI;
      //   - re-adding the difference meant a model could never disappear, so
      //     anthropic/claude-fable-5 stayed in the picker after the upstream
      //     stopped serving it and returned model_not_found on selection.
      //
      // The original comment justified the intersection as "never surface
      // undisclosed models". That risk is real but it belongs upstream, and
      // it is handled there: the gateway only advertises priced, routable,
      // customer-facing ids.
      //
      // Media models are excluded by pricing type rather than by name so the
      // chat picker cannot offer a video or image model. /image and /video
      // read getImageModels() / getVideoModels() and are unaffected.
      const staticByName = new Map(this.chatModels.map((m) => [m.name, m]));

      const models = res.data
        .filter((model) => {
          const kind = (model as { pricing?: { type?: string } }).pricing?.type;
          return kind === undefined || kind === 'token';
        })
        .map((model) => {
          const staticHit = staticByName.get(model.id);
          return {
            name: model.id,
            // Static entries stay useful as presentation metadata: they carry
            // the human label and real context window. Anything the gateway
            // adds later still shows, just under its raw id until labelled.
            label: staticHit?.label ?? model.id,
            provider: this.name,
            maxTokenAllowed: staticHit?.maxTokenAllowed ?? 128000,
            modality: 'chat' as const,
          };
        });

      // A gateway that answers with an empty list is far more likely to be
      // misconfigured than to genuinely sell nothing, so keep the static
      // catalog rather than render an empty picker.
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
