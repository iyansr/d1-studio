// Fails when the built UI (dist/ui, before gzip) is over budget (plan 02
// exit criteria), leaving room under the 3 MB package budget.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const BUDGET = 1.5 * 1024 * 1024;
const dir = path.resolve(import.meta.dirname, '..', 'dist', 'ui');

function size(target) {
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(target).reduce((sum, name) => sum + size(path.join(target, name)), 0);
}

const bytes = size(dir);
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`dist/ui: ${mb(bytes)} of ${mb(BUDGET)}`);
if (bytes > BUDGET) {
  console.error('The UI bundle is over budget.');
  process.exit(1);
}
