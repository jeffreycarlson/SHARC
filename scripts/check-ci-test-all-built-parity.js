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
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const args = process.argv.slice(2);
let workflowArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workflow') {
    workflowArg = args[i + 1];
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

const workflowPath = resolve(root, workflowArg || process.env.SHARC_CI_WORKFLOW_PATH || '.github/workflows/ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

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
    if (step && typeof step === 'object' && step.run === 'npm run test:all:built') {
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

console.log(`OK. CI runs test:all:built (${expectedSuites.length} suites) on pull_request.`);
