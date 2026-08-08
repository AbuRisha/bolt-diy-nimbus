import { json, redirect, type LoaderFunctionArgs, type MetaFunction } from '@remix-run/cloudflare';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import {
  NIMBUS_TOKEN_PARAM,
  buildNimbusDashboardRedirect,
  getNimbusSharedSecret,
  isNimbusSsoDisabled,
  readNimbusSessionFromRequest,
  resolveNimbusEnv,
  serializeNimbusSessionCookie,
  mintNimbusSessionToken,
  fetchCustomerApiKey,
  fetchNimbusAccount,
  type NimbusJwtPayload,
  verifyNimbusToken,
} from '~/lib/.server/nimbus-sso';

export const meta: MetaFunction = () => {
  return [
    { title: 'Nimbus Builder' },
    {
      name: 'description',
      content: 'Nimbus Builder - prompt, run, edit, and deploy full-stack apps with Nimbus AI.',
    },
  ];
};

/**
 * Root loader — SSO gate.
 *
 * Accepts three inputs, in order of preference:
 *   1. `?nimbus_token=<HS256 JWT>` on the URL. Verified against
 *      NIMBUS_SSO_SHARED_SECRET, persisted as a first-party cookie, then the
 *      caller is redirected to the same path with the token stripped.
 *   2. An existing `nimbus_session` cookie (either minted here or issued by
 *      the dashboard under Domain=.nimbusapi.net).
 *   3. No credentials — hand off to nimbusapi.net/dashboard?next=builder so
 *      the dashboard can mint a token and bounce the user back here.
 *
 * NIMBUS_SSO_DISABLED=true (or a missing shared secret) short-circuits the
 * gate so local `pnpm dev` and CI don't require a live dashboard.
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const env = resolveNimbusEnv((context as any)?.cloudflare?.env);
  const secret = getNimbusSharedSecret(env);


  // Escape hatch for local dev / CI. Also self-heals when the container was
  // deployed without a shared secret so the app doesn't hard-redirect-loop.
  if (isNimbusSsoDisabled(env) || !secret) {
    return json({
      nimbusSso: {
        enabled: false,
        subject: null as string | null,
        email: null as string | null,
      },
    });
  }

  const url = new URL(request.url);
  const bootstrapToken = url.searchParams.get(NIMBUS_TOKEN_PARAM);

  // Step 1 — trade a bootstrap token for a cookie and clean the URL.
  if (bootstrapToken) {
    const verified = await verifyNimbusToken(bootstrapToken, secret);

    if (verified) {
      url.searchParams.delete(NIMBUS_TOKEN_PARAM);

      const target = `${url.pathname}${url.search}${url.hash}` || '/';

      // Do NOT store the bootstrap token as the session. It lives 60 seconds by
      // design (it is a hand-off credential, short so a copied URL is dead on
      // arrival), and serializeNimbusSessionCookie clamps Max-Age to the token's
      // own exp - so the session would expire a minute after sign-in and bounce
      // the user back to the dashboard, forever. Mint a real session instead.
      // Resolve the customer's OWN api key once, at handoff, and carry it in
      // the session cookie. Their usage then bills to their balance instead of
      // the shared container key. Once per session, never per request.
      const ownKey = await fetchCustomerApiKey(
        typeof verified.payload.sub === 'string' ? verified.payload.sub : undefined,
        env,
      );
      const sessionToken = await mintNimbusSessionToken(
        { ...(verified.payload as NimbusJwtPayload), nimbus_key: ownKey },
        secret,
      );

      return redirect(target, {
        headers: {
          'Set-Cookie': serializeNimbusSessionCookie(sessionToken, env),
        },
      });
    }

    // A bad/expired token behaves like no token — fall through to the cookie
    // check, then to the dashboard hand-off.
  }

  // Step 2 — honor an existing signed cookie (either ours or the dashboard's).
  const session = await readNimbusSessionFromRequest(request, env);

  if (session) {
    /*
     * Balance and Builder-scoped spend, so the UI can show what the customer is
     * signed in as and what Builder has cost them. Never throws — fetchNimbusAccount
     * returns `configured: false` on any failure, which the UI renders as
     * "unavailable" rather than as a zero balance.
     */
    const account = await fetchNimbusAccount(
      (session.payload.sub as string | undefined) ?? undefined,
      env,
    );

    return json({
      nimbusSso: {
        enabled: true,
        subject: (session.payload.sub as string | undefined) ?? null,
        email: (session.payload.email as string | undefined) ?? null,
      },
      nimbusAccount: account,
    });
  }

  // Step 3 — no valid credentials. Hand off to the dashboard SSO mint flow.
  return redirect(buildNimbusDashboardRedirect(env, 'builder'));
}

/**
 * Landing page component for Bolt
 * Note: Settings functionality should ONLY be accessed through the sidebar menu.
 * Do not add settings button/panel to this landing page as it was intentionally removed
 * to keep the UI clean and consistent with the design system.
 */
export default function Index() {
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>
    </div>
  );
}
