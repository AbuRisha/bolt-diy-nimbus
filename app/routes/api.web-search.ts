import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs } from '@remix-run/cloudflare';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';
import { safeFetch, validateExternalUrl } from '~/lib/.server/url-guard';

const MAX_CONTENT_LENGTH = 8000;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

function extractMetaDescription(html: string): string {
  const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i);

  if (match) {
    return match[1].trim();
  }

  // Try reverse attribute order
  const altMatch = html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);

  return altMatch ? altMatch[1].trim() : '';
}

function extractTextContent(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  /*
   * Auth guard: resource routes never run the _index page loader, so the SSO
   * check there does not apply here. This route fetches a caller-supplied URL
   * server-side, so it must be gated before the body is parsed and before any
   * outbound request. Kept outside the try/catch below so a 401 can never be
   * downgraded into the catch-all error response.
   */
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  try {
    const { url } = (await request.json()) as { url?: string };

    if (!url || typeof url !== 'string') {
      return json({ error: 'URL is required' }, { status: 400 });
    }

    /*
     * SSRF guard: authentication alone does not stop an authenticated caller
     * from pointing this at loopback, RFC1918 space or the cloud metadata
     * endpoint, so validate the destination before fetching it.
     */
    const validated = validateExternalUrl(url);

    if (!validated.ok) {
      return json({ error: validated.reason, code: validated.code }, { status: 400 });
    }

    /*
     * safeFetch re-validates every redirect hop: a permitted host is free to
     * answer with a 302 pointing at a private address.
     */
    const result = await safeFetch(
      validated.url,
      {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(10_000),
      },
      { maxRedirects: 5 },
    );

    if (!result.ok) {
      return json({ error: result.rejection.reason, code: result.rejection.code }, { status: 400 });
    }

    const { response } = result;

    if (!response.ok) {
      return json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` }, { status: 502 });
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return json({ error: 'URL must point to an HTML or text page' }, { status: 400 });
    }

    const html = await response.text();
    const title = extractTitle(html);
    const description = extractMetaDescription(html);
    const content = extractTextContent(html);

    return json({
      success: true,
      data: {
        title,
        description,
        content: content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) + '...' : content,
        sourceUrl: url,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return json({ error: 'Request timed out after 10 seconds' }, { status: 504 });
    }

    console.error('Web search error:', error);

    return json({ error: error instanceof Error ? error.message : 'Failed to fetch URL' }, { status: 500 });
  }
}
