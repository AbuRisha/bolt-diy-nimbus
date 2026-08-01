/**
 * Black-box SSO smoke test for the same Wrangler Pages request path launched
 * by the production Docker image. Point it at a local container or a
 * zero-traffic ACA revision URL; it intentionally uses no credentials.
 */
const baseUrl = (process.argv[2] || process.env.BUILDER_RUNTIME_BASE_URL || '').replace(/\/$/, '');

if (!baseUrl) {
  throw new Error('Usage: node scripts/test-builder-sso-runtime.mjs <base-url>');
}

async function request(path) {
  return fetch(`${baseUrl}${path}`, { redirect: 'manual' });
}

const apiResponse = await request('/api/models');
const apiBody = await apiResponse.json();

if (apiResponse.status !== 401 || apiBody?.error !== 'nimbus_sso_required') {
  throw new Error(`/api/models expected 401 nimbus_sso_required, got ${apiResponse.status} ${JSON.stringify(apiBody)}`);
}

for (const path of ['/', '/chat/direct-guest', '/git']) {
  const response = await request(path);
  const location = response.headers.get('location');

  if (response.status !== 302 || location !== 'https://nimbusapi.net/login?next=/dashboard/builder') {
    throw new Error(`${path} expected exact Nimbus login redirect, got ${response.status} ${location}`);
  }
}

const healthResponse = await request('/api/health');

if (healthResponse.status !== 200) {
  throw new Error(`/api/health expected 200, got ${healthResponse.status}`);
}

console.log('Builder Docker-runtime SSO smoke passed: API 401, document redirects, health 200.');
