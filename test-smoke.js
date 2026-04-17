import fs from 'node:fs';
import assert from 'node:assert/strict';

console.log('Running smoke tests for SHARC built artifacts...\n');

let failed = false;

function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed = true;
    console.error(`❌ ${name}: ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed = true;
    console.error(`❌ ${name}: ${error.message}`);
  }
}

const esmModules = [
  {
    name: 'sharc-container',
    path: './dist/sharc-container.js',
    expectedExports: ['SHARCContainer', 'SHARC_VERSION']
  },
  {
    name: 'sharc-creative',
    path: './dist/sharc-creative.js',
    expectedExports: ['SHARCCreativeSDK', 'sdk']
  },
  {
    name: 'sharc-protocol',
    path: './dist/sharc-protocol.js',
    expectedExports: ['SHARCProtocol', 'ProtocolMessages']
  },
  {
    name: 'sharc-mraid-bridge',
    path: './dist/sharc-mraid-bridge.js',
    expectedExports: ['MRAIDCompatBridge', 'installMRAIDBridge']
  },
  {
    name: 'sharc-safeframe-bridge',
    path: './dist/sharc-safeframe-bridge.js',
    expectedExports: ['SafeFrameCompatBridge', 'installSafeFrameBridge']
  },
  {
    name: 'sharc-omid-bridge',
    path: './dist/sharc-omid-bridge.js',
    expectedExports: ['OmidCompatBridge', 'installOmidBridge']
  }
];

const iifeArtifacts = [
  './dist/sharc-container.iife.js',
  './dist/sharc-creative.iife.js',
  './dist/sharc-protocol.iife.js'
];

for (const artifact of [...esmModules.map(m => m.path), ...iifeArtifacts]) {
  check(`artifact exists: ${artifact}`, () => {
    assert.ok(fs.existsSync(new URL(artifact, import.meta.url)), `${artifact} does not exist`);
  });
}

for (const mod of esmModules) {
  await checkAsync(`import ${mod.name}`, async () => {
    const imported = await import(mod.path);
    for (const key of mod.expectedExports) {
      assert.ok(key in imported, `missing export ${key}`);
    }
  });
}

console.log('\nSmoke test tradeoff: this verifies current ESM importability and core IIFE artifact presence. It does not attempt full browser execution of bridge globals.');

if (failed) {
  process.exit(1);
}

console.log('\n✅ All smoke tests passed.');
