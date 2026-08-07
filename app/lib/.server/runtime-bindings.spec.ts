/**
 * The SSO settings must survive into the Worker runtime.
 *
 * `bindings.sh` does not carry a list of its own — it greps the names out of
 * `worker-configuration.d.ts` and forwards each one Wrangler-side. So deleting
 * a declaration there silently stops the secret reaching the Worker, with no
 * error anywhere.
 *
 * That used to degrade quietly to an unauthenticated Builder. Since
 * `requireBuilderAuth` now fails CLOSED in production, the same deletion would
 * instead 401 every real user — a visible outage rather than a silent hole.
 * Either way it is the declarations that hold it together, so they are pinned.
 *
 * Taken from PR #6 (codex/builder-sso-runtime-binding-20260731). That PR's
 * other half — the four declarations themselves — is already on main, so this
 * guard is the part still worth having.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());

describe('Nimbus Worker runtime bindings', () => {
  it('forwards every SSO setting used by the Worker into Wrangler', () => {
    const declarations = readFileSync(resolve(ROOT, 'worker-configuration.d.ts'), 'utf8');
    const bindingScript = readFileSync(resolve(ROOT, 'bindings.sh'), 'utf8');

    expect(bindingScript).toContain('worker-configuration.d.ts');

    for (const name of [
      'NIMBUS_SSO_SHARED_SECRET',
      'NIMBUS_SSO_DISABLED',
      'NIMBUS_SSO_COOKIE_DOMAIN',
      'NIMBUS_DASHBOARD_URL',
    ]) {
      expect(declarations).toMatch(new RegExp(`\\b${name}\\s*:`));
    }
  });
});
