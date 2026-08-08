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

interface CatalogEntry {
  /** Provider-prefixed id. Every model the gateway serves has one of these. */
  id: string;

  label: string;

  /**
   * FALLBACK context window, used only when the gateway does not publish one.
   * Values match what /v1/models actually returns today, so a fallback that
   * fires looks identical to one that doesn't.
   */
  context: number;

  /**
   * Public availability date, sourced from the vendor — this is the sort key.
   * `null` means no dated source was found; those entries are placed by
   * version lineage within their own family instead (see below).
   */
  released: string | null;
}

/**
 * THE DISPLAY ORDER for the chat picker: grouped by vendor, newest-first
 * inside each group. Array position IS the contract — `getDynamicModels`
 * sorts the live gateway response against this list.
 *
 * Dates were sourced individually from first-party changelogs and model docs
 * (Anthropic API release notes, the OpenAI API changelog, the Gemini API
 * changelog, DeepSeek's news posts, Z.ai release notes, Alibaba Cloud Model
 * Studio) rather than inferred from version numbers. That distinction matters:
 * version order and release order genuinely disagree twice here, and both
 * disagreements look like bugs until you check the source —
 *
 *   - gpt-5.4-mini (03-17) shipped 12 days AFTER gpt-5.4 (03-05);
 *   - claude-sonnet-4.6 (02-17) shipped after claude-opus-4.6 (02-05), so a
 *     Sonnet sits above an Opus.
 *
 * Both are correct. Do not "fix" them without re-reading the changelog.
 *
 * Two entries carry `released: null` — qwen3-coder and glm-5. Neither vendor
 * publishes a date for them. They are placed last inside their own family,
 * which is unambiguous from lineage (glm-5 predates glm-5.1 predates glm-5.2),
 * so the ordering is sound even though the date is unknown. A guessed date
 * would have been indistinguishable from a sourced one here, which is exactly
 * why the field is nullable rather than best-effort.
 */
const CHAT_CATALOG: readonly CatalogEntry[] = [
  // ── Anthropic ────────────────────────────────────────────────────────────
  { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', context: 1000000, released: '2026-07-24' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', context: 1000000, released: '2026-06-30' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', context: 1000000, released: '2026-05-28' },
  { id: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7', context: 1000000, released: '2026-04-16' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', context: 1000000, released: '2026-02-17' },
  { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6', context: 1000000, released: '2026-02-05' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', context: 200000, released: '2025-10-15' },

  /*
   * ── OpenAI ─────────────────────────────────────────────────────────────
   * The 5.6 trio GA'd together in a single changelog entry, so there is no
   * date ordering between them; they are ranked flagship → mid → small.
   */
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', context: 1050000, released: '2026-07-09' },
  { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra', context: 1050000, released: '2026-07-09' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', context: 1050000, released: '2026-07-09' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', context: 1050000, released: '2026-04-24' },
  { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini', context: 400000, released: '2026-03-17' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4', context: 1050000, released: '2026-03-05' },
  { id: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex', context: 400000, released: '2026-02-24' },
  { id: 'openai/gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', context: 400000, released: '2025-12-04' },
  { id: 'openai/gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', context: 400000, released: '2025-11-13' },

  // ── Google ───────────────────────────────────────────────────────────────
  { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', context: 1048576, released: '2026-05-19' },
  {
    id: 'google/gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro Preview',
    context: 1048576,
    released: '2026-02-19',
  },
  {
    id: 'google/gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
    context: 1048576,
    released: '2025-12-17',
  },

  /*
   * ── DeepSeek ───────────────────────────────────────────────────────────
   * Both V4 models shipped the same day as one preview, so this pair is
   * ranked by tier. Flash later got a stable build (0731) that Pro has not;
   * sorting on latest-build instead would put Flash first.
   */
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', context: 1048576, released: '2026-04-24' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', context: 1048576, released: '2026-04-24' },

  /*
   * ── Moonshot ───────────────────────────────────────────────────────────
   * Moonshot prints no dates on its model cards. These two come from
   * third-party coverage and dated asset paths, so treat them as approximate.
   * The ordering does not depend on them — every source agrees K3 is newer.
   */
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3', context: 1000000, released: '2026-07-16' },
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6', context: 262144, released: '2026-04-20' },

  /*
   * ── Qwen ───────────────────────────────────────────────────────────────
   * Alibaba publishes 1,000,000 total for qwen3.7-max, of which 991,808 is
   * usable input and 65,536 is reserved for output. The gateway publishes no
   * context_length for it at all, so this fallback is what the picker shows.
   */
  { id: 'qwen/qwen3.7-max', label: 'Qwen3.7 Max', context: 1000000, released: '2026-05-20' },
  { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder', context: 1048576, released: null },

  /*
   * ── Z.ai ───────────────────────────────────────────────────────────────
   * Z.ai's docs give round labels ("1M", "200K") and no exact integer, so
   * these two are deliberately the round number rather than a guessed
   * power-of-two. For reference the gateway does report glm-5 as 202752, so
   * glm-5.1's true value is plausibly 202752 too — 200000 understates it by
   * ~2.7K, which is the safe direction to be wrong in.
   */
  { id: 'z-ai/glm-5.2', label: 'GLM-5.2', context: 1000000, released: '2026-06-16' },
  { id: 'z-ai/glm-5.1', label: 'GLM-5.1', context: 200000, released: '2026-04-07' },
  { id: 'z-ai/glm-5', label: 'GLM-5', context: 202752, released: null },
];

/**
 * Video roster, in display order: newest family first.
 *
 * Rebuilt from the gateway's live routing table on 2026-08-03. It was both
 * wrong and incomplete — it offered kling-v3-t2v, Wan2.6-T2V and viduq3-pro,
 * none of which exist in the routing table (upstream stopped serving them;
 * the site catalog has flagged all three `unavailable` since 2026-07-26),
 * while listing only 4 of the 18 video models that DO route. A customer could
 * pick a model that always failed, and could not pick most of the ones that
 * worked.
 *
 * Ids use the provider-prefixed spelling where the gateway publishes one.
 * `sora-2` is published bare only — it is namespaced `azure/sora-2` upstream,
 * and that prefix is provenance rather than a routing target, so the bare id
 * is the customer-facing name.
 *
 * Ordering within Veo is by family (3.1 > 3 > 2) and then quality; `sora-2`
 * sits between the Veo 3 and Veo 2 families by lineage, not by a sourced
 * release date — unlike the chat catalog, no vendor date was checked here.
 */
const VIDEO_CATALOG: readonly { id: string; label: string }[] = [
  { id: 'google/veo-3.1-1080p-audio', label: 'Veo 3.1 1080p (audio)' },
  { id: 'google/veo-3.1-720p-audio', label: 'Veo 3.1 720p (audio)' },
  { id: 'google/veo-3.1-1080p', label: 'Veo 3.1 1080p' },
  { id: 'google/veo-3.1-720p', label: 'Veo 3.1 720p' },
  { id: 'google/veo-3.1-fast-1080p-audio', label: 'Veo 3.1 Fast 1080p (audio)' },
  { id: 'google/veo-3.1-fast-720p-audio', label: 'Veo 3.1 Fast 720p (audio)' },
  { id: 'google/veo-3.1-fast-1080p', label: 'Veo 3.1 Fast 1080p' },
  { id: 'google/veo-3.1-fast-720p', label: 'Veo 3.1 Fast 720p' },
  { id: 'google/veo-3-1080p-audio', label: 'Veo 3 1080p (audio)' },
  { id: 'google/veo-3-720p-audio', label: 'Veo 3 720p (audio)' },
  { id: 'google/veo-3-1080p', label: 'Veo 3 1080p' },
  { id: 'google/veo-3-720p', label: 'Veo 3 720p' },
  { id: 'google/veo-3-fast-1080p-audio', label: 'Veo 3 Fast 1080p (audio)' },
  { id: 'google/veo-3-fast-720p-audio', label: 'Veo 3 Fast 720p (audio)' },
  { id: 'google/veo-3-fast-1080p', label: 'Veo 3 Fast 1080p' },
  { id: 'google/veo-3-fast-720p', label: 'Veo 3 Fast 720p' },
  { id: 'sora-2', label: 'Sora 2' },
  { id: 'google/veo-2-720p', label: 'Veo 2 720p' },
];

/** Rank by canonical (bare) id, so both id spellings resolve to one position. */
const DISPLAY_RANK = new Map<string, number>(
  CHAT_CATALOG.map((m, i) => [m.id.slice(m.id.lastIndexOf('/') + 1), i] as const),
);

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

  /**
   * The catalog order below is deliberate — see CHAT_CATALOG. Without this
   * LLMManager alphabetises it away before the picker ever sees it.
   */
  preservesModelOrder = true;

  config = {
    baseUrlKey: 'NIMBUS_API_BASE_URL',
    apiTokenKey: 'NIMBUS_API_KEY',
    baseUrl: 'https://api.nimbusapi.net/v1',
  };

  /**
   * Chat / completion catalog. This is the exact allowlist that renders in
   * the primary picker on the customer-facing hosted deployment.
   */
  private _chatModels: ModelInfo[] = CHAT_CATALOG.map((m) => ({
    name: m.id,
    label: m.label,
    provider: 'Nimbus',
    maxTokenAllowed: m.context,
    modality: 'chat' as const,
  }));

  /**
   * Image-generation catalog for the /image surface tab. Non-streaming — the
   * caller POSTs a prompt and expects one or more image URLs back.
   */
  private _imageModels: ModelInfo[] = [
    /*
     * Only what the gateway can actually route, checked against its live
     * routing table on 2026-08-03.
     *
     * Eight entries were removed here: midjourney-fast-imagine,
     * grok-imagine-image, grok-imagine-image-quality, wan2.7-image,
     * Qwen-Image, and the three seedream ids. None of them exist in the
     * routing table at all, so picking one returned model_not_found — the
     * Image tab was offering eight models that could not work.
     *
     * They are not gone by accident: upstream stopped serving them, the site
     * catalog has carried `unavailable: "upstream 404 model_not_found
     * (verified 2026-07-26)"` on every one since, and the routing table was
     * cleaned to match. This roster was simply never updated with it. Restore
     * an entry only once the gateway lists it again.
     */
    { name: 'openai/gpt-image-2', label: 'GPT Image 2', provider: 'Nimbus', maxTokenAllowed: 4096, modality: 'image' },
    {
      name: 'google/gemini-3.1-flash-image',
      label: 'Gemini 3.1 Flash Image',
      provider: 'Nimbus',
      maxTokenAllowed: 4096,
      modality: 'image',
    },
  ];

  /**
   * Video-generation catalog for the /video surface tab. ASYNC — the caller
   * submits a prompt, receives a job id, polls until the URL is ready.
   */
  private _videoModels: ModelInfo[] = VIDEO_CATALOG.map((m) => ({
    name: m.id,
    label: m.label,
    provider: 'Nimbus',
    maxTokenAllowed: 4096,
    modality: 'video' as const,
  }));

  /**
   * `staticModels` is what LLMManager and the primary chat picker consume.
   * It is intentionally chat-only — the /image and /video surfaces read
   * from getImageModels() / getVideoModels() so that surface pickers never
   * let the user accidentally send an image prompt to a chat model or vice
   * versa.
   */
  staticModels: ModelInfo[] = this._chatModels;

  /**
   * All static entries across every modality — used by generic pickers that
   * want the full Nimbus roster and will filter themselves.
   */
  getAllStaticModels(): ModelInfo[] {
    return [...this._chatModels, ...this._imageModels, ...this._videoModels];
  }

  getImageModels(): ModelInfo[] {
    return this._imageModels;
  }

  getVideoModels(): ModelInfo[] {
    return this._videoModels;
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
       * This previously intersected the response with `_chatModels` and then
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
      const staticByName = new Map<string, (typeof this._chatModels)[number]>();

      for (const m of this._chatModels) {
        staticByName.set(m.name, m);
      }

      for (const m of this._chatModels) {
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
        /*
         * Collapse the two spellings of each model into one row.
         *
         * The gateway advertises most models TWICE — bare ('claude-sonnet-5')
         * and provider-prefixed ('anthropic/claude-sonnet-5'). That is
         * deliberate on the API side: bare is our canonical customer surface,
         * prefixed is what agent frameworks expect, and both route. But the
         * picker consumed the list verbatim, so a 28-model catalog rendered as
         * 55 rows with nearly every model listed twice under two different
         * names. That is the "not organized at all" the owner reported, and it
         * is also why the same model could show two different context windows.
         *
         * Keep the PREFIXED spelling. It is the safe direction: all 28 models
         * have a prefixed id, whereas the flagship claude-opus-5 is served
         * ONLY as 'anthropic/claude-opus-5'. Canonicalising to bare would have
         * emitted 'claude-opus-5', which the gateway does not serve — the
         * flagship would 404 on selection.
         */
        .reduce<Array<NimbusModelsResponse['data'][number]>>((acc, model) => {
          const bare = model.id.includes('/') ? model.id.slice(model.id.lastIndexOf('/') + 1) : model.id;
          const at = acc.findIndex((m) => (m.id.includes('/') ? m.id.slice(m.id.lastIndexOf('/') + 1) : m.id) === bare);

          if (at === -1) {
            acc.push(model);
            return acc;
          }

          /*
           * Merge rather than discard: whichever spelling the gateway happened
           * to describe wins, so dropping a duplicate can never drop the only
           * context window we were given.
           */
          const kept = acc[at];
          acc[at] = {
            ...kept,
            id: model.id.includes('/') ? model.id : kept.id,
            context_length: kept.context_length ?? model.context_length,
          };

          return acc;
        }, [])
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
        })
        /*
         * Grouped by vendor, newest-first inside each group — see CHAT_CATALOG
         * for the order and the sourcing behind it.
         *
         * The gateway returns models in routing-table order, which is neither
         * grouped nor chronological, so ordering has to happen somewhere. It
         * happens here rather than in ModelSelector because this is the only
         * layer that knows what a Nimbus model id means; the selector stays
         * provider-agnostic and now simply preserves the order it is handed.
         *
         * Anything the gateway adds that is not in CHAT_CATALOG sorts to the
         * END alphabetically rather than being hidden. A new model appearing
         * unlabelled at the bottom is a visible prompt to add it here; the
         * alternative — filtering to the known list — is what previously made
         * 35 live models unreachable from the UI.
         */
        .sort((a, b) => {
          const bareA = a.name.slice(a.name.lastIndexOf('/') + 1);
          const bareB = b.name.slice(b.name.lastIndexOf('/') + 1);
          const rankA = DISPLAY_RANK.get(bareA) ?? Number.MAX_SAFE_INTEGER;
          const rankB = DISPLAY_RANK.get(bareB) ?? Number.MAX_SAFE_INTEGER;

          return rankA === rankB ? a.label.localeCompare(b.label) : rankA - rankB;
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
