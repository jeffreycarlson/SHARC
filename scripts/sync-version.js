#!/usr/bin/env node
/**
 * sync-version.js — Propagates the version from package.json to all source files.
 *
 * Run automatically via the npm "version" lifecycle script, or manually:
 *   node scripts/sync-version.js
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

console.log(`Syncing version ${version} across source files...`);

const replacements = [
  // SHARC_VERSION constant (single source of truth)
  {
    file: 'src/sharc-protocol.js',
    pattern: /const SHARC_VERSION = '[^']+'/,
    replacement: `const SHARC_VERSION = '${version}'`,
  },
  // @version JSDoc tags
  {
    file: 'src/sharc-protocol.js',
    pattern: /(@version )\S+/,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-container.js',
    pattern: /(@version )\S+/,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-creative.js',
    pattern: /(@version )\S+/,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-mraid-bridge.js',
    pattern: /(@version )\S+/,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-safeframe-bridge.js',
    pattern: /(@version )\S+/,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-omid-bridge.js',
    pattern: /(@version )\S+/,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-navigation-bridge.js',
    pattern: /(@version )\S+/,
    replacement: `$1${version}`,
  },
  // README badge
  {
    file: 'README.md',
    pattern: /package-v[\d.]+/,
    replacement: `package-v${version}`,
  },
  // README CDN example URLs
  {
    file: 'README.md',
    pattern: /@iabtechlab\/sharc@[\d.]+/g,
    replacement: `@iabtechlab/sharc@${version}`,
  },
];

let updated = 0;

for (const { file, pattern, replacement } of replacements) {
  const filepath = resolve(root, file);
  const content = readFileSync(filepath, 'utf8');
  const newContent = content.replace(pattern, replacement);
  if (newContent !== content) {
    writeFileSync(filepath, newContent, 'utf8');
    console.log(`  ✓ ${file}`);
    updated++;
  } else {
    console.log(`  – ${file} (already up to date)`);
  }
}

console.log(`\nDone. ${updated} file(s) updated to ${version}.`);
