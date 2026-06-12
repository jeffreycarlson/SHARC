#!/usr/bin/env node

/**
 * test-normalizer.js — creative validator Phase 1 coverage.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  classifyAdmKind,
  extractInlineOmidVendorScripts,
  isOmidProductVendorScript,
  normalizeCleanedCorpus,
  omidVendorMatchesHostname,
  sanitizeApiDeclarations,
  toJsonl,
  unwrapAdm,
} from '../src/normalizer.js';

const fixturePath = resolve(
  'tools/creative-validator/fixtures/reductions/001-normalizer-cleaned-corpus/cleaned-corpus.fixture.json',
);
const cliPath = resolve('tools/creative-validator/src/cli.js');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const cases = normalizeCleanedCorpus(fixture, { sourceFile: fixturePath });

function stringLiterals(source) {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function normalizerOmidVendorHosts() {
  const source = readFileSync(resolve('tools/creative-validator/src/normalizer.js'), 'utf8');
  const block = source.match(/const OMID_VENDOR_SCRIPT_HOSTS = \[(.*?)\];/s);
  assert.ok(block, 'normalizer OMID vendor host block exists');
  const hosts = [];
  for (const match of block[1].matchAll(/hosts:\s*\[([^\]]*)\]/g)) {
    hosts.push(...stringLiterals(match[1]));
  }
  return hosts.sort();
}

function runnerOmidVendorHosts() {
  const source = readFileSync(resolve('tools/creative-validator/harness/markup-runner.html'), 'utf8');
  const block = source.match(/function classifyOmidVendorSourceUrl\(value\) \{(.*?)\n\}/s);
  assert.ok(block, 'runner OMID vendor source classifier exists');
  return [...block[1].matchAll(/\[([\s\S]*?)\]\s*\.some/g)]
    .flatMap((match) => stringLiterals(match[1]))
    .sort();
}

test('API sanitization filters, deduplicates, and sorts known integer codes', () => {
  assert.deepEqual(sanitizeApiDeclarations([7, 3, 999, 3, 'x', 10, 5]), [3, 5, 7, 10]);
});

test('adm classification detects supported and skipped creative kinds', () => {
  assert.equal(classifyAdmKind('<script src="mraid.js"></script>'), 'html-mraid');
  assert.equal(classifyAdmKind('<script>mraid.open("https://click.example/")</script>'), 'html-mraid');
  assert.equal(classifyAdmKind('<div><a href="https://mraid.example.com/ad"></a></div>'), 'html');
  assert.equal(
    classifyAdmKind('<script>$sf.ext.register(1,1,function(){})</script>'),
    'html-safeframe',
  );
  assert.equal(classifyAdmKind('<?xml version="1.0"?><VAST></VAST>'), 'vast-xml');
  assert.equal(classifyAdmKind('{"native":{"assets":[]}}'), 'native-json');
});

test('adm unwrap handles conservative wrapper formats', () => {
  const encoded = Buffer.from(
    '<html><body><div>decoded</div><script>window.__creativeLoaded = true;</script></body></html>',
    'utf8',
  ).toString('base64');
  const unwrapped = unwrapAdm(encoded);
  assert.match(unwrapped.adm, /decoded/);
  assert.deepEqual(unwrapped.transformations, ['base64']);

  const encodedJson = Buffer.from(
    JSON.stringify({ renderables: [{ adm: '<div>json inner</div>' }] }),
    'utf8',
  ).toString('base64');
  const jsonWrapped = unwrapAdm(encodedJson);
  assert.equal(jsonWrapped.adm, '<div>json inner</div>');
  assert.deepEqual(jsonWrapped.transformations, ['base64', 'renderables[0].adm']);

  const wrapped = unwrapAdm(JSON.stringify({ renderables: [{ adm: '<div>inner</div>' }] }));
  assert.equal(wrapped.adm, '<div>inner</div>');
  assert.deepEqual(wrapped.transformations, ['renderables[0].adm']);
});

test('adm unwrap does not tag long printable non-base64 payloads as base64', () => {
  const tokenLike = 'a'.repeat(72) + 'bbbbccccdddd';
  const unwrapped = unwrapAdm(tokenLike);
  assert.equal(unwrapped.adm, tokenLike);
  assert.deepEqual(unwrapped.transformations, []);
});

test('inline OMID vendor script detection separates instrumentation from declaration', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script src="https://cdn.doubleverify.com/dvtp_src.js"></script>
    <script src="https://static.adsafeprotected.com/ias.js"></script>
    <script src="https://z.moatads.com/example/moatad.js"></script>
    <script>window.omid3p && window.omid3p.registerSessionObserver(observer, 'vendor')</script>
  `);
  assert.deepEqual(scripts.map((script) => script.vendor), [
    'doubleverify',
    'ias',
    'moat',
    'generic-omid3p',
  ]);
  assert.equal(scripts[0].source, 'adm-script-src');
  assert.equal(scripts[0].url.origin, 'https://cdn.doubleverify.com');
  assert.equal(scripts[0].url.hostname, 'cdn.doubleverify.com');
  assert.equal(scripts[3].source, 'adm-inline-script');
  assert.equal(extractInlineOmidVendorScripts('<script src="mraid.js"></script>').length, 0);
});

test('runner OMID attribution allowlist stays aligned with normalizer host classifier', () => {
  const runnerHosts = runnerOmidVendorHosts();
  const normalizerHosts = normalizerOmidVendorHosts();
  assert.ok(runnerHosts.length > 0, 'runner OMID vendor host extraction is non-empty');
  assert.ok(normalizerHosts.length > 0, 'normalizer OMID vendor host extraction is non-empty');
  assert.deepEqual(runnerHosts, normalizerHosts);
});

test('canonical OMID vendor host matcher uses suffix registry entries only', () => {
  assert.equal(omidVendorMatchesHostname('ias', 'cdn.integralads.com'), true);
  assert.equal(omidVendorMatchesHostname('ias', 'iasds01.com'), true);
  assert.equal(omidVendorMatchesHostname('ias', 'imrworldwide.com'), false);
  assert.equal(omidVendorMatchesHostname('doubleverify', 'cdn.doubleverify.com'), true);
  assert.equal(omidVendorMatchesHostname('doubleverify', 'dv.tv'), false);
  assert.equal(omidVendorMatchesHostname('oracle', 'tags.grapeshot.co.uk'), true);
  assert.equal(omidVendorMatchesHostname('generic-omid3p', 'cdn.doubleverify.com'), false);
});

test('DV detection is product-scoped: dvbs_src* carries no OMID expectation', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script src="https://cdn.doubleverify.com/dvbs_src.js?ctx=818052&cmp=DV154857&sid=4135814"></script>
    <script src="https://cdn.doubleverify.com/dvbs_src_internal140.js"></script>
    <script src="https://cdn.doubleverify.com/dvtp_src.js?ctx=1"></script>
    <script src="https://cdn.doubleverify.com/dvbm.js"></script>
  `);
  assert.deepEqual(scripts.map((script) => script.url.path), ['/dvtp_src.js', '/dvbm.js']);
});

test('dvbs-only creative records DV presence without an OMID expectation', () => {
  const corpus = [{
    id: 'row-dvbs',
    auction: [{
      bidder: 'rubicon',
      mtype: 'banner',
      bid_request: { id: 'req-dvbs', imp: [{ id: 'imp-dvbs', banner: { w: 300, h: 250 } }] },
      bid_response: {
        id: 'res-dvbs',
        seatbid: [{
          bid: [{
            id: 'bid-dvbs',
            impid: 'imp-dvbs',
            crid: 'crid-dvbs',
            adm: '<html><body><script src="https://cdn.doubleverify.com/dvbs_src.js?ctx=1"></script><div>ad</div></body></html>',
            w: 300,
            h: 250,
          }],
        }],
      },
    }],
  }];
  const [normalized] = normalizeCleanedCorpus(corpus, { sourceFile: 'inline' });
  const omid = normalized.bidSignals.measurement.omid;
  assert.equal(omid.inlineVendorScriptPresent, false);
  assert.equal(omid.inlineVendorScriptCount, 0);
  assert.equal(omid.inlineVendorVendors, undefined);
  assert.equal(omid.inlineVendorScripts, undefined);
  assert.deepEqual(omid.inlineNonOmidVendorVendors, ['doubleverify']);
});

test('isOmidProductVendorScript re-checks stale normalized script entries', () => {
  assert.equal(isOmidProductVendorScript({
    vendor: 'doubleverify',
    value: 'https://cdn.doubleverify.com/dvbs_src.js?ctx=1',
    url: { hostname: 'cdn.doubleverify.com', path: '/dvbs_src.js' },
  }), false);
  // Falls back to parsing value when the url object is absent.
  assert.equal(isOmidProductVendorScript({
    vendor: 'doubleverify',
    value: 'https://cdn.doubleverify.com/dvbs_src_internal140.js',
  }), false);
  assert.equal(isOmidProductVendorScript({
    vendor: 'doubleverify',
    value: 'https://cdn.doubleverify.com/dvtp_src.js?dvtagver=6.1.src',
  }), true);
  assert.equal(isOmidProductVendorScript({
    vendor: 'doubleverify',
    url: { hostname: 'cdn.doubleverify.com', path: '/dvbm.js' },
  }), true);
  // Validator-owned DV-hosted fixture probes stay expectation-bearing.
  assert.equal(isOmidProductVendorScript({
    vendor: 'doubleverify',
    url: { path: '/__sharc-validator-fixtures/omid-vendor-service-probe.js' },
  }), true);
  // Vendors without product scoping are unaffected.
  assert.equal(isOmidProductVendorScript({
    vendor: 'ias',
    url: { hostname: 'static.adsafeprotected.com', path: '/anything.js' },
  }), true);
  assert.equal(isOmidProductVendorScript({
    vendor: 'generic-omid3p',
    source: 'adm-inline-script',
    value: 'omid3p observer probe',
    url: null,
  }), true);
});

test('runner DV OMID product-path scoping stays aligned with normalizer', () => {
  const normalizerSource = readFileSync(resolve('tools/creative-validator/src/normalizer.js'), 'utf8');
  const block = normalizerSource.match(/omidProductPaths:\s*\[([^\]]*)\]/);
  assert.ok(block, 'normalizer DV omidProductPaths block exists');
  const patterns = [...block[1].matchAll(/\/(?:[^/\\\n]|\\.)+\/[a-z]*/g)].map((match) => match[0]);
  assert.ok(patterns.length >= 3, 'normalizer DV omidProductPaths has product patterns');
  const runnerSource = readFileSync(resolve('tools/creative-validator/harness/markup-runner.html'), 'utf8');
  for (const pattern of patterns) {
    assert.ok(
      runnerSource.includes(pattern),
      `runner harness contains DV product path pattern ${pattern}`,
    );
  }
});

test('inline OMID vendor script detection requires vendor script hosts', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script src="https://example.com/blog/about-moatads.html"></script>
    <script src="https://cdn.example.com/integralads-tracker.js"></script>
    <script src="https://attacker.com/dvtp_src.js"></script>
    <script src="https://cdn.doubleverify.com@attacker.com/dvtp_src.js"></script>
    <script src="/dvtp_src.js"></script>
    <script>function registerSessionObserver() { return false; }</script>
  `);
  assert.deepEqual(scripts, []);
});

test('inline OMID vendor script detection requires explicit HTTPS URLs', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script src="http://cdn.doubleverify.com/dvtp_src.js"></script>
    <script src="data:text/javascript,window.omid3p"></script>
    <script src="javascript:void(0)"></script>
    <script src="//cdn.doubleverify.com/dvtp_src.js"></script>
    <script src="/dvtp_src.js"></script>
    <script src="   https://cdn.doubleverify.com/padded/dvtp_src.js   "></script>
    <script src="HTTPS://cdn.doubleverify.com/upper/dvbm.js"></script>
    <script src="https://cdn.doubleverify.com/dvtp_src.js"></script>
  `);
  assert.deepEqual(scripts.map((script) => script.vendor), [
    'doubleverify',
    'doubleverify',
    'doubleverify',
  ]);
  assert.deepEqual(scripts.map((script) => script.value), [
    'https://cdn.doubleverify.com/padded/dvtp_src.js',
    'https://cdn.doubleverify.com/upper/dvbm.js',
    'https://cdn.doubleverify.com/dvtp_src.js',
  ]);
});

test('inline OMID generic signal ignores inert text and data-type does not shadow type', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <div>window.omid3p.registerSessionObserver(function(){})</div>
    <script type="application/json">{"probe":"window.omid3p.addEventListener(function(){})"}</script>
    <script>/* window.omid3p.registerSessionObserver(function(){}) */</script>
    <script>// window.omid3p.addEventListener("impression", function(){})</script>
    <script>/** Use window.omid3p.addEventListener() for OMID observers. */</script>
    <script data-type="application/json">window.omid3p.registerSessionObserver(function(){})</script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'generic-omid3p');
});

test('inline OMID generic signal handles executable MIME parameters', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script type="text/javascript;charset=utf-8">
      window.omid3p.registerSessionObserver(function(){});
    </script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'generic-omid3p');
});

test('inline OMID generic signal survives protocol-relative strings before the call', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script>
      var u = "//cdn.example.com/verification.js"; window.omid3p.addEventListener("geometryChange", function(){});
      window.omid3p.addEventListener("impression", function(){});
    </script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'generic-omid3p');
});

test('inline OMID generic signal survives escaped URL regex literals before the call', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script>
      var urlPattern = /https?:\\/\\/[^\\s]+/; window.omid3p.registerSessionObserver(function(){});
    </script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'generic-omid3p');
});

test('inline OMID generic signal is suppressed by escaped-slash regex literal boundary', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script>
      var host = /example\\.com\\//; window.omid3p.registerSessionObserver(function(){});
    </script>
  `);
  // Known limitation #261: trailing \// is read as a line comment. When #258
  // lands tokenizer-backed scanning, flip this to assert the signal is found.
  assert.equal(scripts.length, 0);
});

test('inline OMID generic signal survives double-slash strings without counting comments', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script>
      var path = "path//thing";
      /* window.omid3p.registerSessionObserver(function(){}) */
      // window.omid3p.addEventListener("impression", function(){})
    </script>
  `);
  assert.deepEqual(scripts, []);
});

test('inline OMID generic signal is not hidden by non-matching inline body stuffing', () => {
  const scripts = extractInlineOmidVendorScripts(`
    ${'<script>noop()</script>'.repeat(64)}
    <script>window.omid3p.registerSessionObserver(function(){});</script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'generic-omid3p');
});

test('inline OMID generic signal is not hidden by token-only inline body stuffing', () => {
  const scripts = extractInlineOmidVendorScripts(`
    ${'<script>var x = "omid3p";</script>'.repeat(64)}
    <script>window.omid3p.registerSessionObserver(function(){});</script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'generic-omid3p');
});

test('inline OMID vendor script detection ignores data-src lazy-load attributes', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script data-src="https://moatads.com/x.js"></script>
  `);
  assert.deepEqual(scripts, []);
});

test('inline OMID vendor script detection ignores attributes embedded in other attribute values', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script foo="abc src='https://moatads.com/x.js' def"></script>
    <script foo='type="application/json"'>window.omid3p.registerSessionObserver(function(){});</script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'generic-omid3p');
});

test('inline OMID vendor script detection handles quote-adjacent attributes', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script async=""src="https://cdn.doubleverify.com/dvtp_src.js"></script>
    <script foo="x"type="text/javascript;charset=utf-8">
      window.omid3p.addEventListener('impression', function(){});
    </script>
  `);
  assert.deepEqual(scripts.map((script) => script.vendor), ['doubleverify', 'generic-omid3p']);
});

test('inline OMID vendor script detection handles greater-than characters inside attributes', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script foo="a>" src="https://cdn.doubleverify.com/dvtp_src.js"></script>
    <script foo='b>' type="text/javascript">
      window.omid3p.registerSessionObserver(function(){});
    </script>
  `);
  assert.deepEqual(scripts.map((script) => script.vendor), ['doubleverify', 'generic-omid3p']);
});

test('inline OMID vendor script detection follows first duplicate attribute semantics', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script src="https://cdn.doubleverify.com/dvtp_src.js" src="https://example.com/benign.js"></script>
    <script type="text/javascript" type="application/json">
      window.omid3p.registerSessionObserver(function(){});
    </script>
  `);
  assert.deepEqual(scripts.map((script) => script.vendor), ['doubleverify', 'generic-omid3p']);
});

test('inline OMID vendor script detection recovers after malformed script closer', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script src="https://example.com/oops>
    <script src="https://z.moatads.com/swallowed.js"></script>
    <script src="https://cdn.doubleverify.com/dvtp_src.js"></script>
  `);
  assert.deepEqual(scripts.map((script) => script.vendor), ['doubleverify']);
});

test('inline OMID vendor script detection uses decoded script src attributes', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <script src="https://cdn.doubleverify.com/dvtp_src.js?x=1&amp;y=2"></script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'doubleverify');
  assert.equal(scripts[0].value, 'https://cdn.doubleverify.com/dvtp_src.js?x=1&y=2');
});

test('inline OMID vendor script detection handles namespaced tags and trailing-dot hosts', () => {
  const scripts = extractInlineOmidVendorScripts(`
    <svg:script src="https://doubleverify.com./dvtp_src.js"></svg:script>
  `);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].vendor, 'doubleverify');
  assert.equal(scripts[0].url.hostname, 'doubleverify.com');
});

test('normalization bounds inline OMID vendor scans', () => {
  const longAdm = `${Array.from({ length: 300 }, (_, index) =>
    `<script src="https://cdn.doubleverify.com/${index}/dvtp_src.js"></script>`).join('')}${'x'.repeat(1_000_001)}`;
  const [bounded] = normalizeCleanedCorpus([{
    id: 'auction-row-omid-bounded',
    auction: [{
      bidder: 'synthetic-omid-bounded',
      mtype: 'banner',
      bid_request: {
        id: 'request-omid-bounded',
        imp: [{ id: 'imp-omid-bounded', banner: { w: 300, h: 250 } }],
      },
      bid_response: {
        id: 'response-omid-bounded',
        seatbid: [{
          bid: [{
            id: 'bid-omid-bounded',
            impid: 'imp-omid-bounded',
            crid: 'creative-omid-bounded',
            adm: longAdm,
          }],
        }],
      },
    }],
  }]);

  const omid = bounded.bidSignals.measurement.omid;
  assert.equal(omid.inlineVendorScriptCount, 256);
  assert.equal(omid.inlineVendorScanTruncated, true);
  assert.equal(omid.inlineVendorScriptTagLimitReached, true);
});

test('normalization does not let inline script tag stuffing hide later vendor src tags', () => {
  const stuffedAdm = `${'<script>noop()</script>'.repeat(256)}`
    + '<script src="https://cdn.doubleverify.com/dvtp_src.js"></script>';
  const [stuffed] = normalizeCleanedCorpus([{
    id: 'auction-row-omid-stuffed',
    auction: [{
      bidder: 'synthetic-omid-stuffed',
      mtype: 'banner',
      bid_request: {
        id: 'request-omid-stuffed',
        imp: [{ id: 'imp-omid-stuffed', banner: { w: 300, h: 250 } }],
      },
      bid_response: {
        id: 'response-omid-stuffed',
        seatbid: [{
          bid: [{
            id: 'bid-omid-stuffed',
            impid: 'imp-omid-stuffed',
            crid: 'creative-omid-stuffed',
            adm: stuffedAdm,
          }],
        }],
      },
    }],
  }]);

  const omid = stuffed.bidSignals.measurement.omid;
  assert.equal(omid.inlineVendorScriptCount, 1);
  assert.equal(omid.inlineVendorScriptTagLimitReached, undefined);
  assert.equal(omid.inlineVendorScripts[0].vendor, 'doubleverify');
});

test('normalization does not let non-vendor src stuffing hide later vendor src tags', () => {
  const stuffedAdm = `${Array.from({ length: 256 }, (_, index) =>
    `<script src="https://example.com/${index}.js"></script>`).join('')}`
    + '<script src="https://cdn.doubleverify.com/dvtp_src.js"></script>';
  const [stuffed] = normalizeCleanedCorpus([{
    id: 'auction-row-omid-src-stuffed',
    auction: [{
      bidder: 'synthetic-omid-src-stuffed',
      mtype: 'banner',
      bid_request: {
        id: 'request-omid-src-stuffed',
        imp: [{ id: 'imp-omid-src-stuffed', banner: { w: 300, h: 250 } }],
      },
      bid_response: {
        id: 'response-omid-src-stuffed',
        seatbid: [{
          bid: [{
            id: 'bid-omid-src-stuffed',
            impid: 'imp-omid-src-stuffed',
            crid: 'creative-omid-src-stuffed',
            adm: stuffedAdm,
          }],
        }],
      },
    }],
  }]);

  const omid = stuffed.bidSignals.measurement.omid;
  assert.equal(omid.inlineVendorScriptCount, 1);
  assert.equal(omid.inlineVendorScriptTagLimitReached, undefined);
  assert.equal(omid.inlineVendorScripts[0].vendor, 'doubleverify');
});

test('normalization preserves inline OMID vendor instrumentation without API declaration', () => {
  const [inlineOmid] = normalizeCleanedCorpus([{
    id: 'auction-row-omid-inline',
    auction: [{
      bidder: 'synthetic-omid-inline',
      mtype: 'banner',
      bid_request: {
        id: 'request-omid-inline',
        imp: [{ id: 'imp-omid-inline', banner: { w: 300, h: 250 } }],
      },
      bid_response: {
        id: 'response-omid-inline',
        seatbid: [{
          bid: [{
            id: 'bid-omid-inline',
            impid: 'imp-omid-inline',
            crid: 'creative-omid-inline',
            adm: '<script src="https://cdn.doubleverify.com/dvtp_src.js"></script>',
          }],
        }],
      },
    }],
  }]);

  assert.equal(inlineOmid.bidSignals.measurement.omid.declaredByApi, false);
  assert.equal(inlineOmid.bidSignals.measurement.omid.sidecarPresent, false);
  assert.equal(inlineOmid.bidSignals.measurement.omid.inlineVendorScriptPresent, true);
  assert.equal(inlineOmid.bidSignals.measurement.omid.inlineVendorScriptCount, 1);
  assert.equal(inlineOmid.bidSignals.measurement.omid.inlineVendorScanTruncated, undefined);
  assert.equal(inlineOmid.bidSignals.measurement.omid.inlineVendorScriptTagLimitReached, undefined);
  assert.deepEqual(inlineOmid.bidSignals.measurement.omid.inlineVendorVendors, ['doubleverify']);
  assert.equal(inlineOmid.bidSignals.measurement.omid.inlineVendorScripts[0].url.path, '/dvtp_src.js');
});

test('cleaned corpus normalization emits one stable case per bid', () => {
  assert.equal(cases.length, 5);

  const mraid = cases.find((item) => item.ids.bidId === 'bid-mraid-1');
  assert.ok(mraid);
  assert.equal(mraid.creative.admKind, 'html-mraid');
  assert.equal(mraid.expectations.execute, true);
  assert.deepEqual(mraid.bidSignals.apis.sanitized, [3, 5, 7]);
  assert.ok(mraid.bidSignals.apis.sources.some(
    (s) => s.path === 'imp.video.api' && s.role === 'context',
  ));
  assert.deepEqual(mraid.sharcOptions.creativeMeta.apis, [3, 5, 7]);
  assert.equal(mraid.bidSignals.measurement.omid.declaredByApi, true);
  assert.equal(mraid.bidSignals.measurement.omid.sidecarPresent, true);
  assert.equal(mraid.bidSignals.measurement.omid.inlineVendorScriptPresent, false);
  assert.equal(mraid.bidSignals.measurement.omid.inlineVendorScriptCount, 0);
  assert.equal(mraid.bidSignals.measurement.omid.inlineVendorVendors, undefined);
  assert.equal(mraid.bidSignals.measurement.omid.inlineVendorScripts, undefined);
  assert.equal(mraid.bidSignals.measurement.omid.verificationScriptCount, 1);
  assert.deepEqual(mraid.bidSignals.measurement.omid.sources, [{
    path: 'bid.ext.measurement.omid',
    verificationScriptCount: 1,
  }]);
  assert.deepEqual(mraid.sharcOptions.creativeMeta.measurement.omid.verificationScripts, [{
    resourceUrl: 'https://verify.example/omid.js',
    vendor: 'vendor.example',
    verificationParameters: 'fixture-params',
    accessMode: 'limited',
  }]);
  assert.equal(mraid.sharcOptions.creativeMeta.measurement.omid.creativeType, 'display');
  assert.equal(mraid.sharcOptions.creativeMeta.measurement.omid.mediaType, 'display');
  assert.equal(mraid.sharcOptions.creativeMeta.measurement.omid.impressionType, 'beginToRender');
  assert.equal(mraid.sharcOptions.creativeMeta.measurement.omid.contentUrl, 'https://advertiser.example/creative.html');
  assert.equal(mraid.sharcOptions.requireSharcInit, true);
  assert.deepEqual(mraid.expectations.declared, ['mraid', 'omid']);
  assert.deepEqual(mraid.expectations.sniffed, ['mraid']);
  assert.equal(mraid.creative.width, 320);
  assert.equal(mraid.creative.height, 50);

  const nativeCase = cases.find((item) => item.ids.bidId === 'bid-native-1');
  assert.equal(nativeCase.creative.admKind, 'native-json');
  assert.equal(nativeCase.expectations.execute, false);
  assert.equal(nativeCase.expectations.skipReason, 'unsupported-adm-kind:native-json');

  const vast = cases.find((item) => item.ids.bidId === 'bid-video-1');
  assert.equal(vast.creative.admKind, 'vast-xml');
  assert.deepEqual(vast.bidSignals.apis.sanitized, [7]);
  assert.ok(vast.expectations.declared.includes('omid'));
  assert.equal(vast.expectations.execute, false);

  const sharc = cases.find((item) => item.ids.bidId === 'bid-sharc-1');
  assert.equal(sharc.sharcOptions.requireSharcInit, true);
  assert.deepEqual(sharc.bidSignals.apis.sanitized, [3, 5, 10]);
  assert.equal(sharc.creative.width, 300);
  assert.equal(sharc.creative.height, 250);
  assert.deepEqual(sharc.bidSignals.battr, []);
  assert.deepEqual(mraid.bidSignals.attr, [1]);

  const safeframe = cases.find((item) => item.ids.bidId === 'bid-safeframe-1');
  assert.equal(safeframe.creative.admKind, 'html-safeframe');
  assert.deepEqual(safeframe.expectations.sniffed, ['safeframe']);
});

test('JSONL output emits one newline-terminated line per case', () => {
  const jsonl = toJsonl(cases);
  assert.equal(jsonl.endsWith('\n'), true);
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, cases.length);
  assert.equal(JSON.parse(lines[0]).ids.bidId, 'bid-mraid-1');
});

test('CLI normalizes to private output and protects public paths', () => {
  const privateRoot = resolve('tools/creative-validator/private');
  mkdirSync(privateRoot, { recursive: true });
  const outDir = mkdtempSync(resolve(privateRoot, 'test-normalizer-'));
  const outPath = resolve(outDir, 'cases.jsonl');

  try {
    execFileSync('node', [cliPath, 'normalize', fixturePath, '--out', outPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, cases.length);
  } finally {
    rmSync(outDir, { force: true, recursive: true });
  }

  const publicOut = resolve('tools/creative-validator/fixtures/leak.jsonl');
  assert.throws(
    () => execFileSync('node', [cliPath, 'normalize', fixturePath, '--out', publicOut], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    /Refusing to write private creative validator output outside/,
  );
  assert.equal(existsSync(publicOut), false);
});

test('CLI reports zero-match globs even when another input is valid', () => {
  assert.throws(
    () => execFileSync('node', [
      cliPath,
      'normalize',
      fixturePath,
      'tools/creative-validator/fixtures/reductions/001-normalizer-cleaned-corpus/nope-*.json',
      '--out',
      resolve(tmpdir(), 'sharc-validator-should-not-write.jsonl'),
      '--allow-public-out',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    /Input glob matched no files/,
  );
});
