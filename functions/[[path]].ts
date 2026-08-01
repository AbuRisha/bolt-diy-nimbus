import type { ServerBuild } from '@remix-run/cloudflare';
import { createPagesFunctionHandler } from '@remix-run/cloudflare-pages';
import {
  enforceNimbusAuth,
  isNimbusPublicPath,
  resolveNimbusEnv,
  scopeNimbusEnvForRequest,
} from '../app/lib/.server/nimbus-sso';

export const onRequest: PagesFunction = async (context) => {
  const pathname = new URL(context.request.url).pathname;
  let requestContext = context;

  if (!isNimbusPublicPath(pathname)) {
    const env = resolveNimbusEnv(context.env);
    const authResponse = await enforceNimbusAuth(context.request, env);

    if (authResponse) {
      return authResponse;
    }

    requestContext = {
      ...context,
      env: await scopeNimbusEnvForRequest(context.request, env),
    };
  }

  const serverBuild = (await import('../build/server')) as unknown as ServerBuild;

  const handler = createPagesFunctionHandler({
    build: serverBuild,
  });

  return handler(requestContext);
};
