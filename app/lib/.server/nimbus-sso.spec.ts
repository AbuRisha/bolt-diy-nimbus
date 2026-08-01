import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  NIMBUS_COOKIE_NAME,
  enforceNimbusAuth,
  isNimbusPublicPath,
  readNimbusSessionFromRequest,
  scopeNimbusEnvForRequest,
  type NimbusEnv,
} from './nimbus-sso';

const SECRET = 'test-only-shared-secret-with-enough-entropy';
const ENV: NimbusEnv = { NIMBUS_SSO_SHARED_SECRET: SECRET };

async function mintHandoff(audience = 'builder', lifetimeSeconds = 60, nimbusKey?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ email: 'builder@example.com', name: 'Builder User', nimbus_key: nimbusKey })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject('customer-123')
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeSeconds)
    .sign(new TextEncoder().encode(SECRET));
}

function cookieValue(setCookie: string): string {
  const pair = setCookie.split(';', 1)[0];
  return decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
}

describe('Nimbus Builder SSO boundary', () => {
  it('redirects a direct guest navigation to the Nimbus login handoff', async () => {
    const response = await enforceNimbusAuth(new Request('https://builder.nimbusapi.net/'), ENV);

    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe('https://nimbusapi.net/login?next=/dashboard/builder');
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns JSON 401 for unauthenticated API requests', async () => {
    const response = await enforceNimbusAuth(
      new Request('https://builder.nimbusapi.net/api/models', { headers: { Accept: 'application/json' } }),
      ENV,
    );

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toEqual({ error: 'nimbus_sso_required' });
  });

  it('fails closed when the shared secret binding is absent', async () => {
    const response = await enforceNimbusAuth(new Request('https://builder.nimbusapi.net/'), {});

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({ error: 'nimbus_sso_not_configured' });
  });

  it('allows only the explicit local-development escape hatch', async () => {
    const response = await enforceNimbusAuth(new Request('http://localhost:5173/'), {
      NIMBUS_SSO_DISABLED: 'true',
    });

    expect(response).toBeNull();
  });

  it('rejects a validly signed token for the chat audience', async () => {
    const token = await mintHandoff('chat');
    const response = await enforceNimbusAuth(
      new Request(`https://builder.nimbusapi.net/?nimbus_token=${encodeURIComponent(token)}`),
      ENV,
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe('https://nimbusapi.net/login?next=/dashboard/builder');
    expect(response?.headers.has('Set-Cookie')).toBe(false);
  });

  it('rejects handoffs whose lifetime exceeds the short-lived contract', async () => {
    const token = await mintHandoff('builder', 300);
    const response = await enforceNimbusAuth(
      new Request(`https://builder.nimbusapi.net/?nimbus_token=${encodeURIComponent(token)}`),
      ENV,
    );

    expect(response?.headers.get('Location')).toBe('https://nimbusapi.net/login?next=/dashboard/builder');
    expect(response?.headers.has('Set-Cookie')).toBe(false);
  });

  it('exchanges a valid Builder handoff for a secure host-only session', async () => {
    const token = await mintHandoff();
    const response = await enforceNimbusAuth(
      new Request(`https://builder.nimbusapi.net/?project=demo&nimbus_token=${encodeURIComponent(token)}`),
      ENV,
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe('/?project=demo');

    const setCookie = response?.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain(`${NIMBUS_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=28800');
    expect(setCookie).not.toContain('Domain=');
    expect(setCookie).not.toContain(token);

    const requestWithSession = new Request('https://builder.nimbusapi.net/chat/demo', {
      headers: { Cookie: `${NIMBUS_COOKIE_NAME}=${encodeURIComponent(cookieValue(setCookie))}` },
    });

    await expect(enforceNimbusAuth(requestWithSession, ENV)).resolves.toBeNull();

    const session = await readNimbusSessionFromRequest(requestWithSession, ENV);
    expect(session?.payload.sub).toBe('customer-123');
    expect(session?.payload.email).toBe('builder@example.com');
    expect(session?.payload.aud).toBe('builder-session');
  });

  it('does not accept the one-minute handoff JWT as a session cookie', async () => {
    const handoff = await mintHandoff();
    const request = new Request('https://builder.nimbusapi.net/', {
      headers: { Cookie: `${NIMBUS_COOKIE_NAME}=${encodeURIComponent(handoff)}` },
    });

    const response = await enforceNimbusAuth(request, ENV);
    expect(response?.status).toBe(302);
    expect(response?.headers.get('Location')).toBe('https://nimbusapi.net/login?next=/dashboard/builder');
  });

  it('strips the shared reseller key from authenticated customer requests without a delegation', async () => {
    const token = await mintHandoff();
    const exchange = await enforceNimbusAuth(
      new Request(`https://builder.nimbusapi.net/?nimbus_token=${encodeURIComponent(token)}`),
      ENV,
    );
    const sessionToken = cookieValue(exchange?.headers.get('Set-Cookie') ?? '');
    const request = new Request('https://builder.nimbusapi.net/api/chat', {
      headers: { Cookie: `${NIMBUS_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });

    const scoped = await scopeNimbusEnvForRequest(request, { ...ENV, NIMBUS_API_KEY: 'shared-master-key' });
    expect(scoped.NIMBUS_API_KEY).toBeUndefined();
  });

  it('injects only the signed customer delegation into the Remix request environment', async () => {
    const token = await mintHandoff('builder', 60, 'customer-delegation-key');
    const exchange = await enforceNimbusAuth(
      new Request(`https://builder.nimbusapi.net/?nimbus_token=${encodeURIComponent(token)}`),
      ENV,
    );
    const sessionToken = cookieValue(exchange?.headers.get('Set-Cookie') ?? '');
    const request = new Request('https://builder.nimbusapi.net/api/chat', {
      headers: { Cookie: `${NIMBUS_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` },
    });

    const scoped = await scopeNimbusEnvForRequest(request, { ...ENV, NIMBUS_API_KEY: 'shared-master-key' });
    expect(scoped.NIMBUS_API_KEY).toBe('customer-delegation-key');
  });

  it('keeps health and static Builder assets public', () => {
    expect(isNimbusPublicPath('/api/health')).toBe(true);
    expect(isNimbusPublicPath('/mascot/nimbus-companion.png')).toBe(true);
    expect(isNimbusPublicPath('/brand/builder-hero-atelier.png')).toBe(true);
    expect(isNimbusPublicPath('/api/models')).toBe(false);
    expect(isNimbusPublicPath('/chat/demo')).toBe(false);
  });
});
