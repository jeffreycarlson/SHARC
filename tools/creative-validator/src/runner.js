/**
 * @file Creative validator SHARC Markup runner.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  classifyOutcome,
  expectedBridges,
  isCorsConsole,
  isCspConsole,
  makeEmptyRun,
} from './diagnose.js';

const DEFAULT_PORT = 18865;
const DEFAULT_RENDERER_PORT = 18866;
const DEFAULT_RENDER_TIMEOUT_MS = 10_000;
const DEFAULT_SETTLE_MS = 2_000;

function parsePort(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port '${raw}' — must be an integer in 1..65535.`);
  }
  return n;
}

function resolveChromePath() {
  const fromEnv = process.env.CHROME_PATH
    || process.env.CHROME_EXECUTABLE_PATH
    || process.env.BROWSER_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`Chrome executable override does not exist: ${fromEnv}`);
    }
    return fromEnv;
  }

  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ]
    : process.platform === 'linux'
    ? [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ]
    : process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : [];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  throw new Error(
    'Unable to locate Chrome/Chromium. Set CHROME_PATH, '
    + 'CHROME_EXECUTABLE_PATH, BROWSER_PATH, or PUPPETEER_EXECUTABLE_PATH.',
  );
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
      req.setTimeout(1000, () => {
        req.destroy(new Error('request timed out'));
      });
    }
    attempt();
  });
}

async function withServer(options, body) {
  let serverStdout = '';
  let serverStderr = '';
  let stopping = false;
  const server = spawn(process.execPath, ['server.cjs'], {
    cwd: options.repoRoot,
    env: {
      ...process.env,
      PORT: String(options.port),
      RENDERER_PORT: String(options.rendererPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitError = (code, signal) => new Error(
    `Dev server exited unexpectedly (code=${code}, signal=${signal}).\n`
    + serverStdout
    + serverStderr,
  );

  server.stdout.on('data', (chunk) => {
    serverStdout += String(chunk);
    const text = String(chunk).trim();
    if (options.verbose && text) console.log('[server]', text);
  });
  server.stderr.on('data', (chunk) => {
    serverStderr += String(chunk);
    const text = String(chunk).trim();
    if (options.verbose && text) console.error('[server!]', text);
  });

  try {
    let serverReady = false;
    const earlyExit = new Promise((_, reject) => {
      server.once('exit', (code, signal) => {
        if (serverReady) return;
        reject(exitError(code, signal));
      });
    });
    await Promise.race([
      waitForServer(options.baseUrl + '/', 10_000).then(() => { serverReady = true; }),
      earlyExit,
    ]);
    const midRunExit = new Promise((_, reject) => {
      server.once('exit', (code, signal) => {
        if (!stopping) reject(exitError(code, signal));
      });
    });
    return await Promise.race([body(), midRunExit]);
  } finally {
    stopping = true;
    server.kill('SIGTERM');
    await new Promise((resolvePromise) => {
      const done = () => resolvePromise();
      server.once('exit', done);
      setTimeout(done, 1500);
    });
  }
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Failed to parse ${file} line ${index + 1}: ${err.message}`);
      }
    });
}

function summarizeCase(testCase) {
  return {
    source: testCase.source,
    ids: testCase.ids,
    creative: {
      mode: testCase.creative && testCase.creative.mode,
      admKind: testCase.creative && testCase.creative.admKind,
      width: testCase.creative && testCase.creative.width,
      height: testCase.creative && testCase.creative.height,
      placementType: testCase.creative && testCase.creative.placementType,
      transformations: testCase.creative && testCase.creative.transformations,
    },
    expectations: testCase.expectations,
    bidSignals: {
      apis: testCase.bidSignals && testCase.bidSignals.apis,
      mtype: testCase.bidSignals && testCase.bidSignals.mtype,
      measurement: testCase.bidSignals && testCase.bidSignals.measurement,
    },
  };
}

function summarizeConsoleMessage(msg) {
  const type = msg.type();
  if (type === 'debug' || type === 'info') return null;
  return {
    type,
    text: msg.text()
      .replace(/https?:\/\/\S+/g, '[url]')
      .slice(0, 240),
  };
}

function summarizePageError(err) {
  return {
    message: String(err && err.message ? err.message : err).slice(0, 500),
  };
}

function summarizeRequestUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.slice(0, 500);
  } catch (_) {
    return String(url).split('?')[0].slice(0, 500);
  }
}

function summarizeRequestOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (_) {
    return 'unknown';
  }
}

function isLegacyMraidLoaderUrl(url) {
  try {
    const parsed = new URL(url, 'http://validator.invalid/');
    const parts = parsed.pathname.toLowerCase().split('/');
    return parts[parts.length - 1] === 'mraid.js';
  } catch (_) {
    const pathname = String(url || '').split('?')[0].toLowerCase();
    return pathname.endsWith('/mraid.js') || pathname === 'mraid.js';
  }
}

function summarizeScriptUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      present: true,
      protocol: parsed.protocol,
      origin: parsed.origin === 'null' ? null : parsed.origin,
      legacyMraidLoader: isLegacyMraidLoaderUrl(url),
    };
  } catch (_) {
    return {
      present: true,
      protocol: 'invalid',
      origin: null,
      legacyMraidLoader: isLegacyMraidLoaderUrl(url),
    };
  }
}

function hashUrl(url) {
  const text = String(url || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function isFaviconRequest(url) {
  try {
    return new URL(url).pathname === '/favicon.ico';
  } catch (_) {
    return false;
  }
}

function incrementBucket(map, key) {
  const normalized = key || 'unknown';
  map[normalized] = (map[normalized] || 0) + 1;
}

function consoleFacet(messages, kind) {
  const match = kind === 'cors' ? isCorsConsole : kind === 'csp' ? isCspConsole : null;
  if (!match) return [];
  return (messages || []).filter((msg) => match(msg && msg.text ? msg.text : ''));
}

function summarizeNetwork(run) {
  const failedRequests = run.failedRequests || [];
  const failedResponses = run.failedResponses || [];
  const byResourceType = {};
  const byOrigin = {};
  const byStatus = {};

  for (const request of failedRequests) {
    incrementBucket(byResourceType, request.resourceType);
    incrementBucket(byOrigin, summarizeRequestOrigin(request.url));
  }
  // Transport-level failures do not have HTTP status codes; byStatus is
  // intentionally limited to completed responses with status >= 400.
  for (const response of failedResponses) {
    incrementBucket(byResourceType, response.resourceType);
    incrementBucket(byOrigin, summarizeRequestOrigin(response.url));
    incrementBucket(byStatus, String(response.status));
  }

  const corsConsole = consoleFacet(run.consoleMessages, 'cors');
  const cspConsole = consoleFacet(run.consoleMessages, 'csp');
  return {
    failedRequestCount: failedRequests.length,
    failedResponseCount: failedResponses.length,
    corsConsoleCount: corsConsole.length,
    cspConsoleCount: cspConsole.length,
    byResourceType,
    byOrigin,
    byStatus,
    corsConsole,
    cspConsole,
  };
}

function scriptKey(url) {
  if (!url || url.present !== true) return 'unknown|unknown';
  return `${url.protocol || 'unknown'}|${url.origin || 'unknown'}`;
}

function scriptCallKey(call) {
  return call && call.urlHash ? `hash:${call.urlHash}` : scriptKey(call && call.url);
}

function scriptOutcomeKey(outcome) {
  return outcome && outcome.urlHash ? `hash:${outcome.urlHash}` : scriptKey(outcome && outcome.url);
}

function backfillScriptLoadDiagnostics(navigationDiagnostics, scriptOutcomes) {
  const scriptLoads = navigationDiagnostics && navigationDiagnostics.scriptLoads;
  if (!scriptLoads || !Array.isArray(scriptLoads.calls)) return;

  const legacyMraidByKey = {};
  for (const outcome of scriptOutcomes) {
    if (outcome && outcome.url && outcome.url.legacyMraidLoader === true) {
      legacyMraidByKey[scriptOutcomeKey(outcome)] = true;
    }
  }
  for (const call of scriptLoads.calls) {
    if (call && call.url && legacyMraidByKey[scriptCallKey(call)] === true) {
      call.url.legacyMraidLoader = true;
    }
  }

  const terminalByKey = {};
  for (const call of scriptLoads.calls) {
    if (!call || (call.status !== 'loaded' && call.status !== 'error')) continue;
    incrementBucket(terminalByKey, scriptCallKey(call));
  }

  const outcomesByKey = {};
  for (const outcome of scriptOutcomes) {
    const key = scriptOutcomeKey(outcome);
    if (!outcomesByKey[key]) outcomesByKey[key] = [];
    outcomesByKey[key].push(outcome);
  }

  for (const call of scriptLoads.calls) {
    if (!call || call.status !== 'discovered') continue;
    const key = scriptCallKey(call);
    if (terminalByKey[key] > 0) {
      terminalByKey[key] -= 1;
      continue;
    }
    const outcomes = outcomesByKey[key] || [];
    const outcome = outcomes.shift();
    if (!outcome) continue;
    const status = outcome.status >= 400 || outcome.failed === true ? 'error' : 'loaded';
    if (status === 'loaded') scriptLoads.loadedCount += 1;
    else scriptLoads.errorCount += 1;
    scriptLoads.byStatus[status] = (scriptLoads.byStatus[status] || 0) + 1;
    if (scriptLoads.calls.length < 20) {
      scriptLoads.calls.push({
        status,
        lifecycle: call.lifecycle || {},
        url: outcome.url || call.url || {},
        async: call.async === true,
        defer: call.defer === true,
        type: call.type || '',
      });
    }
  }
  for (const call of scriptLoads.calls) {
    if (call && Object.prototype.hasOwnProperty.call(call, 'urlHash')) {
      delete call.urlHash;
    }
  }
}

function bridgeSignalList(testCase, name) {
  const values = testCase
    && testCase.expectations
    && Array.isArray(testCase.expectations[name])
    ? testCase.expectations[name]
    : [];
  return values.map((value) => String(value).toLowerCase());
}

function shouldAliasLegacyMraidLoader(testCase) {
  return expectedBridges(testCase).includes('mraid');
}

async function installLegacyMraidLoaderAlias(page, testCase) {
  if (!shouldAliasLegacyMraidLoader(testCase)) return;
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    try {
      if (typeof request.isInterceptResolutionHandled === 'function'
          && request.isInterceptResolutionHandled()) {
        return;
      }
      if (request.resourceType() === 'script' && isLegacyMraidLoaderUrl(request.url())) {
        await request.respond({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          body: '/* SHARC validator: legacy mraid.js satisfied by injected window.mraid bridge. */\n',
        });
        return;
      }
      await request.continue();
    } catch (_) {
      try {
        await request.continue();
      } catch (_) {
        // Page teardown can race with late ad-network requests. The run-level
        // diagnostics are already collected from completed/failed requests.
      }
    }
  });
}

function summarizeLegacyMraidLoader(testCase, run) {
  const declared = bridgeSignalList(testCase, 'declared').includes('mraid');
  const sniffed = bridgeSignalList(testCase, 'sniffed').includes('mraid');
  const summary = {
    requested: false,
    count: 0,
    loadedCount: 0,
    errorCount: 0,
    byStatus: {},
    byProtocol: {},
    byOrigin: {},
    signal: {
      declared,
      sniffed,
      runtimeOnly: false,
    },
  };
  const scriptLoads = run
    && run.navigationDiagnostics
    && run.navigationDiagnostics.scriptLoads;
  const calls = scriptLoads && Array.isArray(scriptLoads.calls) ? scriptLoads.calls : [];
  const scriptOutcomes = run && Array.isArray(run.scriptOutcomes) ? run.scriptOutcomes : [];
  const discoveredByKey = {};
  const terminalByKey = {};

  for (const call of calls) {
    if (!call || !call.url || call.url.legacyMraidLoader !== true) continue;
    const status = call.status || 'unknown';
    const key = scriptCallKey(call);
    incrementBucket(summary.byStatus, status);
    incrementBucket(summary.byProtocol, call.url.protocol);
    incrementBucket(summary.byOrigin, call.url.origin);
    if (status === 'discovered') {
      incrementBucket(discoveredByKey, key);
      summary.count += 1;
    } else if (status === 'loaded') {
      incrementBucket(terminalByKey, key);
      summary.loadedCount += 1;
    } else if (status === 'error') {
      incrementBucket(terminalByKey, key);
      summary.errorCount += 1;
    }
  }

  for (const outcome of scriptOutcomes) {
    if (!outcome || !outcome.url || outcome.url.legacyMraidLoader !== true) continue;
    const key = scriptOutcomeKey(outcome);
    const status = outcome.status >= 400 || outcome.failed === true ? 'error' : 'loaded';
    if (discoveredByKey[key] > 0) {
      discoveredByKey[key] -= 1;
    } else {
      summary.count += 1;
    }
    if (terminalByKey[key] > 0) {
      terminalByKey[key] -= 1;
      continue;
    }
    incrementBucket(summary.byStatus, status);
    incrementBucket(summary.byProtocol, outcome.url.protocol);
    incrementBucket(summary.byOrigin, outcome.url.origin);
    if (status === 'loaded') summary.loadedCount += 1;
    else if (status === 'error') summary.errorCount += 1;
  }

  if (summary.count === 0 && summary.loadedCount === 0 && summary.errorCount === 0) {
    const failedScripts = [
      ...((run && run.failedRequests) || []),
      ...((run && run.failedResponses) || []),
    ].filter((entry) => entry && entry.resourceType === 'script' && isLegacyMraidLoaderUrl(entry.url));
    for (const entry of failedScripts) {
      summary.count += 1;
      summary.errorCount += 1;
      incrementBucket(summary.byStatus, entry.status ? String(entry.status) : 'error');
      incrementBucket(summary.byOrigin, summarizeRequestOrigin(entry.url));
    }
  }

  summary.requested = summary.count > 0 || summary.loadedCount > 0 || summary.errorCount > 0;
  summary.signal.runtimeOnly = summary.requested && !declared && !sniffed;
  return summary;
}

function chromeLaunchArgs() {
  if (process.env.SHARC_VALIDATOR_CHROME_NO_SANDBOX === '1') {
    console.error(
      '[creative-validator] WARNING: launching Chrome with OS sandbox disabled. '
      + 'Only use SHARC_VALIDATOR_CHROME_NO_SANDBOX=1 inside a disposable VM/container.',
    );
    return ['--no-sandbox', '--disable-setuid-sandbox'];
  }
  return [];
}

async function runExecutableCase(browser, testCase, options) {
  const context = typeof browser.createBrowserContext === 'function'
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  // Allows page.goto + in-page render/settle work to report cleanly before
  // Puppeteer aborts the evaluate call itself.
  page.setDefaultTimeout(options.renderTimeoutMs + options.settleMs + 5_000);

  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const failedResponses = [];
  const scriptOutcomes = [];

  await installLegacyMraidLoaderAlias(page, testCase);

  page.on('console', (msg) => {
    const summarized = summarizeConsoleMessage(msg);
    if (summarized) consoleMessages.push(summarized);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(summarizePageError(err));
  });
  page.on('requestfailed', (request) => {
    if (isFaviconRequest(request.url())) return;
    const failure = request.failure();
    failedRequests.push({
      url: summarizeRequestUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      errorText: failure ? failure.errorText : '',
    });
    if (request.resourceType() === 'script') {
      scriptOutcomes.push({
        urlHash: hashUrl(request.url()),
        url: summarizeScriptUrl(request.url()),
        failed: true,
        status: 0,
      });
    }
  });
  page.on('requestfinished', (request) => {
    if (isFaviconRequest(request.url())) return;
    if (request.resourceType() !== 'script') return;
    const response = request.response();
    scriptOutcomes.push({
      urlHash: hashUrl(request.url()),
      url: summarizeScriptUrl(request.url()),
      failed: false,
      status: response ? response.status() : 0,
    });
  });
  page.on('response', (response) => {
    const status = response.status();
    const request = response.request();
    if (status < 400) return;
    if (isFaviconRequest(response.url())) return;
    failedResponses.push({
      url: summarizeRequestUrl(response.url()),
      status,
      statusText: response.statusText(),
      method: request.method(),
      resourceType: request.resourceType(),
    });
  });

  try {
    await page.goto(options.harnessUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.renderTimeoutMs,
    });
    const hasHarness = await page.evaluate(() =>
      Boolean(window.__sharcCreativeValidatorHarness
        && typeof window.__sharcCreativeValidatorHarness.runCase === 'function'));
    if (!hasHarness) {
      return {
        constructionError: 'validator harness did not initialize',
        loadError: null,
        timedOut: false,
        creativeRendered: false,
        creativeInjected: false,
        terminated: false,
        finalState: null,
        placementSessionId: null,
        durationMs: 0,
        stateHistory: [],
        securityEvents: [],
        errors: [],
        navigationEvents: [],
        interactionEvents: [],
        messages: [],
        bridgeProbes: [],
        navigationDiagnostics: null,
        measurement: { omid: null },
        consoleMessages,
        pageErrors,
        failedRequests,
        failedResponses,
        scriptOutcomes,
      };
    }

    const run = await page.evaluate(
      (item, runOptions) => window.__sharcCreativeValidatorHarness.runCase(item, runOptions),
      testCase,
      {
        creativeSdkUrl: options.creativeSdkUrl,
        omidAutoInstall: options.omidAutoInstall,
        rendererUrl: options.rendererUrl,
        renderTimeoutMs: options.renderTimeoutMs,
        settleMs: options.settleMs,
      },
    );
    backfillScriptLoadDiagnostics(run.navigationDiagnostics, scriptOutcomes);
    return {
      ...run,
      consoleMessages,
      pageErrors,
      failedRequests,
      failedResponses,
      scriptOutcomes,
    };
  } catch (err) {
    return makeEmptyRun({
      constructionError: `runner page execution failed: ${err && err.message ? err.message : String(err)}`,
      consoleMessages,
      pageErrors,
      failedRequests,
      failedResponses,
      scriptOutcomes,
    });
  } finally {
    await context.close();
  }
}

async function runCase(browser, testCase, options) {
  const run = testCase.expectations && testCase.expectations.execute === true
    ? await runExecutableCase(browser, testCase, options)
    : makeEmptyRun();
  return buildReport(testCase, run);
}

function buildReport(testCase, run) {
  const outcome = classifyOutcome(testCase, run);
  return {
    case: summarizeCase(testCase),
    outcome: {
      ...outcome,
      durationMs: run.durationMs,
      creativeRendered: run.creativeRendered,
      creativeInjected: run.creativeInjected,
      terminated: run.terminated,
      finalState: run.finalState,
      reachedActive: run.stateHistory.some((entry) => entry.to === 'active'),
    },
    diagnostics: {
      placementSessionId: run.placementSessionId,
      constructionError: run.constructionError,
      loadError: run.loadError,
      timedOut: run.timedOut,
      stateHistory: run.stateHistory,
      securityEvents: run.securityEvents,
      errors: run.errors,
      navigationEvents: run.navigationEvents,
      interactionEvents: run.interactionEvents,
      messages: run.messages,
      bridgeProbes: run.bridgeProbes,
      navigationDiagnostics: run.navigationDiagnostics,
      measurement: run.measurement,
      console: run.consoleMessages,
      pageErrors: run.pageErrors,
      failedRequests: run.failedRequests,
      failedResponses: run.failedResponses,
      network: summarizeNetwork(run),
      legacyMraidLoader: summarizeLegacyMraidLoader(testCase, run),
    },
  };
}

async function runNormalizedCases(inputFile, outFile, options = {}) {
  const repoRoot = resolve(options.repoRoot || '.');
  const port = parsePort(options.port, DEFAULT_PORT);
  const rendererPort = parsePort(options.rendererPort, DEFAULT_RENDERER_PORT);
  const baseUrl = `http://localhost:${port}`;
  const rendererUrl = options.rendererUrl
    || `http://localhost:${rendererPort}/examples/renderer/`;
  const creativeSdkUrl = new URL('/dist/sharc-creative.js', rendererUrl).href;
  const harnessUrl = `${baseUrl}/tools/creative-validator/harness/markup-runner.html`;
  const omidAutoInstall = {
    partnerName: 'SHARC Creative Validator',
    partnerVersion: '0.0.0',
    creativeType: 'display',
    mediaType: 'display',
    impressionType: 'beginToRender',
    omSdkServiceScriptUrl: 'https://omid.validator.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://omid.validator.example/omid-session-client-v1.js',
  };
  const cases = readJsonl(inputFile);
  const runOptions = {
    repoRoot,
    port,
    rendererPort,
    baseUrl,
    creativeSdkUrl,
    omidAutoInstall,
    rendererUrl,
    harnessUrl,
    renderTimeoutMs: options.renderTimeoutMs || DEFAULT_RENDER_TIMEOUT_MS,
    settleMs: options.settleMs || DEFAULT_SETTLE_MS,
    verbose: options.verbose === true,
  };

  mkdirSync(dirname(outFile), { recursive: true });
  const stream = createWriteStream(outFile, { encoding: 'utf8' });
  let count = 0;
  let streamError = null;
  stream.on('error', (err) => { streamError = err; });

  try {
    await withServer(runOptions, async () => {
      const chromePath = resolveChromePath();
      const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: true,
        args: chromeLaunchArgs(),
      });

      try {
        for (const testCase of cases) {
          let report;
          try {
            report = await runCase(browser, testCase, runOptions);
          } catch (err) {
            report = buildReport(testCase, makeEmptyRun({
              constructionError: `runner case failed: ${err && err.message ? err.message : String(err)}`,
            }));
          }
          stream.write(JSON.stringify(report) + '\n');
          if (streamError) throw streamError;
          count++;
        }
      } finally {
        await browser.close();
      }
    });
  } catch (err) {
    stream.destroy();
    throw err;
  }

  await new Promise((resolvePromise, reject) => {
    stream.end(() => {
      if (streamError) reject(streamError);
      else resolvePromise();
    });
  });

  return { count, outFile };
}

export {
  DEFAULT_RENDER_TIMEOUT_MS,
  DEFAULT_SETTLE_MS,
  classifyOutcome,
  readJsonl,
  runNormalizedCases,
};
