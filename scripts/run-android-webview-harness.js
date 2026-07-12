#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReportVerdicts } from '../tools/creative-validator/src/regression.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const androidRoot = resolve(repoRoot, 'examples/host-apps/android');
const packageName = 'com.iabtechlab.sharcg6harness';
const activityName = `${packageName}/.MainActivity`;
const hostPort = 18865;
const rendererPort = 18866;
const creativePort = 18867;
const creativeRendererPort = 18868;
const defaultBaseline = resolve(androidRoot, 'baselines/g5-public-fixtures.web.jsonl');
const defaultOut = resolve(repoRoot, 'tools/creative-validator/private/g6-android-webview/report.jsonl');
const defaultCompareOut = resolve(repoRoot, 'tools/creative-validator/private/g6-android-webview/compare.json');
const defaultApk = resolve(androidRoot, 'app/build/outputs/apk/debug/app-debug.apk');
const emulatorHost = process.env.ANDROID_EMULATOR_HOST || '10.0.2.2';
const harnessUrl = `http://${emulatorHost}:${hostPort}/examples/host-apps/android/harness/index.html?creativeOrigin=${encodeURIComponent(`http://${emulatorHost}:${creativePort}`)}`;

function parseArgs(argv) {
  const out = {
    baseline: defaultBaseline,
    report: defaultOut,
    compareOut: defaultCompareOut,
    device: null,
    apk: defaultApk,
    skipBuild: false,
    timeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline') out.baseline = resolve(argv[++i]);
    else if (arg === '--out') out.report = resolve(argv[++i]);
    else if (arg === '--compare-out') out.compareOut = resolve(argv[++i]);
    else if (arg === '--device') out.device = argv[++i];
    else if (arg === '--apk') out.apk = resolve(argv[++i]);
    else if (arg === '--skip-build') out.skipBuild = true;
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: process.env,
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
  const result = spawnSync('/usr/bin/env', ['which', name], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${name} not found. The Android WebView harness requires Android command-line tools.`);
  }
}

function adbArgs(device, args) {
  return device ? ['-s', device, ...args] : args;
}

function adb(device, args, options = {}) {
  return run('adb', adbArgs(device, args), options);
}

function pickDevice(requestedDevice) {
  if (requestedDevice) return requestedDevice;
  const out = run('adb', ['devices']);
  const devices = out.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
  if (devices.length > 0) return devices[0];
  throw new Error('No connected Android emulator/device found. Start an emulator or pass --device <serial>.');
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
    env: { ...process.env, PORT: String(port), RENDERER_PORT: String(secondaryPort) },
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

function buildApp() {
  const gradle = process.env.GRADLE || 'gradle';
  run(gradle, [':app:assembleDebug'], { cwd: androidRoot, stdio: 'inherit' });
  if (!existsSync(defaultApk)) throw new Error(`Built APK not found: ${defaultApk}`);
  return defaultApk;
}

function readJsonl(file) {
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
}

function driveBackgroundForeground(device) {
  return Promise.resolve()
    .then(() => adb(device, ['shell', 'input', 'keyevent', 'KEYCODE_HOME']))
    .then(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 900)))
    .then(() => adb(device, [
      'shell', 'am', 'start',
      '-n', activityName,
      '--es', 'harness-url', harnessUrl,
    ]));
}

function assertPhase2Rows(rows) {
  const byBidId = new Map(rows.map((row) => [row.case && row.case.ids && row.case.ids.bidId, row]));
  const lifecycle = byBidId.get('g6-android-lifecycle-roundtrip');
  const exfil = byBidId.get('g6-android-port-exfil-navigation');
  const expand = byBidId.get('g6-android-expand-collapse');
  if (!lifecycle || lifecycle.outcome.status !== 'passed' || lifecycle.outcome.bucket !== 'passed') {
    throw new Error('G6 Android phase-2 lifecycle round-trip row did not pass.');
  }
  if (!exfil || exfil.outcome.status !== 'failed' || exfil.outcome.bucket !== 'navigation-policy') {
    throw new Error('G6 Android phase-2 port-exfil navigation row did not fail closed with navigation-policy.');
  }
  if (!expand || expand.outcome.status !== 'passed' || expand.outcome.bucket !== 'passed') {
    throw new Error('G6 Android phase-2 expand/collapse row did not pass.');
  }
}

function launchAndCollect(device, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const rows = [];
    let summary = null;
    let buffer = '';
    let drivingLifecycle = false;
    let settled = false;

    adb(device, ['logcat', '-c']);
    const logcat = spawn('adb', adbArgs(device, ['logcat', '-v', 'raw', 'SHARC_G6:I', 'AndroidRuntime:E', '*:S']), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for Android harness after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logcat.kill('SIGTERM');
      if (err) reject(err);
      else resolvePromise({ rows, summary });
    }

    function consume(text) {
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line || line[0] !== '{') continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch (_) { continue; }
        if (parsed.type === 'summary') {
          summary = parsed;
          setTimeout(() => finish(), 100);
        } else if (parsed.type === 'control' && parsed.action === 'backgroundForeground' && !drivingLifecycle) {
          drivingLifecycle = true;
          driveBackgroundForeground(device).catch(finish);
        } else if (parsed.case && parsed.outcome) {
          rows.push(parsed);
        }
      }
    }

    logcat.stdout.on('data', (chunk) => consume(String(chunk)));
    logcat.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
    logcat.on('error', finish);

    try {
      adb(device, ['shell', 'am', 'force-stop', packageName]);
      adb(device, [
        'shell', 'am', 'start',
        '-n', activityName,
        '--es', 'harness-url', harnessUrl,
      ]);
    } catch (err) {
      finish(err);
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureTool('adb');
  if (!options.skipBuild) ensureTool(process.env.GRADLE || 'gradle');
  if (!existsSync(resolve(repoRoot, 'dist/sharc-container.mjs'))) {
    throw new Error('dist/ missing. Run `npm run build` before the Android WebView harness gate.');
  }

  const device = pickDevice(options.device);
  const apk = options.skipBuild ? options.apk : buildApp();
  if (!existsSync(apk)) throw new Error(`APK not found: ${apk}`);

  const hostServer = spawnServer(hostPort, rendererPort, 'host');
  const creativeServer = spawnServer(creativePort, creativeRendererPort, 'creative');
  try {
    await waitForServer(`http://localhost:${hostPort}/`, 10_000);
    await waitForServer(`http://localhost:${creativePort}/`, 10_000);
    adb(device, ['install', '-r', apk], { stdio: 'inherit' });
    const { rows, summary } = await launchAndCollect(device, options.timeoutMs);
    if (!summary) throw new Error('Harness did not emit terminal summary.');
    if (summary.status === 'failed') throw new Error(`Harness failed: ${summary.reason || 'unknown failure'}`);

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
      throw new Error(`Row-count parity failed: baseline=${baselineRows.length}, android=${rows.length}`);
    }
    if (!comparison.regressionClean || comparison.totals.verdictChanges !== 0) {
      throw new Error(`Android verdict comparison failed. See ${options.compareOut}`);
    }
    assertPhase2Rows(rows);
    console.log(`Android WebView harness passed: ${rows.length} row(s), identical verdicts. Report: ${options.report}`);
  } finally {
    await stop(hostServer);
    await stop(creativeServer);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
