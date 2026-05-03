import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const isProduction = process.env.NODE_ENV === 'production';

// Build outputs for SHARC modules:
//   - .js  = IIFE browser-global bundles (for <script src="...">)
//   - .mjs = ESM modules (for bundlers / <script type="module">)

const inputFiles = {
  'sharc-protocol': 'src/sharc-protocol.js',
  'sharc-container': 'src/sharc-container.js',
  'sharc-creative': 'src/sharc-creative.js',
  'sharc-mraid-bridge': 'src/sharc-mraid-bridge.js',
  'sharc-safeframe-bridge': 'src/sharc-safeframe-bridge.js',
  'sharc-omid-bridge': 'src/sharc-omid-bridge.js',
  'sharc-navigation-bridge': 'src/sharc-navigation-bridge.js',
};

export default Object.keys(inputFiles).map(moduleName => {
  return {
    input: inputFiles[moduleName],
    output: [
      // IIFE — sets window.SHARC.* when loaded via <script src="...">
      // extend: true merges multiple bundles into the same window.SHARC global
      {
        dir: 'dist',
        format: 'iife',
        entryFileNames: `${moduleName}.js`,
        chunkFileNames: '[name].[hash].js',
        name: 'SHARC',
        extend: true,
        sourcemap: !isProduction,
      },
      // ESM — for bundlers and <script type="module">
      {
        dir: 'dist',
        format: 'es',
        entryFileNames: `${moduleName}.mjs`,
        chunkFileNames: '[name].[hash].mjs',
        sourcemap: !isProduction,
      },
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
