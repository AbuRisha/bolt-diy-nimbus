// TEMPORARY MUTATION PROBE — deleted immediately after the run. Not committed.
// Guard present and correctly placed outside try/catch, but AFTER an upstream call.
import { json, type LoaderFunctionArgs } from '@remix-run/cloudflare';
import { resolveNimbusEnv, requireBuilderAuth } from '~/lib/.server/nimbus-sso';

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const upstream = await fetch('https://api.nimbusapi.net/v1/models');

  const env = resolveNimbusEnv(context?.cloudflare?.env);
  const denied = await requireBuilderAuth(request, env);

  if (denied) {
    return denied;
  }

  return json({ ok: upstream.ok });
};
