/**
 * Reference-URL research (Lovable-parity "replicate/take inspiration").
 * Ported from nimbus_site_v2/lib/studio/agent/research.ts.
 *
 * Fetches a user-supplied URL server-side (SSRF-guarded), extracts structural
 * and design hints, and asks a cheap model to distill a compact "reference
 * digest" the clarify/plan flow can use.
 *
 * Every failure path degrades gracefully.
 */
import { generateText } from 'ai';
import { LLMManager } from '~/lib/modules/llm/manager';
import { createScopedLogger } from '~/utils/logger';
import { isAllowedUrl, safeFetch } from '~/utils/url';

/*
 * Removed node:net + node:dns/promises — wrangler pages dev runtime in the
 * Nimbus Builder Docker container does not reliably expose these. SSRF
 * safety now depends solely on URL-parser normalization (reject non-http(s),
 * reject credentials, reject explicit ports). The Docker container is not
 * on any VNet with private services, so RFC1918 blocking here is defense
 * in depth rather than the primary control.
 */

const logger = createScopedLogger('research');

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2_000_000;
const DIGEST_MODEL = 'anthropic/claude-haiku-4.5';
const DIGEST_PROVIDER = 'Nimbus';

export type ReferenceDigest = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  navItems: string[];
  sectionTypes: string[];
  paletteHints: string[];
  textSample: string;
  summary: string;
};

export type ResearchResult = { ok: true; digest: ReferenceDigest } | { ok: false; note: string };

// isPrivateAddress removed alongside node:net import — see file header note.

export function normalizeReferenceUrl(raw: string): URL | null {
  const trimmed = String(raw || '').trim();

  if (!trimmed) {
    return null;
  }

  const hierarchical = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\//i);

  if (hierarchical && !/^https?$/i.test(hierarchical[1])) {
    return null;
  }

  const opaque = trimmed.match(/^([a-z][a-z0-9+.-]*):(?!\/\/)(?!\d)/i);

  if (opaque && !/^https?$/i.test(opaque[1])) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(url.protocol)) {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }

  if (url.port && url.port !== '80' && url.port !== '443') {
    return null;
  }

  /*
   * SSRF. This URL comes straight from `POST /api/plan { referenceUrl }`, and
   * the body of whatever it points at is parsed and returned to the caller —
   * so an unchecked target is a read primitive against anything the container
   * can reach.
   *
   * The checks above are not that control: scheme, credentials and port say
   * nothing about the destination, and port 80 is exactly where link-local and
   * internal HTTP services live. Verified against production 2026-08-07 —
   * `referenceUrl: http://example.com/` came back with the page title and
   * headings extracted, and `http://127.0.0.1/` reported "did not respond",
   * i.e. it was attempted and simply had nothing listening.
   *
   * This file predates `~/utils/url` and rolled its own fetch, which is why
   * the earlier audit of `isAllowedUrl` callers missed it.
   */
  if (!isAllowedUrl(url.toString())) {
    return null;
  }

  return url;
}

/*
 * Renamed from `safeFetch`, which collided with the genuinely-safe one in
 * `~/utils/url` — two functions, one name, opposite guarantees. This one only
 * ever added a timeout; it used `redirect: 'follow'`, so even a validated URL
 * could be bounced into internal space by a 302 and the check never re-ran.
 *
 * It now delegates to the checked implementation, which drives redirects with
 * `redirect: 'manual'` and re-validates every hop.
 */
async function fetchReferenceWithTimeout(url: URL, timeoutMs: number): Promise<Response | null> {
  try {
    return await safeFetch(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'NimbusBuilder-Research/1.0 (+https://nimbusapi.net)' },
    });
  } catch (err) {
    logger.warn(`fetch failed for ${url.hostname}`, err);
    return null;
  }
}

function extractStructure(html: string): Omit<ReferenceDigest, 'url' | 'summary'> {
  const clean = html.slice(0, MAX_BODY_BYTES);
  const pick = (re: RegExp): string[] =>
    Array.from(clean.matchAll(re))
      .map((m) =>
        String(m[1] || '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter((s) => s.length > 0 && s.length <= 200);

  const title = (clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 240);

  const description =
    clean
      .match(/<meta\s+name=["']description["']\s+content=["']([^"']+)/i)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400) || '';

  const headings = [...pick(/<h1[^>]*>([\s\S]*?)<\/h1>/gi), ...pick(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].slice(0, 12);

  const navItems = pick(/<nav[^>]*>([\s\S]*?)<\/nav>/gi).slice(0, 4);

  const sectionTypes = Array.from(
    new Set(
      Array.from(clean.matchAll(/<(section|main|article|aside|footer|header)/gi)).map((m) =>
        String(m[1] || '').toLowerCase(),
      ),
    ),
  ).slice(0, 10);

  const paletteHints = Array.from(
    new Set(
      Array.from(clean.matchAll(/#[0-9a-fA-F]{6}\b/g))
        .map((m) => m[0].toLowerCase())
        .filter((c, _, arr) => arr.filter((x) => x === c).length >= 2),
    ),
  ).slice(0, 6);

  const textSample = clean
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);

  return { title, description, headings, navItems, sectionTypes, paletteHints, textSample };
}

const SUMMARY_SYSTEM = `You produce compact JSON summaries of reference websites for a build planner. Return ONLY JSON of shape:
{"summary":"one paragraph describing the site's product, audience, tone, and 2-3 things worth borrowing (never copy content)"}
Keep the summary under 260 characters.`;

/*
 * `digest` was widened from Omit<..., 'summary'> to match what extractStructure
 * actually produces. The body only does JSON.stringify(digest) and never reads
 * `url`, so requiring it was a signature that described no real dependency.
 */
async function summarizeDigest(
  digest: Omit<ReferenceDigest, 'url' | 'summary'>,
  serverEnv: Record<string, string>,
): Promise<string> {
  try {
    const provider = LLMManager.getInstance(serverEnv).getProvider(DIGEST_PROVIDER);

    if (!provider) {
      return '';
    }

    const model = provider.getModelInstance({
      model: DIGEST_MODEL,
      serverEnv: serverEnv as unknown as Env,
    });
    const { text } = await generateText({
      model,
      system: SUMMARY_SYSTEM,
      prompt: JSON.stringify(digest).slice(0, 8000),
      maxTokens: 300,
      temperature: 0.3,
    });
    const parsed = (() => {
      try {
        return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
      } catch {
        const m = text.match(/\{[\s\S]*\}/);

        try {
          return m ? JSON.parse(m[0]) : {};
        } catch {
          return {};
        }
      }
    })();

    return String(parsed.summary || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 260);
  } catch (err) {
    logger.warn('summarizeDigest failed', err);
    return '';
  }
}

export async function researchReference(rawUrl: string, serverEnv: Record<string, string>): Promise<ResearchResult> {
  const url = normalizeReferenceUrl(rawUrl);

  if (!url) {
    return { ok: false, note: 'That URL is not valid or not http(s).' };
  }

  const res = await fetchReferenceWithTimeout(url, FETCH_TIMEOUT_MS);

  if (!res || !res.ok) {
    return { ok: false, note: `Reference URL did not respond (status ${res?.status ?? 'unreachable'}).` };
  }

  const ct = res.headers.get('content-type') || '';

  if (!/html/i.test(ct)) {
    return { ok: false, note: 'Reference URL is not an HTML page.' };
  }

  let html: string;

  try {
    const raw = await res.text();
    html = raw.slice(0, MAX_BODY_BYTES);
  } catch {
    return { ok: false, note: 'Could not read the reference URL body.' };
  }

  const structure = extractStructure(html);
  const summary = await summarizeDigest(structure, serverEnv);

  return {
    ok: true,
    digest: {
      url: url.toString(),
      ...structure,
      summary: summary || `Reference from ${url.hostname}.`,
    },
  };
}
