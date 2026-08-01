import { describe, expect, it } from 'vitest';
import { onRequest } from './[[path]]';

describe('Docker Wrangler request boundary', () => {
  it('returns 401 for unauthenticated /api/models before Remix resource routing', async () => {
    const response = await onRequest({
      request: new Request('https://builder.nimbusapi.net/api/models'),
      env: { NIMBUS_SSO_SHARED_SECRET: 'test-only-shared-secret' },
    } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'nimbus_sso_required' });
  });
});
