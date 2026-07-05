#!/usr/bin/env node

/**
 * test-regression.js — private corpus report comparison coverage.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { compareReportVerdicts } from '../src/regression.js';

const cliPath = resolve('tools/creative-validator/src/cli.js');

function report(id, status, bucket, reason = null) {
  return {
    case: {
      source: {
        sourceFile: 'private/normalized/cases.jsonl',
        rowIndex: Number(id.replace(/\D/g, '')) || 0,
        bidder: 'private-bidder',
        mtype: 'banner',
      },
      ids: {
        bidId: id,
        crid: `crid-${id}`,
      },
    },
    outcome: { status, bucket, reason },
  };
}

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('compareReportVerdicts treats documented creative-side pass-to-fail as regression-clean', () => {
  const baseline = [
    report('bid-1', 'passed', 'passed'),
    report('bid-2', 'failed', 'network-cors'),
  ];
  const current = [
    report('bid-1', 'failed', 'network-cors', 'script fetch failed'),
    report('bid-2', 'passed', 'passed'),
  ];
  const result = compareReportVerdicts(baseline, current, {
    notes: {
      'bid-1': {
        attribution: 'creative-flake',
        cause: 'Third-party script returned a transient transport failure during current run.',
      },
      'bid-2': {
        attribution: 'sharc-fix',
        cause: 'Current SHARC behavior no longer classifies the benign load as network-cors.',
      },
    },
  });

  assert.equal(result.totals.verdictChanges, 2);
  assert.equal(result.totals.passToFail, 1);
  assert.equal(result.totals.sharcPassToFailRegressions, 0);
  assert.equal(result.totals.undocumentedPassToFail, 0);
  assert.equal(typeof result.verdictChanges[0].rowKey, 'string');
  assert.match(result.verdictChanges[0].rowKey, /"sourceFile"/);
  assert.equal(result.regressionClean, true);
});

test('compareReportVerdicts flags SHARC-attributed and untriaged pass-to-fail changes', () => {
  const baseline = [
    report('bid-1', 'passed', 'passed'),
    report('bid-2', 'passed', 'passed'),
  ];
  const current = [
    report('bid-1', 'failed', 'mraid-lifecycle-gate'),
    report('bid-2', 'failed', 'renderer-timeout'),
  ];
  const result = compareReportVerdicts(baseline, current, {
    notes: {
      'bid-1': {
        attribution: 'sharc',
        cause: 'Synthetic test note: this would be a SHARC-attributed regression.',
      },
    },
  });

  assert.equal(result.totals.verdictChanges, 2);
  assert.equal(result.totals.passToFail, 2);
  assert.equal(result.totals.sharcPassToFailRegressions, 1);
  assert.equal(result.totals.undocumentedPassToFail, 1);
  assert.equal(result.regressionClean, false);
});

test('CLI compare writes the private regression report and exits non-zero when triage is missing', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-regression-'));
  const baselinePath = resolve(workDir, 'baseline.jsonl');
  const currentPath = resolve(workDir, 'current.jsonl');
  const cleanOutPath = resolve(workDir, 'clean.json');
  const dirtyOutPath = resolve(workDir, 'dirty.json');
  const notesPath = resolve(workDir, 'notes.json');

  try {
    writeJsonl(baselinePath, [report('bid-1', 'passed', 'passed')]);
    writeJsonl(currentPath, [report('bid-1', 'failed', 'network-cors')]);
    writeFileSync(notesPath, JSON.stringify({
      'bid-1': {
        attribution: 'creative-flake',
        cause: 'Synthetic test note: documented non-SHARC pass-to-fail.',
      },
    }, null, 2) + '\n');

    execFileSync('node', [
      cliPath,
      'compare',
      baselinePath,
      '--current',
      currentPath,
      '--notes',
      notesPath,
      '--out',
      cleanOutPath,
    ], { encoding: 'utf8' });
    assert.equal(JSON.parse(readFileSync(cleanOutPath, 'utf8')).regressionClean, true);

    const dirty = spawnSync('node', [
      cliPath,
      'compare',
      baselinePath,
      '--current',
      currentPath,
      '--out',
      dirtyOutPath,
    ], { encoding: 'utf8' });
    assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
    const dirtyReport = JSON.parse(readFileSync(dirtyOutPath, 'utf8'));
    assert.equal(dirtyReport.regressionClean, false);
    assert.equal(dirtyReport.totals.undocumentedPassToFail, 1);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});
