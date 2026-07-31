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
