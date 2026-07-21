import { type ActionFunctionArgs, json } from '@remix-run/cloudflare';
import { classifyAndQuestion } from '~/lib/agent/clarify';
import { researchReference, type ReferenceDigest } from '~/lib/agent/research';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('api.plan');

/**
 * POST /api/plan  { prompt: string, referenceUrl?: string }
 *   -> { mode: 'build' | 'questions', reason: string, questions: [...], referenceDigest?: ReferenceDigest, referenceNote?: string }
 *
 * Lovable-parity clarify + research gate. Optionally scrapes a reference URL
 * server-side (SSRF-guarded) and returns a compact digest the planner can use.
 * If mode === 'build', proceed directly to /api/chat with the digest folded in.
 * If mode === 'questions', render chip UI, collect answers, then call /api/chat.
 */
export async function action({ context, request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { prompt?: string; referenceUrl?: string };
    const prompt = String(body.prompt || '').trim();
    const referenceUrl = String(body.referenceUrl || '').trim();

    if (prompt.length === 0) {
      return json({ error: 'missing_prompt' }, { status: 400 });
    }

    if (prompt.length > 40_000) {
      return json({ error: 'prompt_too_long' }, { status: 413 });
    }

    const serverEnv = (context?.cloudflare?.env ?? {}) as Record<string, string>;

    // Optional reference URL research (Lovable "clone this vibe" flow)
    let referenceDigest: ReferenceDigest | null = null;
    let referenceNote: string | undefined;
    if (referenceUrl) {
      const research = await researchReference(referenceUrl, serverEnv);
      if (research.ok) {
        referenceDigest = research.digest;
      } else {
        referenceNote = research.note;
      }
    }

    const decision = await classifyAndQuestion(prompt, serverEnv);

    return json({ ...decision, referenceDigest, referenceNote });
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
