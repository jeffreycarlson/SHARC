#!/usr/bin/env node

/**
 * test-runner.js — creative validator Phase 2 runner coverage.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  isCacheableScriptRequest,
  sanitizeCachedResponseHeaders,
} from '../src/runner.js';

const cliPath = resolve('tools/creative-validator/src/cli.js');
const navigationReductionPath = resolve(
  'tools/creative-validator/fixtures/reductions/002-navigation-policy-post-render/cleaned-corpus.fixture.json',
);
const documentSourceReductionPath = resolve(
  'tools/creative-validator/fixtures/reductions/005-document-source-classification/cleaned-corpus.fixture.json',
);
const opaqueDocumentReductionPath = resolve(
  'tools/creative-validator/fixtures/reductions/006-blank-opaque-document-sources/cleaned-corpus.fixture.json',
);
const cspEmbeddedFrameReductionPath = resolve(
  'tools/creative-validator/fixtures/reductions/007-csp-embedded-frame-diagnostics/cleaned-corpus.fixture.json',
);

let nextTestPort = 12000 + (process.pid % 900) * 20;
function testPortPair() {
  const ports = { runner: String(nextTestPort), renderer: String(nextTestPort + 1) };
  nextTestPort += 2;
  return ports;
}

const reductionPorts = {
  runnerSmoke: testPortPair(),
  externalScript: testPortPair(),
  omidFullAccess: testPortPair(),
  navigation: testPortPair(),
  scriptLoadNavigation: testPortPair(),
  documentSource: testPortPair(),
  opaqueDocument: testPortPair(),
  cspEmbeddedFrame: testPortPair(),
};

function makeCase(overrides) {
  return {
    source: {
      sourceFile: 'synthetic-runner-test',
      rowIndex: 0,
      auctionId: 'auction-runner-test',
      auctionIndex: 0,
      bidder: 'synthetic-runner',
      mtype: 'banner',
    },
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-test',
      impId: 'imp-runner-test',
      crid: 'creative-runner-test',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><div id="ad">runner smoke</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [], sanitized: [], sources: [] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: [],
      sniffed: [],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [] },
      requireSharcInit: false,
      placementType: 'inline',
    },
    ...overrides,
  };
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
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

function fakeRequest({ url, method = 'GET', resourceType = 'script' }) {
  return {
    method: () => method,
    resourceType: () => resourceType,
    url: () => url,
  };
}

test('script response cache excludes mraid.js and cross-row state headers', () => {
  assert.equal(
    isCacheableScriptRequest(fakeRequest({ url: 'https://cdn.example/foo/mraid.js?cb=1#frag' })),
    false,
  );
  assert.equal(
    isCacheableScriptRequest(fakeRequest({ url: 'https://cdn.example/foo/MRAID.JS' })),
    false,
  );
  assert.equal(
    isCacheableScriptRequest(fakeRequest({ url: 'https://cdn.example/tag.js' })),
    true,
  );
  assert.equal(
    isCacheableScriptRequest(fakeRequest({ url: 'https://cdn.example/tag.js', method: 'POST' })),
    false,
  );
  assert.equal(
    isCacheableScriptRequest(fakeRequest({ url: 'https://cdn.example/pixel.png', resourceType: 'image' })),
    false,
  );

  const headers = sanitizeCachedResponseHeaders({
    'content-type': 'application/javascript',
    'content-encoding': 'gzip',
    'set-cookie': 'vendor_session=abc; HttpOnly',
    'set-cookie2': 'legacy=abc',
    'clear-site-data': '"cookies"',
  }, 12);
  assert.equal(headers['content-type'], 'application/javascript');
  assert.equal(headers['content-length'], '12');
  assert.equal(headers['content-encoding'], undefined);
  assert.equal(headers['set-cookie'], undefined);
  assert.equal(headers['set-cookie2'], undefined);
  assert.equal(headers['clear-site-data'], undefined);
});

function withReductionFixture({ fixturePath, workDirPrefix, ports, runOptions = [], includeTriage = false }, assertions) {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, workDirPrefix));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const outPath = resolve(workDir, 'reports.jsonl');
  const summaryPath = resolve(workDir, 'summary.json');

  try {
    runCli(['normalize', fixturePath, '--out', inputPath]);
    runCli([
      'run',
      inputPath,
      '--out',
      outPath,
      '--port',
      ports.runner,
      '--renderer-port',
      ports.renderer,
      '--render-timeout-ms',
      '4000',
      ...runOptions,
    ]);
    if (includeTriage) {
      runCli(['triage', outPath, '--out', summaryPath]);
    }
    assertions({
      reports: readJsonl(outPath),
      summary: includeTriage ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null,
      inputPath,
      outPath,
      summaryPath,
      workDir,
    });
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

test('runner executes HTML cases and writes one report row per case', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const outPath = resolve(workDir, 'reports.jsonl');

  const executable = makeCase({});
  const mraid = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-mraid',
      impId: 'imp-runner-test',
      crid: 'creative-runner-mraid',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-mraid',
      html: '<!doctype html><html><body><script>'
        + 'window.__sawMraid = typeof window.mraid !== "undefined";'
        + 'window.parent.postMessage({type:"SHARC:Validator:bridgeProbe",probeNonce:"forged",payload:{bridges:{mraid:{exists:false,methods:{}}}}},"*");'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [5], sanitized: [5], sources: [{ path: 'bid.api', values: [5], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['mraid'],
      sniffed: ['mraid'],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [5] },
      requireSharcInit: true,
      placementType: 'inline',
    },
  });
  const safeframe = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-safeframe',
      impId: 'imp-runner-test',
      crid: 'creative-runner-safeframe',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-safeframe',
      html: '<!doctype html><html><body><script>window.__sawSf = !!(window.$sf && window.$sf.ext);</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [9002], sanitized: [9002], sources: [{ path: 'bid.api', values: [9002], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['safeframe'],
      sniffed: ['safeframe'],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [9002] },
      requireSharcInit: false,
      placementType: 'inline',
    },
  });
  const missingMraid = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-mraid-missing',
      impId: 'imp-runner-test',
      crid: 'creative-runner-mraid-missing',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-mraid',
      html: '<!doctype html><html><body><div>declared mraid without bridge signal</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [5], sanitized: [5], sources: [{ path: 'bid.api', values: [5], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['mraid'],
      sniffed: [],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [] },
      requireSharcInit: false,
      placementType: 'inline',
    },
  });
  const mraidApiError = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-mraid-api-error',
      impId: 'imp-runner-test',
      crid: 'creative-runner-mraid-api-error',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-mraid',
      html: '<!doctype html><html><body><script>'
        + 'window.mraid.open=function(){throw new Error("probe boom")};'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [5], sanitized: [5], sources: [{ path: 'bid.api', values: [5], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['mraid'],
      sniffed: ['mraid'],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [5] },
      requireSharcInit: true,
      placementType: 'inline',
    },
  });
  const mraidOpen = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-mraid-open',
      impId: 'imp-runner-test',
      crid: 'creative-runner-mraid-open',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-mraid',
      html: '<!doctype html><html><body><script>'
        + 'setTimeout(function(){ window.mraid.open("https://click.example/mraid-open?private=1"); }, 20);'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [5], sanitized: [5], sources: [{ path: 'bid.api', values: [5], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['mraid'],
      sniffed: ['mraid'],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [5] },
      requireSharcInit: true,
      placementType: 'inline',
    },
  });
  // #327: MRAID-bridge + native-SDK double-SDK shape — FIXED by the
  // window-singleton boot guard (src/sharc-creative.js). This creative BOTH
  // declares MRAID (api 5 → bridges:['mraid'], so the renderer provisions the
  // sharc-protocol → sharc-creative → mraid-bridge wrapper that drives
  // createSession #1) AND ships its own copy of sharc-creative.js. The shipped
  // SDK's module-scope evaluation USED to auto-instantiate a SECOND
  // `new SHARCCreative()` + `_boot()`, firing createSession #2 and clobbering the
  // shared port — pinning the container in `loading`. With the window-singleton
  // guard, the second module evaluation is a NO-OP for boot: no second instance,
  // no second session, no port clobber. Only the wrapper session exists, it owns
  // the port, `Container:init` resolves, and the container reaches ACTIVE. The
  // case now verifies the FIXED outcome (reachedActive: true, no duplicate
  // createSession to reject) below.
  const mraidDoubleCreateSession = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-mraid-double-createsession',
      impId: 'imp-runner-test',
      crid: 'creative-runner-mraid-double-createsession',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-mraid',
      // Declares MRAID (api 5 below → renderer wrapper = createSession #1) AND
      // ships its own sharc-creative.js (same-origin /dist asset served by the
      // renderer). Post-#327 the window-singleton guard makes that second
      // sharc-creative.js eval boot-inert: its module-scope evaluation does NOT
      // instantiate a second `SHARCCreative` and fires no createSession #2.
      // Only the wrapper's createSession #1 is established, so a single session
      // owns the port and the case reaches ACTIVE (nothing for the container to
      // reject — which is why the duplicate-warn-absent assertions below hold).
      html: '<!doctype html><html><body>'
        + '<div id="ad">mraid double createSession</div>'
        + '<script src="/dist/sharc-creative.js"></script>'
        + '</body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [5], sanitized: [5], sources: [{ path: 'bid.api', values: [5], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['mraid'],
      sniffed: ['mraid'],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [5] },
      requireSharcInit: true,
      placementType: 'inline',
    },
  });
  const sharcRequestNavigationSync = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-sharc-request-navigation-sync',
      impId: 'imp-runner-test',
      crid: 'creative-runner-sharc-request-navigation-sync',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-mraid',
      html: '<!doctype html><html><body><script>'
        + 'window.SHARC.requestNavigation({url:"https://click.example/sync-request-navigation?private=1"}).catch(function(){});'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [5], sanitized: [5], sources: [{ path: 'bid.api', values: [5], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['mraid'],
      sniffed: ['mraid'],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [5] },
      requireSharcInit: true,
      placementType: 'inline',
    },
  });
  const omid = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-omid',
      impId: 'imp-runner-test',
      crid: 'creative-runner-omid',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><div>omid display creative</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [7], sanitized: [7], sources: [{ path: 'bid.api', values: [7], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: {
        omid: {
          declaredByApi: true,
          sidecarPresent: true,
          verificationScriptCount: 1,
          sources: [{ path: 'bid.ext.measurement.omid', verificationScriptCount: 1 }],
        },
      },
    },
    expectations: {
      declared: ['omid'],
      sniffed: [],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: {
        apis: [7],
        measurement: {
          omid: {
            verificationScripts: [{
              resourceUrl: 'https://verify.example/omid.js',
              vendor: 'vendor.example',
              verificationParameters: 'runner-params',
              accessMode: 'limited',
            }],
            creativeType: 'display',
            mediaType: 'display',
            impressionType: 'beginToRender',
            contentUrl: 'https://advertiser.example/creative.html',
          },
        },
      },
      requireSharcInit: false,
      placementType: 'inline',
    },
  });
  const inlineOmidVendor = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-inline-omid-vendor',
      impId: 'imp-runner-test',
      crid: 'creative-runner-inline-omid-vendor',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="https://cdn.doubleverify.com/__sharc-validator-fixtures/omid-vendor-probe.js"></script><div>inline omid vendor</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [], sanitized: [], sources: [] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: {
        omid: {
          declaredByApi: false,
          sidecarPresent: false,
          inlineVendorScriptPresent: true,
          inlineVendorScriptCount: 1,
          inlineVendorVendors: ['doubleverify'],
          inlineVendorScripts: [{
            vendor: 'doubleverify',
            source: 'adm-script-src',
            value: 'https://cdn.doubleverify.com/dvtp_src.js',
            url: {
              protocol: 'https:',
              origin: 'https://cdn.doubleverify.com',
              hostname: 'cdn.doubleverify.com',
              path: '/dvtp_src.js',
            },
          }],
          sources: [{ path: 'adm.script[src]', vendor: 'doubleverify' }],
        },
      },
    },
    expectations: {
      declared: [],
      sniffed: [],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [] },
      requireSharcInit: false,
      placementType: 'inline',
    },
  });
  const inlineOmidVendorAsync = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-inline-omid-vendor-async',
      impId: 'imp-runner-test',
      crid: 'creative-runner-inline-omid-vendor-async',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="https://cdn.doubleverify.com/__sharc-validator-fixtures/omid-vendor-async-probe.js"></script><div>inline omid vendor async</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: inlineOmidVendor.bidSignals,
    expectations: inlineOmidVendor.expectations,
    sharcOptions: inlineOmidVendor.sharcOptions,
  });
  const inlineOmidUnrelatedSubscriber = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-inline-omid-unrelated-subscriber',
      impId: 'imp-runner-test',
      crid: 'creative-runner-inline-omid-unrelated-subscriber',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="/tools/creative-validator/fixtures/omid-unrelated-vendor-probe.js"></script><div>inline omid unrelated subscriber</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [], sanitized: [], sources: [] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: {
        omid: {
          declaredByApi: false,
          sidecarPresent: false,
          inlineVendorScriptPresent: true,
          inlineVendorScriptCount: 1,
          inlineVendorVendors: ['doubleverify'],
          inlineVendorScripts: [{
            vendor: 'doubleverify',
            source: 'adm-script-src',
            value: 'https://cdn.doubleverify.com/dvtp_src.js',
            url: {
              protocol: 'https:',
              origin: 'https://cdn.doubleverify.com',
              hostname: 'cdn.doubleverify.com',
              path: '/dvtp_src.js',
            },
          }],
          sources: [{ path: 'adm.script[src]', vendor: 'doubleverify' }],
        },
      },
    },
    expectations: {
      declared: [],
      sniffed: [],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [] },
      requireSharcInit: false,
      placementType: 'inline',
    },
  });
  const inlineOmidProxySubscriber = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-inline-omid-proxy-subscriber',
      impId: 'imp-runner-test',
      crid: 'creative-runner-inline-omid-proxy-subscriber',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="https://cadmus2.script.ac/__sharc-validator-fixtures/omid-vendor-proxy-probe.js"></script><div>inline omid proxy subscriber</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: inlineOmidUnrelatedSubscriber.bidSignals,
    expectations: inlineOmidUnrelatedSubscriber.expectations,
    sharcOptions: inlineOmidUnrelatedSubscriber.sharcOptions,
  });
  const inlineOmidMixedSubscriber = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-inline-omid-mixed-subscriber',
      impId: 'imp-runner-test',
      crid: 'creative-runner-inline-omid-mixed-subscriber',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body>'
        + '<script src="https://cdn.doubleverify.com/__sharc-validator-fixtures/omid-vendor-probe.js"></script>'
        + '<script src="/tools/creative-validator/fixtures/omid-unrelated-vendor-probe.js"></script>'
        + '<div>inline omid mixed subscriber</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: inlineOmidUnrelatedSubscriber.bidSignals,
    expectations: inlineOmidUnrelatedSubscriber.expectations,
    sharcOptions: inlineOmidUnrelatedSubscriber.sharcOptions,
  });
  const network404 = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-network-404',
      impId: 'imp-runner-test',
      crid: 'creative-runner-network-404',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><div>network probe</div><script>'
        + 'setTimeout(function(){fetch("/missing-validator-fetch.json").catch(function(){});},0);'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const docWrite = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-document-write',
      impId: 'imp-runner-test',
      crid: 'creative-runner-document-write',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script>'
        + 'document.write("<textarea><meta http-equiv=\\"refresh\\" content=\\"0;url=https://click.example/\\"><iframe></iframe><script src=\\"https://cdn.example/tag.js\\"></textarea>");'
        + 'document.writeln("<div>location.href window.open(</div>");'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const windowOpen = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-window-open',
      impId: 'imp-runner-test',
      crid: 'creative-runner-window-open',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script>'
        + 'window.open("https://click.example/path?private=1", "_blank", "noopener");'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const scriptLoadOk = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-script-load-ok',
      impId: 'imp-runner-test',
      crid: 'creative-runner-script-load-ok',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script>'
        + 'window.addEventListener("load",function(){'
        + 'var script=document.createElement("script");'
        + 'script.src="/tools/creative-validator/fixtures/script-load-ok.js";'
        + 'document.body.appendChild(script);'
        + '});'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const scriptLoadMissing = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-script-load-missing',
      impId: 'imp-runner-test',
      crid: 'creative-runner-script-load-missing',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script>'
        + 'window.addEventListener("load",function(){'
        + 'var script=document.createElement("script");'
        + 'script.src="/tools/creative-validator/fixtures/missing-script-load.js";'
        + 'document.body.appendChild(script);'
        + '});'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const staticScriptLoadOk = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-static-script-load-ok',
      impId: 'imp-runner-test',
      crid: 'creative-runner-static-script-load-ok',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="/tools/creative-validator/fixtures/script-load-ok.js"></script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const staticScriptLoadMissing = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-static-script-load-missing',
      impId: 'imp-runner-test',
      crid: 'creative-runner-static-script-load-missing',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="/tools/creative-validator/fixtures/missing-static-script-load.js"></script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const legacyMraidLoaderRuntimeOnly = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-legacy-mraid-loader-runtime-only',
      impId: 'imp-runner-test',
      crid: 'creative-runner-legacy-mraid-loader-runtime-only',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="mraid.js"></script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const legacyMraidLoaderDeclared = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-legacy-mraid-loader-declared',
      impId: 'imp-runner-test',
      crid: 'creative-runner-legacy-mraid-loader-declared',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html-mraid',
      html: '<!doctype html><html><body><script src="mraid.js"></script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [5], sanitized: [5], sources: [{ path: 'bid.api', values: [5], role: 'bid' }] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: { omid: { declaredByApi: false, sidecarPresent: false, sources: [] } },
    },
    expectations: {
      declared: ['mraid'],
      sniffed: ['mraid'],
      execute: true,
      skipReason: null,
    },
    sharcOptions: {
      creativeMeta: { apis: [5] },
      requireSharcInit: false,
      placementType: 'inline',
    },
  });
  const legacyMraidLoaderSniffedOnly = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-legacy-mraid-loader-sniffed-only',
      impId: 'imp-runner-test',
      crid: 'creative-runner-legacy-mraid-loader-sniffed-only',
    },
    creative: {
      mode: 'adm-html',
      // Load-bearing: html-mraid is the sniffed signal. No bidSignals or
      // sharcOptions overrides are supplied, so this remains undeclared by API.
      admKind: 'html-mraid',
      html: '<!doctype html><html><body><script src="mraid.js"></script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    expectations: {
      declared: [],
      sniffed: ['mraid'],
      execute: true,
      skipReason: null,
    },
  });
  const legacyMraidLoaderAfterCallCap = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-legacy-mraid-loader-after-call-cap',
      impId: 'imp-runner-test',
      crid: 'creative-runner-legacy-mraid-loader-after-call-cap',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script>'
        + 'window.addEventListener("load",function(){'
        + 'for(var i=0;i<20;i++){'
        + 'var script=document.createElement("script");'
        + 'script.src="/tools/creative-validator/fixtures/script-load-ok.js?i="+i;'
        + 'document.body.appendChild(script);'
        + '}'
        + 'function appendMraidScript(index){'
        + 'var mraidScript=document.createElement("script");'
        + 'mraidScript.src="/tools/creative-validator/fixtures/legacy-mraid-loader/mraid.js";'
        + 'if(index<1){mraidScript.onload=function(){appendMraidScript(index+1)};}'
        + 'document.body.appendChild(mraidScript);'
        + '}'
        + 'appendMraidScript(0);'
        + '});'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const skipped = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-native',
      impId: 'imp-runner-test',
      crid: 'creative-runner-native',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'native-json',
      html: '{"native":{"assets":[]}}',
      url: null,
      width: null,
      height: null,
      placementType: 'inline',
      transformations: [],
    },
    expectations: {
      declared: [],
      sniffed: [],
      execute: false,
      skipReason: 'unsupported-adm-kind:native-json',
    },
  });

  try {
    writeFileSync(inputPath, [
      executable,
      mraid,
      safeframe,
      missingMraid,
      mraidApiError,
      mraidOpen,
      mraidDoubleCreateSession,
      sharcRequestNavigationSync,
      omid,
      inlineOmidVendor,
      inlineOmidVendorAsync,
      inlineOmidUnrelatedSubscriber,
      inlineOmidProxySubscriber,
      inlineOmidMixedSubscriber,
      network404,
      docWrite,
      windowOpen,
      scriptLoadOk,
      scriptLoadMissing,
      staticScriptLoadOk,
      staticScriptLoadMissing,
      legacyMraidLoaderRuntimeOnly,
      legacyMraidLoaderDeclared,
      legacyMraidLoaderSniffedOnly,
      legacyMraidLoaderAfterCallCap,
      skipped,
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    execFileSync('node', [
      cliPath,
      'run',
      inputPath,
      '--out',
      outPath,
      '--port',
      reductionPorts.runnerSmoke.runner,
      '--renderer-port',
      reductionPorts.runnerSmoke.renderer,
      '--render-timeout-ms',
      '4000',
      '--settle-ms',
      '500',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const reports = readJsonl(outPath);
    assert.equal(reports.length, 26);

    const htmlReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-test');
    assert.ok(htmlReport);
    assert.equal(htmlReport.outcome.status, 'passed');
    assert.equal(htmlReport.outcome.bucket, 'passed');
    assert.equal(htmlReport.outcome.creativeRendered, true);
    assert.equal(htmlReport.outcome.terminated, false);
    assert.equal(htmlReport.case.creative.html, undefined);
    assert.equal(typeof htmlReport.outcome.reachedActive, 'boolean');
    assert.ok(Array.isArray(htmlReport.diagnostics.stateHistory));
    assert.equal(htmlReport.outcome.creativeInjected, false);
    assert.ok(htmlReport.diagnostics.bridgeProbes.length >= 1);
    assert.equal(htmlReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.installed, false);
    // #346: this is a plain-HTML creative (`<div id="ad">` — no `$sf.ext`, no
    // `apis`), so the container's three-layer bridge resolution must detect NO
    // SafeFrame and provision none → `installed === false`. Pre-#346 the
    // validator's own injected bridge-probe carried a literal `$sf.ext` token
    // that the container's Layer-3 adm content-scan (`html.indexOf('$sf.ext')`)
    // matched — detecting the PROBE's reference, not the creative's — so the
    // #339 SafeFrame wrapper spuriously provisioned and this reported `true`.
    // The probe now reads `window['$sf']['e'+'xt']` dynamically, so its source
    // no longer contains the literal substring; real SafeFrame creatives (which
    // ship their own `$sf.ext` and/or declare the SafeFrame api) still detect
    // — see `bid-runner-safeframe` below, which must stay `true`.
    assert.equal(htmlReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.installed, false);
    assert.equal(htmlReport.diagnostics.measurement.omid.expected, false);

    const mraidReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid');
    assert.ok(mraidReport);
    assert.equal(mraidReport.outcome.status, 'passed');
    assert.equal(mraidReport.outcome.creativeInjected, false);
    assert.equal(mraidReport.outcome.reachedActive, true);
    assert.ok(mraidReport.diagnostics.bridgeProbes.length >= 1);
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.exists, true);
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.installed, true);
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.getState.status, 'ok');
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.getState.value, 'default');
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.isViewable.status, 'ok');
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.isViewable.value, true);
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.getVersion.status, 'ok');
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.open.status, 'ok');
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.expand.status, 'ok');
    assert.equal(mraidReport.diagnostics.navigationDiagnostics.bridgeCalls.count, 0);
    assert.equal(mraidReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['mraid.open'], undefined);
    assert.equal(mraidReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['mraid.open'], 1);
    assert.equal(mraidReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['mraid.expand'], 1);
    assert.equal(mraidReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['sharc.requestNavigation'], 1);

    const safeframeReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-safeframe');
    assert.ok(safeframeReport);
    assert.equal(safeframeReport.outcome.status, 'passed');
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.exists, true);
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.installed, true);
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.methods.geom.status, 'ok');
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.methods.supports.status, 'ok');
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.methods.register.status, 'ok');
    // The current SHARC SafeFrame bridge does not expose redirect(), so the
    // active redirect probe is only reachable as an absent method here.
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.methods.redirect.status, 'absent');
    assert.equal(safeframeReport.diagnostics.navigationDiagnostics.bridgeCalls.count, 0);
    assert.equal(safeframeReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['safeframe.register'], undefined);
    assert.equal(
      safeframeReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['safeframe.register'],
      1,
    );
    assert.equal(
      safeframeReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byProtocol.unknown,
      undefined,
    );

    const missingMraidReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid-missing');
    assert.ok(missingMraidReport);
    assert.equal(missingMraidReport.outcome.status, 'passed');
    assert.equal(missingMraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.exists, false);

    const mraidApiErrorReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid-api-error');
    assert.ok(mraidApiErrorReport);
    assert.equal(mraidApiErrorReport.outcome.status, 'failed');
    assert.equal(mraidApiErrorReport.outcome.bucket, 'bridge-api-error');
    assert.equal(
      mraidApiErrorReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.open.status,
      'threw',
    );
    assert.equal(
      mraidApiErrorReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['mraid.open'],
      1,
    );

    const mraidOpenReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid-open');
    assert.ok(mraidOpenReport);
    assert.equal(mraidOpenReport.outcome.status, 'passed');
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['mraid.open'], 1);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['mraid.expand'], undefined);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['sharc.requestNavigation'], 1);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.byProtocol['https:'], 2);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['mraid.open'], 1);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['mraid.expand'], 1);
    assert.equal(
      mraidOpenReport.diagnostics.navigationDiagnostics.probeBridgeCalls.byMethod['sharc.requestNavigation'],
      1,
    );
    assert.ok(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.calls.some((call) =>
      call.bridge === 'mraid' && call.method === 'open' && call.url.origin === 'https://click.example'));

    // #327 — FIXED (window-singleton boot guard, src/sharc-creative.js).
    //
    // Shape: an MRAID-declaring creative (`api:5` → renderer wrapper SDK,
    // createSession #1) that ALSO ships its own `sharc-creative.js`. Before the
    // fix, the creative-shipped SDK auto-booted a SECOND instance at module
    // scope, minting a second session and clobbering the shared `port2.onmessage`
    // (single-slot `_attachPort`, last-attacher-wins). The surviving instance was
    // bound to the REJECTED session, the container's `Container:init` for the
    // ACCEPTED session was dropped on a sessionId mismatch, `sendInit` never
    // resolved, READY/ACTIVE never opened — the ad rendered but the container
    // stayed in `loading` (silent viewability/OMID under-count).
    //
    // The window-singleton guard makes the SECOND module evaluation a NO-OP for
    // BOOT: no second instance, no second session, no second `_attachPort`. So
    // only the wrapper session exists, it owns the port, `Container:init`
    // resolves, and the canonical strict-mode handshake LOADING→READY→ACTIVE
    // completes. The case now reaches ACTIVE. (There is consequently NO duplicate
    // createSession anymore — nothing to reject — so the old duplicate-warn
    // tripwire is gone by construction.) The #327 tracking chip can be closed.
    const mraidDoubleReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-mraid-double-createsession');
    assert.ok(mraidDoubleReport);
    // Still renders and passes, non-fatal, not terminated.
    assert.equal(mraidDoubleReport.outcome.status, 'passed');
    assert.equal(mraidDoubleReport.outcome.bucket, 'passed');
    assert.equal(mraidDoubleReport.outcome.creativeRendered, true);
    assert.equal(mraidDoubleReport.outcome.terminated, false);
    // #327 FIXED: the double-SDK shape now reaches ACTIVE (was the latent defect
    // — previously pinned `false`/`loading`). The day this regresses, THIS
    // assertion fails loudly. (Flip from `false` → `true`; defect resolved by the
    // window-singleton boot guard.)
    assert.equal(mraidDoubleReport.outcome.reachedActive, true);
    assert.equal(mraidDoubleReport.outcome.finalState, 'active');
    // Single stable session — the guarded second eval never minted a competing
    // session, so a single placementSessionId is held throughout.
    assert.equal(typeof mraidDoubleReport.diagnostics.placementSessionId, 'string');
    assert.ok(mraidDoubleReport.diagnostics.placementSessionId.length > 0);
    // The mraid bridge (wrapper session) is installed and usable.
    assert.equal(mraidDoubleReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.exists, true);
    assert.equal(mraidDoubleReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.installed, true);
    // No duplicate createSession is emitted anymore — the singleton guard
    // prevents the second SDK from booting a competing session, so the container
    // never sees (and never has to reject) a duplicate.
    assert.equal(
      mraidDoubleReport.diagnostics.console.some((entry) =>
        /Duplicate createSession received/.test(entry.text || '')),
      false,
    );
    // No fatal/duplicate-session error escalated through onError.
    assert.equal(
      mraidDoubleReport.diagnostics.errors.some((entry) =>
        /duplicate/i.test(entry.message || '') || /createSession/i.test(entry.message || '')),
      false,
    );

    const sharcSyncReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-sharc-request-navigation-sync');
    assert.ok(sharcSyncReport);
    assert.equal(sharcSyncReport.outcome.status, 'passed');
    assert.equal(
      sharcSyncReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['sharc.requestNavigation'],
      1,
    );
    assert.ok(sharcSyncReport.diagnostics.navigationDiagnostics.bridgeCalls.calls.some((call) =>
      call.bridge === 'sharc' && call.method === 'requestNavigation' && call.url.origin === 'https://click.example'));

    const omidReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-omid');
    assert.ok(omidReport);
    assert.equal(omidReport.outcome.status, 'passed');
    assert.equal(omidReport.outcome.bucket, 'passed');
    assert.equal(omidReport.case.bidSignals.measurement.omid.declaredByApi, true);
    assert.equal(omidReport.case.bidSignals.measurement.omid.sidecarPresent, true);
    assert.equal(omidReport.diagnostics.measurement.omid.expected, true);
    assert.equal(omidReport.diagnostics.measurement.omid.sidecarPresent, true);
    assert.equal(omidReport.diagnostics.measurement.omid.extensionPresent, true);
    assert.equal(omidReport.diagnostics.measurement.omid.featureAdvertised, true);
    assert.equal(omidReport.diagnostics.measurement.omid.sessionStarted, true);
    assert.equal(omidReport.diagnostics.measurement.omid.loadedFired, true);
    assert.equal(omidReport.diagnostics.measurement.omid.impressionFired, true);
    assert.equal(omidReport.diagnostics.measurement.omid.verificationScriptCount, 1);
    assert.deepEqual(omidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.installed, false);
    // #346: this OMID case declares `apis: [7]`, which maps to an empty bridge
    // set (OMID is a measurement axis, not a bridge), so resolution falls
    // through to the Layer-3 adm content-scan. The creative HTML carries no
    // `$sf.ext`, so once the validator probe stops emitting that literal token
    // the scan finds nothing and SafeFrame is not provisioned →
    // `installed === false`. OMID and SafeFrame are independent surfaces; the
    // OMID measurement assertions above are unaffected.
    assert.deepEqual(omidReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.installed, false);

    const inlineOmidVendorReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-inline-omid-vendor');
    assert.ok(inlineOmidVendorReport);
    assert.equal(inlineOmidVendorReport.outcome.status, 'passed');
    assert.equal(inlineOmidVendorReport.outcome.bucket, 'passed');
    assert.equal(
      inlineOmidVendorReport.case.bidSignals.measurement.omid.inlineVendorScriptPresent,
      true,
    );
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.expected, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.sidecarPresent, false);
    assert.equal(
      inlineOmidVendorReport.diagnostics.measurement.omid.sidecarSynthesizedFromInlineVendor,
      true,
    );
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.extensionPresent, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.featureAdvertised, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.sessionStarted, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.loadedFired, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.impressionFired, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.expected, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.accessMode, 'limited');
    assert.deepEqual(
      inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.vendorsExpected,
      ['doubleverify'],
    );
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.omid3pFound, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.subscriptionObserved, true);
    assert.equal(
      inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.expectedVendorSubscriptionObserved,
      true,
    );
    assert.equal(
      inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.unattributedSubscriptionObserved,
      false,
    );
    assert.ok(
      inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.registerSessionObserverCalls >= 1,
    );
    assert.ok(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.addEventListenerCalls >= 1);
    assert.ok(
      inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor
        .expectedVendorRegisterSessionObserverCalls >= 1,
    );
    assert.ok(
      inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor
        .callsByExpectedVendor.doubleverify >= 1,
    );
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.lifecycle.sessionStart, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.lifecycle.loaded, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.lifecycle.impression, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.lifecycleObserved, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.lifecycleComplete, true);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.lifecycleNotObserved, false);
    assert.equal(inlineOmidVendorReport.diagnostics.measurement.omid.inlineVendor.passed, true);

    const inlineOmidVendorAsyncReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-inline-omid-vendor-async');
    assert.ok(inlineOmidVendorAsyncReport);
    assert.equal(inlineOmidVendorAsyncReport.outcome.status, 'passed');
    assert.equal(inlineOmidVendorAsyncReport.outcome.bucket, 'passed');
    assert.equal(
      inlineOmidVendorAsyncReport.diagnostics.measurement.omid.inlineVendor
        .expectedVendorSubscriptionObserved,
      true,
    );
    assert.equal(
      inlineOmidVendorAsyncReport.diagnostics.measurement.omid.inlineVendor
        .unattributedSubscriptionObserved,
      false,
    );
    assert.ok(
      inlineOmidVendorAsyncReport.diagnostics.measurement.omid.inlineVendor
        .callsByExpectedVendor.doubleverify >= 1,
    );
    assert.ok(
      inlineOmidVendorAsyncReport.diagnostics.measurement.omid.inlineVendor.samples.some((sample) =>
        sample.injectionId === 'fixture-async'
        && sample.sourceUrls.some((url) =>
          url.includes('cdn.doubleverify.com/__sharc-validator-fixtures/omid-vendor-async-probe.js'))),
    );

    const unrelatedSubscriberReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-inline-omid-unrelated-subscriber');
    assert.ok(unrelatedSubscriberReport);
    assert.equal(unrelatedSubscriberReport.outcome.status, 'failed');
    assert.equal(unrelatedSubscriberReport.outcome.bucket, 'measurement-omid');
    assert.equal(
      unrelatedSubscriberReport.outcome.reason,
      'inline OMID vendor script did not produce an attributed subscription',
    );
    assert.equal(unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.omid3pFound, true);
    assert.equal(unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.subscriptionObserved, true);
    assert.equal(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.expectedVendorSubscriptionObserved,
      false,
    );
    assert.equal(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.unattributedSubscriptionObserved,
      true,
    );
    assert.equal(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.unattributedSubscriptionCalls,
      2,
    );
    assert.deepEqual(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.callsByExpectedVendor,
      {},
    );
    assert.deepEqual(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.callsByVendorKey,
      { doubleverify: 1 },
    );
    assert.equal(unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.lifecycleObserved, true);
    assert.equal(unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.passed, false);
    assert.equal(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.diagnosticOutcome,
      'unattributed-lifecycle',
    );
    assert.equal(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor.callsBySourceOrigin[
        `http://localhost:${reductionPorts.runnerSmoke.renderer}`
      ],
      2,
    );
    assert.equal(
      unrelatedSubscriberReport.diagnostics.measurement.omid.inlineVendor
        .unattributedCallsBySourceOrigin[`http://localhost:${reductionPorts.runnerSmoke.renderer}`],
      2,
    );

    const proxySubscriberReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-inline-omid-proxy-subscriber');
    assert.ok(proxySubscriberReport);
    assert.equal(proxySubscriberReport.outcome.status, 'failed');
    assert.equal(proxySubscriberReport.outcome.bucket, 'measurement-omid');
    assert.equal(
      proxySubscriberReport.diagnostics.measurement.omid.inlineVendor.diagnosticOutcome,
      'unattributed-lifecycle',
    );
    assert.equal(proxySubscriberReport.diagnostics.measurement.omid.inlineVendor.subscriptionObserved, true);
    assert.equal(
      proxySubscriberReport.diagnostics.measurement.omid.inlineVendor.expectedVendorSubscriptionObserved,
      false,
    );
    assert.equal(
      proxySubscriberReport.diagnostics.measurement.omid.inlineVendor.callsByVendorKey['455256'],
      1,
    );
    assert.equal(
      proxySubscriberReport.diagnostics.measurement.omid.inlineVendor.callsBySourceOrigin[
        'https://cadmus2.script.ac'
      ],
      2,
    );
    assert.equal(
      proxySubscriberReport.diagnostics.measurement.omid.inlineVendor.callsBySourceVendor.unknown,
      2,
    );
    assert.equal(
      proxySubscriberReport.diagnostics.measurement.omid.inlineVendor
        .unattributedCallsBySourceOrigin['https://cadmus2.script.ac'],
      2,
    );
    assert.equal(
      proxySubscriberReport.diagnostics.measurement.omid.inlineVendor
        .unattributedCallsBySourceVendor.unknown,
      2,
    );

    const mixedSubscriberReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-inline-omid-mixed-subscriber');
    assert.ok(mixedSubscriberReport);
    assert.equal(mixedSubscriberReport.outcome.status, 'passed');
    assert.equal(mixedSubscriberReport.outcome.bucket, 'passed');
    assert.equal(mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.subscriptionObserved, true);
    assert.equal(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.expectedVendorSubscriptionObserved,
      true,
    );
    assert.equal(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.unattributedSubscriptionObserved,
      true,
    );
    assert.equal(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.unattributedSubscriptionCalls,
      2,
    );
    assert.ok(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor
        .callsByExpectedVendor.doubleverify >= 1,
    );
    assert.ok(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.registerSessionObserverCalls >= 2,
    );
    assert.ok(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.addEventListenerCalls >= 2,
    );
    assert.equal(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.diagnosticOutcome,
      'expected-vendor-lifecycle',
    );
    assert.ok(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.callsBySourceVendor.doubleverify >= 1,
    );
    assert.ok(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor.callsBySourceVendor.unknown >= 1,
    );
    assert.equal(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor
        .unattributedCallsBySourceVendor.doubleverify,
      undefined,
    );
    assert.ok(
      mixedSubscriberReport.diagnostics.measurement.omid.inlineVendor
        .unattributedCallsBySourceVendor.unknown >= 1,
    );

    const networkReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-network-404');
    assert.ok(networkReport);
    assert.equal(networkReport.outcome.status, 'passed');
    assert.equal(networkReport.outcome.bucket, 'passed');
    assert.ok(networkReport.diagnostics.failedResponses.some((response) =>
      response.status === 404 && response.resourceType === 'fetch'));
    assert.equal(networkReport.diagnostics.network.failedRequestCount, 0);
    assert.ok(networkReport.diagnostics.network.failedResponseCount >= 1);
    assert.ok(networkReport.diagnostics.network.byStatus['404'] >= 1);
    assert.ok(networkReport.diagnostics.network.byResourceType.fetch >= 1);

    const docWriteReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-document-write');
    assert.ok(docWriteReport);
    assert.equal(docWriteReport.outcome.status, 'passed');
    assert.equal(docWriteReport.diagnostics.navigationDiagnostics.documentWrite.count, 2);
    assert.equal(docWriteReport.diagnostics.navigationDiagnostics.documentWrite.writelnCount, 1);
    assert.equal(docWriteReport.diagnostics.navigationDiagnostics.documentWrite.patterns.iframe, 1);
    assert.equal(docWriteReport.diagnostics.navigationDiagnostics.documentWrite.patterns.location, 1);
    assert.equal(docWriteReport.diagnostics.navigationDiagnostics.documentWrite.patterns.metaRefresh, 1);
    assert.equal(docWriteReport.diagnostics.navigationDiagnostics.documentWrite.patterns.scriptSrc, 1);
    assert.equal(docWriteReport.diagnostics.navigationDiagnostics.documentWrite.patterns.windowOpen, 1);

    const windowOpenReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-window-open');
    assert.ok(windowOpenReport);
    assert.equal(windowOpenReport.outcome.status, 'passed');
    assert.equal(windowOpenReport.diagnostics.navigationDiagnostics.windowOpen.count, 1);
    assert.equal(windowOpenReport.diagnostics.navigationDiagnostics.windowOpen.calls[0].url.origin, 'https://click.example');
    assert.equal(windowOpenReport.diagnostics.navigationDiagnostics.windowOpen.calls[0].url.protocol, 'https:');
    assert.equal(windowOpenReport.diagnostics.navigationDiagnostics.windowOpen.calls[0].target, '_blank');

    const scriptLoadOkReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-script-load-ok');
    assert.ok(scriptLoadOkReport);
    assert.equal(scriptLoadOkReport.outcome.status, 'passed');
    assert.equal(scriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(scriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 1);
    assert.equal(scriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 0);
    assert.equal(scriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.byProtocol['http:'], 1);
    assert.equal(scriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.calls[0].url.present, true);
    assert.equal(scriptLoadOkReport.diagnostics.network.scriptCache.enabled, true);
    assert.ok(scriptLoadOkReport.diagnostics.network.scriptCache.lookups >= 1);
    assert.ok(scriptLoadOkReport.diagnostics.network.scriptCache.stores >= 1);
    assert.ok(scriptLoadOkReport.diagnostics.network.scriptCache.bytesFromNetwork > 0);
    assert.equal('entries' in scriptLoadOkReport.diagnostics.network.scriptCache, false);
    assert.equal('totalBytes' in scriptLoadOkReport.diagnostics.network.scriptCache, false);
    assert.ok(Number.isInteger(scriptLoadOkReport.diagnostics.network.scriptCache.entriesAtStart));
    assert.ok(Number.isInteger(scriptLoadOkReport.diagnostics.network.scriptCache.entriesAtEnd));
    assert.ok(scriptLoadOkReport.diagnostics.network.scriptCache.entriesAtEnd
      >= scriptLoadOkReport.diagnostics.network.scriptCache.entriesAtStart);
    assert.match(
      scriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.calls[0].url.origin,
      new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${reductionPorts.runnerSmoke.renderer}$`),
    );

    const scriptLoadMissingReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-script-load-missing');
    assert.ok(scriptLoadMissingReport);
    assert.equal(scriptLoadMissingReport.outcome.status, 'passed');
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 0);
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 1);
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.byStatus.error, 1);

    const staticScriptLoadOkReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-static-script-load-ok');
    assert.ok(staticScriptLoadOkReport);
    assert.equal(staticScriptLoadOkReport.outcome.status, 'passed');
    assert.equal(staticScriptLoadOkReport.outcome.bucket, 'passed');
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 1);
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 0);
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.byStatus.loaded, 1);
    assert.ok(staticScriptLoadOkReport.diagnostics.network.scriptCache.hits >= 1);
    assert.ok(staticScriptLoadOkReport.diagnostics.network.scriptCache.bytesFromCache > 0);

    const staticScriptLoadMissingReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-static-script-load-missing');
    assert.ok(staticScriptLoadMissingReport);
    assert.equal(staticScriptLoadMissingReport.outcome.status, 'passed');
    assert.equal(staticScriptLoadMissingReport.outcome.bucket, 'passed');
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 0);
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 1);
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.byStatus.error, 1);

    const legacyRuntimeReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-legacy-mraid-loader-runtime-only');
    assert.ok(legacyRuntimeReport);
    assert.equal(legacyRuntimeReport.outcome.status, 'passed');
    assert.equal(legacyRuntimeReport.outcome.bucket, 'passed');
    assert.equal(legacyRuntimeReport.diagnostics.legacyMraidLoader.requested, true);
    assert.ok(legacyRuntimeReport.diagnostics.legacyMraidLoader.count >= 1);
    assert.equal(legacyRuntimeReport.diagnostics.legacyMraidLoader.loadedCount, 0);
    assert.ok(legacyRuntimeReport.diagnostics.legacyMraidLoader.errorCount >= 1);
    assert.ok(legacyRuntimeReport.diagnostics.legacyMraidLoader.byStatus.discovered >= 1);
    assert.ok(legacyRuntimeReport.diagnostics.legacyMraidLoader.byStatus.error >= 1);
    assert.equal(legacyRuntimeReport.diagnostics.legacyMraidLoader.signal.declared, false);
    assert.equal(legacyRuntimeReport.diagnostics.legacyMraidLoader.signal.sniffed, false);
    assert.equal(legacyRuntimeReport.diagnostics.legacyMraidLoader.signal.runtimeOnly, true);

    const legacyDeclaredReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-legacy-mraid-loader-declared');
    assert.ok(legacyDeclaredReport);
    assert.equal(legacyDeclaredReport.outcome.status, 'passed');
    assert.equal(legacyDeclaredReport.diagnostics.legacyMraidLoader.requested, true);
    assert.ok(legacyDeclaredReport.diagnostics.legacyMraidLoader.count >= 1);
    assert.ok(legacyDeclaredReport.diagnostics.legacyMraidLoader.loadedCount >= 1);
    assert.equal(legacyDeclaredReport.diagnostics.legacyMraidLoader.errorCount, 0);
    assert.equal(legacyDeclaredReport.diagnostics.network.byStatus['404'], undefined);
    assert.equal(legacyDeclaredReport.diagnostics.legacyMraidLoader.signal.declared, true);
    assert.equal(legacyDeclaredReport.diagnostics.legacyMraidLoader.signal.sniffed, true);
    assert.equal(legacyDeclaredReport.diagnostics.legacyMraidLoader.signal.runtimeOnly, false);

    const legacySniffedOnlyReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-legacy-mraid-loader-sniffed-only');
    assert.ok(legacySniffedOnlyReport);
    assert.equal(legacySniffedOnlyReport.outcome.status, 'passed');
    assert.equal(legacySniffedOnlyReport.outcome.bucket, 'passed');
    assert.equal(legacySniffedOnlyReport.diagnostics.legacyMraidLoader.requested, true);
    assert.ok(legacySniffedOnlyReport.diagnostics.legacyMraidLoader.count >= 1);
    assert.ok(legacySniffedOnlyReport.diagnostics.legacyMraidLoader.loadedCount >= 1);
    assert.equal(legacySniffedOnlyReport.diagnostics.legacyMraidLoader.errorCount, 0);
    assert.equal(legacySniffedOnlyReport.diagnostics.network.byStatus['404'], undefined);
    assert.equal(legacySniffedOnlyReport.diagnostics.legacyMraidLoader.signal.declared, false);
    assert.equal(legacySniffedOnlyReport.diagnostics.legacyMraidLoader.signal.sniffed, true);
    assert.equal(legacySniffedOnlyReport.diagnostics.legacyMraidLoader.signal.runtimeOnly, false);

    const legacyAfterCallCapReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-legacy-mraid-loader-after-call-cap');
    assert.ok(legacyAfterCallCapReport);
    assert.equal(legacyAfterCallCapReport.outcome.status, 'passed');
    assert.equal(legacyAfterCallCapReport.diagnostics.navigationDiagnostics.scriptLoads.count, 22);
    assert.equal(legacyAfterCallCapReport.diagnostics.navigationDiagnostics.scriptLoads.calls.length, 20);
    assert.equal(legacyAfterCallCapReport.diagnostics.legacyMraidLoader.requested, true);
    assert.equal(legacyAfterCallCapReport.diagnostics.legacyMraidLoader.count, 2);
    assert.equal(legacyAfterCallCapReport.diagnostics.legacyMraidLoader.loadedCount, 2);
    assert.equal(legacyAfterCallCapReport.diagnostics.legacyMraidLoader.errorCount, 0);
    assert.equal(legacyAfterCallCapReport.diagnostics.legacyMraidLoader.signal.runtimeOnly, true);

    const nativeReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-native');
    assert.ok(nativeReport);
    assert.equal(nativeReport.outcome.status, 'skipped');
    assert.equal(nativeReport.outcome.bucket, 'unsupported-input');
    assert.equal(nativeReport.outcome.reason, 'unsupported-adm-kind:native-json');
    assert.equal(nativeReport.outcome.creativeRendered, false);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('runner passes inline OMID vendor access mode to the browser harness', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-omid-full-access-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const outPath = resolve(workDir, 'reports.jsonl');

  const inlineOmidVendor = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-inline-omid-vendor-full-access',
      impId: 'imp-runner-test',
      crid: 'creative-runner-inline-omid-vendor-full-access',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><script src="https://cdn.doubleverify.com/__sharc-validator-fixtures/omid-vendor-probe.js"></script><div>inline omid vendor</div></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
    bidSignals: {
      apis: { raw: [], sanitized: [], sources: [] },
      mtype: 'banner',
      adomain: ['runner.example'],
      cat: [],
      battr: [],
      attr: [],
      placement: { id: 'imp-runner-test', instl: 0, secure: 1, mediaTypes: ['banner'] },
      measurement: {
        omid: {
          declaredByApi: false,
          sidecarPresent: false,
          inlineVendorScriptPresent: true,
          inlineVendorScriptCount: 1,
          inlineVendorVendors: ['doubleverify'],
          inlineVendorScripts: [{
            vendor: 'doubleverify',
            source: 'adm-script-src',
            value: 'https://cdn.doubleverify.com/dvtp_src.js',
            url: {
              protocol: 'https:',
              origin: 'https://cdn.doubleverify.com',
              hostname: 'cdn.doubleverify.com',
              path: '/dvtp_src.js',
            },
          }],
          sources: [{ path: 'adm.script[src]', vendor: 'doubleverify' }],
        },
      },
    },
  });

  try {
    writeFileSync(inputPath, `${JSON.stringify(inlineOmidVendor)}\n`);
    runCli([
      'run',
      inputPath,
      '--out',
      outPath,
      '--port',
      reductionPorts.omidFullAccess.runner,
      '--renderer-port',
      reductionPorts.omidFullAccess.renderer,
      '--render-timeout-ms',
      '4000',
      '--settle-ms',
      '500',
      '--omid-inline-vendor-access-mode',
      'full',
    ]);

    const [report] = readJsonl(outPath);
    assert.equal(report.diagnostics.measurement.omid.inlineVendor.expected, true);
    assert.equal(report.diagnostics.measurement.omid.inlineVendor.accessMode, 'full');
    assert.equal(report.diagnostics.measurement.omid.inlineVendor.omid3pFound, true);
    assert.equal(report.diagnostics.measurement.omid.inlineVendor.subscriptionObserved, true);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('runner refuses public report output by default', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-guard-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const publicOut = resolve('tools/creative-validator/fixtures/reports-leak.jsonl');

  try {
    writeFileSync(inputPath, JSON.stringify(makeCase({})) + '\n');
    assert.throws(
      () => execFileSync('node', [cliPath, 'run', inputPath, '--out', publicOut], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      /Refusing to write private creative validator output outside/,
    );
    assert.equal(existsSync(publicOut), false);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('runner documents external-script navigation policy boundary', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-nav-boundary-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const outPath = resolve(workDir, 'reports.jsonl');

  const scriptCase = (slug, scriptName) => makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: `bid-runner-boundary-${slug}`,
      impId: 'imp-runner-test',
      crid: `creative-runner-boundary-${slug}`,
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><div>navigation boundary</div><script>'
        + 'window.addEventListener("load",function(){'
        + 'var script=document.createElement("script");'
        + `script.src="/tools/creative-validator/fixtures/${scriptName}";`
        + 'document.body.appendChild(script);'
        + '});'
        + '</script></body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });
  const parserScriptCase = (slug, scriptSrc) => makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: `bid-runner-boundary-${slug}`,
      impId: 'imp-runner-test',
      crid: `creative-runner-boundary-${slug}`,
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      html: '<!doctype html><html><body><div>navigation boundary</div>'
        + `<script src="${scriptSrc}"></script>`
        + '</body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });

  try {
    writeFileSync(inputPath, [
      scriptCase('noop', 'navigation-boundary-noop.js'),
      scriptCase('nested-iframe', 'navigation-boundary-nested-iframe.js'),
      scriptCase('static-iframe', 'navigation-boundary-static-iframe.js'),
      scriptCase('frame-src-attribute', 'navigation-boundary-frame-src-attribute.js'),
      scriptCase('frame-src-property', 'navigation-boundary-frame-src-property.js'),
      parserScriptCase('parser-script-ok', '/tools/creative-validator/fixtures/navigation-boundary-noop.js'),
      parserScriptCase('parser-script-404', 'mraid.js'),
      scriptCase('location', 'navigation-boundary-location.js'),
      scriptCase('meta-refresh', 'navigation-boundary-meta-refresh.js'),
      scriptCase('form-submit', 'navigation-boundary-form-submit.js'),
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    execFileSync('node', [
      cliPath,
      'run',
      inputPath,
      '--out',
      outPath,
      '--port',
      reductionPorts.externalScript.runner,
      '--renderer-port',
      reductionPorts.externalScript.renderer,
      '--render-timeout-ms',
      '4000',
      '--settle-ms',
      '1500',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const reports = readJsonl(outPath);
    assert.equal(reports.length, 10);

    const bySlug = (slug) => reports.find((row) =>
      row.case.ids.bidId === `bid-runner-boundary-${slug}`);
    const assertScriptLoaded = (row) => {
      assert.equal(row.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
      assert.equal(row.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 1);
      assert.equal(row.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 0);
      assert.equal(row.diagnostics.navigationDiagnostics.scriptLoads.byProtocol['http:'], 1);
    };
    const assertNavigationPolicy = (row) => {
      assert.equal(row.outcome.status, 'failed');
      assert.equal(row.outcome.bucket, 'navigation-policy');
      assert.equal(row.outcome.reason, 'unauthorized navigation');
      assert.equal(row.outcome.creativeRendered, true);
      assert.equal(row.outcome.terminated, true);
      assert.ok(row.diagnostics.securityEvents.some((event) =>
        event.type === 'unauthorized_navigation'
          && event.details
          && event.details.variant === 'markup'));
      assertScriptLoaded(row);
      assert.equal(row.diagnostics.navigationDiagnostics.windowOpen.count, 0);
      assert.equal(row.diagnostics.navigationDiagnostics.bridgeCalls.count, 0);
    };

    const noop = bySlug('noop');
    assert.ok(noop);
    assert.equal(noop.outcome.status, 'passed');
    assert.equal(noop.outcome.bucket, 'passed');
    assert.equal(noop.outcome.terminated, false);
    assertScriptLoaded(noop);

    const nestedIframe = bySlug('nested-iframe');
    assert.ok(nestedIframe);
    assert.equal(nestedIframe.outcome.status, 'passed');
    assert.equal(nestedIframe.outcome.bucket, 'passed');
    assert.equal(nestedIframe.outcome.terminated, false);
    assertScriptLoaded(nestedIframe);
    assert.ok(nestedIframe.diagnostics.navigationDiagnostics.documentSources.count >= 1);
    assert.ok(nestedIframe.diagnostics.navigationDiagnostics.documentSources.byKind.frame >= 1);
    assert.ok(nestedIframe.diagnostics.navigationDiagnostics.documentSources.byTag.iframe >= 1);

    const staticIframe = bySlug('static-iframe');
    assert.ok(staticIframe);
    assert.equal(staticIframe.outcome.status, 'passed');
    assert.equal(staticIframe.outcome.bucket, 'passed');
    assertScriptLoaded(staticIframe);
    assert.equal(staticIframe.diagnostics.navigationDiagnostics.documentSources.count, 1);
    assert.equal(staticIframe.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(staticIframe.diagnostics.navigationDiagnostics.documentSources.byTag.iframe, 1);

    const frameSrcAttribute = bySlug('frame-src-attribute');
    assert.ok(frameSrcAttribute);
    assert.equal(frameSrcAttribute.outcome.status, 'passed');
    assert.equal(frameSrcAttribute.outcome.bucket, 'passed');
    assertScriptLoaded(frameSrcAttribute);
    assert.equal(frameSrcAttribute.diagnostics.navigationDiagnostics.documentSources.count, 2);
    assert.equal(frameSrcAttribute.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(frameSrcAttribute.diagnostics.navigationDiagnostics.documentSources.byKind['frame-src'], 1);
    assert.equal(frameSrcAttribute.diagnostics.navigationDiagnostics.documentSources.byProtocol['http:'], 2);
    assert.ok(
      frameSrcAttribute.diagnostics.navigationDiagnostics.documentSources.calls.some((call) =>
        call.kind === 'frame-src'
          && call.assignment === 'attribute'
          && call.assignedUrl
          && call.assignedUrl.origin === `http://localhost:${reductionPorts.externalScript.renderer}`
          && call.url
          && call.url.origin === `http://localhost:${reductionPorts.externalScript.renderer}`),
    );

    const frameSrcProperty = bySlug('frame-src-property');
    assert.ok(frameSrcProperty);
    assert.equal(frameSrcProperty.outcome.status, 'passed');
    assert.equal(frameSrcProperty.outcome.bucket, 'passed');
    assertScriptLoaded(frameSrcProperty);
    assert.equal(frameSrcProperty.diagnostics.navigationDiagnostics.documentSources.count, 2);
    assert.equal(frameSrcProperty.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(frameSrcProperty.diagnostics.navigationDiagnostics.documentSources.byKind['frame-src'], 1);
    assert.equal(frameSrcProperty.diagnostics.navigationDiagnostics.documentSources.byProtocol['http:'], 2);
    assert.ok(
      frameSrcProperty.diagnostics.navigationDiagnostics.documentSources.calls.some((call) =>
        call.kind === 'frame-src'
          && call.assignment === 'property'
          && call.assignedUrl
          && call.assignedUrl.origin === `http://localhost:${reductionPorts.externalScript.renderer}`
          && call.url
          && call.url.origin === `http://localhost:${reductionPorts.externalScript.renderer}`),
    );

    const parserScriptOk = bySlug('parser-script-ok');
    assert.ok(parserScriptOk);
    assert.equal(parserScriptOk.outcome.status, 'passed');
    assert.equal(parserScriptOk.outcome.bucket, 'passed');
    assert.equal(parserScriptOk.outcome.terminated, false);
    assertScriptLoaded(parserScriptOk);

    const parserScript404 = bySlug('parser-script-404');
    assert.ok(parserScript404);
    assert.equal(parserScript404.outcome.status, 'passed');
    assert.equal(parserScript404.outcome.bucket, 'passed');
    assert.equal(parserScript404.outcome.terminated, false);
    assert.equal(parserScript404.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(parserScript404.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 0);
    assert.equal(parserScript404.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 1);
    assert.equal(parserScript404.diagnostics.legacyMraidLoader.requested, true);
    assert.equal(parserScript404.diagnostics.legacyMraidLoader.signal.runtimeOnly, true);

    assertNavigationPolicy(bySlug('location'));
    assertNavigationPolicy(bySlug('meta-refresh'));
    const formSubmit = bySlug('form-submit');
    assertNavigationPolicy(formSubmit);
    assert.ok(formSubmit.diagnostics.navigationDiagnostics.documentSources.byKind.form >= 1);
    assert.ok(formSubmit.diagnostics.navigationDiagnostics.documentSources.byOrigin['https://click.example'] >= 1);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

// #362: quarantined out of the 26-case batch run. In the batch (settle-ms 500)
// this case's verdict-timing margin was too thin under CI load and intermittently
// reported `passed`. Running it alone at the same generous settle the other
// post-render navigation-policy reductions use (1500ms, matching the fatal-path
// force-terminate fallback) removes the margin without widening settle for all
// 26 in-batch cases. The contract asserted here is identical to the one the batch
// previously carried for bid-runner-script-load-navigation.
test('runner buckets external script-load post-render navigation as navigation-policy', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-script-load-nav-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const outPath = resolve(workDir, 'reports.jsonl');

  const scriptLoadNavigation = makeCase({
    ids: {
      requestId: 'request-runner-test',
      responseId: 'response-runner-test',
      bidId: 'bid-runner-script-load-navigation',
      impId: 'imp-runner-test',
      crid: 'creative-runner-script-load-navigation',
    },
    creative: {
      mode: 'adm-html',
      admKind: 'html',
      // #344: load the fixture synchronously at parse time (not on window.load)
      // so its onReady registration always precedes the container's
      // 200ms-deferred Container:init. onReady is single-shot and not replayed
      // to late subscribers, so registering before init is what makes the
      // post-render navigation fire deterministically (see the fixture header).
      html: '<!doctype html><html><body>'
        + '<script src="/tools/creative-validator/fixtures/script-load-navigation.js"></script>'
        + '</body></html>',
      url: null,
      width: 320,
      height: 50,
      placementType: 'inline',
      transformations: [],
    },
  });

  try {
    writeFileSync(inputPath, JSON.stringify(scriptLoadNavigation) + '\n');
    execFileSync('node', [
      cliPath,
      'run',
      inputPath,
      '--out',
      outPath,
      '--port',
      reductionPorts.scriptLoadNavigation.runner,
      '--renderer-port',
      reductionPorts.scriptLoadNavigation.renderer,
      '--render-timeout-ms',
      '4000',
      '--settle-ms',
      // Unauthorized navigation enters the fatal-error path, whose production
      // force-terminate fallback is 1s if the renderer does not acknowledge.
      // Matches test #6's budget so the verdict always settles before report.
      '1500',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const reports = readJsonl(outPath);
    assert.equal(reports.length, 1);
    const [reportRow] = reports;
    assert.equal(reportRow.case.ids.bidId, 'bid-runner-script-load-navigation');
    assert.equal(reportRow.outcome.status, 'failed');
    assert.equal(reportRow.outcome.bucket, 'navigation-policy');
    assert.equal(reportRow.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(reportRow.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 1);
    assert.equal(reportRow.diagnostics.navigationDiagnostics.windowOpen.count, 0);
    assert.equal(reportRow.diagnostics.navigationDiagnostics.bridgeCalls.count, 0);
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});

test('runner buckets post-render iframe navigation reduction as navigation-policy', () => {
  withReductionFixture({
    fixturePath: navigationReductionPath,
    workDirPrefix: 'test-runner-navigation-',
    ports: reductionPorts.navigation,
    runOptions: [
      '--settle-ms',
      // Unauthorized navigation enters the fatal-error path, whose production
      // force-terminate fallback is 1s if the renderer does not acknowledge.
      '1500',
    ],
  }, ({ reports }) => {
    assert.equal(reports.length, 1);
    const [reportRow] = reports;
    assert.equal(reportRow.case.ids.bidId, 'bid-navigation-policy-post-render');
    assert.equal(reportRow.case.creative.html, undefined);
    assert.equal(reportRow.outcome.status, 'failed');
    assert.equal(reportRow.outcome.bucket, 'navigation-policy');
    assert.equal(reportRow.outcome.reason, 'unauthorized navigation');
    assert.equal(reportRow.outcome.creativeRendered, true);
    assert.equal(reportRow.outcome.terminated, true);
    const navEvent = reportRow.diagnostics.securityEvents.find((event) =>
      event.type === 'unauthorized_navigation');
    assert.ok(navEvent);
    assert.equal(navEvent.details.variant, 'markup');
    assert.equal(typeof navEvent.details.msSinceRender, 'number');
    const lifecycleMarkers = reportRow.diagnostics.console
      .map((message) => message.text.match(/^\[sharc-reduction-lifecycle\] (.+)$/))
      .filter(Boolean)
      .map((match) => JSON.parse(match[1]));
    assert.deepEqual(
      lifecycleMarkers.map((marker) => marker.name),
      ['script-start', 'domcontentloaded', 'load', 'before-navigation'],
    );
    assert.equal(
      lifecycleMarkers.find((marker) => marker.name === 'before-navigation').readyState,
      'complete',
    );
  });
});

test('runner documents nested document-source reduction as passing diagnostics', () => {
  withReductionFixture({
    fixturePath: documentSourceReductionPath,
    workDirPrefix: 'test-runner-document-sources-',
    ports: reductionPorts.documentSource,
    runOptions: [
      '--settle-ms',
      '1500',
    ],
    includeTriage: true,
  }, ({ reports, summary }) => {
    assert.equal(reports.length, 4);
    assert.equal(reports.filter((row) => row.outcome.status === 'passed').length, 4);
    assert.equal(reports.filter((row) => row.outcome.bucket === 'passed').length, 4);

    const byBid = (bidId) => reports.find((row) => row.case.ids.bidId === bidId);
    const srcdoc = byBid('bid-document-source-srcdoc');
    assert.ok(srcdoc);
    assert.equal(srcdoc.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(srcdoc.diagnostics.navigationDiagnostics.documentSources.byProtocol.unknown, 1);
    assert.ok(srcdoc.diagnostics.navigationDiagnostics.documentSources.calls.some((call) =>
      call.kind === 'frame' && call.srcdoc === true));

    const about = byBid('bid-document-source-about');
    assert.ok(about);
    assert.equal(about.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(about.diagnostics.navigationDiagnostics.documentSources.byProtocol['about:'], 1);

    const attribute = byBid('bid-document-source-frame-src-attribute');
    assert.ok(attribute);
    assert.equal(attribute.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(attribute.diagnostics.navigationDiagnostics.documentSources.byKind['frame-src'], 1);
    assert.ok(attribute.diagnostics.navigationDiagnostics.documentSources.calls.some((call) =>
      call.kind === 'frame-src' && call.assignment === 'attribute'));

    const property = byBid('bid-document-source-frame-src-property');
    assert.ok(property);
    assert.equal(property.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(property.diagnostics.navigationDiagnostics.documentSources.byKind['frame-src'], 1);
    assert.ok(property.diagnostics.navigationDiagnostics.documentSources.calls.some((call) =>
      call.kind === 'frame-src' && call.assignment === 'property'));

    const network = summary.corpusDiagnostics.network;
    assert.equal(summary.totals.passed, 4);
    assert.equal(summary.totals.failed, 0);
    assert.equal(network.rowsWithDocumentSources, 4);
    assert.deepEqual(network.documentSourceRowsByClass, {
      'observed-frame': 4,
      'blank-or-opaque-document': 2,
      'external-frame': 2,
      'frame-src-assignment': 2,
      'insecure-frame': 2,
      'srcdoc-frame': 1,
    });
    assert.deepEqual(network.documentSourceRowsByClassAndBidder, {
      'blank-or-opaque-document|synthetic-document-source-about': 1,
      'blank-or-opaque-document|synthetic-document-source-srcdoc': 1,
      'external-frame|synthetic-document-source-frame-src-attribute': 1,
      'external-frame|synthetic-document-source-frame-src-property': 1,
      'frame-src-assignment|synthetic-document-source-frame-src-attribute': 1,
      'frame-src-assignment|synthetic-document-source-frame-src-property': 1,
      'insecure-frame|synthetic-document-source-frame-src-attribute': 1,
      'insecure-frame|synthetic-document-source-frame-src-property': 1,
      'observed-frame|synthetic-document-source-about': 1,
      'observed-frame|synthetic-document-source-frame-src-attribute': 1,
      'observed-frame|synthetic-document-source-frame-src-property': 1,
      'observed-frame|synthetic-document-source-srcdoc': 1,
      'srcdoc-frame|synthetic-document-source-srcdoc': 1,
    });
  });
});

test('runner documents delayed opaque document-source reduction as passing diagnostics', () => {
  withReductionFixture({
    fixturePath: opaqueDocumentReductionPath,
    workDirPrefix: 'test-runner-opaque-documents-',
    ports: reductionPorts.opaqueDocument,
    runOptions: [
      '--settle-ms',
      '1500',
    ],
    includeTriage: true,
  }, ({ reports, summary }) => {
    assert.equal(reports.length, 3);
    assert.equal(reports.filter((row) => row.outcome.status === 'passed').length, 3);
    assert.equal(reports.filter((row) => row.outcome.bucket === 'passed').length, 3);

    const byBid = (bidId) => reports.find((row) => row.case.ids.bidId === bidId);
    const about = byBid('bid-opaque-delayed-about');
    assert.ok(about);
    assert.equal(about.diagnostics.navigationDiagnostics.documentSources.count, 1);
    assert.deepEqual(about.diagnostics.navigationDiagnostics.documentSources.byKind, { frame: 1 });
    assert.deepEqual(about.diagnostics.navigationDiagnostics.documentSources.byProtocol, { 'about:': 1 });

    const srcdoc = byBid('bid-opaque-delayed-srcdoc');
    assert.ok(srcdoc);
    assert.equal(srcdoc.diagnostics.navigationDiagnostics.documentSources.count, 1);
    assert.deepEqual(srcdoc.diagnostics.navigationDiagnostics.documentSources.byKind, { frame: 1 });
    assert.deepEqual(srcdoc.diagnostics.navigationDiagnostics.documentSources.byProtocol, { unknown: 1 });
    assert.ok(srcdoc.diagnostics.navigationDiagnostics.documentSources.calls.some((call) =>
      call.kind === 'frame' && call.srcdoc === true));

    const repeated = byBid('bid-opaque-repeated-frames');
    assert.ok(repeated);
    assert.equal(repeated.diagnostics.navigationDiagnostics.documentSources.count, 3);
    assert.deepEqual(repeated.diagnostics.navigationDiagnostics.documentSources.byKind, { frame: 3 });
    assert.deepEqual(repeated.diagnostics.navigationDiagnostics.documentSources.byProtocol, {
      'about:': 1,
      unknown: 2,
    });
    assert.equal(
      repeated.diagnostics.navigationDiagnostics.documentSources.calls.filter((call) => call.srcdoc === true).length,
      1,
    );

    const network = summary.corpusDiagnostics.network;
    assert.equal(summary.totals.passed, 3);
    assert.equal(summary.totals.failed, 0);
    assert.equal(network.rowsWithFailedRequests, 0);
    assert.equal(network.rowsWithFailedDocuments, 0);
    assert.equal(network.rowsWithDocumentSources, 3);
    assert.deepEqual(network.documentSourceRowsByClass, {
      'blank-or-opaque-document': 3,
      'observed-frame': 3,
      'srcdoc-frame': 2,
    });
    assert.deepEqual(network.documentSourceEventsByClass, {
      'blank-or-opaque-document': 5,
      'observed-frame': 5,
      'srcdoc-frame': 2,
    });
    assert.deepEqual(network.documentSourceRowsByClassAndBidder, {
      'blank-or-opaque-document|synthetic-opaque-delayed-about': 1,
      'blank-or-opaque-document|synthetic-opaque-delayed-srcdoc': 1,
      'blank-or-opaque-document|synthetic-opaque-repeated-frames': 1,
      'observed-frame|synthetic-opaque-delayed-about': 1,
      'observed-frame|synthetic-opaque-delayed-srcdoc': 1,
      'observed-frame|synthetic-opaque-repeated-frames': 1,
      'srcdoc-frame|synthetic-opaque-delayed-srcdoc': 1,
      'srcdoc-frame|synthetic-opaque-repeated-frames': 1,
    });
  });
});

test('runner documents CSP embedded-frame diagnostics as passing diagnostics', () => {
  withReductionFixture({
    fixturePath: cspEmbeddedFrameReductionPath,
    workDirPrefix: 'test-runner-csp-embedded-frames-',
    ports: reductionPorts.cspEmbeddedFrame,
    runOptions: [
      '--settle-ms',
      '1500',
    ],
    includeTriage: true,
  }, ({ reports, summary }) => {
    assert.equal(reports.length, 2);
    assert.equal(reports.filter((row) => row.outcome.status === 'passed').length, 2);
    assert.equal(reports.filter((row) => row.outcome.bucket === 'passed').length, 2);

    const byBid = (bidId) => reports.find((row) => row.case.ids.bidId === bidId);
    const staticFrame = byBid('bid-csp-embedded-static-frame');
    assert.ok(staticFrame);
    assert.equal(staticFrame.diagnostics.network.cspConsoleCount, 1);
    assert.equal(staticFrame.diagnostics.network.failedRequestCount, 1);
    assert.equal(staticFrame.diagnostics.network.byResourceType.document, 1);
    assert.match(
      staticFrame.diagnostics.network.cspConsole[0].text,
      /Content Security Policy/,
    );
    assert.equal(staticFrame.diagnostics.navigationDiagnostics.documentSources.count, 1);
    assert.equal(staticFrame.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(staticFrame.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 0);

    const delayedFrame = byBid('bid-csp-embedded-delayed-frame');
    assert.ok(delayedFrame);
    assert.equal(delayedFrame.diagnostics.network.cspConsoleCount, 1);
    assert.equal(delayedFrame.diagnostics.network.failedRequestCount, 1);
    assert.equal(delayedFrame.diagnostics.network.byResourceType.document, 1);
    assert.equal(delayedFrame.diagnostics.navigationDiagnostics.documentSources.count, 2);
    assert.equal(delayedFrame.diagnostics.navigationDiagnostics.documentSources.byKind.frame, 1);
    assert.equal(delayedFrame.diagnostics.navigationDiagnostics.documentSources.byKind['frame-src'], 1);
    assert.equal(delayedFrame.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 1);
    assert.equal(delayedFrame.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 0);

    const network = summary.corpusDiagnostics.network;
    assert.equal(summary.totals.passed, 2);
    assert.equal(summary.totals.failed, 0);
    assert.equal(network.rowsWithCspConsole, 2);
    assert.equal(network.rowsWithFailedDocuments, 2);
    assert.equal(network.byShape['request:1 response:0 cors:0 csp:1'], 2);
    assert.deepEqual(network.cspRowsByBidder, {
      'synthetic-csp-embedded-delayed-frame': 1,
      'synthetic-csp-embedded-static-frame': 1,
    });
    assert.deepEqual(network.documentSourceRowsByClass, {
      'external-frame': 2,
      'insecure-frame': 2,
      'observed-frame': 2,
      'frame-src-assignment': 1,
    });

    const scripts = summary.corpusDiagnostics.scriptLoads;
    assert.equal(scripts.rowsWithErrors, 0);
    assert.equal(scripts.rowsWithErrorsByClass['script-csp-blocked'], undefined);
    assert.deepEqual(scripts.rowsWithErrorsByClass, {});
  });
});
