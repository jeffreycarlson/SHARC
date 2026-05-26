#!/usr/bin/env node

/**
 * @file Creative validator CLI.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, relative, resolve, sep } from 'path';
import { normalizeCleanedCorpus, toJsonl } from './normalizer.js';
import { runNormalizedCases } from './runner.js';
import { triageReports } from './triage.js';

const DEFAULT_PRIVATE_ROOT = resolve('tools/creative-validator/private');
const FORBIDDEN_PUBLIC_DIRS = [
  resolve('tools/creative-validator/fixtures'),
  resolve('tools/creative-validator/src'),
  resolve('tools/creative-validator/test'),
];

function usage() {
  return `SHARC Creative Validator

Usage:
  creative-validator normalize <corpus-file-or-glob> [more-files...] --out <private/cases.jsonl>
  creative-validator run <normalized-cases.jsonl> --out <private/reports/report.jsonl>
  creative-validator triage <report-jsonl-or-glob> [more-files...] --out <private/triage/summary.json>

Examples:
  node tools/creative-validator/src/cli.js normalize "tools/creative-validator/private/*.cleaned.json" --out tools/creative-validator/private/normalized/cases.jsonl
  node tools/creative-validator/src/cli.js run tools/creative-validator/private/normalized/cases.jsonl --out tools/creative-validator/private/reports/report.jsonl
  node tools/creative-validator/src/cli.js triage "tools/creative-validator/private/reports/*.jsonl" --out tools/creative-validator/private/triage/summary.json

Notes:
  - Globs are supported only in the final path segment, e.g. private/*.cleaned.json.
  - Output must stay under tools/creative-validator/private/ unless --allow-public-out is passed.
  - Run options: --port, --renderer-port, --renderer-url, --repo-root, --render-timeout-ms, --settle-ms, --verbose.
`;
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel && !rel.startsWith('..') && !rel.startsWith(sep));
}

function assertOutputPath(outPath, allowPublicOut) {
  if (allowPublicOut) {
    for (const forbidden of FORBIDDEN_PUBLIC_DIRS) {
      if (isInside(outPath, forbidden)) {
        throw new Error(`Refusing to write validator output under ${relative(process.cwd(), forbidden)}.`);
      }
    }
    return;
  }

  if (!isInside(outPath, DEFAULT_PRIVATE_ROOT)) {
    throw new Error(
      'Refusing to write private creative validator output outside tools/creative-validator/private/. '
      + 'Pass --allow-public-out only for sanitized throwaway output.',
    );
  }
}

/**
 * Supports simple filesystem globs in the final path segment, e.g.
 * `private/*.cleaned.json`. This avoids adding a dependency for Phase 1.
 *
 * @param {string} pattern
 * @returns {string[]}
 */
function expandInput(pattern) {
  if (!pattern.includes('*')) {
    const file = resolve(pattern);
    if (!existsSync(file)) throw new Error(`Input file not found: ${pattern}`);
    return [file];
  }
  const absolute = resolve(pattern);
  const dir = dirname(absolute);
  const filePattern = absolute.slice(dir.length + 1);
  const regex = new RegExp('^' + filePattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*') + '$');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Input glob directory not found: ${dirname(pattern)}`);
  }
  const matches = readdirSync(dir)
    .filter((entry) => regex.test(entry))
    .map((entry) => resolve(dir, entry))
    .sort();
  if (matches.length === 0) throw new Error(`Input glob matched no files: ${pattern}`);
  return matches;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    process.exit(0);
  }
  if (command !== 'normalize' && command !== 'run' && command !== 'triage') {
    throw new Error('Expected command: normalize, run, or triage\n\n' + usage());
  }

  const inputs = [];
  let out = null;
  let allowPublicOut = false;
  let port = null;
  let rendererPort = null;
  let rendererUrl = null;
  let repoRoot = null;
  let renderTimeoutMs = null;
  let settleMs = null;
  let verbose = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--out') {
      out = rest[++i];
    } else if (arg === '--allow-public-out') {
      allowPublicOut = true;
    } else if (arg === '--port') {
      port = parsePositiveInt(rest[++i], '--port');
    } else if (arg === '--renderer-port') {
      rendererPort = parsePositiveInt(rest[++i], '--renderer-port');
    } else if (arg === '--renderer-url') {
      rendererUrl = rest[++i];
    } else if (arg === '--repo-root') {
      repoRoot = rest[++i];
    } else if (arg === '--render-timeout-ms') {
      renderTimeoutMs = parsePositiveInt(rest[++i], '--render-timeout-ms');
    } else if (arg === '--settle-ms') {
      settleMs = parsePositiveInt(rest[++i], '--settle-ms');
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length === 0) throw new Error('At least one corpus input is required.');
  if (!out) throw new Error('--out <cases.jsonl> is required.');
  if (command === 'run' && inputs.length !== 1) {
    throw new Error('run expects exactly one normalized JSONL input file.');
  }
  return {
    allowPublicOut,
    command,
    inputs,
    out,
    port,
    rendererPort,
    rendererUrl,
    repoRoot,
    renderTimeoutMs,
    settleMs,
    verbose,
  };
}

function parsePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return n;
}

function readJsonCorpus(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.name === 'SyntaxError') {
      const match = /position\s+(\d+)/i.exec(err.message || '');
      const position = match ? ` at position ${match[1]}` : '';
      throw new Error(`Failed to parse ${basename(file)}: invalid JSON${position}.`);
    }
    throw err;
  }
}

function writeCasesJsonl(outPath, files) {
  return new Promise((resolvePromise, reject) => {
    const stream = createWriteStream(outPath, { encoding: 'utf8' });
    let count = 0;

    stream.on('error', reject);
    stream.on('finish', () => resolvePromise(count));

    try {
      for (const file of files) {
        const json = readJsonCorpus(file);
        const cases = normalizeCleanedCorpus(json, { sourceFile: file });
        count += cases.length;
        for (const item of cases) {
          stream.write(toJsonl([item]));
        }
      }
      stream.end();
    } catch (err) {
      stream.destroy();
      reject(err);
    }
  });
}

async function main() {
  const {
    allowPublicOut,
    command,
    inputs,
    out,
    port,
    rendererPort,
    rendererUrl,
    repoRoot,
    renderTimeoutMs,
    settleMs,
    verbose,
  } = parseArgs(process.argv.slice(2));
  const outPath = resolve(out);
  assertOutputPath(outPath, allowPublicOut);

  if (command === 'normalize') {
    const files = inputs.flatMap(expandInput);
    if (files.length === 0) {
      throw new Error('No input files matched.');
    }

    mkdirSync(dirname(outPath), { recursive: true });
    const count = await writeCasesJsonl(outPath, files);
    console.log(`Normalized ${count} cases from ${files.length} file(s) to ${outPath}`);
    return;
  }

  if (command === 'triage') {
    const files = inputs.flatMap(expandInput);
    if (files.length === 0) {
      throw new Error('No report files matched.');
    }

    mkdirSync(dirname(outPath), { recursive: true });
    const summary = triageReports(files);
    writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
    console.log(`Triaged ${summary.totals.reports} report row(s) from ${files.length} file(s) to ${outPath}`);
    return;
  }

  const inputPath = resolve(inputs[0]);
  if (!existsSync(inputPath)) throw new Error(`Input file not found: ${inputs[0]}`);
  const result = await runNormalizedCases(inputPath, outPath, {
    port,
    rendererPort,
    rendererUrl,
    repoRoot,
    renderTimeoutMs,
    settleMs,
    verbose,
  });
  console.log(`Ran ${result.count} normalized case(s) to ${result.outFile}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
