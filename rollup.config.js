import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const isProduction = process.env.NODE_ENV === 'production';
const buildMode = isProduction ? 'prod' : 'dev';

// Build outputs for SHARC modules:
//   - .js  = IIFE browser-global bundles (for <script src="...">)
//   - .mjs = ESM modules (for bundlers / <script type="module">)

const inputFiles = {
  'sharc-protocol': 'src/sharc-protocol.js',
  'sharc-protocol-router': 'src/sharc-protocol-router.js',
  'sharc-container': 'src/sharc-container.js',
  'sharc-creative': 'src/sharc-creative.js',
  'sharc-mraid-bridge': 'src/sharc-mraid-bridge.js',
  'sharc-safeframe-bridge': 'src/sharc-safeframe-bridge.js',
  'sharc-omid-bridge': 'src/sharc-omid-bridge.js',
  'sharc-omid-shim': 'src/sharc-omid-shim.js',
  'sharc-navigation-bridge': 'src/sharc-navigation-bridge.js',
};

function replaceBuildMode() {
  const replacement = JSON.stringify(buildMode);
  return {
    name: 'sharc-build-mode-replace',
    renderChunk(code) {
      return {
        code: code
          .replaceAll('"__SHARC_BUILD_MODE__"', replacement)
          .replaceAll("'__SHARC_BUILD_MODE__'", replacement),
        map: null,
      };
    },
  };
}

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
      replaceBuildMode(),
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
