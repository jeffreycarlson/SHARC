/**
 * Shared harness for the #486 G3 red contracts.
 *
 * Same chain as the #484 IAB reference-client gate
 * (test/node/test-omid-iab-reference-clients.js), with the publisher-page
 * OM SDK replaced by the recorded-behavior stand-in (./omsdk-web-standin.js):
 *
 *   real SHARCContainer + real OmidCompatBridge (dist) on a jsdom publisher page
 *     -> OM SDK web stand-in (recorded surface + recorded omweb behavior)
 *          -> service-path vendor listeners (the DV / Pixalate channel)
 *     -> bridge postMessage -> real installOmidShim in a creative realm
 *          -> window.omid3p -> IAB VerificationClient + Validation/Compliance
 *             clients (vendored verbatim, Apache-2.0) -> counted beacons
 *
 * The develop slice promotes this file and the stand-in to test/shared/ and
 * points the #484 gate at the same stand-in.
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installOmSdkWebStandin } from './omsdk-web-standin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(__dirname, '../vendor/omid-jsclients');
const JSCLIENTS_SEM_VERSION = '1.6.5';

export const PUBLISHER_ORIGIN = 'https://publisher.example';
export const PUBLISHER_PAGE_URL = PUBLISHER_ORIGIN + '/articles/2026/secret-article?user=42';
const RENDERER_URL = 'https://renderer.example/render.html';
const RENDERER_ORIGIN = 'https://renderer.example';
const CREATIVE_HTML = '<html><body>creative</body></html>';
const VALIDATION_BEACON_PREFIX = 'http://localhost:66/sendmessage?msg=';

// The ad slot as laid out on the publisher page (CSS px, viewport coords).
export const DEFAULT_IFRAME_RECT = Object.freeze({ x: 0, y: 100, width: 300, height: 250 });

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: PUBLISHER_PAGE_URL });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.HTMLIFrameElement = dom.window.HTMLIFrameElement;
global.MessageEvent = dom.window.MessageEvent;
global.MessageChannel = dom.window.MessageChannel;
global.MessagePort = dom.window.MessagePort;
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.subtle?.sign !== 'function') {
  const nodeCrypto = await import('node:crypto');
  globalThis.crypto = nodeCrypto.webcrypto;
}

const protoMod = await import('../../dist/sharc-protocol.mjs');
window.SHARC = window.SHARC || {};
window.SHARC.Protocol = protoMod;
export const { SHARCContainer } = await import('../../dist/sharc-container.mjs');
export const { OmidCompatBridge } = await import('../../dist/sharc-omid-bridge.mjs');
const { installOmidShim } = await import('../../dist/sharc-omid-shim.mjs');

let pendingTasks = 0;
function post(deliverFn, message) {
  const cloned = structuredClone(message);
  pendingTasks++;
  setTimeout(() => { pendingTasks--; deliverFn(cloned); }, 0);
}
export async function settle() {
  for (let i = 0; i < 1000 && pendingTasks > 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  await new Promise((r) => setTimeout(r, 0));
}

function indexVendoredModules() {
  const byName = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!entry.endsWith('.js')) continue;
      const m = /goog\.module\('([^']+)'\)/.exec(fs.readFileSync(p, 'utf8'));
      if (m) byName.set(m[1], { file: p, source: fs.readFileSync(p, 'utf8') });
    }
  })(path.join(VENDOR_DIR, 'src'));
  const template = fs.readFileSync(path.join(VENDOR_DIR, 'templates/version-js.template'), 'utf8');
  byName.set('omid.common.version', {
    file: path.join(VENDOR_DIR, 'templates/version-js.template'),
    source: template.replace('${semVersionString}', JSCLIENTS_SEM_VERSION).replace('${buildVersion}', 'iab'),
  });
  return byName;
}
const VENDORED_MODULES = indexVendoredModules();

function makeGoogLoader(sandbox) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const mod = VENDORED_MODULES.get(name);
    if (!mod) throw new Error('vendored goog.module missing: ' + name);
    const rec = { exports: {} };
    cache.set(name, rec);
    const goog = { module: Object.assign(() => {}, { declareLegacyNamespace() {} }), require: load };
    const fn = vm.runInContext(
      '(function (goog, __rec) { let exports = __rec.exports;\n' + mod.source + '\n;return exports; })',
      sandbox, { filename: mod.file });
    rec.exports = fn(goog, rec);
    return rec.exports;
  }
  return load;
}

function createCreativeRealm({ protocolNonce, placementSessionId, deliverToPublisher }) {
  const beacons = [];
  const messageListeners = new Set();
  const parentWindow = {
    postMessage(message, targetOrigin) { post((m) => deliverToPublisher(m, targetOrigin), message); },
  };
  const noop = () => {};
  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      createElement(tagName) {
        const el = { tagName, addEventListener() {} };
        Object.defineProperty(el, 'src', { set(v) { beacons.push(v); }, configurable: true });
        return el;
      },
    },
    frames: {},
    addEventListener(type, fn) { if (type === 'message') messageListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') messageListeners.delete(fn); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = parentWindow;
  vm.createContext(sandbox);
  installOmidShim({ protocolNonce, placementSessionId, containerOrigin: PUBLISHER_ORIGIN,
    targetWindow: sandbox, parentWindow });
  return {
    sandbox,
    beacons,
    load: makeGoogLoader(sandbox),
    receive(message) {
      const event = { source: parentWindow, origin: PUBLISHER_ORIGIN, data: message };
      for (const fn of Array.from(messageListeners)) fn(event);
    },
  };
}

function bootIabReferenceClients(realm) {
  const VerificationClient = realm.load('omid.verificationClient.VerificationClient');
  const Validation = realm.load('omid.validationVerificationScript.ValidationVerificationClient');
  const Compliance = realm.load('omid.complianceVerificationScript.ComplianceVerificationClient');
  new Validation(new VerificationClient(), 'iabtechlab.com-omid');
  new Compliance(new VerificationClient(), 'iabtechlab.com-omid');
}

/** Decoded events the IAB ValidationVerificationClient beaconed. */
export function validationEvents(realm) {
  return realm.beacons.map((url) => {
    if (!url.startsWith(VALIDATION_BEACON_PREFIX)) return null;
    const msg = decodeURIComponent(url.slice(VALIDATION_BEACON_PREFIX.length));
    try {
      const parsed = JSON.parse(msg.slice(msg.indexOf('::') + 2));
      return parsed && typeof parsed.type === 'string' ? parsed : null;
    } catch (_) { return null; }
  }).filter(Boolean);
}

function freshSlot() {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** Sets the iframe's client rect as jsdom has no layout. */
export function layOut(el, rect) {
  el.getBoundingClientRect = () => ({
    x: rect.x, y: rect.y, left: rect.x, top: rect.y, width: rect.width, height: rect.height,
    right: rect.x + rect.width, bottom: rect.y + rect.height,
  });
}

/**
 * Drives one placement: render -> OMID session -> ACTIVE -> optional steps -> close.
 * @param {object} [o]
 * @param {'web'|'native'} [o.serviceMode='web']
 * @param {object} [o.environmentData]
 * @param {string} [o.contentUrl] operator-configured contentUrl
 * @param {object} [o.iframeRect]
 * @param {(ctx: object) => (void|Promise<void>)} [o.whileActive] runs after ACTIVE, before close
 * @param {(win: Window, standin: object) => void} [o.patchStandin] e.g. a future-client variant
 */
export async function runPlacement({
  serviceMode = 'web',
  environmentData,
  contentUrl,
  iframeRect = DEFAULT_IFRAME_RECT,
  whileActive,
  patchStandin,
} = {}) {
  const standin = installOmSdkWebStandin(window);
  if (patchStandin) patchStandin(window, standin);
  const serviceEvents = [];
  for (const t of ['sessionStart', 'loaded', 'impression', 'geometryChange', 'sessionFinish']) {
    standin.addServiceListener(t, (ev) => serviceEvents.push(ev));
  }
  const bridgeOptions = {
    omSdkSessionClientUrl: 'https://cdn.example/omid/omid-session-client-v1.js',
    partnerName: 'sharc',
    partnerVersion: '0.7.13',
    creativeType: 'htmlDisplay',
    impressionType: 'beginToRender',
    mediaType: 'display',
    serviceMode,
    ...(serviceMode === 'web' ? { omSdkServiceScriptUrl: 'https://cdn.example/omid/omweb-v1.js' } : {}),
    ...(contentUrl !== undefined ? { contentUrl } : {}),
  };
  const bridge = new OmidCompatBridge(bridgeOptions);
  const c = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: RENDERER_URL,
    placementElement: freshSlot(),
    extensions: [bridge],
    ...(environmentData ? { environmentData } : {}),
    timeouts: { rendererLoad: 5000, rendererReply: 5000 },
  });
  c.load();
  layOut(c._iframe, iframeRect);
  await c.protocolRouter.ready('SHARC:Renderer:');

  let realm = null;
  const omidEnvelopes = [];
  c._iframe.contentWindow.postMessage = (message) => {
    if (!message || typeof message.type !== 'string' || message.type.indexOf('SHARC:Omid:') !== 0) return;
    omidEnvelopes.push(structuredClone(message));
    if (realm) post((m) => realm.receive(m), message);
  };
  c._iframe.dispatchEvent(new dom.window.Event('load'));
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'SHARC:Renderer:rendered',
      placementSessionId: c.placementSessionId,
      sharcNonce: c._rendererProtocolNonce,
      rendererOrigin: RENDERER_ORIGIN,
    },
    origin: RENDERER_ORIGIN,
    source: c._iframe.contentWindow,
  }));
  await c.protocolRouter.ready('SHARC:Omid:');
  const omidNonce = c.protocolRouter.getProtocol('SHARC:Omid:').protocolNonce;
  realm = createCreativeRealm({
    protocolNonce: omidNonce,
    placementSessionId: c.placementSessionId,
    deliverToPublisher(message) {
      window.dispatchEvent(new dom.window.MessageEvent('message', {
        data: message, origin: RENDERER_ORIGIN, source: c._iframe.contentWindow,
      }));
    },
  });
  bootIabReferenceClients(realm);

  // Composer inputs for a fully visible ad (jsdom has no IntersectionObserver).
  c._onRawParentVisibility(true);
  c._onRawIntersection(1);
  if (typeof c._transitionToActive === 'function' && c.getState() !== 'active') {
    c._transitionToActive();
  }
  await settle();
  const ctx = { c, bridge, standin, realm, omidEnvelopes, serviceEvents };
  if (whileActive) {
    await whileActive(ctx);
    await settle();
  }
  c.close();
  await settle();
  standin.uninstall();
  return ctx;
}

/** The AdSession that actually started (native mode also constructs probes). */
export function startedSession(standin) {
  return standin.sessions.find((s) => s.serviceEvents.some((e) => e.type === 'sessionStart')) || null;
}

export function relayed(ctx, type) {
  return ctx.omidEnvelopes.filter((e) => e.event && e.event.type === type).map((e) => e.event);
}
