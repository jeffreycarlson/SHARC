#!/usr/bin/env node

/**
 * test-mraid-lifecycle-gates.js — issue #387 staged MRAID delivery gates.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';

const cliPath = resolve('tools/creative-validator/src/cli.js');
const fixturePath = resolve(
  'tools/creative-validator/fixtures/mraid-lifecycle-gates/cleaned-corpus.fixture.json',
);
const manifestPath = resolve('tools/creative-validator/fixtures/mraid-lifecycle-gates/cases.jsonl');

let nextPort = 14500 + (process.pid % 700) * 2;
function portPair() {
  const ports = { runner: String(nextPort), renderer: String(nextPort + 1) };
  nextPort += 2;
  return ports;
}

function runCli(args) {
  const result = spawnSync('node', [cliPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.status,
    0,
    `CLI failed: node ${cliPath} ${args.join(' ')}\n${result.stderr || result.stdout}`,
  );
  assert.equal(result.stderr, '', `CLI wrote unexpected stderr: ${result.stderr}`);
  return result.stdout;
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function stableManifestRows(rows) {
  return rows.map((row) => {
    const stable = structuredClone(row);
    stable.source.sourceFile = relative(process.cwd(), stable.source.sourceFile);
    return stable;
  });
}

function mraidLifecycle(row) {
  const probe = row.diagnostics.bridgeProbes.at(-1);
  assert.ok(probe, `${row.case.ids.bidId} has a bridge probe`);
  assert.ok(probe.bridges.mraid.lifecycle, `${row.case.ids.bidId} has mraid lifecycle diagnostics`);
  return probe.bridges.mraid.lifecycle;
}

function assertGate1(row) {
  const lifecycle = mraidLifecycle(row);
  assert.equal(lifecycle.parse.mraidExists, true, `${row.case.ids.bidId} parse-time mraid exists`);
  assert.equal(lifecycle.parse.getStateStatus, 'ok', `${row.case.ids.bidId} parse-time getState works`);
  assert.equal(lifecycle.parse.getStateValue, 'loading', `${row.case.ids.bidId} starts loading`);
  assert.equal(
    lifecycle.parse.readyDeliveredBeforeParseEnd,
    false,
    `${row.case.ids.bidId} ready not delivered at parse-time gate`,
  );
  assert.equal(
    lifecycle.parse.defaultStateChangeDeliveredBeforeParseEnd,
    false,
    `${row.case.ids.bidId} default stateChange not delivered at parse-time gate`,
  );
}

function assertGate2(row) {
  const lifecycle = mraidLifecycle(row);
  assert.equal(lifecycle.ready.delivered, true, `${row.case.ids.bidId} ready delivered`);
  assert.equal(
    lifecycle.stateChange.firstDefaultAt <= lifecycle.ready.firstAt,
    true,
    `${row.case.ids.bidId} stateChange(default) delivered at-or-before ready`,
  );
  assert.equal(
    lifecycle.ready.firstAt >= lifecycle.documentLoadAt,
    true,
    `${row.case.ids.bidId} ready delivered after document load`,
  );
  assert.equal(lifecycle.ready.getStateAfterReady, 'default', `${row.case.ids.bidId} state default after ready`);
  assert.equal(lifecycle.ready.lateReplayDelivered, true, `${row.case.ids.bidId} late ready listener replayed`);
  assert.equal(lifecycle.ready.lateReplayCount, 1, `${row.case.ids.bidId} late ready replay exactly once`);
  assert.equal(
    lifecycle.ready.parseListenerCountAfterLateAttach,
    1,
    `${row.case.ids.bidId} parse-time ready listener did not refire`,
  );
}

function assertGate3(row) {
  const lifecycle = mraidLifecycle(row);
  assert.equal(lifecycle.viewableChange.trueDelivered, true, `${row.case.ids.bidId} viewableChange(true) delivered`);
  assert.equal(lifecycle.viewableChange.isViewableAtTrue, true, `${row.case.ids.bidId} isViewable agrees`);
  assert.equal(lifecycle.exposureChange.delivered, true, `${row.case.ids.bidId} exposureChange delivered`);
  assert.equal(
    Number.isInteger(lifecycle.exposureChange.lastPercentage),
    true,
    `${row.case.ids.bidId} exposure percentage is an integer`,
  );
  assert.equal(
    lifecycle.exposureChange.lastPercentage >= 50 && lifecycle.exposureChange.lastPercentage <= 100,
    true,
    `${row.case.ids.bidId} exposure percentage matches visible state`,
  );
}

test('MRAID compliance ads pass staged lifecycle gates and never-ready fails gate-2', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-mraid-lifecycle-gates-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const reportPath = resolve(workDir, 'report.jsonl');
  const summaryPath = resolve(workDir, 'summary.json');
  const ports = portPair();

  try {
    runCli(['normalize', fixturePath, '--out', inputPath]);
    const cases = readJsonl(inputPath);
    assert.deepEqual(
      stableManifestRows(cases),
      readJsonl(manifestPath),
      'cleaned fixture normalizes to the committed conformance manifest',
    );
    assert.equal(cases.length, 4, 'fixture normalizes to three compliance ads plus one negative');
    assert.equal(cases.every((row) => row.expectations.mraidLifecycleGates === true), true);

    runCli([
      'run',
      inputPath,
      '--out',
      reportPath,
      '--port',
      ports.runner,
      '--renderer-port',
      ports.renderer,
      '--render-timeout-ms',
      '10000',
      '--settle-ms',
      '6000',
    ]);
    runCli(['triage', reportPath, '--out', summaryPath]);

    const reports = readJsonl(reportPath);
    const byBid = Object.fromEntries(reports.map((row) => [row.case.ids.bidId, row]));
    for (const bidId of [
      'bid-mraid-compliance-loadandevents',
      'bid-mraid-compliance-resize-negative',
      'bid-mraid-compliance-viewability',
    ]) {
      const row = byBid[bidId];
      assert.ok(row, `${bidId} report exists`);
      assert.equal(row.outcome.status, 'passed', `${bidId} passes`);
      assert.equal(row.outcome.bucket, 'passed', `${bidId} pass bucket`);
      assertGate1(row);
      assertGate2(row);
      assertGate3(row);
    }

    const resize = byBid['bid-mraid-compliance-resize-negative'];
    const resizeLifecycle = mraidLifecycle(resize);
    assert.equal(resizeLifecycle.error.count > 0, true, 'resize-negative fires MRAID error events');
    assert.equal(
      resizeLifecycle.error.lateReplayDelivered,
      true,
      'resize-negative replays the last error to a late listener',
    );
    assert.equal(
      typeof resizeLifecycle.error.lateReplayMessage,
      'string',
      'resize-negative late replay carries an error message',
    );
    assert.notEqual(resizeLifecycle.error.lateReplayMessage, '');

    const neverReady = byBid['bid-mraid-compliance-never-ready'];
    assert.ok(neverReady, 'synthetic never-ready report exists');
    assert.equal(neverReady.outcome.status, 'failed');
    assert.equal(neverReady.outcome.bucket, 'mraid-lifecycle-gate');
    assert.match(neverReady.outcome.reason, /gate-2 failed/);
    assertGate1(neverReady);
    assert.equal(mraidLifecycle(neverReady).ready.delivered, false, 'never-ready does not deliver ready');

    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.equal(summary.totals.reports, 4);
    assert.equal(summary.totals.passed, 3);
    assert.equal(summary.totals.failed, 1);
    assert.equal(summary.corpusDiagnostics.mraidLifecycleGates.rowsExpected, 4);
    assert.equal(summary.corpusDiagnostics.mraidLifecycleGates.byGate1.passed, 4);
    assert.equal(summary.corpusDiagnostics.mraidLifecycleGates.byGate2.passed, 3);
    assert.equal(summary.corpusDiagnostics.mraidLifecycleGates.byGate2.failed, 1);
    assert.equal(summary.corpusDiagnostics.mraidLifecycleGates.byFailedGate['gate-2'], 1);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});
