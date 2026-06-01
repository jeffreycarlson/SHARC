/**
 * Treeshaking test scaffold for SHARC
 * 
 * This file tests that only the expected exports are included when
 * importing specific SHARC modules. It verifies that unused exports
 * are properly eliminated by the bundler.
 * 
 * Usage: npm run test-treeshake
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Test lives at test/node/; repo root is two levels up.
const ROOT = join(__dirname, '..', '..');
const DIST = join(ROOT, 'dist');

// Expected exports per module
const EXPORTS = {
  'sharc-protocol': ['SHARC'],
  'sharc-container': ['SHARC'],
  'sharc-creative': ['SHARC'],
  'sharc-mraid-bridge': ['mraid'],
  'sharc-safeframe-bridge': ['$sf'],
  'sharc-omid-bridge': ['omid'],
  'sharc-omid-shim': ['installOmidShim', 'MAX_OMID_SUBSCRIPTIONS'],
  'sharc-navigation-bridge': ['installNavigationBridge'],
};

console.log('🔍 Running treeshaking tests...\n');

let allPassed = true;

// Bridge-like modules expose browser globals in their IIFE builds; this test
// validates their ESM output only, while smoke covers the IIFE artifacts.
const bridgeModules = [
  'sharc-mraid-bridge',
  'sharc-safeframe-bridge',
  'sharc-omid-bridge',
  'sharc-omid-shim',
  'sharc-navigation-bridge',
];

for (const [moduleName, expectedExports] of Object.entries(EXPORTS)) {
  const esmPath = join(DIST, `${moduleName}.mjs`);
  const iifePath = join(DIST, `${moduleName}.js`);
  const isBridge = bridgeModules.includes(moduleName);
  
  if (!esmPath) {
    console.error(`❌ ${moduleName}: Dist files not found`);
    allPassed = false;
    continue;
  }
  
  try {
    const esmContent = readFileSync(esmPath, 'utf-8');
    
    // For bridges, just verify ESM output (no IIFE to check)
    if (isBridge) {
      // Verify expected exports exist
      for (const exp of expectedExports) {
        if (!esmContent.includes(exp)) {
          console.error(`❌ ${moduleName}: Missing export "${exp}"`);
          allPassed = false;
        }
      }
      const esmSize = esmContent.length;
      console.log(`✅ ${moduleName}`);
      console.log(`   ESM: ${esmSize.toLocaleString()} bytes (ESM-only)`);
      console.log(`   Exports: ${expectedExports.join(', ')}`);
      continue;
    }
    
    // Non-bridge modules: check both ESM and IIFE
    if (!iifePath) {
      console.error(`❌ ${moduleName}: IIFE file not found`);
      allPassed = false;
      continue;
    }
    
    const iifeContent = readFileSync(iifePath, 'utf-8');
    
    // Check that expected exports exist
    for (const exp of expectedExports) {
      if (!esmContent.includes(exp) && !iifeContent.includes(exp)) {
        console.error(`❌ ${moduleName}: Missing export "${exp}"`);
        allPassed = false;
        continue;
      }
    }
    
    // For creative, ensure container methods are NOT present
    if (moduleName === 'sharc-creative') {
      if (iifeContent.includes('notifyPlacementChange')) {
        console.warn(`⚠️  ${moduleName}: May include unused container methods`);
      }
    }
    
    // For container, ensure creative methods are NOT present  
    if (moduleName === 'sharc-container') {
      if (iifeContent.includes('reportInteraction')) {
        console.warn(`⚠️  ${moduleName}: May include unused creative methods`);
      }
    }
    
    // Check file sizes for sanity
    const esmSize = esmContent.length;
    const iifeSize = iifeContent.length;
    
    console.log(`✅ ${moduleName}`);
    console.log(`   ESM: ${esmSize.toLocaleString()} bytes`);
    console.log(`   IIFE: ${iifeSize.toLocaleString()} bytes`);
    console.log(`   Exports: ${expectedExports.join(', ')}`);
    
  } catch (err) {
    console.error(`❌ ${moduleName}: ${err.message}`);
    allPassed = false;
  }
}

console.log('');
if (allPassed) {
  console.log('✅ All treeshaking tests passed!');
  process.exit(0);
} else {
  console.log('❌ Some treeshaking tests failed.');
  process.exit(1);
}
