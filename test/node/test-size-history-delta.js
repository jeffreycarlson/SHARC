/**
 * test-size-history-delta.js — issue #318 coverage
 *
 * Proportional symmetry between the growth and shrinkage gates in
 * `scripts/check-size-history-delta.js`.
 *
 * PR #316 tightened the SHRINKAGE path to require a PROPORTIONAL limit
 * decrease (`limitLoweredEnough`): a token 1-byte limit drop no longer excuses
 * arbitrary shrinkage past the threshold. The GROWTH path stayed permissive —
 * `const limitRaised = currentRow.limit > previousRow.limit` — so a token
 * 1-byte limit RAISE excused ARBITRARY growth past the threshold. #318 mirrors
 * the shrinkage fix onto growth (`limitRaisedEnough`): a limit raise must be
 * proportional to the size growth to excuse it.
 *
 * This is the RED→GREEN contract for that fix. It drives the real script via a
 * temp size-history directory (SHARC_SIZE_HISTORY_DIR) so it exercises the
 * actual gate logic, not a reimplementation:
 *   (a) >threshold growth + token 1-byte limit raise  -> FAILS (the bug)
 *   (b) >threshold growth + proportional limit raise   -> passes
 *   (c) shrinkage path unchanged (token drop fails, proportional drop passes)
 *   (d) growth at/under threshold with no limit change  -> passes (control)
 *
 * Pure Node; no build step required.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const script = resolve(root, 'scripts/check-size-history-delta.js');

const THRESHOLD = 0.10; // SHARC_SIZE_HISTORY_THRESHOLD default
const SHRINK_THRESHOLD = 0.25; // SHARC_SIZE_HISTORY_SHRINK_THRESHOLD default

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

/**
 * Writes a previous/current snapshot pair into a fresh temp dir and runs the
 * real check against it. Returns { status, output }.
 */
function runCheck(previousRows, currentRows) {
  const dir = mkdtempSync(resolve(tmpdir(), 'sharc-size-history-'));
  try {
    writeFileSync(resolve(dir, '0.0.0.json'), JSON.stringify(previousRows));
    writeFileSync(resolve(dir, '0.0.1.json'), JSON.stringify(currentRows));
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, SHARC_SIZE_HISTORY_DIR: dir },
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('test-size-history-delta.js — #318 growth/shrinkage proportional symmetry\n');

// --- (a) THE BUG: >threshold growth excused only by a token 1-byte limit raise.
// 1000 -> 1200 B is +20% (> 10% threshold). The limit rises by exactly 1 byte
// (2000 -> 2001), a +0.05% raise — far below the 10% threshold. Pre-#318 the
// permissive `limitRaised` gate treated this token raise as a real budget
// decision and PASSED. With `limitRaisedEnough` it must FAIL.
{
  const result = runCheck(
    [{ name: 'core', size: 1000, limit: 2000 }],
    [{ name: 'core', size: 1200, limit: 2001 }],
  );
  assert(result.status !== 0, 'token 1-byte limit raise does NOT excuse +20% growth (fails)');
  assert(/growth exceeded threshold without a proportional limit raise/.test(result.output),
    'growth failure diagnostic names the missing proportional raise');
}

// --- (b) Proportional raise DOES excuse proportional growth.
// 1000 -> 1200 B is +20% growth; the limit also rises +20% (2000 -> 2400),
// which is > the 10% threshold, so `limitRaisedEnough` is true and it PASSES.
{
  const result = runCheck(
    [{ name: 'core', size: 1000, limit: 2000 }],
    [{ name: 'core', size: 1200, limit: 2400 }],
  );
  assert(result.status === 0, 'proportional (+20%) limit raise excuses +20% growth (passes)');
}

// --- (b2) A real-but-still-sub-threshold raise is NOT enough.
// +20% growth with only a +9% limit raise (2000 -> 2180, under the 10%
// threshold) must still FAIL — the raise must clear the same threshold growth
// must clear, mirroring the shrinkage side.
{
  const result = runCheck(
    [{ name: 'core', size: 1000, limit: 2000 }],
    [{ name: 'core', size: 1200, limit: 2180 }],
  );
  assert(result.status !== 0, 'sub-threshold (+9%) limit raise does NOT excuse +20% growth (fails)');
}

// --- (c) Regression guard: SHRINKAGE path is unchanged.
// A token 1-byte limit drop must NOT excuse >shrinkThreshold shrinkage; a
// proportional drop must. 1000 -> 700 B is -30% (> 25% shrinkThreshold).
{
  const tokenDrop = runCheck(
    [{ name: 'core', size: 1000, limit: 2000 }],
    [{ name: 'core', size: 700, limit: 1999 }],
  );
  assert(tokenDrop.status !== 0, 'token 1-byte limit drop does NOT excuse -30% shrinkage (fails)');
  assert(/shrinkage exceeded threshold without a lowered limit/.test(tokenDrop.output),
    'shrinkage failure diagnostic preserved');

  const proportionalDrop = runCheck(
    [{ name: 'core', size: 1000, limit: 2000 }],
    [{ name: 'core', size: 700, limit: 1400 }],
  );
  assert(proportionalDrop.status === 0,
    'proportional (-30%) limit drop excuses -30% shrinkage (passes)');
}

// --- (d) Control: movement within thresholds with no limit change passes.
{
  const result = runCheck(
    [{ name: 'core', size: 1000, limit: 2000 }],
    [{ name: 'core', size: 1050, limit: 2000 }],
  );
  assert(result.status === 0, '+5% growth (under threshold), no limit change, passes');
}

// --- Sanity: assert the thresholds the cases assume match the script defaults,
// so a future default change surfaces here instead of silently weakening cases.
assert(THRESHOLD === 0.10 && SHRINK_THRESHOLD === 0.25,
  'test fixtures assume default growth=10% / shrink=25% thresholds');

if (failures > 0) {
  console.error(`\n✗ ${failures} size-history delta assertion(s) failed.`);
  process.exit(1);
}

console.log('\n✓ All size-history delta symmetry assertions passed.');
