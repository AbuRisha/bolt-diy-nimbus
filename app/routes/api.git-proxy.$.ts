import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';
import { safeFetch, validateExternalUrl, urlGuardErrorResponse } from '~/lib/.server/url-guard';

// Allowed headers to forward to the target server
const ALLOW_HEADERS = [
  'accept-encoding',
  'accept-language',
  'accept',
  'access-control-allow-origin',
  'authorization',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'dnt',
  'pragma',
  'range',
  'referer',
  'user-agent',
  'x-authorization',
  'x-http-method-override',
  'x-requested-with',
];

// Headers to expose from the target server's response
const EXPOSE_HEADERS = [
  'accept-ranges',
  'age',
  'cache-control',
  'content-length',
  'content-language',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'pragma',
  'server',
  'transfer-encoding',
  'vary',
  'x-github-request-id',
  'x-redirected-url',
];

function corsPreflightResponse() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': ALLOW_HEADERS.join(', '),
      'Access-Control-Expose-Headers': EXPOSE_HEADERS.join(', '),
      'Access-Control-Max-Age': '86400',
    },
  });
}

// Handle all HTTP methods
export async function action({ request, params, context }: ActionFunctionArgs) {
  /*
   * CORS preflight stays ungated on purpose: browsers send OPTIONS without
   * credentials and it returns no data. Everything else is gated below.
   */
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse();
  }

  /*
   * Auth guard: resource routes never run the _index page loader, so the SSO
   * check there does not apply here. This route is a server-side fetch proxy,
   * so it must be gated before the destination is built or contacted. Kept
   * outside handleProxyRequest's try/catch so a 401 can never be downgraded
   * into the catch-all error response.
   */
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  return handleProxyRequest(request, params['*']);
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse();
  }

  // Same guard as `action` — see the comment there.
  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  return handleProxyRequest(request, params['*']);
}

async function handleProxyRequest(request: Request, path: string | undefined) {
  try {
    if (!path) {
      return json({ error: 'Invalid proxy URL format' }, { status: 400 });
    }

    // Extract domain and remaining path
    const parts = path.match(/([^\/]+)\/?(.*)/);

    if (!parts) {
      return json({ error: 'Invalid path format' }, { status: 400 });
    }

    const domain = parts[1];
    const remainingPath = parts[2] || '';

    // Reconstruct the target URL with query parameters
    const url = new URL(request.url);
    const targetURL = `https://${domain}/${remainingPath}${url.search}`;

    /*
     * SSRF guard: the destination is fully caller-controlled, so an
     * authenticated caller could otherwise point this proxy at loopback,
     * RFC1918 space or the cloud metadata endpoint. Validate before any
     * outbound request is made.
     */
    const validated = validateExternalUrl(targetURL);

    if (!validated.ok) {
      return urlGuardErrorResponse(validated);
    }

    const target = validated.url;

    console.log('Target URL:', target.toString());

    // Filter and prepare headers
    const headers = new Headers();

    // Only forward allowed headers
    for (const header of ALLOW_HEADERS) {
      if (request.headers.has(header)) {
        headers.set(header, request.headers.get(header)!);
      }
    }

    // Set the host header from the validated target, never from the raw input
    headers.set('Host', target.host);

    // Set Git user agent if not already present
    if (!headers.has('user-agent') || !headers.get('user-agent')?.startsWith('git/')) {
      headers.set('User-Agent', 'git/@isomorphic-git/cors-proxy');
    }

    /*
     * Deliberately not logging the forwarded header set: ALLOW_HEADERS
     * includes `authorization`, and dumping it would write the caller's
     * credential into the server log.
     */

    // Prepare fetch options
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
    };

    const hasBody = !['GET', 'HEAD'].includes(request.method);

    // Add body for non-GET/HEAD requests
    if (hasBody) {
      fetchOptions.body = request.body;
      fetchOptions.duplex = 'half';

      /*
       * Note: duplex property is removed to ensure TypeScript compatibility
       * across different environments and versions
       */
    }

    /*
     * Forward the request. Redirects are never followed blindly — safeFetch
     * re-validates every hop, because a permitted host can answer with a 302
     * pointing at a private address. Bodied requests are not auto-followed
     * since a streamed body cannot be replayed on the next hop; the validated
     * 3xx is handed back to the caller instead.
     */
    const result = await safeFetch(target, fetchOptions, { followRedirects: !hasBody });

    if (!result.ok) {
      return urlGuardErrorResponse(result.rejection);
    }

    const { response, finalUrl, redirected } = result;

    console.log('Response status:', response.status);

    // Create response headers
    const responseHeaders = new Headers();

    // Add CORS headers
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', ALLOW_HEADERS.join(', '));
    responseHeaders.set('Access-Control-Expose-Headers', EXPOSE_HEADERS.join(', '));

    // Copy exposed headers from the target response
    for (const header of EXPOSE_HEADERS) {
      // Skip content-length as we'll use the original response's content-length
      if (header === 'content-length') {
        continue;
      }

      if (response.headers.has(header)) {
        responseHeaders.set(header, response.headers.get(header)!);
      }
    }

    // If the response was redirected, add the x-redirected-url header
    if (redirected) {
      responseHeaders.set('x-redirected-url', finalUrl);
    }

    console.log('Response headers:', Object.fromEntries(responseHeaders.entries()));

    // Return the response with the target's body stream piped directly
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return json(
      {
        error: 'Proxy error',
        message: error instanceof Error ? error.message : 'Unknown error',
        url: path ? `https://${path}` : 'Invalid URL',
      },
      { status: 500 },
    );
  }
}
