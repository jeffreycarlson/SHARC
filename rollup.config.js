import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const isProduction = process.env.NODE_ENV === 'production';

// Build outputs for SHARC modules
// - Bridges (mraid, safeframe, omid): ESM-only
// - Container + creative + protocol: ESM + IIFE

const inputFiles = {
  'sharc-protocol': 'examples/sharc-protocol.js',
  'sharc-container': 'examples/sharc-container.js',
  'sharc-creative': 'examples/sharc-creative.js',
  'sharc-mraid-bridge': 'examples/sharc-mraid-bridge.js',
  'sharc-safeframe-bridge': 'examples/sharc-safeframe-bridge.js',
  'sharc-omid-bridge': 'examples/sharc-omid-bridge.js',
};

// Bridge modules should be ESM-only (they need MessageChannel features)
const bridgeModules = ['sharc-mraid-bridge', 'sharc-safeframe-bridge', 'sharc-omid-bridge'];
const esmOnlyModules = bridgeModules; // Bridges are ESM-only; no IIFE fallback

export default Object.keys(inputFiles).map(moduleName => ({
  input: inputFiles[moduleName],
  output: [
    // ESM output
    {
      dir: 'dist',
      format: 'es',
      entryFileNames: `${moduleName}.js`,
      chunkFileNames: '[name].[hash].js',
      sourcemap: !isProduction,
    },
    // IIFE output for container/creative and bridges (unless ESM-only)
    ...(esmOnlyModules.includes(moduleName) ? [] : [
      {
        dir: 'dist',
        format: 'iife',
        entryFileNames: `${moduleName}.iife.js`,
        chunkFileNames: '[name].[hash].iife.js',
        name: 'SHARC',
        sourcemap: !isProduction,
      },
    ]),
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
}));
