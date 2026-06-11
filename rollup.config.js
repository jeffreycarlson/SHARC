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

// IIFE global assignment is first-assignment-wins for the whole window.SHARC
// namespace.
//
// In the IIFE build the trailer is `})(this.SHARC = this.SHARC || {})`, so the
// `exports` argument IS `window.SHARC`. Rollup's auto-generated export epilogue
// emits one UNCONDITIONAL `exports.X = X;` per named export — i.e.
// `window.SHARC.X = X` — which runs AFTER the module body and overwrites any
// `window.SHARC.X` an operator pre-set before the bundle loaded. That clobber
// bypasses the source-level first-assignment-wins guards (e.g.
// `installNavigationBridge` in sharc-creative.js) and silently replaces an
// operator's override on every <script src> evaluation. It affects every named
// export that collides with a pre-set window.SHARC property — `SHARCNavigationError`,
// `SHARCCreative`, etc. — on single-SDK loads too.
//
// This plugin rewrites that epilogue from unconditional assignment
//   exports.X = X;
// into first-assignment-wins form
//   if (!('X' in exports)) exports.X = X;
// so the bundle installs its default only when the property is absent. On a
// fresh load (no operator pre-set) behavior is byte-for-byte equivalent in
// effect — the property is absent, so it is assigned exactly as today. When an
// operator HAS pre-set window.SHARC.X, their value survives.
//
// IIFE-only: gated on `options.format === 'iife'`, so the ESM (`format: 'es'`)
// `export { ... }` surface that bundler/`type=module` consumers import is left
// completely untouched. Must run BEFORE terser so it matches the un-minified
// `exports.X = X;` trailer; terser then minifies the guarded form, preserving
// the `in` check.
function firstAssignmentWinsGlobalExports() {
  return {
    name: 'sharc-iife-first-assignment-wins',
    renderChunk(code, chunk, options) {
      if (options.format !== 'iife') return null;
      const guarded = code.replace(
        /^(\s*)exports\.([A-Za-z_$][\w$]*) = (\2);$/gm,
        (match, indent, name) =>
          `${indent}if (!(${JSON.stringify(name)} in exports)) exports.${name} = ${name};`,
      );
      if (guarded === code) return null;
      return { code: guarded, map: null };
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
      firstAssignmentWinsGlobalExports(),
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
