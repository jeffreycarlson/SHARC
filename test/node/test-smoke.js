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
    path: '../../dist/sharc-container.mjs',
    expectedExports: ['SHARCContainer', 'SHARC_VERSION']
  },
  {
    name: 'sharc-creative',
    path: '../../dist/sharc-creative.mjs',
    // Phase E deliverable 2: the navigation bridge is now bundled into
    // the SDK so the Creative URL flow auto-installs it at SDK init.
    // `SHARCNavigationError` stays a named SDK export (for `instanceof`
    // parity). This locks in the +1.1 kB bundling decision against a
    // future change that accidentally tree-shakes the bridge out of the
    // SDK build (which would silently regress URL-flow click-through
    // audit coverage).
    //
    // `installNavigationBridge` is intentionally NOT a named export of the
    // creative bundle (#365): in the IIFE build a top-level named export
    // becomes an unconditional `window.SHARC.installNavigationBridge = …`
    // epilogue assignment that clobbers an operator's first-assignment-wins
    // override. The bridge RUNTIME stays bundled regardless — it's pulled in
    // by the SDK's guarded in-source install path — so the anti-tree-shake
    // intent above holds without the named re-export. ESM consumers import
    // `installNavigationBridge` from the standalone `sharc-navigation-bridge`
    // module (asserted below), the canonical source.
    expectedExports: ['SHARCCreative', 'creative', 'SHARCNavigationError']
  },
  {
    name: 'sharc-protocol',
    path: '../../dist/sharc-protocol.mjs',
    expectedExports: ['SHARCProtocol', 'ProtocolMessages']
  },
  {
    name: 'sharc-mraid-bridge',
    path: '../../dist/sharc-mraid-bridge.mjs',
    expectedExports: ['MRAIDCompatBridge', 'installMRAIDBridge']
  },
  {
    name: 'sharc-safeframe-bridge',
    path: '../../dist/sharc-safeframe-bridge.mjs',
    expectedExports: ['SafeFrameCompatBridge', 'installSafeFrameBridge']
  },
  {
    name: 'sharc-omid-bridge',
    path: '../../dist/sharc-omid-bridge.mjs',
    expectedExports: ['OmidCompatBridge']
  },
  {
    name: 'sharc-omid-shim',
    path: '../../dist/sharc-omid-shim.mjs',
    expectedExports: ['installOmidShim', 'MAX_OMID_SUBSCRIPTIONS']
  },
  {
    name: 'sharc-navigation-bridge',
    path: '../../dist/sharc-navigation-bridge.mjs',
    expectedExports: ['installNavigationBridge']
  }
];

const iifeArtifacts = [
  '../../dist/sharc-container.js',
  '../../dist/sharc-creative.js',
  '../../dist/sharc-protocol.js',
  '../../dist/sharc-mraid-bridge.js',
  '../../dist/sharc-safeframe-bridge.js',
  '../../dist/sharc-omid-bridge.js',
  '../../dist/sharc-omid-shim.js',
  '../../dist/sharc-navigation-bridge.js',
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
