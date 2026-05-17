/**
 * @fileoverview SHARC Creative Injector — operator-side reference extension
 *
 * A first-class `SHARCContainer` extension that injects a `<script src="...">`
 * tag for `sharc-creative.js` (the SHARC creative-side SDK) into legacy
 * Markup-variant creative HTML before the container hands it to the
 * renderer. This is the canonical "lift legacy inventory into SHARC"
 * pattern — operators add the extension to `extensions: [...]` and any
 * inventory shape (plain HTML, MRAID v1/v2/v3, SafeFrame 1.x) becomes
 * compatible with the SHARC container without per-creative changes.
 *
 * Architectural role:
 *
 *   The container already exposes an `extensions: []` constructor option
 *   that invokes `extension.injectIntoMarkup(html)` against the creative
 *   markup before iframe load (see `SHARCContainer._runMarkupInjection`).
 *   This module is a turn-key extension that operators wire up once and
 *   forget. Without it, operators were rolling their own injection — same
 *   regex, same edge cases, no shared test coverage. This file consolidates
 *   the pattern and locks in the doctype-edge refinement that prevents
 *   accidental quirks-mode rendering.
 *
 * Trust model:
 *
 *   Operator-side, operator-trusted. The extension runs on the publisher
 *   page in the container context — same trust boundary as the rest of
 *   `SHARCContainer`. It does NOT inspect or transform creative content
 *   beyond the single string-replace that adds the script tag.
 *
 * Variant scope:
 *
 *   Markup variant only — i.e. `new SHARCContainer({ creativeHtml: ... })`.
 *   The URL variant (`creativeUrl: ...`) cannot be injected when the URL
 *   is cross-origin (browser CORS). Operators whose Markup pipeline emits
 *   plain-HTML/MRAID/SafeFrame adm strings install this extension; URL-only
 *   pipelines fall back to `requireSharcInit: false` (see design § 11).
 *
 * Injection-order contract (doctype-edge refinement, 2026-05-17):
 *
 *   The injector inserts the script tag at the FIRST of these positions
 *   that exists in the markup:
 *     1. After the `<head>` opening tag (most specific — keeps the script
 *        in `<head>` scope, where parser-blocking script semantics work).
 *     2. After the `<html>` opening tag (creative had no `<head>` element).
 *     3. After the `<!DOCTYPE>` declaration (fragment with doctype only —
 *        injecting BEFORE the doctype would push the browser into
 *        quirks-mode rendering, which subtly breaks legacy creatives that
 *        rely on standards-mode layout). The refinement is the explicit
 *        AFTER-doctype branch; prior drafts prepended and were quirks-mode-
 *        triggering on edge cases.
 *     4. Prepend (true fragment — no doctype, no `<html>`, no `<head>`).
 *
 *   Each regex is case-insensitive and tolerates attributes on the open
 *   tag (e.g. `<head lang="en">`, `<HTML class="...">`).
 *
 * Idempotency contract:
 *
 *   `skipIfPresent: true` (default) — the injector returns the markup
 *   unchanged if it already contains the substring `sharc-creative.js`
 *   (any URL with that filename). This protects against:
 *     - Operator pipelines that already inject the SDK at an upstream step.
 *     - Native SHARC creatives that ship the SDK inline.
 *     - Back-to-back extension runs (e.g. two pipeline stages each adding
 *       an injector).
 *   Operators that want to force-inject (different SDK build, multi-version
 *   coexistence test, etc.) opt out via `skipIfPresent: false`.
 *
 * Script-attribute contract:
 *
 *   `scriptAttrs: {}` (default) — emits a bare `<script src="..."></script>`,
 *   which is parser-blocking and synchronous. This is the ONLY attribute
 *   set that prevents the inline-`mraid.*` race condition for MRAID
 *   creatives: `defer` allows inline scripts to run before the SDK loads
 *   (and `mraid` would be undefined when the creative's `mraid.expand()`
 *   inline fires); `async` is worse. Operators with fully event-driven
 *   pipelines (no inline `mraid.*` / `$sf.ext.*` calls) can override with
 *   `{ defer: true }` / `{ async: true }` / `{ integrity: 'sha384-...' }`
 *   / etc.
 *
 *   Attribute serialization rules:
 *     - `true` → bare attribute name (e.g. `{ async: true }` → ` async`)
 *     - `false` / `null` / `undefined` → omitted entirely
 *     - string → `="..."` with quote-escaping (defense against
 *       attribute-injection if operator passes user-controlled data)
 *     - other types → coerced to string then escaped
 *
 * Spec source: GitHub issue #97 (locked 2026-05-16, doctype refinement
 * 2026-05-17). Design § 10.2 (Extensions) and § 6.3 (operator-injection
 * pattern) provide the surrounding context.
 *
 * @version 0.7.2
 */

'use strict';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * HTML-escapes a string value for safe insertion inside a double-quoted
 * attribute value. Targets the minimum set that breaks out of an attribute:
 *   `&` → `&amp;` (must come FIRST so we don't double-escape the others)
 *   `"` → `&quot;`
 *   `<` → `&lt;`  (defense-in-depth — `<` inside an attribute is legal
 *                  but escaping it removes any chance an HTML scanner
 *                  upstream mistakes the boundary)
 *
 * Operators passing static URLs and known-safe attribute values don't
 * need this — but the contract has to assume some operator pipelines
 * thread user-derived data (RTB macro substitution, A/B test
 * configuration, etc.) through `scriptAttrs`. Defense-in-depth.
 *
 * @param {string} value - Raw attribute value (already coerced to string).
 * @returns {string} The HTML-attribute-safe escaped value.
 * @private
 */
function _escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/**
 * Serializes a `scriptAttrs` object into a string suitable for splicing
 * into a `<script>` open tag. Each entry produces a leading space; the
 * caller does not need to add separators. Empty object returns `''`.
 *
 * @param {Object} attrs - Operator-supplied attribute map.
 * @returns {string} Serialized attribute string (with leading spaces) or `''`.
 * @private
 */
function _serializeAttrs(attrs) {
  if (!attrs || typeof attrs !== 'object') return '';
  const parts = [];
  const keys = Object.keys(attrs);
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i];
    const value = attrs[name];
    // Omit falsy non-boolean-true entirely. `false` / `null` / `undefined`
    // all mean "do not emit this attribute" — matches the React-style
    // convention operators are accustomed to.
    if (value === false || value === null || value === undefined) continue;
    if (value === true) {
      // Bare attribute (e.g. `async`, `defer`, `nomodule`).
      parts.push(' ' + name);
    } else {
      // String or coercible-to-string. HTML-escape the value to prevent
      // attribute-injection if the operator threaded user-controlled
      // data through.
      parts.push(' ' + name + '="' + _escapeAttr(value) + '"');
    }
  }
  return parts.join('');
}

/**
 * Builds the final `<script src="...">` tag from the resolved URL and
 * the serialized attribute string. Splits out so the injection logic in
 * `injectIntoMarkup` reads cleanly.
 *
 * @param {string} url - The creative-SDK URL (validated by constructor).
 * @param {Object} attrs - The `scriptAttrs` option.
 * @returns {string} The complete `<script ...></script>` tag.
 * @private
 */
function _buildScriptTag(url, attrs) {
  return '<script src="' + _escapeAttr(url) + '"' + _serializeAttrs(attrs) + '></script>';
}

// ---------------------------------------------------------------------------
// SHARCCreativeInjector — the extension class
// ---------------------------------------------------------------------------

/**
 * Container extension that injects `sharc-creative.js` into Markup-variant
 * creative HTML at iframe-load time.
 *
 * Wires up via the standard `SHARCContainer({ extensions: [...] })` option.
 * The container invokes `injectIntoMarkup(html)` before posting the markup
 * to the renderer; this class implements that hook with the doctype-aware
 * injection logic documented at the top of this file.
 *
 * Usage:
 * ```javascript
 * import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';
 * import { SHARCCreativeInjector } from '@iabtechlab/sharc/sharc-creative-injector';
 *
 * const container = new SHARCContainer({
 *   creativeHtml: bid.adm,
 *   creativeRendererUrl: rendererUrl,
 *   bridges: ['mraid'],
 *   extensions: [
 *     new SHARCCreativeInjector({
 *       creativeSdkUrl: 'https://operator-cdn.example/sharc-creative.js',
 *     }),
 *   ],
 *   placementElement: slot,
 * });
 * container.load();
 * ```
 *
 * @param {Object}  options
 * @param {string}  options.creativeSdkUrl    - REQUIRED. The URL of the
 *                                              `sharc-creative.js` build
 *                                              the operator hosts.
 * @param {boolean} [options.skipIfPresent=true] - If true, markup already
 *                                              containing a `<script src="…
 *                                              sharc-creative.js">` tag
 *                                              passes through unchanged.
 *                                              **Multi-injector caveat:**
 *                                              if multiple `SHARCCreativeInjector`
 *                                              instances are configured (e.g.
 *                                              versioned SDK coexistence),
 *                                              only the first runs — the
 *                                              second's `skipIfPresent` sees
 *                                              the SDK already injected and
 *                                              skips. Set `skipIfPresent: false`
 *                                              on at least one if you need
 *                                              multi-version side-by-side
 *                                              loading.
 * @param {Object}  [options.scriptAttrs={}]  - Additional `<script>`
 *                                              attributes. See module
 *                                              JSDoc for serialization rules.
 *
 * @throws {TypeError} If `creativeSdkUrl` is missing, empty, or not a string.
 */
class SHARCCreativeInjector {
  /**
   * @param {{ creativeSdkUrl: string, skipIfPresent?: boolean, scriptAttrs?: Object }} options
   */
  constructor(options) {
    /** @type {{ creativeSdkUrl: string, skipIfPresent?: boolean, scriptAttrs?: Object }} */
    const opts = options || /** @type {any} */ ({});
    // Required-option validation — fail loud at construction time. Operators
    // who omit this catch the error in their bootstrap, not at the first
    // ad load. The TypeError name is conventional for "wrong-type-or-missing
    // argument" per the Node.js error conventions the rest of SHARC uses.
    if (typeof opts.creativeSdkUrl !== 'string' || opts.creativeSdkUrl.length === 0) {
      throw new TypeError(
        '[SHARCCreativeInjector] creativeSdkUrl is required and must be a '
          + 'non-empty string (got '
          + (opts.creativeSdkUrl === undefined ? 'undefined' : typeof opts.creativeSdkUrl)
          + ').'
      );
    }

    /** @type {string} */
    this.creativeSdkUrl = opts.creativeSdkUrl;

    /** @type {boolean} */
    this.skipIfPresent = opts.skipIfPresent !== false; // default true

    /** @type {Object} */
    this.scriptAttrs = (opts.scriptAttrs && typeof opts.scriptAttrs === 'object')
      ? opts.scriptAttrs
      : {};
  }

  /**
   * Returns the feature name advertised to the creative via Container:init's
   * `supportedFeatures` array. Lets SHARC-aware creatives detect that the
   * operator is auto-injecting the SDK and adjust behavior (e.g. skip their
   * own SDK-load shim).
   *
   * @returns {string}
   */
  getFeatureName() {
    return 'com.iabtechlab.sharc.creative-injector';
  }

  /**
   * Hook called by `SHARCContainer._runMarkupInjection()` (and the URL-variant
   * `_fetchAndInjectCreative()` path) before the markup is posted to the
   * renderer. Returns the markup with the `sharc-creative.js` `<script>` tag
   * inserted at the most-specific position available — see the module JSDoc
   * for the full position table and the doctype-edge rationale.
   *
   * Idempotent when `skipIfPresent: true` (default): markup that already
   * contains `sharc-creative.js` is returned unchanged.
   *
   * @param {string} html - Raw creative markup.
   * @returns {string} Markup with the SDK script tag injected (or unchanged
   *   per `skipIfPresent`).
   */
  injectIntoMarkup(html) {
    // Defensive — extension hooks see whatever the operator put in
    // `creativeHtml`. The container itself doesn't coerce; the contract
    // is "string in, string out."
    if (typeof html !== 'string') return html;

    // Idempotency guard. Requires the SDK to appear inside a
    // `<script src="...sharc-creative.js">` tag specifically — bare
    // substring presence (in comments, metadata, log-output strings,
    // etc.) doesn't trigger the skip. The previous looser substring
    // check produced silent no-ops when creatives mentioned
    // `sharc-creative.js` in a `<!-- ... -->` comment or `<meta>`
    // content without actually loading the SDK; the bridge auto-install
    // (G9) would then time out and the container would behave as if the
    // creative was non-SHARC. Tightening to script-src context closes
    // this footgun. Tolerant of path prefixes (CDN, versioned subdirs,
    // protocol-relative URLs) because the match only requires the
    // filename to appear inside the `src` attribute's value.
    if (this.skipIfPresent && /<script[^>]*\bsrc\s*=\s*["'][^"']*sharc-creative\.js/i.test(html)) {
      return html;
    }

    const scriptTag = _buildScriptTag(this.creativeSdkUrl, this.scriptAttrs);

    // Position 1: after `<head>` open tag. Case-insensitive; tolerates
    // attributes on the tag (`<head lang="en">`, `<HEAD class="...">`).
    // Lookahead `(?=[\s>])` rejects `<header>`, `<headers>`, etc. — the
    // bare `<head[^>]*>` pattern would otherwise greedily consume
    // `<header class="top">` as a valid match (the `[^>]*` happily
    // gobbles `er class="top"`). Confirmed regression: Bootstrap /
    // Tailwind landing-page creatives use `<header>` and would have
    // received the SDK script injected inside the header element
    // instead of the document head.
    const headMatch = html.match(/<head(?=[\s>])[^>]*>/i);
    if (headMatch) {
      return html.replace(headMatch[0], headMatch[0] + scriptTag);
    }

    // Position 2: after `<html>` open tag (no `<head>` in markup).
    // Same lookahead defense — rejects `<htmlfoo>` and similar non-`<html>`
    // tags that happen to start with the four letters.
    const htmlMatch = html.match(/<html(?=[\s>])[^>]*>/i);
    if (htmlMatch) {
      return html.replace(htmlMatch[0], htmlMatch[0] + scriptTag);
    }

    // Position 3: after `<!DOCTYPE>` (fragment with doctype but no `<html>`
    // wrapper). Inserting BEFORE the doctype would push the browser into
    // quirks-mode rendering for the entire document — the explicit
    // refinement (2026-05-17) is that the doctype branch must inject
    // AFTER the declaration, not before.
    const doctypeMatch = html.match(/<!DOCTYPE[^>]*>/i);
    if (doctypeMatch) {
      return html.replace(doctypeMatch[0], doctypeMatch[0] + scriptTag);
    }

    // Position 4: true fragment (no doctype, no `<html>`, no `<head>`).
    // Prepend — the script tag is the first thing the renderer's
    // `document.write` will see.
    return scriptTag + html;
  }

  /**
   * Optional cleanup hook. The current implementation holds no resources
   * (no DOM listeners, no timers, no fetched URLs) so this is a no-op.
   * Present so future extensions of this class — or operator-extended
   * subclasses — have a stable lifecycle surface to hook into.
   */
  destroy() {
    // Intentionally empty — no resources to release.
  }
}

// ---------------------------------------------------------------------------
// ESM exports
// ---------------------------------------------------------------------------

export { SHARCCreativeInjector };

// Legacy IIFE — register the class on the SHARC namespace so non-module
// consumers (a `<script src="dist/sharc-creative-injector.js">` tag) can
// reach it via `window.SHARC.SHARCCreativeInjector`. First-assignment-wins
// to match the OmidCompatBridge / navigation-bridge precedent: operators
// who pre-set the class (e.g. with telemetry wrapping) keep their override.
if (typeof window !== 'undefined') {
  /** @type {any} */
  const _win = window;
  _win.SHARC = _win.SHARC || {};
  if (typeof _win.SHARC.SHARCCreativeInjector !== 'function') {
    _win.SHARC.SHARCCreativeInjector = SHARCCreativeInjector;
  }
}
