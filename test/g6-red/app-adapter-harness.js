/**
 * Shared jsdom harness for the G6 #433 dynamic app-adapter contracts.
 *
 * Mirrors the established lifecycle-test setup (test/node/
 * test-restore-transient-hidden.js) but imports from src/ — the g6-red suite
 * is a source-contract suite, not a built-artifact suite. Each consuming test
 * file runs in its own node:test child process, so the module-level globals
 * below are process-isolated.
 */

import { JSDOM } from 'jsdom';

const PUBLISHER_ORIGIN = 'https://publisher.example';

export const dom = new JSDOM(
  '<!DOCTYPE html><html><head></head><body></body></html>',
  { url: PUBLISHER_ORIGIN + '/page.html', pretendToBeVisual: true },
);

global.window = dom.window;
global.document = dom.window.document;

let _docVisibility = 'visible';
Object.defineProperty(global.document, 'visibilityState', {
  configurable: true,
  get() { return _docVisibility; },
});
export function setDocVisibility(state) { _docVisibility = state; }

let _hasFocus = false;
global.document.hasFocus = () => _hasFocus;
export function setHasFocus(value) { _hasFocus = value; }

global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
global.MessageEvent = dom.window.MessageEvent;
if (typeof globalThis.crypto === 'undefined'
    || typeof globalThis.crypto.randomUUID !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

const _ioInstances = [];
global.IntersectionObserver = class IntersectionObserverStub {
  constructor(callback) {
    this._callback = callback;
    this._targets = [];
    _ioInstances.push(this);
  }

  observe(target) { this._targets.push(target); }

  unobserve(target) { this._targets = this._targets.filter((t) => t !== target); }

  disconnect() { this._targets = []; }

  _trigger(entries) { this._callback(entries, this); }
};
window.IntersectionObserver = global.IntersectionObserver;

// src/sharc-container.js resolves its protocol dependency from
// window.SHARC.Protocol when no CJS `module` exists (ESM import path).
const protoMod = await import('../../src/sharc-protocol.js');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;

const { SHARCContainer } = await import('../../src/sharc-container.js');

export { SHARCContainer };
export const { ContainerStates } = protoMod;

/** Severity order per design § 4.3: active < passive < hidden < frozen. */
export const SEVERITY = Object.freeze({
  active: 0, passive: 1, hidden: 2, frozen: 3,
});

const _liveContainers = [];
export function flushContainers() {
  while (_liveContainers.length) {
    const c = _liveContainers.pop();
    try { if (!c._terminated) c._terminate(); } catch (_) { /* ignore */ }
  }
}
process.on('beforeExit', flushContainers);

function freshSlot() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * Constructs and loads a container with a lifecycle adapter attached.
 * Returns the container plus the IntersectionObserver stub the adapter built.
 */
export function makeContainer({
  hostContext,
  requireSharcInit = false,
  extensions = [],
  beforeLoad = null,
} = {}) {
  const prevIoCount = _ioInstances.length;
  const options = {
    creativeUrl: 'https://ads.example/c.html',
    placementElement: freshSlot(),
    requireSharcInit,
    visible: true,
    timeouts: { createSession: 5000 },
    extensions,
  };
  if (hostContext !== undefined) options.hostContext = hostContext;
  const c = new SHARCContainer(options);
  _liveContainers.push(c);
  // Publisher-page-only assertions — no live MessagePort needed.
  c._protocol.sendStateChange = () => {};
  if (beforeLoad) beforeLoad(c);
  c.load();
  if (_ioInstances.length === prevIoCount) {
    throw new Error('test setup: lifecycle adapter did not construct an IntersectionObserver');
  }
  return { c, io: _ioInstances[_ioInstances.length - 1] };
}

/** Records every setState() target in order (wraps the instance method). */
export function recordTransitions(c) {
  const transitions = [];
  const realSetState = c.setState.bind(c);
  c.setState = (s) => { transitions.push(s); return realSetState(s); };
  return transitions;
}

export function dispatchIframeLoad(c) {
  c._iframe.dispatchEvent(new dom.window.Event('load'));
}

export function triggerIntersection(io, { isIntersecting, intersectionRatio }) {
  io._trigger([{ target: io._targets[0], isIntersecting, intersectionRatio }]);
}

export function dispatchVisibilityChange() {
  document.dispatchEvent(new dom.window.Event('visibilitychange'));
}

export function dispatchFreeze() {
  document.dispatchEvent(new dom.window.Event('freeze'));
}

export function dispatchResume() {
  document.dispatchEvent(new dom.window.Event('resume'));
}

export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Drives a permissive adapter-driven container LOADING → ACTIVE. */
export async function driveToActive(c, io) {
  dispatchIframeLoad(c);
  triggerIntersection(io, { isIntersecting: true, intersectionRatio: 0.9 });
  await sleep(5);
  if (c.getState() !== ContainerStates.ACTIVE) {
    throw new Error('test setup: container did not reach ACTIVE, got ' + c.getState());
  }
}
