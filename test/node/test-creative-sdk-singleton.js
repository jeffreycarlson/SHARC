/**
 * test-creative-sdk-singleton.js — #327 window-singleton boot guard
 *
 * Defect (#327): an MRAID-declaring creative (`apis:[5]` → renderer-provisioned
 * wrapper SDK) that ALSO ships its own `sharc-creative.js` evaluates the SDK
 * IIFE bundle TWICE in one iframe window. Today the module-scope
 * `new SHARCCreative()._boot()` runs unconditionally on every evaluation (the
 * `_initialized` guard is per-INSTANCE, useless against a second instance), so
 * two protocols mint two sessions and the second `_attachPort` clobbers the
 * single-slot `port2.onmessage`. The surviving instance is bound to the
 * REJECTED session, the container's `Container:init` for the ACCEPTED session is
 * dropped on sessionId mismatch, `sendInit` never resolves, READY/ACTIVE never
 * open — a silent measurement under-count. (Full root cause:
 * Obsidian/dev-team/sharc/2026-06-09-327-double-sdk-never-active-discover.md.)
 *
 * The fix is a WINDOW-singleton guard at module-eval/boot time so a SECOND IIFE
 * evaluation is a no-op for BOOT: no second instance, no second protocol, no
 * second bootstrap listener, no second createSession, no second `_attachPort`.
 *
 * This file models the double-eval directly by running the shipped IIFE bundle
 * (`dist/sharc-creative.js`, the classic-script artifact the validator-runner
 * case loads twice) against ONE shared window, twice. It proves the BOOT-side
 * mechanics. The end-to-end "double-SDK reaches ACTIVE" proof lives in the
 * flipped validator-runner assertion (`bid-runner-mraid-double-createsession`,
 * tools/creative-validator/test/test-runner.js).
 *
 * Three scenarios — the three risks the fix must not regress — each in its own
 * child process (a fresh `global.window` per scenario):
 *   (a) DOUBLE-EVAL BOOT GUARD: second eval spins up NO second instance / NO
 *       second bootstrap listener / NO second createSession. (headline fix)
 *   (b) BFCACHE RELINK STILL RE-ATTACHES (#338): a relink handshake (same
 *       window, new port) after a guarded boot re-attaches the NEW port on the
 *       SAME surviving instance. The guard keys on module-eval/boot, NOT on
 *       `_attachPort`, so relink (same instance, new port) is untouched.
 *   (c) NAV-BRIDGE OVERRIDE ORDER PRESERVED: an operator pre-set
 *       `window.SHARC.installNavigationBridge` survives BOTH evals
 *       (first-assignment-wins), and the second eval does not rebind
 *       `window.SHARC._instance` to a phantom second instance.
 *
 * Runs in Node after `npm run build`.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MODE = process.env.SHARC_SINGLETON_MODE;

// ===========================================================================
// Parent: spawn one child per scenario, aggregate results.
// ===========================================================================
if (!MODE) {
  console.log('Running creative SDK window-singleton (#327) tests...\n');
  const __filename = fileURLToPath(import.meta.url);
  let failed = 0;
  for (const mode of ['a', 'b', 'c']) {
    console.log(`──── scenario (${mode}) ────`);
    const r = spawnSync(
      process.execPath,
      [__filename],
      {
        env: { ...process.env, SHARC_SINGLETON_MODE: mode },
        stdio: 'inherit',
        cwd: path.dirname(__filename),
      },
    );
    if (r.status !== 0) {
      failed++;
      console.error(`✗ scenario (${mode}) failed (exit ${r.status}).`);
    } else {
      console.log(`✓ scenario (${mode}) passed.`);
    }
    console.log('');
  }
  if (failed > 0) {
    console.error(`✗ ${failed} singleton-guard scenario(s) failed.`);
    process.exit(1);
  }
  console.log('✓ All #327 window-singleton boot-guard scenarios passed.');
  process.exit(0);
}

// ===========================================================================
// Child: one scenario.
// ===========================================================================

const { JSDOM } = await import('jsdom');
const fs = await import('node:fs');

const PUBLISHER_ORIGIN = 'https://publisher.example';

const dom = new JSDOM(
  '<!DOCTYPE html><html><body><div id="ad">ad</div></body></html>',
  { url: PUBLISHER_ORIGIN + '/creative.html', pretendToBeVisual: true },
);
const win = dom.window;

// Wire the browser globals the IIFE bundle references as bare identifiers
// through Node's `global` (mirrors the other node tests' setup so the bundle
// evaluates exactly as a classic <script> would).
global.window = win;
global.document = win.document;
global.HTMLElement = win.HTMLElement;
global.HTMLIFrameElement = win.HTMLIFrameElement;
// jsdom does not provide MessageChannel/MessagePort; use Node's globals (the
// protocol only needs onmessage/postMessage/start, which Node ports support).
global.MessageChannel = globalThis.MessageChannel;
global.MessagePort = globalThis.MessagePort;
global.MessageEvent = win.MessageEvent;
win.MessageChannel = globalThis.MessageChannel;
win.MessagePort = globalThis.MessagePort;
global.setTimeout = win.setTimeout ? win.setTimeout.bind(win) : setTimeout;
global.clearTimeout = win.clearTimeout ? win.clearTimeout.bind(win) : clearTimeout;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}
if (typeof win.crypto === 'undefined' || typeof win.crypto.randomUUID !== 'function') {
  try { win.crypto = globalThis.crypto; } catch { /* jsdom exposes crypto as a getter-only prop; ignore */ }
}

// Count bootstrap 'message' listeners registered on the window (one per
// protocol.init()). A second BOOTED instance would register a second one.
let bootstrapMessageListeners = 0;
const realAdd = win.addEventListener.bind(win);
win.addEventListener = function (type, fn, opts) {
  if (type === 'message') bootstrapMessageListeners++;
  return realAdd(type, fn, opts);
};

const IIFE_SRC = fs.readFileSync(
  new URL('../../dist/sharc-creative.js', import.meta.url),
  'utf8',
);

// Execute the IIFE bundle against the shared window, modelling a classic
// <script src> tag that loads the same URL twice (re-executes module scope
// each time). `this` at the top of the bundle is the window (the trailer is
// `})(this.SHARC = this.SHARC || {})`).
function runIIFE() {
  // eslint-disable-next-line no-new-func
  const fn = new Function(IIFE_SRC);
  fn.call(win);
}

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log('  ✓', message);
  } else {
    console.error('  ✗', message);
    failures++;
  }
}

if (MODE === 'a') {
  // -- (a) DOUBLE-EVAL BOOT GUARD — the headline fix. -------------------
  runIIFE();
  const firstInstance = win.SHARC && win.SHARC._instance;
  const listenersAfterFirst = bootstrapMessageListeners;

  runIIFE();
  const secondInstance = win.SHARC && win.SHARC._instance;
  const listenersAfterSecond = bootstrapMessageListeners;

  check(!!firstInstance, '(a) first eval booted an instance');
  check(firstInstance === secondInstance,
    '(a) second eval did NOT replace the instance (window-singleton holds)');
  check(listenersAfterFirst === 1,
    `(a) first eval registered exactly one bootstrap message listener (got ${listenersAfterFirst})`);
  check(listenersAfterSecond === 1,
    `(a) second eval registered NO additional bootstrap message listener (still ${listenersAfterSecond}) — no second protocol.init()`);
  check(win.__sharcCreativeBooted === true,
    '(a) window-singleton boot flag is set');
} else if (MODE === 'b') {
  // -- (b) BFCACHE RELINK STILL RE-ATTACHES (#338) — risk #1. -----------
  runIIFE();
  runIIFE(); // double-eval, guarded

  const instance = win.SHARC && win.SHARC._instance;
  check(!!instance, '(b) surviving instance exists after double-eval');
  const proto = instance && instance._proto;
  check(!!proto, '(b) surviving instance has a protocol');

  // Spy on _attachPort to observe which port the relink re-attaches.
  const attached = [];
  const realAttach = proto._attachPort.bind(proto);
  proto._attachPort = function (port) {
    attached.push(port);
    return realAttach(port);
  };

  // First handshake establishes the channel (initial port). In jsdom at top
  // level, window.parent === window, so source = win passes the bootstrap's
  // `event.source === window.parent` check.
  const ch1 = new win.MessageChannel();
  win.dispatchEvent(new win.MessageEvent('message', {
    data: { type: 'SHARC:Container:handshake' },
    origin: PUBLISHER_ORIGIN,
    source: win.parent,
    ports: [ch1.port2],
  }));

  // Relink handshake: a NEW MessageChannel/port for the SAME session/instance
  // (models the container re-running initChannel after a bfcache restore).
  const ch2 = new win.MessageChannel();
  win.dispatchEvent(new win.MessageEvent('message', {
    data: { type: 'SHARC:Container:handshake' },
    origin: PUBLISHER_ORIGIN,
    source: win.parent,
    ports: [ch2.port2],
  }));

  check(attached.length === 2,
    `(b) _attachPort ran for BOTH the initial handshake and the relink (got ${attached.length})`);
  check(attached[0] === ch1.port2,
    '(b) initial handshake attached the first port');
  check(attached[1] === ch2.port2,
    '(b) relink re-attached the NEW port on the SAME instance (relink path intact)');
  check(proto._port === ch2.port2,
    '(b) surviving instance now routes through the relinked port');
} else if (MODE === 'c') {
  // -- (c) NAV-BRIDGE OVERRIDE ORDER PRESERVED — risk #2. ---------------
  // The override-order property in scope for THIS fix is idempotence of the
  // SECOND eval: a guarded second module evaluation must NOT change the
  // navigation-bridge binding or the instance binding relative to a single
  // eval. (The boot block carries the documented first-assignment-wins guards
  // at src/sharc-creative.js:893-904; the guarded second eval must not re-run
  // them in a way that flips override order.)
  //
  // Operator pre-sets installNavigationBridge BEFORE any SHARC module loads.
  const operatorSentinel = function operatorInstall() { /* operator override */ };
  win.SHARC = win.SHARC || {};
  win.SHARC.installNavigationBridge = operatorSentinel;

  runIIFE();
  const instanceAfterFirst = win.SHARC._instance;
  check(!!instanceAfterFirst, '(c) first eval booted an instance');
  check(typeof win.SHARC.installNavigationBridge === 'function',
    '(c) nav-bridge install surface is a function after the first eval');

  // Instrument augmentation: a guarded second eval must NOT re-run the
  // module-scope `Object.assign(window.SHARC, {…})` boot augmentation. The
  // augmentation binds `window.SHARC._instance` and the public-API closures
  // over `_instance`; re-running it would rebind them to a phantom second
  // instance. We detect re-augmentation by trapping a write to `_instance`.
  let instanceWrites = 0;
  let instanceVal = win.SHARC._instance;
  Object.defineProperty(win.SHARC, '_instance', {
    configurable: true,
    enumerable: true,
    get() { return instanceVal; },
    set(v) { instanceWrites++; instanceVal = v; },
  });

  runIIFE();

  check(instanceWrites === 0,
    `(c) second eval did NOT re-run the boot augmentation (no write to window.SHARC._instance; got ${instanceWrites})`);
  check(win.SHARC._instance === instanceAfterFirst,
    '(c) window.SHARC._instance is unchanged — the public-API binding still points at the FIRST instance, override order preserved');
  check(typeof win.SHARC.installNavigationBridge === 'function',
    '(c) nav-bridge install surface remains a function after the guarded second eval (override contract not broken)');
} else {
  console.error(`✗ unknown SHARC_SINGLETON_MODE: ${MODE}`);
  process.exit(1);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} (${MODE}) assertion(s) failed.`);
  process.exit(1);
}
process.exit(0);
