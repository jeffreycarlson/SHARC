#!/usr/bin/env node
/**
 * Builds and validates the npm publish tarball.
 *
 * This script creates the production artifact it validates. Release publishing
 * must pass the same tarball path to `npm publish <tarball>` so validation and
 * provenance apply to one concrete package file.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const keepTarball = args.includes('--keep');
const metadataIndex = args.indexOf('--metadata');
const metadataPath = metadataIndex === -1 ? null : resolve(root, args[metadataIndex + 1] || '');
if (metadataIndex !== -1 && !args[metadataIndex + 1]) {
  console.error('--metadata requires an output path');
  process.exit(1);
}

const npmCache = mkdtempSync(join(tmpdir(), 'sharc-npm-cache-'));

function fail(message, details = []) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function run(command, argsForCommand, options = {}) {
  return execFileSync(command, argsForCommand, {
    cwd: root,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      ...options.env,
    },
    encoding: options.encoding || 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

let tarballPath = null;

try {
  // Avoid stale development sourcemaps from a prior local `npm run build`.
  rmSync(resolve(root, 'dist'), { recursive: true, force: true });
  run('npm', ['run', 'build:prod'], { stdio: 'inherit' });
  run('npm', ['run', 'build:types'], { stdio: 'inherit' });

  const packOutput = run('npm', ['pack', '--json']);

  let pack;
  try {
    [pack] = JSON.parse(packOutput);
  } catch (error) {
    fail(`Unable to parse npm pack --json output: ${error.message}`);
  }

  if (!pack || !Array.isArray(pack.files)) {
    fail('npm pack --json did not return a file manifest.');
  }

  tarballPath = resolve(root, pack.filename);
  const fileEntries = new Map(pack.files.map((file) => [file.path, file]));
  const files = new Set(fileEntries.keys());

  const expected = new Set([
    'package.json',
    'README.md',
    'LICENSE',
    'dist/lifecycle-adapters/base-adapter.d.ts',
    'dist/lifecycle-adapters/html-adapter.d.ts',
  ]);

  for (const entry of Object.values(pkg.exports || {})) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of ['types', 'import']) {
      if (typeof entry[key] === 'string') {
        expected.add(entry[key].replace(/^\.\//, ''));
      }
    }
    if (typeof entry.import === 'string' && entry.import.endsWith('.mjs')) {
      expected.add(entry.import.replace(/^\.\//, '').replace(/\.mjs$/, '.js'));
    }
  }

  // Internal/build-only artifact. It is intentionally shipped under dist/ for
  // bundle tooling and script-tag loading, but intentionally not exposed as a
  // package `exports` subpath.
  for (const extension of ['js', 'mjs', 'd.ts']) {
    expected.add(`dist/sharc-protocol-router.${extension}`);
  }

  const missing = [...expected].filter((path) => !files.has(path)).sort();
  if (missing.length > 0) {
    fail('Publish tarball is missing required files:', missing);
  }

  const allowedRoots = new Set(['package.json', 'README.md', 'LICENSE']);
  const stray = [...files].filter((path) => (
    !allowedRoots.has(path) && !path.startsWith('dist/')
  ));
  if (stray.length > 0) {
    fail('Publish tarball contains files outside dist/ + package metadata:', stray.sort());
  }

  const sourceMaps = [...files].filter((path) => path.endsWith('.map'));
  if (sourceMaps.length > 0) {
    fail('Publish tarball must not contain sourcemaps:', sourceMaps.sort());
  }

  const tooSmall = [];
  for (const path of expected) {
    const entry = fileEntries.get(path);
    if (!entry) continue;
    const min = path.endsWith('.d.ts') ? 50 : path.endsWith('.js') || path.endsWith('.mjs') ? 100 : 1;
    if (entry.size <= min) {
      tooSmall.push(`${path}: ${entry.size} bytes (expected > ${min})`);
    }
  }
  if (tooSmall.length > 0) {
    fail('Publish tarball contains placeholder-sized expected files:', tooSmall);
  }

  const forbiddenBundleTokens = [
    'sourceMappingURL',
    '__webpack_require__',
    'process.env.NODE_ENV !== "production"',
    "process.env.NODE_ENV !== 'production'",
  ];
  const forbiddenHits = [];
  for (const path of files) {
    if (!path.startsWith('dist/') || (!path.endsWith('.js') && !path.endsWith('.mjs'))) continue;
    const content = readFileSync(resolve(root, path), 'utf8');
    for (const token of forbiddenBundleTokens) {
      if (content.includes(token)) {
        forbiddenHits.push(`${path}: ${token}`);
      }
    }
  }
  if (forbiddenHits.length > 0) {
    fail('Publish bundles contain forbidden debug/package tokens:', forbiddenHits.sort());
  }

  if (pkg.exports?.['./sharc-protocol-router']) {
    fail('sharc-protocol-router must remain internal/build-only for 0.7.8; remove the public export or update the release hardening plan.');
  }

  const tarballBytes = readFileSync(tarballPath);
  const sha256 = createHash('sha256').update(tarballBytes).digest('hex');

  if (metadataPath) {
    writeFileSync(metadataPath, JSON.stringify({
      filename: pack.filename,
      path: pack.filename,
      sha256,
      files: files.size,
    }, null, 2) + '\n');
  }

  if (!keepTarball && existsSync(tarballPath)) {
    unlinkSync(tarballPath);
  }

  console.log(`OK. ${pack.filename} contains ${files.size} validated package files.`);
  console.log(`sha256 ${sha256}`);
} catch (error) {
  console.error(error.message);
  for (const detail of error.details || []) {
    console.error(`  - ${detail}`);
  }
  if (!keepTarball && tarballPath && existsSync(tarballPath)) {
    unlinkSync(tarballPath);
  }
  process.exitCode = 1;
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
