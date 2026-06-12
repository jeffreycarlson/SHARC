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

function runOrphanGuard(pkgPath, testDir, { allowlist = null, workflow = null } = {}) {
  const argv = [
    guard,
    '--workflow', workflow || resolve(fixtures, 'ci-parity-valid.yml'),
    '--pkg', pkgPath,
    '--test-dir', testDir,
  ];
  if (allowlist) {
    argv.push('--allowlist', allowlist);
  }
  return spawnSync(process.execPath, argv, {
    cwd: root,
    env: { ...process.env },
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
  // The current ci.yml positive above also exercises the prod-build-leg
  // invariant's happy path: its build-and-test-prod job runs build:prod
  // followed by an active test:all:built step.
  ['a deliberately-bypassed (job-level if:) build:prod job is out of scope', resolve(fixtures, 'ci-parity-prod-build-bypassed-job.yml')],
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
    'multiple canonical steps with one gated shadow step is rejected',
    'ci-parity-multiple-canonical-steps.yml',
    /must not gate npm run test:all:built behind an if: clause/,
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
  // Prod-build-leg invariant (#383 / PR #384 review): build:prod may never go
  // untested. The exploit shape — deleting the prod job's test step while the
  // dev job's canonical step keeps the existence check green — must now fail.
  [
    'a build:prod job missing its test:all:built step is rejected',
    'ci-parity-prod-build-untested.yml',
    /CI job build-and-test-prod runs `npm run build:prod`.*without a later/,
  ],
  // A conditioned prod test step fails via the forward per-step bypass check
  // (any canonical step carrying an if: is rejected), so the prod build
  // cannot hide behind a step that only sometimes runs.
  [
    'a build:prod job whose test:all:built step is if-conditioned is rejected',
    'ci-parity-prod-build-test-bypassed.yml',
    /must not gate npm run test:all:built behind an if: clause/,
  ],
  // Ordering is enforced: a test step BEFORE build:prod tests the previous
  // bundle, not the prod one, so it does not satisfy the invariant.
  [
    'a test:all:built step BEFORE build:prod is rejected',
    'ci-parity-prod-build-test-before.yml',
    /CI job build-and-test-prod runs `npm run build:prod`.*without a later/,
  ],
];

for (const [label, filename, expected] of negatives) {
  const result = runGuard(resolve(fixtures, filename));
  const output = `${result.stdout}\n${result.stderr}`;
  assert(result.status !== 0, `${label}: exits non-zero`);
  assert(expected.test(output), `${label}: diagnostic matches`);
}

// Reverse-direction orphan guard: every test/node/test-*.js must be wired
// into the test:all:built chain (or explicitly allowlisted).
const orphanPkg = resolve(fixtures, 'orphan-pkg.json');

const wiredResult = runOrphanGuard(orphanPkg, resolve(fixtures, 'orphan-wired/test-node'));
assert(wiredResult.status === 0, 'wired test files pass the orphan guard');

const orphanResult = runOrphanGuard(orphanPkg, resolve(fixtures, 'orphan-unwired/test-node'));
const orphanOutput = `${orphanResult.stdout}\n${orphanResult.stderr}`;
assert(orphanResult.status !== 0, 'an orphaned test-*.js fails the orphan guard');
assert(/test-orphan\.js/.test(orphanOutput), 'orphan guard names the offending file');

const allowlistedResult = runOrphanGuard(
  orphanPkg,
  resolve(fixtures, 'orphan-allowlisted/test-node'),
  { allowlist: 'test-orphan.js' },
);
assert(
  allowlistedResult.status === 0,
  'an orphaned-but-allowlisted test-*.js passes the orphan guard',
);

// Transitive recursion: a file wired only via a NESTED test:* script (root
// chains to test:group, which runs test-nested.js) must be treated as wired.
const nestedPkg = resolve(fixtures, 'orphan-nested-pkg.json');
const nestedResult = runOrphanGuard(nestedPkg, resolve(fixtures, 'orphan-nested/test-node'));
const nestedOutput = `${nestedResult.stdout}\n${nestedResult.stderr}`;
assert(
  nestedResult.status === 0,
  'a file wired via a nested test:* script passes the orphan guard (collectChained recursion)',
);
assert(
  !/test-nested\.js/.test(nestedOutput),
  'the nested-wired file is not reported as an orphan',
);

// Reverse-harvest bypass filtering: a `npm run test:*` referenced only by a
// BYPASSED workflow step does not reliably gate, so the reverse harvest must
// NOT count its test file as wired. The file must surface as an orphan.
const bypassPkg = resolve(fixtures, 'orphan-bypass-pkg.json');

const coeResult = runOrphanGuard(
  bypassPkg,
  resolve(fixtures, 'orphan-bypass-continue-on-error/test-node'),
  { workflow: resolve(fixtures, 'ci-parity-bypass-continue-on-error.yml') },
);
const coeOutput = `${coeResult.stdout}\n${coeResult.stderr}`;
assert(
  coeResult.status !== 0,
  'a test:* referenced only by a continue-on-error step is an orphan (not wired)',
);
assert(
  /test-foo\.js/.test(coeOutput),
  'orphan guard names the continue-on-error-only test file',
);

const ifFalseResult = runOrphanGuard(
  bypassPkg,
  resolve(fixtures, 'orphan-bypass-if-false/test-node'),
  { workflow: resolve(fixtures, 'ci-parity-bypass-if-false.yml') },
);
const ifFalseOutput = `${ifFalseResult.stdout}\n${ifFalseResult.stderr}`;
assert(
  ifFalseResult.status !== 0,
  'a test:* referenced only by an if: false step is an orphan (not wired)',
);
assert(
  /test-bar\.js/.test(ifFalseOutput),
  'orphan guard names the if:false-only test file',
);

// Sanity control: the SAME test:foo step, but ACTIVE (no if, no
// continue-on-error), must count test-foo.js as wired — proving the bypass
// filter rejects only bypassed steps, not active ones.
const activeControlResult = runOrphanGuard(
  bypassPkg,
  resolve(fixtures, 'orphan-bypass-continue-on-error/test-node'),
  { workflow: resolve(fixtures, 'ci-parity-bypass-active-control.yml') },
);
const activeControlOutput = `${activeControlResult.stdout}\n${activeControlResult.stderr}`;
assert(
  activeControlResult.status === 0,
  'an active (no-if, no-continue-on-error) step counts its test:* as wired',
);
assert(
  !/test-foo\.js/.test(activeControlOutput),
  'the active-step test file is not reported as an orphan',
);

if (failures > 0) {
  console.error(`\n✗ ${failures} CI parity assertion(s) failed.`);
  process.exit(1);
}

console.log('\n✓ All CI parity guard assertions passed.');
