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
 * Contract (b) — TRACEABILITY (active once docs/spec/traceability.md exists):
 * every RFC-2119 keyword line (MUST / MUST NOT / SHALL / SHALL NOT / REQUIRED)
 * in a NORMATIVE-bannered file must be indexed by exactly one row of the
 * MUST-to-gate table at docs/spec/traceability.md. Line-level, by anchor:
 *
 *   - the table's legend maps a document key to a file:
 *       | L1 | `docs/spec/container-runtime.md` | ...
 *   - each index row names its key in the "Doc §" column and carries an
 *     anchor, a verbatim substring of the indexed line, in backticks:
 *       | L1-001 | L1 §1.7.2 | `The container MUST ignore` | ... |
 *   - every keyword line must contain the anchor of exactly one row for its
 *     file, and every row's anchor must match exactly one keyword line.
 *
 * A NORMATIVE file with keyword lines and no legend entry fails; a new MUST
 * line with no row fails; a row whose line was edited away (stale) or whose
 * anchor matches several lines (ambiguous) fails. Lines that are wholly an
 * HTML comment (the banner, `<!-- trace: … -->` footers) are machine metadata,
 * not spec text, and are not indexed. Row CONTENT (class, gate, status) is
 * reviewed by humans; this check enforces membership only.
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
const COMMENT_LINE_RE = /^\s*<!--.*-->\s*$/;
const LEGEND_RE = /^\|\s*([A-Z][A-Z0-9]*)\s*\|\s*`(docs\/[^`]+\.md)`\s*\|/;
const ROW_RE = /^\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|\s*([A-Z][A-Z0-9]*) §[^|]*\|\s*`([^`]+)`\s*\|/;

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

// The disposition is read from a real banner (own line, first BANNER_WINDOW
// lines), so a file that merely mentions the banner string in prose is not
// mistaken for a NORMATIVE document.
function bannerStatus(file) {
  const head = readFileSync(file, 'utf8').split('\n').slice(0, BANNER_WINDOW);
  for (const line of head) {
    const m = line.trim().match(BANNER_RE);
    if (m) return m[1];
  }
  return null;
}

function keywordLines(file) {
  const out = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (RFC2119_RE.test(line) && !COMMENT_LINE_RE.test(line)) {
      out.push({ lineNo: i + 1, text: line });
    }
  });
  return out;
}

function snippet(text) {
  const t = text.trim();
  return t.length > 90 ? `${t.slice(0, 87)}...` : t;
}

function checkTraceability(files) {
  if (!existsSync(traceabilityPath)) {
    console.log(
      '[test:spec-structure] TODO (contract b, dormant): ' +
        'docs/spec/traceability.md does not exist yet. Once the G1 extraction ' +
        'lands, every RFC-2119 keyword line in a NORMATIVE-bannered file must ' +
        'be indexed there; this check activates on file presence.'
    );
    return { violations: [], summary: null };
  }
  const tableLines = readFileSync(traceabilityPath, 'utf8').split('\n');
  const legend = new Map(); // key -> repo-relative path
  const rows = [];
  const violations = [];
  const seenIds = new Set();
  tableLines.forEach((line, i) => {
    const row = line.match(ROW_RE);
    if (row) {
      const [, id, key, anchor] = row;
      if (seenIds.has(id)) {
        violations.push({ file: traceabilityPath, problem: `duplicate row id ${id} (line ${i + 1})` });
      }
      seenIds.add(id);
      rows.push({ id, key, anchor, tableLine: i + 1 });
      return;
    }
    const leg = line.match(LEGEND_RE);
    if (leg) legend.set(leg[1], leg[2]);
  });

  const linesByKey = new Map();
  let indexedFiles = 0;
  let keywordLineCount = 0;
  for (const file of files) {
    if (bannerStatus(file) !== 'NORMATIVE') continue;
    const lines = keywordLines(file);
    if (lines.length === 0) continue;
    const rel = relative(root, file);
    const key = [...legend.entries()].find(([, path]) => path === rel)?.[0];
    if (!key) {
      violations.push({
        file,
        problem: 'NORMATIVE file with RFC-2119 keywords has no legend entry in docs/spec/traceability.md',
      });
      continue;
    }
    indexedFiles += 1;
    keywordLineCount += lines.length;
    linesByKey.set(key, { file, lines });
    const keyRows = rows.filter((r) => r.key === key);
    for (const { lineNo, text: lineText } of lines) {
      const hits = keyRows.filter((r) => lineText.includes(r.anchor));
      if (hits.length === 0) {
        violations.push({ file, problem: `line ${lineNo} is not indexed: "${snippet(lineText)}"` });
      } else if (hits.length > 1) {
        violations.push({
          file,
          problem: `line ${lineNo} is indexed by ${hits.length} rows (${hits.map((h) => h.id).join(', ')})`,
        });
      }
    }
  }

  for (const r of rows) {
    const target = linesByKey.get(r.key);
    if (!target) {
      if (!legend.has(r.key)) {
        violations.push({ file: traceabilityPath, problem: `row ${r.id}: unknown document key ${r.key}` });
      } else {
        violations.push({
          file: traceabilityPath,
          problem: `row ${r.id}: ${legend.get(r.key)} is not a NORMATIVE file with RFC-2119 lines (stale row)`,
        });
      }
      continue;
    }
    const matches = target.lines.filter((l) => l.text.includes(r.anchor)).length;
    if (matches === 0) {
      violations.push({
        file: traceabilityPath,
        problem: `row ${r.id}: anchor \`${r.anchor}\` matches no RFC-2119 line in ${legend.get(r.key)} (stale row)`,
      });
    } else if (matches > 1) {
      violations.push({
        file: traceabilityPath,
        problem: `row ${r.id}: anchor \`${r.anchor}\` matches ${matches} RFC-2119 lines in ${legend.get(r.key)} (ambiguous anchor)`,
      });
    }
  }

  return {
    violations,
    summary: { indexedFiles, keywordLineCount, rowCount: rows.length },
  };
}

const files = [join(root, 'README.md'), ...markdownFilesUnder(docsDir)];
const bannerViolations = files.map(checkBanner).filter(Boolean);
const trace = checkTraceability(files);

if (trace.summary) {
  const { indexedFiles, keywordLineCount, rowCount } = trace.summary;
  const verdict = trace.violations.length === 0 ? 'PASS' : `FAIL (${trace.violations.length})`;
  console.log(
    `[test:spec-structure] contract (b) traceability: ${verdict} — ` +
      `${keywordLineCount} RFC-2119 lines in ${indexedFiles} NORMATIVE file(s), ` +
      `${rowCount} index rows in docs/spec/traceability.md.`
  );
  for (const v of trace.violations) {
    console.error(`  FAIL ${relative(root, v.file)} — ${v.problem}`);
  }
}

if (bannerViolations.length > 0) {
  console.error(
    'G1 doc-status contract violated (ADR 2026-07-08-g1-spec-traceability-skeleton): ' +
      'every markdown file under docs/ (and the root README.md) must carry exactly one ' +
      `machine-readable "<!-- SHARC-DOC-STATUS: NORMATIVE|INFORMATIVE|HISTORICAL -->" banner ` +
      `within its first ${BANNER_WINDOW} lines.\n`
  );
  for (const v of bannerViolations) {
    console.error(`  FAIL ${relative(root, v.file)} — ${v.problem}`);
  }
  console.error(`\n${bannerViolations.length} of ${files.length} files in scope fail the contract.`);
}

if (bannerViolations.length > 0 || trace.violations.length > 0) {
  process.exit(1);
}

console.log(`[test:spec-structure] ${files.length} files carry a valid SHARC-DOC-STATUS banner.`);
