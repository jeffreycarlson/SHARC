#!/usr/bin/env node
/**
 * Ensures CI runs the canonical dist-based test suite.
 *
 * The durable contract is: PR CI must execute `npm run test:all:built`.
 * If maintainers later expand that package script, CI automatically inherits
 * the new suite instead of drifting behind local verification.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

if (!pkg.scripts?.['test:all:built']) {
  console.error('package.json is missing scripts.test:all:built');
  process.exit(1);
}

const steps = workflow.split(/\n(?=      - name: )/);
const testAllBuiltStep = steps.find((step) => {
  const lines = step.split('\n').map((line) => line.trim());
  const runLine = lines.find((line) => line.startsWith('run:'));
  const ifLine = lines.find((line) => line.startsWith('if:'));
  return runLine === 'run: npm run test:all:built'
    && ifLine !== 'if: false'
    && ifLine !== 'if: ${{ false }}';
});

if (!testAllBuiltStep) {
  console.error(
    'CI must include an active step whose run command is exactly '
    + '`npm run test:all:built` so future suite additions cannot drift out of PR gating.'
  );
  process.exit(1);
}

const expectedSuites = [...pkg.scripts['test:all:built'].matchAll(/npm run (test:[\w:-]+)/g)]
  .map((match) => match[1]);

if (expectedSuites.length === 0) {
  console.error('scripts.test:all:built does not contain any npm test invocations.');
  process.exit(1);
}

const missingScripts = expectedSuites.filter((suite) => !pkg.scripts[suite]);
if (missingScripts.length > 0) {
  console.error('scripts.test:all:built references missing package scripts:');
  for (const suite of missingScripts) {
    console.error(`  - ${suite}`);
  }
  process.exit(1);
}

console.log(`OK. CI runs test:all:built (${expectedSuites.length} suites).`);
