import { json } from '@remix-run/cloudflare';
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import { requireBuilderAuth } from '~/lib/.server/nimbus-sso';
import { isAllowedUrl, safeFetch } from '~/utils/url';

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

// Handle all HTTP methods
export async function action({ request, context, params }: ActionFunctionArgs) {
  // Route-level auth — SSO lived in the page loader only, so calling this
  // route directly skipped it. See requireBuilderAuth in lib/.server/nimbus-sso.
  {
    const denied = await requireBuilderAuth(request, context);

    if (denied) {
      return denied;
    }
  }

  return handleProxyRequest(request, params['*']);
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  return handleProxyRequest(request, params['*']);
}

async function handleProxyRequest(request: Request, path: string | undefined) {
  try {
    if (!path) {
      return json({ error: 'Invalid proxy URL format' }, { status: 400 });
    }

    // Handle CORS preflight request
    if (request.method === 'OPTIONS') {
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
     * The domain comes straight out of the request path and was fetched
     * unvalidated, which is a proxy pointed at whatever the caller names —
     * `/api/git-proxy/<internal-host>/...` included. Gating this route behind
     * a session (done earlier in this branch) limits who can ask; it does not
     * make the target safe.
     *
     * The `https://` prefix is not a control either: it rules out Azure IMDS,
     * which is HTTP-only, but leaves every internal HTTPS service reachable.
     */
    if (!isAllowedUrl(targetURL)) {
      return json({ error: 'Blocked target' }, { status: 400 });
    }

    console.log('Target URL:', targetURL);

    // Filter and prepare headers
    const headers = new Headers();

    // Only forward allowed headers
    for (const header of ALLOW_HEADERS) {
      if (request.headers.has(header)) {
        headers.set(header, request.headers.get(header)!);
      }
    }

    // Set the host header
    headers.set('Host', domain);

    // Set Git user agent if not already present
    if (!headers.has('user-agent') || !headers.get('user-agent')?.startsWith('git/')) {
      headers.set('User-Agent', 'git/@isomorphic-git/cors-proxy');
    }

    console.log('Request headers:', Object.fromEntries(headers.entries()));

    // Prepare fetch options
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
      redirect: 'follow',
    };

    // Add body for non-GET/HEAD requests
    if (!['GET', 'HEAD'].includes(request.method)) {
      fetchOptions.body = request.body;
      fetchOptions.duplex = 'half';

      /*
       * Note: duplex property is removed to ensure TypeScript compatibility
       * across different environments and versions
       */
    }

    // Forward the request to the target URL
    // safeFetch: a git host answering 302 toward internal space must not be followed blindly.
    const response = await safeFetch(targetURL, fetchOptions);

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
    if (response.redirected) {
      responseHeaders.set('x-redirected-url', response.url);
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
