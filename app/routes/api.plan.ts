import { type ActionFunctionArgs, json } from '@remix-run/cloudflare';
import { classifyAndQuestion } from '~/lib/agent/clarify';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.plan');

/**
 * POST /api/plan  { prompt: string }
 *   -> { mode: 'build' | 'questions', reason: string, questions: [...] }
 *
 * Lovable-parity clarify gate. Client calls this before the first build turn.
 * If mode === 'build', proceed directly to /api/chat. If mode === 'questions',
 * render chip UI, collect answers, then call /api/chat with answers folded
 * into the prompt.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { prompt?: string };
    const prompt = String(body.prompt || '').trim();

    if (prompt.length === 0) {
      return json({ error: 'missing_prompt' }, { status: 400 });
    }

    if (prompt.length > 40_000) {
      return json({ error: 'prompt_too_long' }, { status: 413 });
    }

    const serverEnv = (context?.cloudflare?.env ?? {}) as Record<string, string>;
    const decision = await classifyAndQuestion(prompt, serverEnv);

    return json(decision);
  } catch (err) {
    logger.error('plan action failed', err);
    // Never block a build on classifier failure.
    return json({
      mode: 'build',
      questions: [],
      reason: 'Planner unavailable; proceed to build.',
    });
  }
}
