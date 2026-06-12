#!/usr/bin/env node
/**
 * CI parity guard — accidental-drift defense.
 *
 * Purpose: catch unintentional divergence between package.json's
 * `test:all:built` script list and .github/workflows/ci.yml's step list.
 * If a maintainer adds a new test suite to `test:all:built` but forgets
 * to update ci.yml, this guard fails the PR until ci.yml catches up.
 *
 * This guard runs in two directions:
 *   - FORWARD: every `npm run test:*` referenced by `test:all:built`
 *     resolves to a defined package script, and ci.yml runs the canonical
 *     `npm run test:all:built` step on pull_request without a bypass.
 *     Additionally (prod-build-leg invariant, #383 / PR #384 review): any
 *     non-bypassed step that runs `npm run build:prod` must be followed,
 *     later in the same job, by a non-bypassed step whose run is exactly
 *     `npm run test:all:built` — a prod build inside CI may never go
 *     untested. Without this, deleting the prod job's test step would leave
 *     the guard green (the dev job's canonical step satisfies the
 *     existence check) while "Prod Build Test" silently became build-only.
 *   - REVERSE (orphan guard): every `test/node/test-*.js` on disk is wired
 *     into some CI gate step (transitively). "Wired" means reachable from a
 *     CI gate root — any `npm run test:*` invoked by a non-bypassed step in
 *     ci.yml (e.g. `test:all:built`, `test:perf`, `test:bfcache`) — resolved
 *     transitively through chained `npm run test:*` calls. A suite can be
 *     green locally yet never run on the release gate if nobody wires it in
 *     — #322 shipped two such unwired suites, caught only by manual review.
 *     Intentional exclusions live in INTENTIONALLY_UNWIRED below.
 *
 * REVERSE-SCAN SCOPE: the orphan scan covers `test/node` only. Other suites
 * in the chain live outside it — notably the 4 `tools/creative-validator/
 * test/test-*.js` files (run via test:creative-validator-* scripts) and the
 * `test/browser/` bfcache suite. The FORWARD check still verifies those
 * scripts exist, but an orphaned validator/browser test file (present on disk,
 * referenced by no script) would NOT be caught here. Extending the scan to
 * those dirs is future work; for now they rely on the forward check + review.
 *
 * SCOPE: this is NOT a comprehensive defense against intentional CI
 * bypasses. GitHub Actions exposes many ways to disable a workflow gate
 * (paths-ignore, types filters, needs chains to skipped jobs, job-level
 * continue-on-error, matrix collapse, defaults.run.shell override, etc.)
 * — enumerating them all is asymptotic. See PR #300 review for the
 * empirical inventory and the rationale for the narrower scope.
 *
 * Intentional-bypass defense is the responsibility of:
 *   - PR review (current SHARC governance)
 *   - GitHub branch protection with required status checks
 *     (recommended once SHARC moves to multi-maintainer governance)
 *
 * Dependency note: js-yaml stays on 4.x for YAML 1.2 parsing semantics,
 * including avoiding YAML 1.1's Norway-keyword treatment of `on:`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/**
 * Allowlist of `test/node/test-*.js` files that are present on disk but
 * intentionally NOT run on ANY CI gate (not test:all:built, not test:perf,
 * not any other ci.yml step). Keep this list tiny and explicit, with a
 * one-line reason per entry. Anything here is exempt from the orphan guard.
 *
 * This is NOT for suites that run via a separate gate step — those are
 * resolved as "wired" from the ci.yml gate roots (see gateRoots below),
 * so e.g. test-creative-sources-perf.js (run via the test:perf step) does
 * NOT belong here. Allowlisting a file that actually runs would erode the
 * signal: a real never-run orphan could hide behind a stale entry.
 *
 * Example of a valid entry (NOT present today): a not-yet-landed red design
 * test such as `test-mraid-readiness-sequence.js` (Sequence 2, lands later on
 * feat/321-mraid-wrapper) would go here while it is still expected to fail and
 * is deliberately kept off every gate.
 */
const INTENTIONALLY_UNWIRED = {};

const args = process.argv.slice(2);
let workflowArg = null;
let pkgArg = null;
let testDirArg = null;
// --allowlist exists only so fixtures can exercise the allowlist MECHANISM
// without depending on a (now-empty) hardcoded INTENTIONALLY_UNWIRED entry.
// Production CI runs the guard with no --allowlist, so the real allowlist is
// exactly INTENTIONALLY_UNWIRED.
let allowlistArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workflow') {
    workflowArg = args[i + 1];
    i++;
    continue;
  }
  if (args[i] === '--pkg') {
    pkgArg = args[i + 1];
    i++;
    continue;
  }
  if (args[i] === '--test-dir') {
    testDirArg = args[i + 1];
    i++;
    continue;
  }
  if (args[i] === '--allowlist') {
    allowlistArg = args[i + 1];
    i++;
    continue;
  }
  console.error(`Unknown argument: ${args[i]}`);
  process.exit(1);
}
if (args.includes('--workflow') && !workflowArg) {
  console.error('--workflow requires a path');
  process.exit(1);
}
if (args.includes('--allowlist') && !allowlistArg) {
  console.error('--allowlist requires a comma-separated file list');
  process.exit(1);
}
if (args.includes('--pkg') && !pkgArg) {
  console.error('--pkg requires a path');
  process.exit(1);
}
if (args.includes('--test-dir') && !testDirArg) {
  console.error('--test-dir requires a path');
  process.exit(1);
}

const workflowPath = resolve(root, workflowArg || process.env.SHARC_CI_WORKFLOW_PATH || '.github/workflows/ci.yml');
const pkgPath = resolve(root, pkgArg || 'package.json');
const testDir = resolve(root, testDirArg || 'test/node');
const allowlist = new Set(Object.keys(INTENTIONALLY_UNWIRED));
if (allowlistArg) {
  for (const name of allowlistArg.split(',').map((s) => s.trim()).filter(Boolean)) {
    allowlist.add(name);
  }
}
const workflow = readFileSync(workflowPath, 'utf8');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (!pkg.scripts?.['test:all:built']) {
  console.error('package.json is missing scripts.test:all:built');
  process.exit(1);
}

let parsedWorkflow;
try {
  parsedWorkflow = yaml.load(workflow);
} catch (error) {
  console.error(`Unable to parse workflow YAML at ${workflowPath}: ${error.message}`);
  process.exit(1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function hasNonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function hasTrueValue(value) {
  return value === true || String(value).trim().toLowerCase() === 'true';
}

// Shared bypass model for both guard directions. The FORWARD check rejects the
// canonical step outright if it carries ANY of these bypass classes (an active
// gate must not be conditional). The REVERSE harvest reuses the SAME notion to
// decide whether a step's `npm run test:*` counts as "wiring": a step that can
// be skipped or can fail without failing the build does not reliably gate, so
// the tests reachable only through it are not "wired".
//
// Conservative-in-the-safe-direction: for `if`, we only treat a step as active
// when there is NO `if` at the step or its job. A statically-false `if`
// (`if: false`, `if: ${{ false }}`) is obviously bypassed; a dynamic `if` we
// cannot evaluate is treated as bypassed too — that under-claims wiring (a real
// orphan is still surfaced) rather than over-claiming (masking an orphan behind
// an `if` that may never run). The commented `# if: false` fixture case is a
// YAML comment, so the parser never sees an `if` key and the step stays active —
// matching the forward guard, which also treats it as an active gate.
function isStepBypassed(job, step) {
  if (hasTrueValue(step['continue-on-error'])) return true;
  if (hasNonEmpty(step.if)) return true;
  if (job && typeof job === 'object' && hasNonEmpty(job.if)) return true;
  return false;
}

function getPullRequestTrigger(workflowConfig) {
  const triggers = workflowConfig?.on;
  if (typeof triggers === 'string') {
    return triggers === 'pull_request' ? {} : null;
  }
  if (Array.isArray(triggers)) {
    return triggers.includes('pull_request') ? {} : null;
  }
  if (triggers && typeof triggers === 'object' && Object.hasOwn(triggers, 'pull_request')) {
    return triggers.pull_request ?? {};
  }
  return null;
}

const pullRequestTrigger = getPullRequestTrigger(parsedWorkflow);
if (!pullRequestTrigger) {
  fail('CI workflow must include a pull_request trigger so PRs run the canonical test suite.');
}

if (pullRequestTrigger && typeof pullRequestTrigger === 'object') {
  const branches = asArray(pullRequestTrigger.branches).map(String);
  if (branches.length > 0 && !branches.includes('main')) {
    fail('CI workflow pull_request trigger must include the main branch.');
  }

  const ignoredBranches = asArray(pullRequestTrigger['branches-ignore']).map(String);
  if (ignoredBranches.includes('main')) {
    fail('CI workflow pull_request trigger must not ignore the main branch.');
  }
}

const jobs = parsedWorkflow?.jobs;
if (!jobs || typeof jobs !== 'object') {
  fail('CI workflow must define jobs.');
}

const matchingSteps = [];
for (const [jobName, job] of Object.entries(jobs)) {
  if (!job || typeof job !== 'object') continue;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const [index, step] of steps.entries()) {
    if (
      step
      && typeof step === 'object'
      && String(step.run).trim() === 'npm run test:all:built'
    ) {
      matchingSteps.push({ jobName, job, step, index });
    }
  }
}

if (matchingSteps.length === 0) {
  fail(
    'CI must include an active step whose run command is exactly '
    + '`npm run test:all:built` so future suite additions cannot drift out of PR gating.'
  );
}

for (const { jobName, job, step, index } of matchingSteps) {
  if (hasNonEmpty(job.if)) {
    fail(`CI job ${jobName} must not gate npm run test:all:built behind an if: clause.`);
  }
  if (hasNonEmpty(step.if)) {
    fail(`CI step ${jobName}.steps[${index}] must not gate npm run test:all:built behind an if: clause.`);
  }
  if (hasTrueValue(step['continue-on-error'])) {
    fail(`CI step ${jobName}.steps[${index}] must not use continue-on-error: true for npm run test:all:built.`);
  }
}

// Prod-build-leg invariant (#383 / PR #384 review): a prod build inside CI
// may never go untested. The existence check above only requires SOME job to
// run the canonical step — it would stay green if the prod job's test step
// were deleted, because the dev job's step satisfies it. So: every
// non-bypassed step running `npm run build:prod` must have a LATER
// non-bypassed step in the same job whose run is exactly
// `npm run test:all:built`. Ordering matters — a test step before the prod
// build tests the previous bundle, not the prod one. Bypassed build:prod
// steps (step/job `if:`, continue-on-error) are deliberately out of scope,
// consistent with how isStepBypassed scopes the rest of the guard.
for (const [jobName, job] of Object.entries(jobs)) {
  if (!job || typeof job !== 'object') continue;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object') continue;
    if (isStepBypassed(job, step)) continue;
    const command = typeof step.run === 'string' ? step.run : '';
    if (!command.includes('npm run build:prod')) continue;
    const testedAfter = steps.slice(index + 1).some(
      (later) => later
        && typeof later === 'object'
        && !isStepBypassed(job, later)
        && String(later.run).trim() === 'npm run test:all:built',
    );
    if (!testedAfter) {
      fail(
        `CI job ${jobName} runs \`npm run build:prod\` (steps[${index}]) without a later `
        + 'active `npm run test:all:built` step — a prod build inside CI may never go '
        + 'untested (#383). Add the canonical test step after the build:prod step.',
      );
    }
  }
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

// REVERSE direction: orphan guard. "Wired" means reachable from a CI gate
// root: any `npm run test:*` invoked by a non-bypassed step in ci.yml, plus
// `test:all:built` itself. We resolve those roots transitively (a chained
// script may itself call other `npm run test:*`), collect every
// `test/node/test-*.js` those scripts run, and require that every such file
// on disk is wired in (or explicitly allowlisted). Resolving from the gate
// roots (not just test:all:built) means a suite that runs via a dedicated
// step — e.g. test:perf, test:bfcache — is correctly counted as wired.

// Single test-file character class shared by the wired-extraction regex and
// the on-disk filter, so the two halves of the orphan check can never disagree
// (a wired file with an unusual char being reported as a false orphan).
const TEST_FILE_CLASS = '[\\w.-]+';
const wiredFileRe = new RegExp(`test/node/(test-${TEST_FILE_CLASS}\\.js)`, 'g');
const diskFileRe = new RegExp(`^test-${TEST_FILE_CLASS}\\.js$`);

// Collect the CI gate roots: every `npm run test:*` referenced by a
// non-bypassed step `run:` command across all jobs in the parsed workflow.
// Bypassed steps (continue-on-error: true, or a non-empty step/job `if:`)
// do not reliably gate, so their test entrypoints are NOT counted as wiring —
// see isStepBypassed for the shared model aligned with the forward check.
const gateRoots = new Set();
for (const job of Object.values(jobs)) {
  if (!job || typeof job !== 'object') continue;
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if (isStepBypassed(job, step)) continue;
    const command = typeof step.run === 'string' ? step.run : '';
    for (const match of command.matchAll(/npm run (test:[\w:-]+)/g)) {
      gateRoots.add(match[1]);
    }
  }
}
gateRoots.add('test:all:built');

const chainedScripts = new Set();
function collectChained(scriptName) {
  if (chainedScripts.has(scriptName)) return;
  chainedScripts.add(scriptName);
  const command = pkg.scripts?.[scriptName];
  if (typeof command !== 'string') return;
  for (const match of command.matchAll(/npm run (test:[\w:-]+)/g)) {
    collectChained(match[1]);
  }
}
for (const gateRoot of gateRoots) {
  collectChained(gateRoot);
}

const wiredTestFiles = new Set();
for (const scriptName of chainedScripts) {
  const command = pkg.scripts?.[scriptName];
  if (typeof command !== 'string') continue;
  for (const match of command.matchAll(wiredFileRe)) {
    wiredTestFiles.add(match[1]);
  }
}

let testFilesOnDisk;
try {
  testFilesOnDisk = readdirSync(testDir).filter((name) => diskFileRe.test(name));
} catch (error) {
  fail(`Unable to read test directory ${testDir}: ${error.message}`);
}

const orphans = testFilesOnDisk.filter(
  (name) => !wiredTestFiles.has(name) && !allowlist.has(name),
);

if (orphans.length > 0) {
  console.error(
    'Orphaned test files found — present in test/node but not wired into the '
    + 'test:all:built chain (they never run on the release gate):',
  );
  for (const name of orphans) {
    console.error(`  - test/node/${name}`);
  }
  console.error(
    'Wire each into a test:* script that test:all:built calls, or add it to '
    + 'INTENTIONALLY_UNWIRED in scripts/check-ci-test-all-built-parity.js with a reason.',
  );
  process.exit(1);
}

console.log(
  `OK. CI runs test:all:built (${expectedSuites.length} suites) on pull_request; `
  + `${gateRoots.size} CI gate roots resolved, `
  + `${wiredTestFiles.size} test/node suites wired, no orphans.`,
);
