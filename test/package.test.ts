import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package contract', () => {
  expect(pkg.name).toBe('@iyansr/d1-studio');
  expect(pkg.type).toBe('module');
  expect(pkg.bin).toEqual({ 'd1-studio': 'dist/cli.js' });
  expect(pkg.files).toEqual(['dist']);
  expect(pkg.engines).toEqual({ node: '>=22.16' });
  expect(pkg.publishConfig).toEqual({ access: 'public' });
  // D7: everything is bundled into dist/.
  expect(pkg.dependencies ?? {}).toEqual({});
});
