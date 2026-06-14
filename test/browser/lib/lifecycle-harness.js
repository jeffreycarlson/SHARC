/**
 * lifecycle-harness.js — productionized lifecycle-ordering capture harness.
 *
 * Promotes the throwaway `spike-lifecycle-*` mechanics into a reusable module
 * for the Slice A (load-anchored cascade) validator tests. Same toolchain the
 * spikes proved out:
 *   - puppeteer-core → system Chrome (override via CHROME_PATH).
 *   - server.cjs dual-origin dev server (publisher PORT, renderer RENDERER_PORT).
 *   - CDP browser-level Target.setAutoAttach + Runtime.consoleAPICalled so the
 *     null-origin / cross-origin creative-iframe console is captured, not just
 *     the top page.
 *
 * KEY UPGRADE over the spikes: every captured line carries the CDP
 * `Runtime.consoleAPICalled` `timestamp` (a monotonic wall-clock in ms shared
 * across ALL targets — top page, creative iframe, cross-origin renderer). This
 * gives ONE cross-frame timebase so we can assert the inter-event GAP
 * (e.g. `t[createSession] − t[window 'load'] < 50ms`) across frames that do not
 * share a `performance.now()` origin. The spikes could only eyeball Date.now().
 *
 * This module contains NO assertions and NO production code — it is pure test
 * infrastructure. The contract assertions live in the test files that import it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..', '..', '..');

export function parsePort(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port '${raw}'`);
  }
  return n;
}

export const PORT = parsePort(process.env.PORT, 18799);
export const RENDERER_PORT = parsePort(process.env.RENDERER_PORT, PORT + 1);
export const BASE_URL = `http://localhost:${PORT}`;
export const RENDERER_BASE_URL = `http://localhost:${RENDERER_PORT}`;

export function resolveChromePath() {
  const fromEnv = process.env.CHROME_PATH
    || process.env.CHROME_EXECUTABLE_PATH
    || process.env.BROWSER_PATH
    || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`Chrome override does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ];
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  throw new Error('Unable to locate Chrome. Set CHROME_PATH to your Chrome binary.');
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', (err) => {
        if (Date.now() >= deadline) { reject(new Error(`Timed out waiting for ${url}: ${err.message}`)); return; }
        setTimeout(attempt, 100);
      });
      req.setTimeout(1000, () => req.destroy(new Error('request timed out')));
    }
    attempt();
  });
}

/**
 * Boot server.cjs (dual origin), run `body`, tear the server down. Waits for
 * BOTH the publisher and renderer origins to be live (markup path needs both).
 */
export async function withServer(body) {
  const server = spawn(process.execPath, ['server.cjs'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT), RENDERER_PORT: String(RENDERER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (chunk) => { serverErr += String(chunk); });
  try {
    await waitForServer(`${BASE_URL}/`, 10_000);
    await waitForServer(`${RENDERER_BASE_URL}/`, 10_000);
    return await body();
  } catch (err) {
    if (serverErr.trim()) console.error('[server stderr]', serverErr.trim());
    throw err;
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      const done = () => resolve();
      server.once('exit', done);
      setTimeout(done, 1500);
    });
  }
}

/**
 * Capture all [LIFELOG]/[HOSTLOG] console lines for ONE page load, each tagged
 * with the CDP monotonic `timestamp` (ms). Returns an ordered array of
 * `{ text, t }`. `t` is comparable ACROSS frames (top page, creative iframe,
 * cross-origin renderer) because it is the browser-process clock, not a
 * per-frame `performance.now()`.
 *
 * @param {import('puppeteer-core').Browser} browser
 * @param {string} hostUrl
 * @param {{ captureMs?: number }} [opts]
 * @returns {Promise<Array<{ text: string, t: number }>>}
 */
export async function captureRun(browser, hostUrl, opts = {}) {
  const captureMs = opts.captureMs ?? 4000;
  const lines = [];
  const seen = new Set();
  const record = (text, stamp) => {
    if (typeof text !== 'string') return;
    if (!(text.startsWith('[LIFELOG]') || text.startsWith('[HOSTLOG]'))) return;
    const key = stamp != null ? stamp + '::' + text : text;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ text, t: typeof stamp === 'number' ? stamp : NaN });
  };

  const browserCdp = await browser.target().createCDPSession();
  const attached = new Set();

  async function wireSession(session) {
    try { await session.send('Runtime.enable'); } catch (e) { /* some targets reject */ }
    session.on('Runtime.consoleAPICalled', (evt) => {
      try {
        const text = (evt.args || [])
          .map((a) => (a.value !== undefined ? String(a.value)
            : a.description !== undefined ? String(a.description) : ''))
          .join(' ');
        record(text, evt.timestamp);
      } catch (e) { /* ignore */ }
    });
    try {
      await session.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      });
    } catch (e) { /* ignore */ }
    session.on('Target.attachedToTarget', async (evt) => {
      const child = session.connection().session(evt.sessionId);
      if (child && !attached.has(evt.sessionId)) {
        attached.add(evt.sessionId);
        await wireSession(child);
      }
    });
  }

  await browserCdp.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  });
  browserCdp.on('Target.attachedToTarget', async (evt) => {
    const child = browserCdp.connection().session(evt.sessionId);
    if (child && !attached.has(evt.sessionId)) {
      attached.add(evt.sessionId);
      await wireSession(child);
    }
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const pageCdp = await page.target().createCDPSession();
  await wireSession(pageCdp);

  await page.goto(hostUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await new Promise((r) => setTimeout(r, captureMs));

  await page.close();
  try { await browserCdp.detach(); } catch (e) { /* ignore */ }

  lines._pageErrors = pageErrors;
  return lines;
}

/** Launch headless Chrome with the spike-proven flags. */
export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: resolveChromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

/**
 * One full capture: boot server, launch Chrome, capture `hostUrl`, tear down.
 * @returns {Promise<Array<{text,t}>>}
 */
export async function captureHost(hostUrl, opts = {}) {
  return withServer(async () => {
    const browser = await launchBrowser();
    try {
      return await captureRun(browser, hostUrl, opts);
    } finally {
      await browser.close();
    }
  });
}

// ── line-matching helpers (operate on the {text,t} capture array) ──────────

/** First captured line whose text includes `needle`, or null. */
export function find(lines, needle) {
  return lines.find((l) => l.text.includes(needle)) || null;
}

/** Timestamp (ms) of the first line including `needle`, or NaN. */
export function timeOf(lines, needle) {
  const l = find(lines, needle);
  return l ? l.t : NaN;
}

/** Index of the first line including `needle`, or -1. */
export function indexOf(lines, needle) {
  return lines.findIndex((l) => l.text.includes(needle));
}

/** Pretty-print the capture for diagnostic output on failure. */
export function dump(lines) {
  return lines
    .map((l, i) => '  ' + String(i + 1).padStart(2, ' ') + '  ' + l.text)
    .join('\n');
}
