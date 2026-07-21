/**
 * Lovable-parity clarify gate — ported from nimbus_site_v2/lib/studio/agent/clarify.ts.
 *
 * A single CHEAP model call classifies each first prompt and either lets the
 * build proceed straight away, OR returns 2-4 clarifying questions attuned to
 * this specific prompt with quick-reply chips.
 *
 * The UI renders questions as chip bubbles, user taps once, build proceeds.
 * Single-shot; never a multi-turn interrogation.
 */
import { generateText } from 'ai';
import { LLMManager } from '~/lib/modules/llm/manager';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('clarify');

// Cheap classifier target; Nimbus routes to a fast model.
const CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5';
const CLASSIFIER_PROVIDER = 'Nimbus';

export type ClarifyChip = string;
export type ClarifyQuestion = { id: string; question: string; chips: ClarifyChip[] };
export type ClarifyDecision = {
  mode: 'build' | 'questions';
  questions: ClarifyQuestion[];
  reason: string;
};

const CLASSIFIER_SYSTEM = `You are Nimbus Studio's build-intake classifier. Given a user's first request to build a website or app, decide whether there is ENOUGH to start building right now, or whether a few targeted questions would genuinely improve the result. Return JSON ONLY, no prose.

Return shape:
{
  "mode": "build" | "questions",
  "reason": "one short sentence",
  "questions": [
    {"id":"kebab-id","question":"specific to THIS prompt","chips":["quick reply","another option","a third"]}
  ]
}

DECISION RULES (default strongly to "build"):
- "build" when the prompt already specifies enough, OR references a product/style/URL, OR is a DASHBOARD, ADMIN PANEL, INTERNAL TOOL, GAME, or pure backend task.
- "questions" ONLY when genuinely underspecified in a way that materially changes what gets built.
- When in doubt, "build". Asking stale questions is worse than building and letting the user refine.

QUESTION RULES:
- 2 to 4 questions maximum, fewer is better.
- Each question SPECIFIC to THIS prompt's gaps (pages/scope, data model, auth, integrations, concrete style).
- Provide 2-4 short quick-reply chips per question (<=32 chars each).
- One shot only, do not plan multi-turn.`;

function trulyEmpty(prompt: string): boolean {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean).length;
  return clean.length < 6 && words < 2;
}

function materiallyVague(prompt: string): boolean {
  const clean = prompt.replace(/\s+/g, ' ').trim().toLowerCase();
  const words = clean.split(' ').filter(Boolean);
  if (words.length > 6) return false;
  const genericRequest = /\b(?:make|build|create|fix|change|improve|better|nice|cool|modern|website|app|thing|it|this)\b/g;
  const meaningful = clean.replace(genericRequest, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  return meaningful.length < 4;
}

function vagueQuestions(): ClarifyQuestion[] {
  return [
    {
      id: 'target',
      question: 'What site, app, or part of the project should I build or improve?',
      chips: ['Landing page', 'Dashboard', 'Full app', 'Mobile flow'],
    },
    {
      id: 'outcome',
      question: 'What should feel or work differently when this is done?',
      chips: ['More polished', 'Easier to use', 'More conversions', 'Fix a broken flow'],
    },
  ];
}

function coerceChips(raw: unknown): ClarifyChip[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ClarifyChip[] = [];
  for (const item of raw) {
    const clean = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
    if (out.length >= 4) break;
  }
  return out;
}

function coerceQuestions(raw: unknown): ClarifyQuestion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ClarifyQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const question = String(value.question || '').replace(/\s+/g, ' ').trim();
    if (question.length < 4) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id =
      String(value.id || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 48) ||
      `q-${out.length + 1}`;
    out.push({ id, question: question.slice(0, 300), chips: coerceChips(value.chips) });
    if (out.length >= 4) break;
  }
  return out;
}

function parseJson<T = unknown>(text: string): T | Record<string, never> {
  const clean = text.trim();
  // Strip common markdown code fences.
  const stripped = clean.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // Try to find a JSON object anywhere in the text as fallback.
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {}
    }
    return {} as Record<string, never>;
  }
}

/**
 * Classify the prompt. Resilient: any model/parse failure returns build so the
 * pipeline never stalls.
 */
export async function classifyAndQuestion(
  prompt: string,
  serverEnv: Record<string, string>,
): Promise<ClarifyDecision> {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  if (trulyEmpty(clean)) {
    return {
      mode: 'questions',
      reason: 'The prompt is too short to build from.',
      questions: [
        {
          id: 'product',
          question: 'What would you like to build? Describe the site or app in a sentence.',
          chips: ['Landing page', 'Dashboard', 'Portfolio', 'Online store'],
        },
      ],
    };
  }
  if (materiallyVague(clean)) {
    return {
      mode: 'questions',
      reason: 'The request does not identify the product or the intended outcome.',
      questions: vagueQuestions(),
    };
  }

  try {
    const provider = LLMManager.getInstance(serverEnv).getProvider(CLASSIFIER_PROVIDER);
    if (!provider) {
      logger.warn(`Provider ${CLASSIFIER_PROVIDER} not registered; skipping classifier`);
      return { mode: 'build', questions: [], reason: 'Classifier unavailable.' };
    }
    const model = provider.getModelInstance({
      model: CLASSIFIER_MODEL,
      serverEnv: serverEnv as unknown as Env,
    });

    const { text } = await generateText({
      model,
      system: CLASSIFIER_SYSTEM,
      prompt: `USER REQUEST:\n${clean.slice(0, 40_000)}`,
      maxTokens: 800,
      temperature: 0.2,
    });

    const parsed = parseJson<{ mode?: string; reason?: string; questions?: unknown }>(text);
    const questions = coerceQuestions(parsed.questions);
    const wantsQuestions =
      String(parsed.mode || '').toLowerCase() === 'questions' && questions.length > 0;

    return {
      mode: wantsQuestions ? 'questions' : 'build',
      reason:
        String(parsed.reason || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 240) ||
        (wantsQuestions
          ? 'Clarification would improve the result.'
          : 'The request is clear enough to build.'),
      questions: wantsQuestions ? questions : [],
    };
  } catch (err) {
    logger.warn('classifier failed, defaulting to build', err);
    return { mode: 'build', questions: [], reason: 'Classifier error; building directly.' };
  }
}
