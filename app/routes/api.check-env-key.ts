import type { LoaderFunction } from '@remix-run/cloudflare';
import { LLMManager } from '~/lib/modules/llm/manager';
import { getApiKeysFromCookie } from '~/lib/api/cookies';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

/**
 * Answers "is this provider's key configured?" with a boolean only — never a
 * value. Still guarded, because an unauthenticated caller should not be able
 * to enumerate which providers this deployment has provisioned.
 */
export const loader: LoaderFunction = async ({ context, request }) => {
  const nimbusEnv = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, nimbusEnv);

  if (denied) {
    return denied;
  }

  const url = new URL(request.url);
  const provider = url.searchParams.get('provider');

  if (!provider) {
    return Response.json({ isSet: false });
  }

  const llmManager = LLMManager.getInstance(context?.cloudflare?.env as any);
  const providerInstance = llmManager.getProvider(provider);

  if (!providerInstance || !providerInstance.config.apiTokenKey) {
    return Response.json({ isSet: false });
  }

  const envVarName = providerInstance.config.apiTokenKey;

  // Get API keys from cookie
  const cookieHeader = request.headers.get('Cookie');
  const apiKeys = getApiKeysFromCookie(cookieHeader);

  /*
   * Check API key in order of precedence:
   * 1. Client-side API keys (from cookies)
   * 2. Server environment variables (from Cloudflare env)
   * 3. Process environment variables (from .env.local)
   * 4. LLMManager environment variables
   */
  const isSet = !!(
    apiKeys?.[provider] ||
    (context?.cloudflare?.env as Record<string, any>)?.[envVarName] ||
    process.env[envVarName] ||
    llmManager.env[envVarName]
  );

  return Response.json({ isSet }, { headers: { 'Cache-Control': 'no-store' } });
};
