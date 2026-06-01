#!/usr/bin/env node
/**
 * sync-version.js — Propagates the version from package.json to all source files.
 *
 * Run automatically via the npm "version" lifecycle script, or manually:
 *   node scripts/sync-version.js
 *
 * With --check, writes nothing and exits non-zero if any tracked file (source,
 * README, selected release-facing docs, or package-lock.json) disagrees with
 * package.json's version. CI runs this to catch a non-canonical bump that
 * strands a file — the failure mode that left package-lock.json at 0.7.6
 * during the 0.7.7 cut (#238).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const CHECK = process.argv.includes('--check');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;

console.log(`${CHECK ? 'Checking' : 'Syncing'} version ${version} across source files...`);

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
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-container.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/lifecycle-adapters/base-adapter.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/lifecycle-adapters/html-adapter.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-creative.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-mraid-bridge.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-safeframe-bridge.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-omid-bridge.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-omid-shim.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-navigation-bridge.js',
    pattern: /(@version )\S+/g,
    replacement: `$1${version}`,
  },
  {
    file: 'src/sharc-protocol-router.js',
    pattern: /(@version )\S+/g,
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
  // Release-facing docs with stable single-line current-version markers.
  {
    file: 'SECURITY.md',
    pattern: /(package version `)[\d.]+(`)/,
    replacement: `$1${version}$2`,
  },
  {
    file: 'docs/current-status.md',
    pattern: /(Repository package version: `)[\d.]+(`)/,
    replacement: `$1${version}$2`,
  },
  {
    file: 'docs/api-reference.md',
    pattern: /(current through package v)[\d.]+(\))/,
    replacement: `$1${version}$2`,
  },
];

let updated = 0;
const drift = [];

for (const { file, pattern, replacement } of replacements) {
  const filepath = resolve(root, file);
  const content = readFileSync(filepath, 'utf8');
  const newContent = content.replace(pattern, replacement);
  if (newContent !== content) {
    if (CHECK) {
      drift.push(file);
      console.log(`  ✗ ${file} (out of sync)`);
    } else {
      writeFileSync(filepath, newContent, 'utf8');
      console.log(`  ✓ ${file}`);
      updated++;
    }
  } else {
    console.log(`  – ${file} (matches ${version})`);
  }
}

// package-lock.json is updated by `npm version` itself, not by the replacement
// table above. Check mode verifies it anyway because a non-canonical bump that
// skips `npm version` strands it (see header / #238).
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const lockVersions = {
  'package-lock.json (root .version)': lock.version,
  'package-lock.json (.packages[""].version)': lock.packages?.['']?.version,
};
for (const [label, lockVersion] of Object.entries(lockVersions)) {
  if (lockVersion !== version) {
    drift.push(label);
    console.log(`  ✗ ${label}: ${lockVersion} (expected ${version})`);
  } else {
    console.log(`  – ${label} (matches ${version})`);
  }
}

if (CHECK) {
  if (drift.length > 0) {
    console.error(
      `\nVersion drift: ${drift.length} target(s) disagree with package.json (${version}).`
      + `\nRun \`npm version <bump>\` (not a manual edit) so package-lock.json stays in sync, then \`node scripts/sync-version.js\`.`,
    );
    process.exit(1);
  }
  console.log(`\nOK. All tracked targets match ${version}.`);
} else {
  console.log(`\nDone. ${updated} file(s) updated to ${version}.`);
}
