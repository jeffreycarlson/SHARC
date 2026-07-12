#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
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
const harnessUrl = `http://localhost:${hostPort}/examples/host-apps/ios/harness/index.html?creativeOrigin=${encodeURIComponent(`http://localhost:${creativePort}`)}`;
const defaultDeveloperDir = '/Applications/Xcode.app/Contents/Developer';
const preferredDeviceName = 'SHARC-G6';

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
    else throw new Error(`Unknown argument: ${arg}`);
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

function launchAndCollect(deviceUdid, timeoutMs) {
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
      harnessUrl,
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

  const hostServer = spawnServer(hostPort, rendererPort, 'host');
  const creativeServer = spawnServer(creativePort, creativeRendererPort, 'creative');
  try {
    await waitForServer(`http://localhost:${hostPort}/`, 10_000);
    await waitForServer(`http://localhost:${creativePort}/`, 10_000);
    const appPath = options.skipBuild
      ? resolve(repoRoot, 'tools/creative-validator/private/g6-ios-walking-skeleton/DerivedData/Build/Products/Debug-iphonesimulator/SHARCG6Harness.app')
      : buildApp(deviceUdid, options.configuration);
    run('xcrun', ['simctl', 'install', deviceUdid, appPath]);
    const { rows, summary, code } = await launchAndCollect(deviceUdid, options.timeoutMs);
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

    if (rows.length !== baselineRows.length) {
      throw new Error(`Row-count parity failed: baseline=${baselineRows.length}, ios=${rows.length}`);
    }
    if (!comparison.regressionClean || comparison.totals.verdictChanges !== 0) {
      throw new Error(`iOS verdict comparison failed. See ${options.compareOut}`);
    }
    assertPhase2Rows(rows);
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
