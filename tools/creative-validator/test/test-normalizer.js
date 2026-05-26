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
  normalizeCleanedCorpus,
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
  assert.equal(mraid.sharcOptions.requireSharcInit, false);
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
