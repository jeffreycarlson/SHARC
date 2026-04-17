import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const isProduction = process.env.NODE_ENV === 'production';

// Build outputs for SHARC modules
// - Bridges (mraid, safeframe, omid): ESM-only (advanced use cases)
// - Core modules (protocol, container, creative): ESM + browser-global IIFE
//
// For backward compatibility with classic <script> tag loading:
//   - .js files are browser-global IIFE bundles (set window.SHARC.*)
//   - .mjs files are ESM modules (for import/export usage)
//
// This allows existing HTML consumers to keep using <script src="sharc-protocol.js">
// while modern bundlers can import from sharc-protocol.mjs

const inputFiles = {
  'sharc-protocol': 'examples/sharc-protocol.js',
  'sharc-container': 'examples/sharc-container.js',
  'sharc-creative': 'examples/sharc-creative.js',
  'sharc-mraid-bridge': 'examples/sharc-mraid-bridge.js',
  'sharc-safeframe-bridge': 'examples/sharc-safeframe-bridge.js',
  'sharc-omid-bridge': 'examples/sharc-omid-bridge.js',
};

// Bridge modules: ESM-only (loaded via dynamic import or bundlers)
const esmOnlyModules = ['sharc-mraid-bridge', 'sharc-safeframe-bridge', 'sharc-omid-bridge'];
  
// Core modules that need backward-compatible browser-global bundles
const coreModules = Object.keys(inputFiles).filter(m => !esmOnlyModules.includes(m));

export default Object.keys(inputFiles).map(moduleName => {
  const isCore = coreModules.includes(moduleName);
  
  return {
    input: inputFiles[moduleName],
    output: [
      // Browser-global IIFE output (primary for backward compatibility)
      // This sets window.SHARC.* when loaded with <script src="...">
      // extend: true allows multiple bundles to merge into window.SHARC
      // so protocol+container+creative can all contribute to the same global
      ...(isCore ? [{
        dir: 'dist',
        format: 'iife',
        entryFileNames: `${moduleName}.js`,
        chunkFileNames: '[name].[hash].js',
        name: 'SHARC',
        extend: true,
        sourcemap: !isProduction,
      }] : []),
      
      // ESM output (for bundlers/modern loaders)
      {
        dir: 'dist',
        format: 'es',
        entryFileNames: `${moduleName}.mjs`,
        chunkFileNames: '[name].[hash].mjs',
        sourcemap: !isProduction,
      },
      
      // Also output .iife.js for explicit IIFE usage (backward compatible)
      // Same as .js but with explicit .iife.js extension for clarity
      ...(isCore ? [{
        dir: 'dist',
        format: 'iife',
        entryFileNames: `${moduleName}.iife.js`,
        chunkFileNames: '[name].[hash].iife.js',
        name: 'SHARC',
        extend: true,
        sourcemap: !isProduction,
      }] : []),
    ],
    plugins: [
      nodeResolve({
        browser: true,
        preferBuiltins: false,
        extensions: ['.js'],
      }),
      commonjs(),
      ...(isProduction ? [
        terser({
          compress: {
            drop_console: true,
            drop_debugger: true,
          },
          format: {
            comments: false,
          },
        }),
      ] : []),
    ],
    external: ['fs', 'path', 'http', 'https', 'url'],
    preserveEntrySignatures: 'allow-extension',
  };
});
