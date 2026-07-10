#!/usr/bin/env node
/**
 * G1 doc-status structural check (spec skeleton ADR, 2026-07-08).
 *
 * Contract (a) — BANNERS (live): every markdown file under docs/, plus the
 * root README.md, carries exactly one machine-readable disposition banner
 *
 *   <!-- SHARC-DOC-STATUS: NORMATIVE -->
 *   <!-- SHARC-DOC-STATUS: INFORMATIVE -->
 *   <!-- SHARC-DOC-STATUS: HISTORICAL -->
 *
 * on its own line within the first BANNER_WINDOW lines. One line, greppable,
 * diff-friendly, render-invisible. docs/design/ is deliberately IN scope: it
 * holds three of the five normative-of-record files, so exempting it would
 * exempt exactly the files most likely to be mistaken for spec. Non-markdown
 * (pages-landing.html, size-history/*.json) is out — this is a prose contract.
 *
 * Contract (b) — TRACEABILITY (placeholder until docs/spec/ exists): every
 * RFC-2119 keyword line in a NORMATIVE-bannered file must be indexed by the
 * MUST-to-gate table at docs/spec/traceability.md. Activates automatically
 * when that file appears; until then it reports TODO and does not fail.
 *
 * Run via: npm run test:spec-structure (NOT wired into test:all).
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const docsDir = join(root, 'docs');
const traceabilityPath = join(docsDir, 'spec', 'traceability.md');

const BANNER_WINDOW = 10;
const BANNER_RE = /^<!-- SHARC-DOC-STATUS: (NORMATIVE|INFORMATIVE|HISTORICAL) -->$/;
const RFC2119_RE = /\b(MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED)\b/;

function markdownFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...markdownFilesUnder(full));
    } else if (entry.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function checkBanner(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (BANNER_RE.test(line.trim())) hits.push(i + 1);
  });
  if (hits.length === 0) return { file, problem: 'no SHARC-DOC-STATUS banner' };
  if (hits.length > 1) {
    return { file, problem: `multiple banners (lines ${hits.join(', ')})` };
  }
  if (hits[0] > BANNER_WINDOW) {
    return {
      file,
      problem: `banner at line ${hits[0]}, must be within the first ${BANNER_WINDOW} lines`,
    };
  }
  return null;
}

function checkTraceability(files) {
  if (!existsSync(traceabilityPath)) {
    console.log(
      '[test:spec-structure] TODO (contract b, dormant): ' +
        'docs/spec/traceability.md does not exist yet. Once the G1 extraction ' +
        'lands, every RFC-2119 keyword line in a NORMATIVE-bannered file must ' +
        'be indexed there; this check activates on file presence.'
    );
    return [];
  }
  const table = readFileSync(traceabilityPath, 'utf8');
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const bannerMatch = text.match(/<!-- SHARC-DOC-STATUS: (\w+) -->/);
    if (!bannerMatch || bannerMatch[1] !== 'NORMATIVE') continue;
    const rel = relative(root, file);
    if (!RFC2119_RE.test(text)) continue;
    // Activation shape: the table must reference every normative source file
    // it indexes; clause-level line accounting lands with the table format.
    if (!table.includes(rel)) {
      violations.push({
        file,
        problem: 'NORMATIVE file with RFC-2119 keywords is not indexed in docs/spec/traceability.md',
      });
    }
  }
  return violations;
}

const files = [join(root, 'README.md'), ...markdownFilesUnder(docsDir)];
const violations = files.map(checkBanner).filter(Boolean);
violations.push(...checkTraceability(files));

if (violations.length > 0) {
  console.error(
    'G1 doc-status contract violated (ADR 2026-07-08-g1-spec-traceability-skeleton): ' +
      'every markdown file under docs/ (and the root README.md) must carry exactly one ' +
      `machine-readable "<!-- SHARC-DOC-STATUS: NORMATIVE|INFORMATIVE|HISTORICAL -->" banner ` +
      `within its first ${BANNER_WINDOW} lines.\n`
  );
  for (const v of violations) {
    console.error(`  FAIL ${relative(root, v.file)} — ${v.problem}`);
  }
  console.error(`\n${violations.length} of ${files.length} files in scope fail the contract.`);
  process.exit(1);
}

console.log(`[test:spec-structure] ${files.length} files carry a valid SHARC-DOC-STATUS banner.`);
