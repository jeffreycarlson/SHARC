/**
 * test-check-doc-banners.js — contract (b) of scripts/check-doc-banners.js
 * reads only VISIBLE spec text.
 *
 * Each case builds a fixture doc tree in a temp dir (root README, one
 * NORMATIVE spec file, a traceability index) and runs the real script with
 * --root. Text hidden from readers (HTML comments, inline or multi-line, and
 * fenced code blocks) must neither count as an RFC-2119 requirement line nor
 * satisfy a row's anchor. Codex review of #483 found each hole (a)–(d).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = resolve(__dirname, '../../scripts/check-doc-banners.js');

let failures = 0;
function assert(condition, message, diag) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    if (diag) console.error(diag.replace(/^/gm, '      '));
    failures++;
  }
}

function runCheck({ specLines, anchors }) {
  const dir = mkdtempSync(join(tmpdir(), 'sharc-doc-banners-'));
  try {
    mkdirSync(join(dir, 'docs', 'spec'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '<!-- SHARC-DOC-STATUS: INFORMATIVE -->\n\n# Fixture\n');
    writeFileSync(
      join(dir, 'docs', 'spec', 'fixture.md'),
      ['<!-- SHARC-DOC-STATUS: NORMATIVE -->', '', '# Fixture spec', '', ...specLines, ''].join('\n'),
    );
    const rows = anchors.map((a, i) => `| FX-${String(i + 1).padStart(3, '0')} | FX §1 | \`${a}\` | r | Core-L1 | — | PINNED |`);
    writeFileSync(
      join(dir, 'docs', 'spec', 'traceability.md'),
      [
        '<!-- SHARC-DOC-STATUS: INFORMATIVE -->',
        '',
        '| Key | File | Document |',
        '|---|---|---|',
        '| FX | `docs/spec/fixture.md` | Fixture |',
        '',
        '| ID | Doc § | Anchor | Requirement | Class | Gate(s) | Status |',
        '|---|---|---|---|---|---|---|',
        ...rows,
        '',
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, [script, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const passed = (r) => r.status === 0 && /contract \(b\) traceability: PASS/.test(r.out);
const lineCount = (r) => Number((r.out.match(/(\d+) RFC-2119 lines/) || [])[1]);

console.log('test-check-doc-banners.js — contract (b) reads visible text only\n');

console.log('clean pass');
{
  const r = runCheck({
    specLines: [
      'The container MUST stop.',
      '',
      '<!-- trace: source=x | gate=the old MUST wording -->',
      '',
      'The renderer MUST NOT echo the nonce.',
    ],
    anchors: ['The container MUST stop.', 'The renderer MUST NOT echo'],
  });
  assert(passed(r) && lineCount(r) === 2, 'two visible MUST lines, two rows, a whole-line trace comment: PASS with 2 lines', r.out);
}

console.log('\n(a) an inline comment cannot satisfy an anchor for the visible requirement beside it');
{
  const r = runCheck({
    specLines: ['<!-- The container MUST stop. --> The container MUST retry indefinitely.'],
    anchors: ['The container MUST stop.'],
  });
  assert(!passed(r), 'FAIL: the anchor matches only hidden comment text', r.out);
  assert(/line 5 is not indexed: "The container MUST retry indefinitely\."/.test(r.out),
    'the visible requirement on line 5 is reported unindexed', r.out);
  assert(/row FX-001: anchor `The container MUST stop\.` matches no RFC-2119 line/.test(r.out),
    'the row anchored in the comment is reported stale', r.out);
}

console.log('\n(b) a keyword only inside a trailing comment is not a requirement line');
{
  const r = runCheck({ specLines: ['Descriptive text. <!-- MUST stop -->'], anchors: [] });
  assert(passed(r) && lineCount(r) === 0, 'PASS with 0 lines: the keyword is hidden', r.out);
}

console.log('\n(c) a multi-line comment is hidden on every line it spans');
{
  const lines = ['<!--', 'The container MUST stop.', '-->', '', 'The container MUST retry.'];
  const unindexed = runCheck({ specLines: lines, anchors: ['The container MUST retry.'] });
  assert(passed(unindexed) && lineCount(unindexed) === 1,
    'PASS with 1 line: the commented MUST is not a requirement; the line after the comment still is', unindexed.out);
  const anchored = runCheck({ specLines: lines, anchors: ['The container MUST retry.', 'The container MUST stop.'] });
  assert(!passed(anchored), 'FAIL: a row anchored inside the comment cannot be satisfied', anchored.out);
  assert(/row FX-002: anchor `The container MUST stop\.` matches no RFC-2119 line/.test(anchored.out),
    'the row anchored inside the comment is reported stale', anchored.out);
  const sameLine = runCheck({ specLines: ['<!-- start', 'The container MUST stop. --> Visible prose.'], anchors: [] });
  assert(passed(sameLine) && lineCount(sameLine) === 0,
    'a comment that closes mid-line hides only the text before -->', sameLine.out);
}

console.log('\n(d) fenced code blocks are not spec text');
{
  const lines = ['```js', 'const MUST = true;', '```', '', '~~~', 'SHALL NOT', '~~~', '', 'The container MUST stop.'];
  const r = runCheck({ specLines: lines, anchors: ['The container MUST stop.'] });
  assert(passed(r) && lineCount(r) === 1,
    'PASS with 1 line: backtick and tilde fences hide keywords; the line after the fences counts', r.out);
  const anchored = runCheck({ specLines: lines, anchors: ['The container MUST stop.', 'const MUST = true;'] });
  assert(/row FX-002: anchor `const MUST = true;` matches no RFC-2119 line/.test(anchored.out),
    'a row anchored inside a fence is reported stale', anchored.out);
}

console.log('\nregression: a requirement between two inline comments is still indexed');
{
  const line = '<!-- a --> The container MUST retry. <!-- b -->';
  const indexed = runCheck({ specLines: [line], anchors: ['The container MUST retry.'] });
  assert(passed(indexed) && lineCount(indexed) === 1, 'PASS with 1 line when a row anchors the visible text', indexed.out);
  const missing = runCheck({ specLines: [line], anchors: [] });
  assert(!passed(missing) && /line 5 is not indexed/.test(missing.out),
    'FAIL with "line 5 is not indexed" when no row exists', missing.out);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll assertions passed');
