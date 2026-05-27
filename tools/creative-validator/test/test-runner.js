#!/usr/bin/env node

/**
 * test-runner.js — creative validator Phase 2 runner coverage.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const cliPath = resolve('tools/creative-validator/src/cli.js');
const navigationReductionPath = resolve(
  'tools/creative-validator/fixtures/reductions/002-navigation-policy-post-render/cleaned-corpus.fixture.json',
);

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
      requireSharcInit: false,
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
        + 'Object.defineProperty(window,"mraid",{configurable:true,set:function(value){'
        + 'value.getState=function(){throw new Error("probe boom")};'
        + 'Object.defineProperty(window,"mraid",{configurable:true,value:value});'
        + '}});'
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
      requireSharcInit: false,
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
      requireSharcInit: false,
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
      requireSharcInit: false,
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
      html: '<!doctype html><html><body><script>'
        + 'window.addEventListener("load",function(){'
        + 'var script=document.createElement("script");'
        + 'script.src="/tools/creative-validator/fixtures/script-load-navigation.js";'
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
      sharcRequestNavigationSync,
      omid,
      network404,
      docWrite,
      windowOpen,
      scriptLoadOk,
      scriptLoadMissing,
      scriptLoadNavigation,
      staticScriptLoadOk,
      staticScriptLoadMissing,
      skipped,
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');
    execFileSync('node', [
      cliPath,
      'run',
      inputPath,
      '--out',
      outPath,
      '--port',
      '18867',
      '--renderer-port',
      '18868',
      '--render-timeout-ms',
      '4000',
      '--settle-ms',
      '100',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const reports = readJsonl(outPath);
    assert.equal(reports.length, 17);

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
    assert.equal(htmlReport.diagnostics.bridgeProbes.length, 1);
    assert.equal(htmlReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.installed, false);
    assert.equal(htmlReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.installed, false);
    assert.equal(htmlReport.diagnostics.measurement.omid.expected, false);

    const mraidReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid');
    assert.ok(mraidReport);
    assert.equal(mraidReport.outcome.status, 'passed');
    assert.equal(mraidReport.diagnostics.bridgeProbes.length, 1);
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.exists, true);
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.installed, true);
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.getState.status, 'ok');
    assert.equal(mraidReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.getVersion.status, 'ok');

    const safeframeReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-safeframe');
    assert.ok(safeframeReport);
    assert.equal(safeframeReport.outcome.status, 'passed');
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.exists, true);
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.installed, true);
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.methods.geom.status, 'ok');
    assert.equal(safeframeReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.methods.supports.status, 'ok');

    const missingMraidReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid-missing');
    assert.ok(missingMraidReport);
    assert.equal(missingMraidReport.outcome.status, 'failed');
    assert.equal(missingMraidReport.outcome.bucket, 'bridge-missing');

    const mraidApiErrorReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid-api-error');
    assert.ok(mraidApiErrorReport);
    assert.equal(mraidApiErrorReport.outcome.status, 'failed');
    assert.equal(mraidApiErrorReport.outcome.bucket, 'bridge-api-error');
    assert.equal(
      mraidApiErrorReport.diagnostics.bridgeProbes.at(-1).bridges.mraid.methods.getState.status,
      'threw',
    );

    const mraidOpenReport = reports.find((row) => row.case.ids.bidId === 'bid-runner-mraid-open');
    assert.ok(mraidOpenReport);
    assert.equal(mraidOpenReport.outcome.status, 'passed');
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['mraid.open'], 1);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['sharc.requestNavigation'], 1);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.byProtocol['https:'], 2);
    assert.equal(mraidOpenReport.diagnostics.navigationDiagnostics.bridgeCalls.calls[0].url.origin, 'https://click.example');

    const sharcSyncReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-sharc-request-navigation-sync');
    assert.ok(sharcSyncReport);
    assert.equal(sharcSyncReport.outcome.status, 'passed');
    assert.equal(
      sharcSyncReport.diagnostics.navigationDiagnostics.bridgeCalls.byMethod['sharc.requestNavigation'],
      1,
    );
    assert.equal(
      sharcSyncReport.diagnostics.navigationDiagnostics.bridgeCalls.calls[0].url.origin,
      'https://click.example',
    );

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
    assert.deepEqual(omidReport.diagnostics.bridgeProbes.at(-1).bridges.safeframe.installed, false);

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
    assert.match(
      scriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.calls[0].url.origin,
      /^http:\/\/(?:127\.0\.0\.1|localhost):18868$/,
    );

    const scriptLoadMissingReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-script-load-missing');
    assert.ok(scriptLoadMissingReport);
    assert.equal(scriptLoadMissingReport.outcome.status, 'passed');
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 0);
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 1);
    assert.equal(scriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.byStatus.error, 1);

    const scriptLoadNavigationReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-script-load-navigation');
    assert.ok(scriptLoadNavigationReport);
    assert.equal(scriptLoadNavigationReport.outcome.status, 'failed');
    assert.equal(scriptLoadNavigationReport.outcome.bucket, 'navigation-policy');
    assert.equal(scriptLoadNavigationReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(scriptLoadNavigationReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 1);
    assert.equal(scriptLoadNavigationReport.diagnostics.navigationDiagnostics.windowOpen.count, 0);
    assert.equal(scriptLoadNavigationReport.diagnostics.navigationDiagnostics.bridgeCalls.count, 0);

    const staticScriptLoadOkReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-static-script-load-ok');
    assert.ok(staticScriptLoadOkReport);
    assert.equal(staticScriptLoadOkReport.outcome.status, 'failed');
    assert.equal(staticScriptLoadOkReport.outcome.bucket, 'navigation-policy');
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 1);
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 0);
    assert.equal(staticScriptLoadOkReport.diagnostics.navigationDiagnostics.scriptLoads.byStatus.loaded, 1);

    const staticScriptLoadMissingReport = reports.find((row) =>
      row.case.ids.bidId === 'bid-runner-static-script-load-missing');
    assert.ok(staticScriptLoadMissingReport);
    assert.equal(staticScriptLoadMissingReport.outcome.status, 'failed');
    assert.equal(staticScriptLoadMissingReport.outcome.bucket, 'navigation-policy');
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.count, 1);
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.loadedCount, 0);
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.errorCount, 1);
    assert.equal(staticScriptLoadMissingReport.diagnostics.navigationDiagnostics.scriptLoads.byStatus.error, 1);

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

test('runner buckets post-render iframe navigation reduction as navigation-policy', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const workDir = mkdtempSync(resolve(privateRoot, 'test-runner-navigation-'));
  const inputPath = resolve(workDir, 'cases.jsonl');
  const outPath = resolve(workDir, 'reports.jsonl');

  try {
    execFileSync('node', [cliPath, 'normalize', navigationReductionPath, '--out', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execFileSync('node', [
      cliPath,
      'run',
      inputPath,
      '--out',
      outPath,
      '--port',
      '18869',
      '--renderer-port',
      '18870',
      '--render-timeout-ms',
      '4000',
      '--settle-ms',
      // Unauthorized navigation enters the fatal-error path, whose production
      // force-terminate fallback is 1s if the renderer does not acknowledge.
      '1500',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const reports = readJsonl(outPath);
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
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
});
