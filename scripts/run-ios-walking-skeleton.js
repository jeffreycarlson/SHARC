#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReportVerdicts } from '../tools/creative-validator/src/regression.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const iosRoot = resolve(repoRoot, 'examples/host-apps/ios');
const projectPath = resolve(iosRoot, 'SHARCG6Harness.xcodeproj');
const bundleId = 'com.iabtechlab.SHARCG6Harness';
const hostPort = 18865;
const rendererPort = 18866;
const creativePort = 18867;
const creativeRendererPort = 18868;
const defaultBaseline = resolve(iosRoot, 'baselines/g5-public-fixtures.web.jsonl');
const defaultOut = resolve(repoRoot, 'tools/creative-validator/private/g6-ios-walking-skeleton/report.jsonl');
const defaultCompareOut = resolve(repoRoot, 'tools/creative-validator/private/g6-ios-walking-skeleton/compare.json');
const defaultMraidRoot = resolve(repoRoot, 'tools/creative-validator/private/g6-ios-mraid-corpus-sample');
const defaultMraidSampleOut = resolve(defaultMraidRoot, 'sample.jsonl');
const defaultMraidWebBaselineOut = resolve(defaultMraidRoot, 'web-baseline.jsonl');
const defaultMraidOut = resolve(defaultMraidRoot, 'ios-report.jsonl');
const defaultMraidCompareOut = resolve(defaultMraidRoot, 'compare.json');
const defaultMraidAnalysisOut = resolve(repoRoot, 'examples/host-apps/ios/analysis/g6-mraid-corpus-sample.md');
const defaultDeveloperDir = '/Applications/Xcode.app/Contents/Developer';
const preferredDeviceName = 'SHARC-G6';

function harnessUrl(extraParams = {}) {
  const url = new URL(`http://localhost:${hostPort}/examples/host-apps/ios/harness/index.html`);
  url.searchParams.set('creativeOrigin', `http://localhost:${creativePort}`);
  url.searchParams.set('rendererOrigin', `http://localhost:${rendererPort}`);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  return url.href;
}

function xcodeEnv() {
  return {
    ...process.env,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR || defaultDeveloperDir,
  };
}

function parseArgs(argv) {
  const out = {
    baseline: defaultBaseline,
    report: defaultOut,
    compareOut: defaultCompareOut,
    configuration: 'Debug',
    device: null,
    skipBuild: false,
    timeoutMs: 120_000,
    mraidCorpus: null,
    mraidWebReport: null,
    mraidSampleOut: defaultMraidSampleOut,
    mraidWebBaselineOut: defaultMraidWebBaselineOut,
    mraidSampleSize: 50,
    analysisOut: null,
    prepareMraidSampleOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline') out.baseline = resolve(argv[++i]);
    else if (arg === '--out') out.report = resolve(argv[++i]);
    else if (arg === '--compare-out') out.compareOut = resolve(argv[++i]);
    else if (arg === '--configuration') out.configuration = argv[++i];
    else if (arg === '--device') out.device = argv[++i];
    else if (arg === '--skip-build') out.skipBuild = true;
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--mraid-corpus') out.mraidCorpus = resolve(argv[++i]);
    else if (arg === '--mraid-web-report') out.mraidWebReport = resolve(argv[++i]);
    else if (arg === '--mraid-sample-out') out.mraidSampleOut = resolve(argv[++i]);
    else if (arg === '--mraid-web-baseline-out') out.mraidWebBaselineOut = resolve(argv[++i]);
    else if (arg === '--mraid-sample-size') out.mraidSampleSize = Number(argv[++i]);
    else if (arg === '--analysis-out') out.analysisOut = resolve(argv[++i]);
    else if (arg === '--prepare-mraid-sample-only') out.prepareMraidSampleOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.mraidCorpus) {
    if (!out.mraidWebReport) throw new Error('--mraid-web-report is required with --mraid-corpus.');
    if (!Number.isInteger(out.mraidSampleSize) || out.mraidSampleSize < 1) {
      throw new Error('--mraid-sample-size must be a positive integer.');
    }
    if (out.baseline === defaultBaseline) out.baseline = out.mraidWebBaselineOut;
    if (out.report === defaultOut) out.report = defaultMraidOut;
    if (out.compareOut === defaultCompareOut) out.compareOut = defaultMraidCompareOut;
    if (!out.analysisOut) out.analysisOut = defaultMraidAnalysisOut;
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: xcodeEnv(),
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`,
    );
  }
  return result.stdout;
}

function ensureTool(name) {
  const result = spawnSync('/usr/bin/env', ['which', name], { encoding: 'utf8', env: xcodeEnv() });
  if (result.status !== 0) {
    throw new Error(`${name} not found. The iOS walking-skeleton gate requires Xcode command line tools.`);
  }
}

function pickSimulator(requestedDevice) {
  if (requestedDevice) return requestedDevice;
  const booted = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']));
  for (const runtime of Object.values(booted.devices || {})) {
    const match = runtime.find((device) => device.isAvailable && device.state === 'Booted');
    if (match) return match.udid;
  }
  const available = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
  for (const runtime of Object.values(available.devices || {})) {
    const match = runtime.find((device) => device.isAvailable && device.name === preferredDeviceName);
    if (match) return match.udid;
  }
  for (const runtime of Object.values(available.devices || {})) {
    const match = runtime.find((device) => device.isAvailable && /iPhone/.test(device.name));
    if (match) return match.udid;
  }
  throw new Error('No available iOS Simulator device found.');
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    function attempt() {
      const req = http.get(url, (res) => {
        res.resume();
        resolvePromise();
      });
      req.on('error', (err) => {
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for ${url}: ${err.message}`));
          return;
        }
        setTimeout(attempt, 100);
      });
      req.setTimeout(1000, () => req.destroy(new Error('request timed out')));
    }
    attempt();
  });
}

function spawnServer(port, secondaryPort, label) {
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: { ...xcodeEnv(), PORT: String(port), RENDERER_PORT: String(secondaryPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) process.stderr.write(`[${label}] ${text}\n`);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) process.stderr.write(`[${label}!] ${text}\n`);
  });
  return child;
}

async function stop(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => {
    child.once('exit', resolvePromise);
    setTimeout(resolvePromise, 1500);
  });
}

function buildApp(deviceUdid, configuration) {
  const derivedDataPath = resolve(repoRoot, 'tools/creative-validator/private/g6-ios-walking-skeleton/DerivedData');
  mkdirSync(derivedDataPath, { recursive: true });
  run('xcodebuild', [
    '-project', projectPath,
    '-scheme', 'SHARCG6Harness',
    '-configuration', configuration,
    '-destination', `platform=iOS Simulator,id=${deviceUdid}`,
    '-derivedDataPath', derivedDataPath,
    'build',
  ], { stdio: 'inherit' });
  const appPath = resolve(
    derivedDataPath,
    `Build/Products/${configuration}-iphonesimulator/SHARCG6Harness.app`,
  );
  if (!existsSync(appPath)) throw new Error(`Built app not found: ${appPath}`);
  return appPath;
}

function readJsonl(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
}

function reportKey(row) {
  const testCase = row && row.case ? row.case : {};
  const source = testCase.source || {};
  const ids = testCase.ids || {};
  return JSON.stringify({
    sourceFile: source.sourceFile == null ? null : String(source.sourceFile),
    rowIndex: source.rowIndex ?? null,
    bidder: source.bidder == null ? null : String(source.bidder),
    mtype: source.mtype == null ? null : String(source.mtype),
    bidId: ids.bidId == null ? null : String(ids.bidId),
    crid: ids.crid == null ? null : String(ids.crid),
  });
}

function caseReportKey(testCase) {
  return reportKey({ case: { source: testCase.source || {}, ids: testCase.ids || {} } });
}

function stableHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

function containsMraid(testCase) {
  const declared = testCase && testCase.expectations && Array.isArray(testCase.expectations.declared)
    ? testCase.expectations.declared
    : [];
  const sniffed = testCase && testCase.expectations && Array.isArray(testCase.expectations.sniffed)
    ? testCase.expectations.sniffed
    : [];
  const apis = testCase
    && testCase.sharcOptions
    && testCase.sharcOptions.creativeMeta
    && Array.isArray(testCase.sharcOptions.creativeMeta.apis)
    ? testCase.sharcOptions.creativeMeta.apis
    : [];
  return declared.includes('mraid')
    || sniffed.includes('mraid')
    || apis.some((api) => api === 3 || api === 5 || api === 6);
}

function mraidSignalBucket(testCase) {
  const declared = testCase && testCase.expectations && Array.isArray(testCase.expectations.declared)
    ? testCase.expectations.declared
    : [];
  const sniffed = testCase && testCase.expectations && Array.isArray(testCase.expectations.sniffed)
    ? testCase.expectations.sniffed
    : [];
  if (declared.includes('mraid')) return 'declared';
  if (sniffed.includes('mraid')) return 'sniffed';
  return 'api-meta';
}

function isExecutableMraidMarkup(testCase) {
  return !!(
    testCase
    && testCase.expectations
    && testCase.expectations.execute === true
    && testCase.creative
    && testCase.creative.mode === 'adm-html'
    && typeof testCase.creative.html === 'string'
    && testCase.creative.html.length > 0
    && containsMraid(testCase)
  );
}

function sampleBucket(testCase) {
  const source = testCase.source || {};
  const creative = testCase.creative || {};
  return [
    source.bidder || 'unknown-bidder',
    creative.admKind || 'unknown-adm-kind',
    mraidSignalBucket(testCase),
  ].join('|');
}

function selectStratifiedMraidSample(cases, limit) {
  const buckets = new Map();
  for (const testCase of cases.filter(isExecutableMraidMarkup)) {
    const key = sampleBucket(testCase);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(testCase);
  }
  for (const items of buckets.values()) {
    items.sort((a, b) => stableHash(caseReportKey(a)).localeCompare(stableHash(caseReportKey(b))));
  }

  const selected = [];
  const bucketEntries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  while (selected.length < limit) {
    let added = false;
    for (const [, items] of bucketEntries) {
      const item = items.shift();
      if (!item) continue;
      selected.push(item);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return {
    selected,
    buckets: Object.fromEntries(bucketEntries.map(([key, items]) => [key, items.length])),
  };
}

function prepareMraidCorpusSample(options) {
  const cases = readJsonl(options.mraidCorpus);
  const webRows = readJsonl(options.mraidWebReport);
  const webRowsByKey = new Map(webRows.map((row) => [reportKey(row), row]));
  const eligibleCases = cases.filter((testCase) => webRowsByKey.has(caseReportKey(testCase)));
  const { selected } = selectStratifiedMraidSample(eligibleCases, options.mraidSampleSize);
  if (selected.length === 0) {
    throw new Error(`No executable MRAID markup rows found in ${options.mraidCorpus}`);
  }

  const baselineRows = [];
  const missing = [];
  for (const testCase of selected) {
    const row = webRowsByKey.get(caseReportKey(testCase));
    if (row) baselineRows.push(row);
    else missing.push({ bidder: testCase.source && testCase.source.bidder, key: caseReportKey(testCase) });
  }
  if (missing.length > 0) {
    throw new Error(`${missing.length} selected MRAID sample row(s) were missing from --mraid-web-report.`);
  }

  mkdirSync(dirname(options.mraidSampleOut), { recursive: true });
  writeFileSync(options.mraidSampleOut, selected.map((row) => JSON.stringify(row)).join('\n') + '\n');
  mkdirSync(dirname(options.baseline), { recursive: true });
  writeFileSync(options.baseline, baselineRows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  return { count: selected.length, selected, baselineRows };
}

function sanitizedId(row) {
  const source = row && row.case && row.case.source ? row.case.source : {};
  const ids = row && row.case && row.case.ids ? row.case.ids : {};
  const bidder = source.bidder || 'unknown';
  return `${bidder}-${stableHash(`${ids.bidId || ''}|${ids.crid || ''}|${source.rowIndex ?? ''}`)}`;
}

function countBy(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = fn(row) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function writeMraidAnalysis(options, comparison, selected, rows) {
  if (!options.analysisOut) return;
  const selectedByKey = new Map(selected.map((testCase) => [caseReportKey(testCase), testCase]));
  const byBidder = countBy(selected, (testCase) => testCase.source && testCase.source.bidder);
  const byAdmKind = countBy(selected, (testCase) => testCase.creative && testCase.creative.admKind);
  const bySignal = countBy(selected, mraidSignalBucket);
  const changes = comparison.verdictChanges || [];
  const lines = [
    '# G6 iOS MRAID Corpus Sample',
    '',
    'Issue: #436',
    '',
    'This sanitized operator-run note records the G6 iOS in-app MRAID corpus sample. The private normalized rows, creative markup, URLs, and full reports remain under `tools/creative-validator/private/` and are intentionally not committed.',
    '',
    '## Selection Method',
    '',
    `- Input corpus: \`${options.mraidCorpus ? 'tools/creative-validator/private/...' : 'n/a'}\``,
    `- Web baseline report: \`${options.mraidWebReport ? 'tools/creative-validator/private/...' : 'n/a'}\``,
    `- Requested sample size: ${options.mraidSampleSize}`,
    `- Selected rows: ${selected.length}`,
    '- Filter: executable Creative Markup rows (`creative.mode === "adm-html"`) with MRAID declared, sniffed, or carried in `creativeMeta.apis`.',
    '- Stratification: deterministic round-robin across `bidder | admKind | MRAID signal` buckets, with stable hash ordering inside each bucket.',
    '',
    '### Sample Buckets',
    '',
    `- By bidder: \`${JSON.stringify(byBidder)}\``,
    `- By adm kind: \`${JSON.stringify(byAdmKind)}\``,
    `- By MRAID signal: \`${JSON.stringify(bySignal)}\``,
    '',
    '## Verdict Comparison',
    '',
    `- Compared rows: ${comparison.totals.comparedRows}`,
    `- Verdict changes: ${comparison.totals.verdictChanges}`,
    `- Pass -> fail changes: ${comparison.totals.passToFail}`,
    `- SHARC-attributed pass -> fail regressions: ${comparison.totals.sharcPassToFailRegressions}`,
    `- Regression clean: ${comparison.regressionClean ? 'yes' : 'no'}`,
  ];

  if (changes.length > 0) {
    lines.push('', '### Sanitized Verdict Changes', '');
    lines.push('| row | bidder | admKind | signal | baseline -> iOS | attribution | cause |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const change of changes) {
      const testCase = selectedByKey.get(change.rowKey) || {};
      const bidder = (testCase.source && testCase.source.bidder) || change.identity.bidder || 'unknown';
      const admKind = (testCase.creative && testCase.creative.admKind) || 'unknown';
      const signal = mraidSignalBucket(testCase);
      lines.push(
        `| ${sanitizedId({ case: { source: change.identity, ids: change.identity } })} `
        + `| ${bidder} | ${admKind} | ${signal} `
        + `| ${change.before.status}/${change.before.bucket} -> ${change.after.status}/${change.after.bucket} `
        + `| ${change.attribution || 'needs-triage'} | ${change.cause || 'needs-triage'} |`,
      );
    }
  } else {
    lines.push('', 'No row-level verdict changes were observed.');
  }

  lines.push(
    '',
    '## Local Artifacts',
    '',
    '- Sample JSONL: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/sample.jsonl`',
    '- Web baseline JSONL: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/web-baseline.jsonl`',
    '- iOS report JSONL: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/ios-report.jsonl`',
    '- Comparison JSON: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/compare.json`',
    '',
  );

  mkdirSync(dirname(options.analysisOut), { recursive: true });
  writeFileSync(options.analysisOut, lines.join('\n'));
}

function driveBackgroundForeground(deviceUdid) {
  return Promise.resolve()
    // This simctl generation has no home-button subcommand. Opening a URL
    // foregrounds another app, which drives the harness app through the real
    // iOS resign/background notifications; launching our bundle brings it
    // back and drives foreground/active.
    .then(() => run('xcrun', ['simctl', 'openurl', deviceUdid, 'https://example.invalid/sharc-g6-background']))
    .then(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 900)))
    .then(() => run('xcrun', ['simctl', 'launch', deviceUdid, bundleId]));
}

function assertPhase2Rows(rows) {
  const byBidId = new Map(rows.map((row) => [row.case && row.case.ids && row.case.ids.bidId, row]));
  const lifecycle = byBidId.get('g6-ios-lifecycle-roundtrip');
  const exfil = byBidId.get('g6-ios-port-exfil-navigation');
  const expand = byBidId.get('g6-ios-expand-collapse');
  if (!lifecycle || lifecycle.outcome.status !== 'passed' || lifecycle.outcome.bucket !== 'passed') {
    throw new Error('G6 phase-2 lifecycle round-trip row did not pass.');
  }
  if (!exfil || exfil.outcome.status !== 'failed' || exfil.outcome.bucket !== 'navigation-policy') {
    throw new Error('G6 phase-2 port-exfil navigation row did not fail closed with navigation-policy.');
  }
  if (!expand || expand.outcome.status !== 'passed' || expand.outcome.bucket !== 'passed') {
    throw new Error('G6 phase-2 expand/collapse row did not pass.');
  }
}

function launchAndCollect(deviceUdid, timeoutMs, url) {
  return new Promise((resolvePromise, reject) => {
    const rows = [];
    let summary = null;
    let buffer = '';
    let drivingLifecycle = false;
    const child = spawn('xcrun', [
      'simctl',
      'launch',
      '--console',
      '--terminate-running-process',
      deviceUdid,
      bundleId,
      '--harness-url',
      url,
    ], { cwd: repoRoot, env: xcodeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out waiting for iOS harness after ${timeoutMs}ms`));
    }, timeoutMs);

    function consume(text) {
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line || line[0] !== '{') continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch (_) { continue; }
        if (parsed.type === 'summary') summary = parsed;
        else if (parsed.type === 'control' && parsed.action === 'backgroundForeground' && !drivingLifecycle) {
          drivingLifecycle = true;
          driveBackgroundForeground(deviceUdid).catch((err) => {
            child.kill('SIGTERM');
            reject(err);
          });
        }
        else if (parsed.case && parsed.outcome) rows.push(parsed);
      }
    }

    child.stdout.on('data', (chunk) => consume(String(chunk)));
    child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && rows.length === 0) {
        reject(new Error(`iOS harness exited with code ${code}`));
        return;
      }
      resolvePromise({ rows, summary, code });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.prepareMraidSampleOnly) {
    if (!options.mraidCorpus) throw new Error('--prepare-mraid-sample-only requires --mraid-corpus.');
    const prepared = prepareMraidCorpusSample(options);
    console.log(`Prepared ${prepared.count} MRAID sample row(s): ${options.mraidSampleOut}`);
    return;
  }

  ensureTool('xcrun');
  ensureTool('xcodebuild');
  if (!existsSync(resolve(repoRoot, 'dist/sharc-container.mjs'))) {
    throw new Error('dist/ missing. Run `npm run build` before the iOS walking-skeleton gate.');
  }

  const deviceUdid = pickSimulator(options.device);
  const boot = spawnSync('xcrun', ['simctl', 'boot', deviceUdid], {
    cwd: repoRoot,
    env: xcodeEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (boot.status !== 0 && !/current state:\s*Booted/i.test(`${boot.stdout}\n${boot.stderr}`)) {
    throw new Error(`xcrun simctl boot ${deviceUdid} failed\n${boot.stdout || ''}${boot.stderr || ''}`);
  }
  run('xcrun', ['simctl', 'bootstatus', deviceUdid, '-b'], { stdio: 'inherit' });

  const mraidSample = options.mraidCorpus ? prepareMraidCorpusSample(options) : null;
  const extraHarnessParams = mraidSample
    ? { mraidCorpus: relative(repoRoot, options.mraidSampleOut) }
    : {};
  const launchUrl = harnessUrl(extraHarnessParams);
  const hostServer = spawnServer(hostPort, rendererPort, 'host');
  const creativeServer = spawnServer(creativePort, creativeRendererPort, 'creative');
  try {
    await waitForServer(`http://localhost:${hostPort}/`, 10_000);
    await waitForServer(`http://localhost:${creativePort}/`, 10_000);
    const appPath = options.skipBuild
      ? resolve(repoRoot, 'tools/creative-validator/private/g6-ios-walking-skeleton/DerivedData/Build/Products/Debug-iphonesimulator/SHARCG6Harness.app')
      : buildApp(deviceUdid, options.configuration);
    run('xcrun', ['simctl', 'install', deviceUdid, appPath]);
    const { rows, summary, code } = await launchAndCollect(deviceUdid, options.timeoutMs, launchUrl);
    if (!summary) throw new Error('Harness did not emit terminal summary.');
    if (summary.status === 'failed') throw new Error(`Harness failed: ${summary.reason || 'unknown failure'}`);
    if (code !== 0) throw new Error(`Harness exited with code ${code}`);

    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(options.report, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const baselineRows = readJsonl(options.baseline);
    const comparison = compareReportVerdicts(baselineRows, rows, {
      baselineLabel: options.baseline,
      currentLabel: options.report,
    });
    mkdirSync(dirname(options.compareOut), { recursive: true });
    writeFileSync(options.compareOut, JSON.stringify(comparison, null, 2) + '\n');

    if (mraidSample) writeMraidAnalysis(options, comparison, mraidSample.selected, rows);

    if (rows.length !== baselineRows.length) {
      throw new Error(`Row-count parity failed: baseline=${baselineRows.length}, ios=${rows.length}`);
    }
    if (!comparison.regressionClean || comparison.totals.verdictChanges !== 0) {
      throw new Error(`iOS verdict comparison failed. See ${options.compareOut}`);
    }
    if (!mraidSample) assertPhase2Rows(rows);
    console.log(`iOS walking skeleton passed: ${rows.length} row(s), identical verdicts. Report: ${options.report}`);
  } finally {
    await stop(hostServer);
    await stop(creativeServer);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
