/**
 * test-ci-test-all-built-parity.js — structural CI parity guard coverage.
 *
 * The guard protects the release contract that PR CI actually gates on the
 * canonical `npm run test:all:built` suite. These fixtures exercise the
 * bypass classes found during the #285 review loop.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const guard = resolve(root, 'scripts/check-ci-test-all-built-parity.js');
const fixtures = resolve(__dirname, 'fixtures');

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

function runGuard(workflowPath, env = {}) {
  return spawnSync(process.execPath, [guard, '--workflow', workflowPath], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function runGuardFromEnv(workflowPath) {
  return spawnSync(process.execPath, [guard], {
    cwd: root,
    env: { ...process.env, SHARC_CI_WORKFLOW_PATH: workflowPath },
    encoding: 'utf8',
  });
}

console.log('test-ci-test-all-built-parity.js — structural CI parity guard\n');

const positives = [
  ['current repository CI workflow', resolve(root, '.github/workflows/ci.yml')],
  ['valid fixture with pull_request main trigger', resolve(fixtures, 'ci-parity-valid.yml')],
  ['commented-out # if: false does not count as an active gate', resolve(fixtures, 'ci-parity-commented-if.yml')],
];

for (const [label, workflowPath] of positives) {
  const result = runGuard(workflowPath);
  assert(result.status === 0, `${label} passes`);
}

const envResult = runGuardFromEnv(resolve(fixtures, 'ci-parity-valid.yml'));
assert(envResult.status === 0, 'SHARC_CI_WORKFLOW_PATH selects a fixture workflow');

const negatives = [
  [
    'step-level expression if: is rejected',
    'ci-parity-step-if-expression.yml',
    /must not gate npm run test:all:built behind an if: clause/,
  ],
  [
    'step-level never-happens if: is rejected',
    'ci-parity-step-if-never.yml',
    /must not gate npm run test:all:built behind an if: clause/,
  ],
  [
    'job-level if: is rejected',
    'ci-parity-job-if.yml',
    /CI job build-and-test must not gate npm run test:all:built behind an if: clause/,
  ],
  [
    'continue-on-error: true is rejected',
    'ci-parity-continue-on-error.yml',
    /must not use continue-on-error: true/,
  ],
  [
    'missing pull_request trigger is rejected',
    'ci-parity-missing-pr-trigger.yml',
    /must include a pull_request trigger/,
  ],
  [
    'pull_request branches without main is rejected',
    'ci-parity-pr-not-main.yml',
    /must include the main branch/,
  ],
  [
    'pull_request branches-ignore main is rejected',
    'ci-parity-pr-ignores-main.yml',
    /must not ignore the main branch/,
  ],
];

for (const [label, filename, expected] of negatives) {
  const result = runGuard(resolve(fixtures, filename));
  const output = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, `${label}: exits non-zero`);
  assert(expected.test(output), `${label}: diagnostic matches`);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} CI parity assertion(s) failed.`);
  process.exit(1);
}

console.log('\n✓ All CI parity guard assertions passed.');
