import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/cloudflare';
import {
  getNimbusApiKey,
  getNimbusUpstreamBase,
  isNimbusSsoDisabled,
  readNimbusSessionFromRequest,
  resolveNimbusEnv,
} from '~/lib/.server/nimbus-sso';
import { createScopedLogger } from '~/utils/logger';
import { requireBuilderAuth } from '~/lib/.server/nimbus-sso';

const logger = createScopedLogger('api.nimbus-proxy');

/**
 * Headers we never forward (either hop-by-hop per RFC 7230 or leak-prone).
 */
const REQUEST_STRIP_HEADERS = new Set<string>([
  'authorization',
  'cookie',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const RESPONSE_STRIP_HEADERS = new Set<string>([
  'connection',
  'content-length',
  'content-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type ProxyArgs = LoaderFunctionArgs | ActionFunctionArgs;

/**
 * Same-origin passthrough to `api.nimbusapi.net/v1/*`.
 *
 * Requirements enforced:
 *   - Requires a valid Nimbus session cookie (unless NIMBUS_SSO_DISABLED=true).
 *   - Never trusts the client `Authorization` header — injects the resolved
 *     upstream key server-side (per-session token if the JWT carried one,
 *     otherwise NIMBUS_API_KEY).
 *   - Strips the browser's own cookies so the session cookie never leaks
 *     upstream.
 *   - Streams the response body back untouched (works for
 *     text/event-stream chat completions).
 *
 * Called as `/api/nimbus-proxy/chat/completions`, `/api/nimbus-proxy/models`,
 * etc. This is the browser-safe path — server-side code (Remix loaders /
 * actions, the streamText pipeline) should keep calling the upstream directly
 * so we don't recursively self-fetch.
 */
async function handleProxy({ request, context, params }: ProxyArgs): Promise<Response> {
  const env = resolveNimbusEnv((context as any)?.cloudflare?.env);
  const session = await readNimbusSessionFromRequest(request, env);
  const ssoDisabled = isNimbusSsoDisabled(env);

  if (!ssoDisabled && !session) {
    return json({ error: 'nimbus_sso_required' }, 401, {
      'WWW-Authenticate': 'NimbusSSO realm="builder.nimbusapi.net"',
    });
  }

  const apiKey = getNimbusApiKey(env, session);

  if (!apiKey) {
    /*
     * The session carries no per-customer key. This is not a server fault and
     * must not be answered with one: billing this request to the container key
     * would charge the operator for a customer's inference, which is exactly
     * the fallback removed from getNimbusApiKey.
     *
     * The fix is a fresh handoff — the dashboard resolves the customer's own
     * key and embeds it when it mints the session — so say that.
     */
    logger.error('No per-customer key on the session; refusing to bill the operator key.');

    return json(
      {
        error: 'nimbus_customer_key_required',
        message: 'Your session has no Nimbus API key attached. Sign in again from the dashboard to refresh it.',
      },
      401,
    );
  }

  const upstreamBase = getNimbusUpstreamBase(env);
  const rawSuffix = (params as Record<string, string | undefined>)['*'] ?? '';
  const suffix = rawSuffix.replace(/^\/+/, '');

  const incoming = new URL(request.url);
  const targetUrl = `${upstreamBase}/${suffix}${incoming.search}`;

  const outboundHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (REQUEST_STRIP_HEADERS.has(key.toLowerCase())) {
      return;
    }

    outboundHeaders.set(key, value);
  });
  outboundHeaders.set('Authorization', `Bearer ${apiKey}`);
  outboundHeaders.set('Accept-Encoding', 'identity');

  const init: RequestInit = {
    method: request.method,
    headers: outboundHeaders,
    redirect: 'manual',
  };

  const methodAllowsBody = !['GET', 'HEAD'].includes(request.method.toUpperCase());

  if (methodAllowsBody) {
    init.body = request.body;

    // Required by undici/workerd for streaming request bodies.
    (init as RequestInit & { duplex?: 'half' }).duplex = 'half';
  }

  let upstream: Response;

  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    logger.error('Upstream fetch failed', { targetUrl, err });
    return json({ error: 'nimbus_upstream_unreachable' }, 502);
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (RESPONSE_STRIP_HEADERS.has(key.toLowerCase())) {
      return;
    }

    responseHeaders.set(key, value);
  });

  // Per-user responses must never end up in a shared cache.
  responseHeaders.set('Cache-Control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export async function loader(args: LoaderFunctionArgs) {
  /*
   * Route-level auth — SSO lived in the page loader only, so calling this
   * route directly skipped it. See requireBuilderAuth in lib/.server/nimbus-sso.
   */
  {
    const denied = await requireBuilderAuth(args.request, args.context);

    if (denied) {
      return denied;
    }
  }

  return handleProxy(args);
}

export async function action(args: ActionFunctionArgs) {
  return handleProxy(args);
}
