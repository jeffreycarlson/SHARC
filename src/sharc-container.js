/**
 * @fileoverview SHARC Container Library
 *
 * Production-ready container-side implementation for the SHARC protocol.
 *
 * Responsibilities:
 *   - Creating and managing the secure iframe rendering context
 *   - Running the container side of the SHARC protocol lifecycle
 *   - Enforcing the Page-Lifecycle-aligned state machine
 *   - Owning close, navigation, placement change, and tracker operations
 *   - Managing the MessageChannel handshake
 *
 * Dependencies:
 *   - sharc-protocol.js (must be loaded first, or required via CommonJS)
 *
 * Usage:
 * ```javascript
 * const container = new SHARCContainer({
 *   creativeUrl: 'https://ads.example.com/creative.html',
 *   placementElement: document.getElementById('ad-slot'),
 *   environmentData: { ... },
 *   extensions: [new OmidCompatBridge({ partnerName: 'MyPublisher', partnerVersion: '1.0' })],
 *   onStateChange: (state) => console.log('State:', state),
 *   onClose: () => document.getElementById('ad-slot').remove(),
 * });
 * container.load();
 * ```
 *
 * @version 0.7.13
 */

'use strict';

// ---------------------------------------------------------------------------
// Import (or reference) protocol constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------
// sharc-protocol.js uses a CJS/browser-global wrapper so its classes are never global.
// In browser mode they live in window.SHARC.Protocol; in Node.js via require.

const {
  SHARCContainerProtocol,
  SHARCStateMachine,
  ProtocolMessages,
  ContainerMessages,
  CreativeMessages,
  ContainerStates,
  ErrorCodes,
  SHARC_VERSION,
  SHARC_API_CODE,
  SAFEFRAME_API_CODE,
  RENDERER_PROTOCOL_VERSION,
} = (typeof module !== 'undefined' && module.exports)
  ? require('./sharc-protocol')
  : ((typeof window !== 'undefined' && window.SHARC && window.SHARC.Protocol) || {});

// ---------------------------------------------------------------------------
// Lifecycle adapters (0.7.2 § 8) — internal dependency, bundled by rollup.
// ---------------------------------------------------------------------------
// The HTML adapter ships in 0.7.2 first half. 0.7.3 adds MraidAdapter /
// SafeFrameAdapter subclasses; selection happens in
// `_selectLifecycleAdapter(apiFramework)` below.

import { HtmlAdapter } from './lifecycle-adapters/html-adapter.js';
import { OmidCompatBridge } from './sharc-omid-bridge.js';
import { SHARCProtocolRouter } from './sharc-protocol-router.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default timeout values in milliseconds. */
const DEFAULT_TIMEOUTS = {
  createSession: 5000,  // 5s to receive createSession
  initResolve: 2000,    // 2s for creative to resolve Container:init
  startResolve: 2000,   // 2s for creative to resolve Container:startCreative
  closeSequence: 2000,  // 2s for creative close sequence
  // Creative Markup renderer protocol (Phase B). See proposal § Timeouts.
  rendererLoad: 5000,   // 5s for renderer iframe `load` event after src assignment
  rendererReply: 2000,  // 2s for renderer's SHARC:Renderer:rendered (or :failed) reply
};

/**
 * Iframe `allow` attribute (Permissions Policy) for the Creative Markup
 * renderer iframe. Default-deny across sensors, hardware-access APIs,
 * payments, identity-federation (FedCM), and UX-intrusive features.
 *
 * Ad-tech-relevant Permissions Policy features are deliberately NOT in the
 * deny list — `private-state-token-issuance` / `private-state-token-redemption`
 * (Private State Tokens, anti-fraud) remain operative; the policy features for
 * `browsing-topics`, `attribution-reporting`, `shared-storage` are also
 * permit-by-default to stay forward-compatible with whatever the W3C PATCG
 * attribution work produces. See proposal § Iframe-level CSP / DD-24.
 *
 * Stronger than `sandbox` for the denied features — `sandbox` doesn't cover
 * most of them.
 */
const RENDERER_PERMISSIONS_POLICY = [
  "geolocation 'none'",
  "camera 'none'",
  "microphone 'none'",
  "payment 'none'",
  "usb 'none'",
  "serial 'none'",
  "clipboard-write 'none'",
  "screen-wake-lock 'none'",
  "accelerometer 'none'",
  "gyroscope 'none'",
  "magnetometer 'none'",
  "web-share 'none'",
  "idle-detection 'none'",
  "xr-spatial-tracking 'none'",
  "identity-credentials-get 'none'",
].join('; ');

/**
 * Iframe `csp` attribute (Chromium-only CSP Embedded Enforcement) for the
 * renderer iframe. Defense-in-depth against `<base href>` redirection and
 * plugin-content (`<object>`/`<embed>`) injection. The portable enforcement
 * layer is the renderer's HTTP-response CSP — see proposal §
 * "CSP enforcement: HTTP response is the portable layer".
 */
const RENDERER_IFRAME_CSP = "object-src 'none'; base-uri 'none'";

/**
 * Answered probe-cycle rate ceiling for `_armRendererBackstop` (#332, Phase 2 of
 * the post-render nav policy — `docs/design/0.7.10-post-render-nav-policy-omid-phase.md`).
 *
 * Phase 1 (#321) gates EVERY post-render renderer-frame load through the
 * authenticated loadProbe/loadAck round-trip, and each ANSWERED cycle emits one
 * `console.info` + one `renderer_load_observed` `onSecurityEvent` callback. A
 * renderer that answers the probe on every load cycle can therefore drive an
 * unbounded `load → runGate → renderer_load_observed` churn — a keep-alive /
 * log-volume DoS-adjacent window. This ceiling bounds BOTH the log volume and
 * the keep-alive-abuse surface WITHOUT killing a legitimate-but-chatty renderer.
 *
 * The bound is a sliding-window RATE cap, not a lifetime cap: at most
 * `PROBE_CYCLE_CEILING_MAX` answered cycles per `PROBE_CYCLE_CEILING_WINDOW_MS`.
 * On the (MAX+1)th answered cycle inside the window the backstop classifies the
 * renderer as abusively chatty and THROTTLES — it suppresses further
 * `renderer_load_observed` emissions and emits the reserved non-terminating
 * `renderer_navigation_blocked` (2122) diagnostic exactly once on the threshold
 * crossing. It does NOT terminate: Decision 0/2 keep the ad alive while SHARC
 * holds the channel; 2118 stays reserved for lost-control (gate unanswered).
 *
 * Why these values, and why CONSTANTS (not construction options): with the
 * inherited 100ms loadAck deadline a maximally abusive renderer can drive at
 * most ~10 answered cycles/second, so a 10s window caps a flood near ~100 cycles
 * — `MAX = 20` trips a flood well before that while staying far above any
 * legitimate bootstrap pattern (the DV corpus showed 1–2 controlled reopens per
 * ad; measurement/MRAID/OMID bootstraps add at most a handful). This is a
 * security/DoS ceiling, not a behavior a renderer should be able to negotiate
 * upward — so it is a fixed constant, mirroring the hardcoded 100ms probe
 * deadline, not a `timeouts`-style option.
 *
 * Accepted residual: because this is a RATE cap (≤MAX answered cycles per
 * window), NOT a lifetime/volume cap, a renderer that paces itself just under
 * the ceiling (~MAX-1 answered cycles/window) sustains a low steady diagnostic
 * rate for the entire ad lifetime and never trips 2122. This is accepted and
 * deliberate. Each answered cycle is a semantically-honest "controlled load
 * observed" signal — not a forgery — so the residual is a bounded log-rate
 * cost, not a security bypass. A lifetime/volume cap is explicitly REJECTED: it
 * would eventually throttle a legitimately long-lived or chatty renderer (long
 * video, repeated OMID/MRAID reopens) and blind operators to genuine late-life
 * signal. The sliding window is the intended tradeoff — bound the burst rate,
 * keep honest late-life observability. (A suppressed-count surfaced on the 2122
 * diagnostic was considered and deferred to Phase-2 intent classification.)
 */
const PROBE_CYCLE_CEILING_MAX = 20;
const PROBE_CYCLE_CEILING_WINDOW_MS = 10000;

/**
 * Reserved bridge identifiers known to the 0.7.1 container-side detection
 * pipeline. Mirrors the renderer's `knownBridges` allowlist. Drift between
 * the two is acceptable (the renderer is the truth — it filters unknown
 * identifiers out) but matching them here is a tighter validation surface
 * for operator-supplied `bridges` arrays at construction.
 *
 * 0.7.1: 'mraid', 'safeframe' only. OMID is container-owned (extension
 * path only) — never a creative bridge. See design doc § 13 Q4 lock.
 *
 * @see docs/design/0.7.1-bridges-field.md § 2 Wire-format change
 */
const KNOWN_BRIDGE_IDENTIFIERS = Object.freeze(['mraid', 'safeframe']);

/**
 * AdCOM `APIFramework` integer codes the container-side detector recognizes
 * as 0.7.1 (issue #82). Each entry maps an AdCOM enum value to the SHARC
 * bridge identifier the renderer should load.
 *
 * Source: AdCOM v1.0 List: API Frameworks
 * https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/master/AdCOM%20v1.0%20FINAL.md#list--api-frameworks-
 *
 * 0.7.1 mapping (per design doc § 3.2):
 *   - `3` (MRAID 1.0)  → 'mraid'
 *   - `5` (MRAID 2.0)  → 'mraid'
 *   - `6` (MRAID 3.0)  → 'mraid'
 *   - `7` (OMID 1.0)   → no mapping in 0.7.1 (deferred to 0.7.2)
 *   - SafeFrame: no AdCOM enum exists today; future SHARC contribution
 *     adds it. Detected via adm scan layer 3 in 0.7.1.
 *   - Other / vendor-specific (500+): ignored.
 *
 * Unrecognized codes (typo, future enum, vendor-specific) silently fall
 * through to layer 3 — they never produce "load nothing on purpose"; that
 * is what an explicit `bridges: []` is for.
 *
 * @see docs/design/0.7.1-bridges-field.md § 3.2 Layer 2
 */
const ADCOM_API_TO_BRIDGE = Object.freeze({
  3: 'mraid',
  5: 'mraid',
  6: 'mraid',
  // 0.7.2: SafeFrame entry via the named placeholder constant (publication-
  // locked per § 6.3). Completes the picker ↔ bridge resolver symmetry —
  // a creative declaring `creativeMeta.apis: [SAFEFRAME_API_CODE]` resolves
  // to `apiFramework: SAFEFRAME_API_CODE` AND `bridges: ['safeframe']`.
  // OMID (code 7) intentionally absent in first-half — measurement bridge
  // ships in 0.7.2 second-half OMID design pass.
  [SAFEFRAME_API_CODE]: 'safeframe',
});

/**
 * Frozen list of canonical SHARC reference renderer URLs hosted by SHARC
 * maintainers. These are SDK-reference deployments only — operators in
 * production must use their own operator-controlled renderer URL. Listing
 * a URL here trips the production-block guard in non-dev origins.
 *
 * When SHARC is contributed upstream to IABTechLab, add the upstream URL.
 *
 * Issue #55 / Phase F — see docs/proposals/creative-sources.md
 * § Renderer Ownership Model.
 */
const KNOWN_TEST_RENDERERS = Object.freeze([
  'https://jeffreycarlson.github.io/SHARC/renderer/',
  // Future upstream: 'https://iabtechlab.github.io/SHARC/renderer/'
  //                  added when SHARC is contributed upstream.
]);

/**
 * Origin patterns recognized as developer/local environments. The
 * production-block guard fires for `KNOWN_TEST_RENDERERS` only when the
 * page origin does NOT match one of these patterns, so local dev against
 * the canonical hosted renderer keeps working.
 *
 * Patterns mirror the dev-origin recognition surface called out in the
 * Phase F brief (localhost / 127.0.0.1 / *.localhost / *.test / *.local
 * / [::1] / 0.0.0.0). Anchored with `^` / `$` to prevent suffix-style
 * spoofing (e.g. an attacker-controlled `notlocalhost.example`).
 */
const DEV_ORIGIN_PATTERNS = Object.freeze([
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.test(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.local(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
  /^https?:\/\/0\.0\.0\.0(:\d+)?$/,
]);

// SHARC_VERSION imported from sharc-protocol.js
const SHARC_BUILD_MODE = /** @type {'dev'|'prod'} */ ('__SHARC_BUILD_MODE__');

// ---------------------------------------------------------------------------
// SHARCContainer
// ---------------------------------------------------------------------------

/**
 * @typedef {{valid: true, resolvedClose?: any}} ValidationOk
 * @typedef {{valid: false, code: number, message: string}} ValidationFail
 */

/**
 * Container-side SHARC implementation.
 *
 * Manages the full lifecycle of a single SHARC ad instance:
 *   loading → ready → active ↔ passive ↔ hidden → frozen → terminated
 *
 * Each SHARCContainer instance manages exactly one ad. To show a new ad,
 * create a new SHARCContainer instance.
 */
/**
 * Discriminated union over all `onSecurityEvent` payloads. The `type` field
 * is the discriminant — narrowing on it gives `details` its event-specific
 * shape. Closes #62. Variants reserved per proposal § Security Model:
 *
 *   - `wrapper_top_frame_inaccessible` — non-terminating; fires once at
 *     construction when `window.top.location` access throws.
 *   - `renderer_origin_mismatch` — terminating (RENDERER_ORIGIN_MISMATCH 2116);
 *     post-load origin echo doesn't match construction-time origin.
 *   - `renderer_protocol_error` — terminating (RENDERER_PROTOCOL_ERROR 2117);
 *     malformed renderer message (timeout, post-failure, malformed payload).
 *   - `renderer_failed` — terminating (RENDERER_FAILED 2115); renderer sent
 *     explicit `SHARC:Renderer:failed`.
 *   - `bridge_load_failed` — terminating (RENDERER_FAILED 2115); the
 *     renderer's dynamic `import()` of a SHARC compatibility bridge module
 *     rejected (404, MIME mismatch, network failure, evaluation throw, or
 *     same-origin assertion failure). Surfaced as a distinct event type
 *     so operators monitoring `onSecurityEvent` see bridge-load failures
 *     separately from generic renderer-reported failures. Added 0.7.1
 *     (issue #82) per the 5 Security Engineer guardrails.
 *   - `unauthorized_navigation` — terminating (RENDERER_UNAUTHORIZED_NAVIGATION
 *     2118); load-event backstop detected a renderer navigation outside the
 *     SHARC protocol path.
 *   - `feature_load_failed` — non-terminating; an extension's load-time
 *     asset (e.g. the OM SDK script for `OmidCompatBridge`) failed to
 *     load on the publisher page. Sibling to `bridge_load_failed` (which
 *     covers the renderer-side dynamic bridge import). The container
 *     keeps running; the failed extension goes inert. No `errorCode`
 *     (extensions are not in the 21xx renderer-error-code namespace).
 *     Added 0.7.4 (issue #125) per the 0.7.4 ADR § 2.2.
 *
 * Common fields live on every variant; `details` payload schemas and
 * sanitization policies are per-variant. Most variants pass `details` through
 * RAW so operators consuming the structured channel get full fidelity; a
 * subset (e.g. `feature_load_failed`, which sanitizes and bounds
 * `details.scriptUrl`) applies per-variant sanitization at emit time — see
 * the variant's typedef for its policy. The dev-channel `console.error` is
 * the only place sanitization (via `_sanitizeForLog`) is mandatory across all
 * variants. See Phase C threat-model notes on `_sanitizeForLog` for the trust
 * boundary.
 *
 * @typedef {WrapperTopFrameInaccessibleEvent
 *   | RendererOriginMismatchEvent
 *   | RendererProtocolErrorEvent
 *   | RendererFailedEvent
 *   | BridgeLoadFailedEvent
 *   | UnauthorizedNavigationEvent
 *   | RendererLoadObservedEvent
 *   | RendererNavigationBlockedEvent
 *   | FeatureLoadFailedEvent
 *   | OmidResourceCapEvent
 *   | UnauthorizedProtocolEvent} SHARCSecurityEvent
 */

/**
 * @typedef {object} SHARCSecurityEventBase
 * @property {number} timestamp - `Date.now()` when the event fired.
 * @property {string} placementSessionId - Correlates this event to the
 *   container instance (same UUID exposed as `container.placementSessionId`).
 * @property {string} message - Human-readable description.
 */

/**
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'wrapper_top_frame_inaccessible',
 *   severity: 'warning' | 'error',
 *   details: {
 *     wrapperOrigin: string | null,
 *     creativeRendererUrl: string,
 *   },
 * }} WrapperTopFrameInaccessibleEvent
 */

/**
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'renderer_origin_mismatch',
 *   severity: 'error',
 *   errorCode: 2116,
 *   details: {
 *     expectedOrigin: string,
 *     actualOrigin: string,
 *   },
 * }} RendererOriginMismatchEvent
 */

/**
 * @remarks Variant collapse: spec § Security Model line 715 reserves only
 * 5 structured event types, so timeout (2114), post-failed (2119), and
 * integrity-failed (2120) — distinct error codes with distinct internal
 * `[type]` log tags — all
 * surface here as `renderer_protocol_error`. The `details.subtype` field
 * discriminates `timeout` / `malformed_payload` / `post_failed` /
 * `integrity_failed`. See
 * api-reference.md § Renderer Protocol § onSecurityEvent surface for the
 * consumer contract.
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'renderer_protocol_error',
 *   severity: 'error',
 *   errorCode: 2114 | 2117 | 2119 | 2120,
 *   details: {
 *     subtype: 'malformed_payload' | 'timeout' | 'post_failed' | 'integrity_failed',
 *     reason: string,
 *   },
 * }} RendererProtocolErrorEvent
 */

/**
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'renderer_failed',
 *   severity: 'error',
 *   errorCode: 2115,
 *   details: {
 *     reason: string,
 *   },
 * }} RendererFailedEvent
 */

/**
 * @remarks Variant carve-out from `RendererFailedEvent`: bridge-load failures
 * share the same error code (RENDERER_FAILED 2115) but get their own
 * structured-event variant so operators monitoring `onSecurityEvent` can
 * distinguish "MRAID bridge module 404'd from your CDN" from "creative
 * markup is malformed and the renderer rejected it." Both surface 2115 to
 * `onError`; the discriminated `event.type` is the operator-facing
 * differentiator. Routed from the renderer's `:failed` reply when
 * `reason === 'bridge_load_failed'`.
 *
 * `details.bridge` carries the bridge identifier the renderer was trying
 * to import (e.g. `'mraid'`); `details.url` carries the resolved bridge-
 * module URL (or the substituted-but-unparseable template string on the
 * rare unparseable-URL path), bounded to 500 chars; `details.reason`
 * carries the literal `'bridge_load_failed'` reason string for parity
 * with `RendererFailedEvent`.
 *
 * Added 0.7.1 (issue #82) per design doc § 4 SE guardrail #5.
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'bridge_load_failed',
 *   severity: 'error',
 *   errorCode: 2115,
 *   details: {
 *     reason: string,
 *     bridge: string,
 *     url: string,
 *   },
 * }} BridgeLoadFailedEvent
 */

/**
 * Defense-in-depth backstop event. Fired when the creative iframe emits an
 * unexpected `load` event — meaning the iframe document navigated outside
 * the SHARC protocol path. The `details.variant` discriminator separates
 * the Markup variant (post-`:rendered` second `load`) from the Creative
 * URL variant (post-initial-load second `load`). Both variants share the
 * structured event type, code, and message; operators monitor 2118 and
 * branch on `details.variant` only when they need variant-specific
 * triage.
 *
 * `details.msSinceRender` is the wall-clock delay (ms) between the
 * "render-anchor" event (Markup: envelope-validated `:rendered`; URL:
 * the initial iframe `load`) and the unexpected post-render `load` event
 * firing. Helps operators distinguish fast-fire (creative immediately
 * reloaded, ~0–100ms) from slow-fire (delayed DOM injection / meta-refresh
 * re-injection, multiple seconds) so they can pre-allocate monitoring
 * buckets and triage redirect-injection patterns. Field name is preserved
 * across variants for grep-stable operator dashboards (the URL variant's
 * "render anchor" is the initial load, not a `:rendered` reply, but the
 * delay-since-anchor semantics are identical).
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'unauthorized_navigation',
 *   severity: 'error',
 *   errorCode: 2118,
 *   details: {
 *     variant: 'markup' | 'url',
 *     msSinceRender: number,
 *   },
 * }} UnauthorizedNavigationEvent
 */

/**
 * Non-terminating post-render-load diagnostic (0.7.10 Phase 1). Fired when a
 * post-render renderer-frame `load` event occurred AND the controlled-context
 * gate (loadProbe/loadAck round-trip) was answered within the deadline — i.e.
 * SHARC still holds the authenticated protocol channel to the renderer document.
 * The ad is kept alive.
 *
 * This is the new default outcome for the corpus pattern (controlled reopen /
 * document.write bootstrap / measurement-vendor bootstrap). It replaces the
 * formerly blanket-fatal 2118 for the controlled case; 2118 is now narrowed to
 * lost-control (gate unanswered) only.
 *
 * `details.msSinceRender` mirrors the 2118 field — wall-clock delay between the
 * render-anchor and this load. `details.loadKind` is a coarse hint: `'first'`
 * for the first verified post-render load, `'subsequent'` for any later one.
 * No top-level `errorCode` field — this is non-terminating and never reaches
 * `onError`. `details.code` carries 2121 (`RENDERER_LOAD_OBSERVED`) for
 * numeric telemetry symmetry with the 2118 terminating event, WITHOUT
 * promoting it to the terminating `errorCode` channel.
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'renderer_load_observed',
 *   severity: 'info',
 *   details: {
 *     variant: 'markup' | 'url',
 *     msSinceRender: number,
 *     loadKind: 'first' | 'subsequent',
 *     code: 2121,
 *   },
 * }} RendererLoadObservedEvent
 */

/**
 * Non-terminating navigation-blocked diagnostic (0.7.10 Phase 2 — first emitter
 * landed in #332). Fired when a behavior is classified and blocked-if-possible
 * while SHARC still holds the channel (ad kept alive). #332's emitter is the
 * answered probe-cycle rate ceiling (`navKind: 'answered_probe_cycle_ceiling'`
 * — chatty-renderer keep-alive / log-volume bound). Further intent-classified
 * nav kinds (top/parent nav, unaudited window.open, landing-page redirect) are
 * deferred Phase-2 work. Non-terminating: 2118 stays reserved for lost-control.
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'renderer_navigation_blocked',
 *   severity: 'warning',
 *   details: {
 *     variant: 'markup' | 'url',
 *     navKind: string,
 *     code: 2122,
 *   },
 * }} RendererNavigationBlockedEvent
 */

/**
 * Non-terminating extension-load-failure variant. Fired when an extension's
 * load-time asset (e.g. the OM SDK script for `OmidCompatBridge`) failed to
 * load on the publisher page after the extension's feature name was already
 * contributed to `supportedFeatures`. Sibling to `bridge_load_failed` (which
 * covers the renderer's dynamic bridge import on the iframe side); this
 * variant covers the publisher-page extension-load path.
 *
 * Non-terminating: the container keeps running, the failed extension goes
 * inert, the operator observes the signal on `onSecurityEvent`. No
 * `errorCode` field — extensions are not in the 21xx renderer-error-code
 * namespace, and there is no fatal-error tail to carry a code into.
 *
 * `details.featureName` names the failed feature (e.g.
 * `'com.iabtechlab.sharc.omid'`). `details.reason` is a classified
 * string token. Current in-tree bridges emit one of `'timeout'`,
 * `'network'`, or `'evaluation_throw'` — script-tag loaders cannot
 * distinguish HTTP status (a 404 and a transport failure both surface
 * to `<script>.onerror` without status detail, so both classify as
 * `'network'`). Future fetch-based loaders may emit additional tokens
 * like `'http_404'`. `details.scriptUrl` is the URL that failed,
 * bounded to 500 chars at the container (parity with
 * `bridge_load_failed.details.url` at the renderer-failure call site) —
 * defense-in-depth against hostile-extension input.
 *
 * Added 0.7.4 (issue #125) per the 0.7.4 ADR § 2.2.
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'feature_load_failed',
 *   severity: 'error',
 *   details: {
 *     featureName: string,
 *     reason: string,
 *     scriptUrl: string,
 *   },
 * }} FeatureLoadFailedEvent
 */

/**
 * Non-terminating discriminated-union variant raised when an extension's
 * per-session resource governance bound trips — currently the OMID bridge's
 * `MAX_OMID_VERIFICATION_RESOURCES` ceiling on distinct verification-script
 * resources fed to one OM SDK `Context` (#244 design D7). The configured list
 * is truncated to the bound (loud truncation): measurement coverage is
 * reduced for the dropped vendors, the ad itself is unaffected, and the
 * container never terminates on this event.
 *
 * Added 0.7.11 (#244 design D7).
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'omid_resource_cap',
 *   severity: 'warning',
 *   details: {
 *     featureName: string,
 *     requestedCount: number,
 *     keptCount: number,
 *     limit: number,
 *   },
 * }} OmidResourceCapEvent
 */

/**
 * Non-terminating discriminated-union variant raised by the protocol router
 * (0.7.7) when an inbound cross-frame envelope passes every trust-anchor check
 * (source, origin, registered prefix, placementSessionId, protocol-derived
 * nonce, declared type) but arrives in a lifecycle phase outside the type's
 * declared phase membership. Defends against cross-protocol envelope-type
 * impersonation by iframe-side extensions landing in later releases.
 *
 * Payload is deliberately minimized to three enumerated, attacker-uncontrolled
 * fields (§ 8.7 of the 0.7.7 design doc). No raw envelope content reaches the
 * security-event channel.
 *
 * @typedef {SHARCSecurityEventBase & {
 *   type: 'unauthorized_protocol',
 *   severity: 'error',
 *   details: {
 *     type: string,
 *     phase: 'init' | 'attaching-renderer' | 'rendered'
 *          | 'omid-active' | 'creative-active' | 'terminated',
 *     reason: 'out-of-phase' | 'nonce-mismatch' | 'prefix-unregistered',
 *   },
 * }} UnauthorizedProtocolEvent
 */

/**
 * @callback SHARCSecurityEventCallback
 * @param {SHARCSecurityEvent} event
 * @returns {void}
 */

class SHARCContainer {
  /**
   * Answered probe-cycle rate ceiling (#332). Read-only telemetry mirror of the
   * module-level `PROBE_CYCLE_CEILING_MAX` / `PROBE_CYCLE_CEILING_WINDOW_MS` so
   * operators and tests can reason about the bound without re-deriving it. These
   * are a fixed security/DoS ceiling, NOT a construction-time option — see the
   * constant docs. `MAX` answered cycles are permitted per `WINDOW_MS`; the
   * (MAX+1)th within the window throttles and emits one 2122.
   *
   * @type {number}
   */
  static PROBE_CYCLE_CEILING_MAX = PROBE_CYCLE_CEILING_MAX;

  /** @type {number} */
  static PROBE_CYCLE_CEILING_WINDOW_MS = PROBE_CYCLE_CEILING_WINDOW_MS;

  /**
   * Captured-native `MessagePort.prototype.postMessage`, captured at module
   * evaluation (top frame, before any creative iframe exists). The container
   * sends the `:loadProbe` over `port1` via `.call(port1, …)` so a clobber of
   * `MessagePort.prototype.postMessage` cannot suppress the probe (ADR
   * 2026-06-15 § Ratified SE conditions, condition 2 — defense-in-depth on the
   * trusted container side). `null` when MessagePort is unavailable (the probe
   * path then no-ops; the gate falls to the existing timeout/2118).
   * @type {Function|null}
   */
  static _NATIVE_PORT_POST = (typeof MessagePort !== 'undefined')
    ? MessagePort.prototype.postMessage : null;

  /** @type {Function|null} */
  static _NATIVE_ET_AEL = (typeof EventTarget !== 'undefined')
    ? EventTarget.prototype.addEventListener : null;

  /** @type {Function|null} */
  static _NATIVE_PORT_START = (typeof MessagePort !== 'undefined')
    ? MessagePort.prototype.start : null;

  /**
   * @param {Object} [options={}]
   * @param {string} [options.creativeUrl] - URL of the SHARC-enabled creative HTML
   *   (Creative URL variant). Mutually exclusive with `creativeHtml`. Exactly one
   *   of `creativeUrl` or `creativeHtml` MUST be provided. Empty string (`''`) is
   *   treated as "not provided" — same as `undefined`/`null`.
   * @param {string} [options.creativeHtml] - Raw HTML markup for the creative
   *   (Creative Markup variant — added in 0.7.0). Mutually exclusive with
   *   `creativeUrl`. Requires `creativeRendererUrl`. Posted to the operator-hosted
   *   renderer page via the renderer protocol. Capped at 256 KiB at construction
   *   (pre-injection); see proposal § Validation Rules. Empty string (`''`) is
   *   treated as "not provided" — same as `undefined`/`null`.
   * @param {string} [options.creativeRendererUrl] - HTTPS URL of an operator-hosted
   *   renderer page. Required when `creativeHtml` is provided; forbidden alongside
   *   `creativeUrl`. Must parse via `new URL(...)`, use the `https:` scheme
   *   (except `http:` localhost-style renderer URLs when the publisher origin is
   *   also a recognized dev origin), contain no userinfo, and be cross-origin to
   *   both `window.location` and (when accessible) `window.top.location`. See
   *   proposal § Validation Rules. Empty string (`''`) is treated as "not provided."
   * @param {string} [options.creativeRendererIntegrity] - Optional SRI-style
   *   SHA-384 digest for the operator-hosted renderer page, in the form
   *   `sha384-<base64>`. Creative Markup only. When provided, the container
   *   fetches `creativeRendererUrl`, computes SHA-384 over the response bytes,
   *   and refuses to assign `iframe.src` or send `SHARC:Renderer:render` when
   *   the digest mismatches or the bytes cannot be verified. This is a
   *   best-effort preflight because browsers do not support native
   *   `integrity=` enforcement on iframes; operators should still serve the
   *   renderer from immutable versioned URLs with strong CDN controls and CORS
   *   headers that allow publisher-side fetch verification.
   * @param {SHARCSecurityEventCallback} [options.onSecurityEvent] - Callback fired
   *   with a {@link SHARCSecurityEvent} for security-relevant events (wrapper carve-out,
   *   origin mismatch, renderer protocol failure, etc.). Production observability hook.
   *   Synchronous; throws are caught and logged. Console output continues regardless
   *   of whether the callback is provided. See proposal § Security Model.
   * @param {boolean} [options.allowPopups=true] - When `true` (default), the Creative
   *   Markup renderer iframe sandbox includes both `allow-popups` AND
   *   `allow-popups-to-escape-sandbox`. When `false`, both tokens are omitted; creative
   *   `window.open()` calls fail at the browser level. `SHARC.requestNavigation()` works
   *   regardless. The `allow-popups-to-escape-sandbox` token is bound to this option
   *   (DD-21); not exposed separately.
   * @param {boolean} [options.allowTopNavigationByUserActivation=true] - When `true`
   *   (default), the renderer iframe sandbox includes `allow-top-navigation-by-user-activation`,
   *   permitting user-gesture-initiated `<a target="_top">` clicks. When `false`, the
   *   token is omitted. The unsafe `allow-top-navigation` token (no-gesture variant) is
   *   never exposed. See DD-20.
   * @param {boolean} [options.allowStorageAccessByUserActivation=true] - When `true`
   *   (default), the renderer iframe sandbox includes
   *   `allow-storage-access-by-user-activation`, permitting `document.requestStorageAccess()`
   *   on user gesture. When `false`, the token is omitted and SAA calls fail. See DD-22.
   * @param {boolean} [options.allowModals=false] - When `true`, the renderer iframe
   *   sandbox includes `allow-modals`. Default `false` — modals are an opt-in operator
   *   control, not a baseline capability. See DD-23.
   * @param {boolean} [options.allowDownloads=false] - When `true`, the renderer iframe
   *   sandbox includes `allow-downloads`. Default `false` — direct iframe downloads are
   *   an opt-in operator control. See DD-25.
   * @param {'warn'|'block'} [options.wrapperPolicy='warn'] - Controls container behavior
   *   when validation rule 7's wrapper-cross-origin carve-out applies (cross-origin top
   *   frame inaccessible at construction). `'warn'` (default) emits `console.warn` +
   *   `onSecurityEvent` and proceeds. `'block'` emits `console.error` + `onSecurityEvent`
   *   and throws synchronously at construction. See DD-19 and proposal § Security Model
   *   § wrapper-cross-origin.
   * @param {string[]|null} [options.bridges] - **Creative Markup variant only**
   *   (paired with `creativeHtml`). Passing `bridges` alongside `creativeUrl`
   *   throws synchronously (Rule 3b) — the Creative URL variant does not load
   *   bridges (no renderer protocol). Explicit list of compatibility-bridge
   *   identifiers the renderer should load alongside the creative HTML. When
   *   provided, overrides the auto-detection pipeline (`creativeMeta.apis` → adm
   *   content scan). Reserved identifiers in 0.7.1: `'mraid'`, `'safeframe'`.
   *   Pass `[]` to explicitly suppress all bridge loading (e.g., a static-image
   *   creative the operator has classified). Pass `null` (or omit) to use
   *   auto-detection. Validated as `null | string[]`; contents validated against
   *   the reserved set — unknown identifiers throw. Resolved value is reflected
   *   on the `bridges` field of the `SHARC:Renderer:render` message and exposed
   *   as `container.bridges`.
   *   See `docs/design/0.7.1-bridges-field.md` § 3 Container-side detection.
   * @param {{apis?: number[], measurement?: {omid?: Object}}} [options.creativeMeta]
   *   - Bid-side metadata used by layer 2 of the bridge auto-detection
   *   pipeline and by measurement sidecars. `creativeMeta.apis` is an array of AdCOM
   *   `APIFramework` integer codes
   *   (https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/master/AdCOM%20v1.0%20FINAL.md#list--api-frameworks-).
   *   For OpenRTB 2.6 sources `bid.apis` maps directly. For pre-2.6 sources
   *   where the field is the deprecated singular `bid.api` (single integer),
   *   normalize at the call site: `creativeMeta: { apis: bid.apis ?? (typeof bid.api === 'number' ? [bid.api] : bid.api ?? []) }`.
   *   Recognized in 0.7.1: 3/5/6 (MRAID 1.0/2.0/3.0) → `'mraid'`. Code 7 (OMID 1.0)
   *   is reserved for 0.7.2; SafeFrame has no AdCOM enum yet (detected via adm
   *   scan in 0.7.1). Vendor-specific codes (500+) ignored. Forward-compatible
   *   bag — future bid-side fields land in this same object without growing the
   *   constructor surface. On Creative URL variant, `creativeMeta` does not
   *   load renderer bridges and does not set `apiFramework`, but may carry
   *   `creativeMeta.measurement.omid` for bid-signaled OMID auto-installation
   *   when paired with `omidAutoInstall`.
   *   See `docs/design/0.7.1-bridges-field.md` § 3.2.
   * @param {Object|null} [options.omidAutoInstall] - Optional operator-owned
   *   OMID auto-install defaults. When `creativeMeta.apis` contains AdCOM
   *   `7` (OMID 1.0) and `creativeMeta.measurement.omid.verificationScripts`
   *   is present, the container appends an `OmidCompatBridge` extension built
   *   from this object plus the bid-declared OMID sidecar. This option is the
   *   source for trusted OM SDK URLs (`omSdkServiceScriptUrl`,
   *   `omSdkSessionClientUrl`) and partner defaults; bid metadata supplies
   *   verification resources and optional OMID session descriptors. Missing or
   *   invalid sidecar data warns and continues without installing OMID.
   * @param {string} [options.creativeSdkUrl] - Operator-hosted `sharc-creative.js` URL.
   *   When set, the container auto-injects a `<script src="...sharc-creative.js"></script>`
   *   tag into Markup-variant creative HTML at load time, lifting legacy adm
   *   (plain HTML / MRAID / SafeFrame creatives that don't know about SHARC)
   *   into the SHARC runtime without per-creative changes.
   *
   *   Pattern: operators ingesting OpenRTB bids from third-party DSPs receive
   *   `bid.adm` that wasn't built against SHARC. Setting one constructor option
   *   is the difference between "creative loads but no handshake" and "creative
   *   handshakes, bridges install, full SHARC observability." This is the
   *   dominant operator integration pattern for the Markup variant — wiring
   *   the SDK at the container level instead of per-creative or via separate
   *   extensions removes the speculation about whether operators will opt in.
   *
   *   Injection position (4-step, most-specific-wins): after `<head>` → after
   *   `<html>` → after `<!DOCTYPE>` → prepend. The doctype branch inserts AFTER
   *   the declaration (not before) — prepending would push the browser into
   *   quirks-mode and subtly break legacy creatives.
   *
   *   Creative URL variant: NOT injected. The URL variant always loads via
   *   `iframe.src` — no container-side injection into URL creatives, ever
   *   (the ratified URL-mode no-injection invariant; the 0.7.4
   *   `useMarkupInjection` fetch+srcdoc opt-in was removed 2026-07-05).
   *   Passing `creativeSdkUrl` alone is a stored no-op on the URL variant,
   *   so operators sharing constructor config across Markup and URL bid
   *   variants don't need per-bid awareness. The
   *   `com.iabtechlab.sharc.creative-injector` feature is advertised only
   *   when injection actually ran (Markup only) — no capability lie.
   *
   *   Throws `TypeError` (Rule 12) when provided as anything other than a
   *   non-empty string. No coercion of numbers/objects/booleans. See 0.7.2
   *   design § 6.3; 0.7.4 design § 2.1 (URL-variant parity, #106).
   * @param {boolean} [options.creativeSdkSkipIfPresent=true] - Idempotency guard
   *   for the built-in SDK injection. When `true` (default), markup already
   *   containing a `<script src="...sharc-creative.js">` tag passes through
   *   unchanged. The script-src context is required — bare substring presence
   *   in HTML comments, `<meta content="...">`, or inline-script text does NOT
   *   trigger the skip (closes the silent-no-op footgun where a comment caused
   *   the SDK to never load and bridge auto-install to time out).
   *
   *   Set `false` to force injection (versioned-SDK coexistence test rigs,
   *   debug-instrumented overlays, etc.). No-op when `creativeSdkUrl` is unset.
   *   See 0.7.2 design § 6.3.
   * @param {Object} [options.creativeSdkScriptAttrs={}] - Additional `<script>`
   *   attributes for the auto-injected SDK tag. Defaults to `{}` — a bare
   *   `<script src="...">` element (parser-blocking, synchronous), which is
   *   the ONLY attribute set that prevents the inline-`mraid.*` race condition
   *   for legacy MRAID creatives. Inline MRAID creatives invoke `mraid.*` calls
   *   immediately during parser execution; `async` / `defer` defer the SDK load
   *   past those calls and they vanish into ReferenceError.
   *
   *   Serialization (React-style): `true` → bare attribute (` async`); `false`
   *   / `null` / `undefined` → omitted entirely; strings → quoted attribute
   *   with HTML escaping (`&` → `&amp;`, `"` → `&quot;`, `<` → `&lt;`) to
   *   defend against attribute-injection when operator pipelines thread
   *   user-derived data through these values. The `creativeSdkUrl` `src=`
   *   attribute is escaped identically.
   *
   *   Operators with fully event-driven pipelines (no inline MRAID calls) can
   *   pass `{ async: true }`, `{ defer: true }`, `{ integrity: 'sha384-...' }`,
   *   etc. No-op when `creativeSdkUrl` is unset. See 0.7.2 design § 6.3.
   * @param {HTMLElement} [options.placementElement] - The DOM element to insert the iframe into.
   *   (Previously named `containerEl` — `containerEl` is no longer accepted. Use `placementElement` instead.)
   * @param {string|null} [options.placementId] - Publisher-supplied placement identifier.
   *   Round-trips through the constructor so the instance exposes `container.placementId`.
   *   Omitting the option or passing `''` both result in `null`.
   * @param {string|null} [options.placementName] - Human-readable placement name.
   *   Round-trips through the constructor so the instance exposes `container.placementName`.
   *   Omitting the option or passing `''` both result in `null`.
   * @param {Object} [options.environmentData] - Environment data to pass in Container:init.
   *   @param {Object} [options.environmentData.currentPlacement] - Placement dimensions.
   *   @param {Object} [options.environmentData.dataspec] - AdCOM or custom dataspec info.
   *   @param {Object} [options.environmentData.data] - Data from the dataspec.
   *   @param {Object} [options.environmentData.containerNavigation] - Navigation capabilities.
   *   @param {boolean} [options.environmentData.isMuted] - Whether audio is muted.
   *   @param {number} [options.environmentData.volume] - Volume level (0-1, or -1 if unknown).
   *   @param {Object} [options.environmentData.publisherContext] - Publisher environment context.
   *     @param {string} [options.environmentData.publisherContext.pageUrl] - Page URL (MRAID 3.0 pattern: "" if unavailable).
   *     @param {string} [options.environmentData.publisherContext.domain] - Domain ("" if unavailable).
   *     @param {string} [options.environmentData.publisherContext.bundleId] - App bundle ID ("" if unavailable).
   *     @param {string} [options.environmentData.publisherContext.platform] - "web"|"ios"|"android"|"ctv" ("" if unknown).
   * @param {Array<string | {name: string, version?: string}>} [options.supportedFeatures=[]] - Explicit feature descriptors this container supports.
   *   Accepts either plain feature name strings or descriptor objects; extra descriptor metadata is tolerated but ignored by the creative's built-in feature lookup.
   *   In practice, pass extensions instead — each extension contributes its feature name automatically. If creatives need descriptor metadata like `version`, pass descriptor objects explicitly.
   * @param {Object[]} [options.extensions=[]] - Extension plugin objects (e.g. OmidCompatBridge, MRAIDCompatBridge).
   *   Each extension may implement:
   *     - `getFeatureName()` → string  — added to supportedFeatures in Container:init
   *     - `injectIntoMarkup(html)` → string — called before iframe load to inject scripts into creative HTML
   *       (Creative Markup variant only — the URL variant never injects)
   *     - `onContainerLifecycleEvent(event)` — called with generic container
   *       lifecycle events (`load`, `stateChange`, `placementChange`, `close`,
   *       `error`, `destroy`) for extension-owned infrastructure
   *     - `onContainerStateChange(newState, previousState, container)` —
   *       backwards-compatible state-only hook
   *     - `destroy()` — called when the container is terminated
   * @param {Object} [options.timeouts] - Override default timeout values.
   * @param {Function} [options.onStateChange] - Called with (newState, previousState) on transition.
   * @param {Function} [options.onClose] - Called when the container has fully closed.
   * @param {Function} [options.onError] - Called with (errorCode, errorMessage) on fatal errors.
   * @param {Function} [options.onNavigation] - Observation-only hook called with
   *   (navigationArgs) when creative requests navigation. Return value is ignored.
   * @param {Function} [options.onOrientationProperties] - Observation-only hook called with
   *   ({forceOrientation, allowOrientationChange}) when the creative calls
   *   mraid.setOrientationProperties(), so a host SDK can drive the device orientation lock.
   *   Observation-only; thrown errors are swallowed. Omit for the default (no-op) behaviour.
   * @param {Function} [options.onInteraction] - Called with (trackingUris) when creative reports interaction.
   * @param {Function} [options.onMessage] - Called with every received message (for debugging/logging).
   * @param {Function} [options.onPlacementChange] - Native-host hook called on every placement
   *   change (expand, fullscreen, resize, collapse) with an object carrying the resolved intent, the
   *   post-change placementUpdate, and the requested targetPosition, so a host SDK that reparents the
   *   container WebView can react. `targetPosition` is creative-supplied (untrusted) and is `null`
   *   when coordinates are non-finite or the change is not a resize. Pairs with the
   *   setHostScreenOffset() instance method for screen-relative MRAID position reporting.
   *   Observation-only; thrown errors are swallowed. Omit for the default behaviour.
   * @param {boolean} [options.hostOwnsClamping=false] - When `true`, the host SDK owns on-screen
   *   positioning and viewport clamping. Both the viewport offscreen-reject and the close-region
   *   clamp are skipped, and the resized iframe is pinned at `(0,0)`. Set this alongside
   *   `onPlacementChange` when the host actually reparents the WebView; leave it `false` (the
   *   default) if you wire `onPlacementChange` purely as an observer.
   * @param {boolean} [options.autoStart=true] - If true, calls startCreative automatically after init resolves.
   * @param {boolean} [options.visible=false] - Initial iframe visibility. Set to false to preload silently.
   * @param {Object} [options.placementPolicy] - Placement-policy object that constrains creative-driven
   *   placement requests (resize / expand / fullscreen / collapse). When provided, requestPlacementChange
   *   args are validated against allowed intents, dimension limits, and close-region requirements before
   *   any DOM mutation. When omitted, placement requests bypass policy validation entirely.
   * @param {Object} [options.closeButtonStyles] - CSS overrides for the auto-rendered close button.
   *   Keys map to the close button element's style properties (e.g. `top`, `right`, `width`).
   * @param {boolean} [options.requireSharcInit=true] - When `true` (default), the container arms the
   *   `createSession` timeout exactly as in 0.7.1: a creative that fails to handshake within
   *   `timeouts.createSession` ms fatal-errors with `ErrorCodes.NO_CREATE_SESSION` (2212). When
   *   `false`, the timeout is not armed; non-SHARC creatives (generic HTML banners, mixed inventory,
   *   validator tooling) load to a stable, queryable, terminable container instance without timing
   *   out. SHARC-aware creatives still handshake normally when this is `false` — the option only
   *   affects the missing-handshake path. Throws `TypeError` for non-boolean values (no truthy/falsy
   *   coercion). See 0.7.2 design § 2, § 13 Q1-Q4.
   */
  constructor(options = {}) {
    const {
      creativeUrl,
      creativeHtml,
      creativeRendererUrl,
      creativeRendererIntegrity,
      onSecurityEvent,
      allowPopups = true,
      allowTopNavigationByUserActivation = true,
      allowStorageAccessByUserActivation = true,
      allowModals = false,
      allowDownloads = false,
      wrapperPolicy = 'warn',
      bridges,
      creativeMeta,
      omidAutoInstall,
      placementElement,
      placementId = null,
      placementName = null,
      environmentData = {},
      supportedFeatures = [],
      extensions = [],
      timeouts = {},
      onStateChange,
      onClose,
      onError,
      onNavigation,
      onOrientationProperties,
      onInteraction,
      onMessage,
      onPlacementChange,
      hostOwnsClamping = false,
      autoStart = true,
      visible = false,
      placementPolicy,
      closeButtonStyles,
      requireSharcInit,
      creativeSdkUrl,
      creativeSdkSkipIfPresent,
      creativeSdkScriptAttrs,
    } = options;

    // ── Removed-option guard: `useMarkupInjection` (removed 2026-07-05) ──
    // The 0.7.4 opt-in fetched the creative URL's HTML and loaded it via
    // srcdoc. Removed as a pre-1.0 clean break: it violated the URL-mode
    // no-injection invariant, was known-broken for OMID (#259 B1 — srcdoc's
    // opaque origin drops targetOrigin-bound postMessage), was never
    // real-browser tested, and its consumer set (same-origin fetch) was a
    // QA topology, not delivery. Any provided value throws — no coercion,
    // no silent acceptance of the old default `false`.
    if ('useMarkupInjection' in options) {
      throw new TypeError(
        '[SHARCContainer] The `useMarkupInjection` option was removed — its '
        + 'fetch+srcdoc load path violated the URL-mode no-injection invariant '
        + 'and silently broke OMID postMessage under srcdoc\'s opaque origin. '
        + 'Load the creative URL directly (Creative URL variant) or use '
        + 'creativeHtml + creativeRendererUrl (Creative Markup variant).'
      );
    }

    // ── Legacy guard: reject old `containerEl` key ──
    if ('containerEl' in options) {
      throw new Error(
        '[SHARCContainer] The `containerEl` constructor option was renamed to `placementElement`. '
        + 'Update your instantiation to use `placementElement` instead. '
        + 'This is not backward-compatible as of 0.6.0.'
      );
    }

    const {
      placementSessionId,
      parsedRendererUrl,
      hasCreativeUrl,
      hasCreativeHtml,
      hasRendererUrl,
    } = SHARCContainer._validateCreativeSources(options, {
      window: (typeof window !== 'undefined') ? window : undefined,
    });

    if (!placementElement) throw new Error('[SHARCContainer] placementElement is required');

    // Rule 9: `bridges` is null/undefined OR an array of recognized identifier
    // strings. Stricter than the renderer-side handling because constructor
    // input is human-authored and a typo deserves a loud failure. See
    // docs/design/0.7.1-bridges-field.md § 3.1 Layer 1.
    if (bridges !== undefined && bridges !== null) {
      if (!Array.isArray(bridges)) {
        throw new TypeError(
          '[SHARCContainer] bridges must be null, undefined, or an array of '
          + 'strings (got ' + (typeof bridges) + '). Pass null/undefined to '
          + 'enable auto-detection or an array like ["mraid"] for explicit '
          + 'override.'
        );
      }
      for (let i = 0; i < bridges.length; i++) {
        const b = bridges[i];
        if (typeof b !== 'string') {
          throw new TypeError(
            '[SHARCContainer] bridges[' + i + '] must be a string '
            + '(got ' + (typeof b) + ').'
          );
        }
        if (KNOWN_BRIDGE_IDENTIFIERS.indexOf(b) === -1) {
          throw new Error(
            '[SHARCContainer] bridges[' + i + '] = ' + JSON.stringify(b)
            + ' is not a recognized bridge identifier. '
            + 'Accepted values: ' + JSON.stringify(KNOWN_BRIDGE_IDENTIFIERS) + '. '
            + 'See docs/design/0.7.1-bridges-field.md § 2 Wire-format change.'
          );
        }
      }
    }

    // Rule 10: `creativeMeta` is undefined OR a non-null object. `creativeMeta.apis`,
    // if present, must be an array of finite numbers. Unrecognized AdCOM
    // codes are silently ignored (per design § 3.2 — fall-through to layer 3).
    if (creativeMeta !== undefined && creativeMeta !== null) {
      if (typeof creativeMeta !== 'object' || Array.isArray(creativeMeta)) {
        throw new TypeError(
          '[SHARCContainer] creativeMeta must be a plain object '
          + '(got ' + (Array.isArray(creativeMeta) ? 'array' : typeof creativeMeta) + ').'
        );
      }
      if (creativeMeta.apis !== undefined && creativeMeta.apis !== null) {
        if (!Array.isArray(creativeMeta.apis)) {
          throw new TypeError(
            '[SHARCContainer] creativeMeta.apis must be an array of integers '
            + '(AdCOM APIFramework codes). Got ' + (typeof creativeMeta.apis) + '.'
          );
        }
        for (let i = 0; i < creativeMeta.apis.length; i++) {
          const code = creativeMeta.apis[i];
          if (!Number.isInteger(code)) {
            throw new TypeError(
              '[SHARCContainer] creativeMeta.apis[' + i + '] must be an integer '
              + '(AdCOM APIFramework code; got '
              + (typeof code === 'number' ? code : typeof code) + ').'
            );
          }
        }
      }
    }

    // Rule 10b: `omidAutoInstall` is undefined/null or a plain object. The
    // contents are passed through OmidCompatBridge validation only if a bid
    // actually declares OMID and supplies an OMID measurement sidecar.
    if (omidAutoInstall !== undefined && omidAutoInstall !== null) {
      if (typeof omidAutoInstall !== 'object' || Array.isArray(omidAutoInstall)) {
        throw new TypeError(
          '[SHARCContainer] omidAutoInstall must be a plain object when provided '
          + '(got ' + (Array.isArray(omidAutoInstall) ? 'array' : typeof omidAutoInstall) + ').'
        );
      }
    }

    // Rule 11: `requireSharcInit` is undefined or a boolean. Strict — no
    // truthy/falsy coercion. Mirrors the validation pattern of the `allow*`
    // boolean family (allowPopups, allowModals, etc.). See 0.7.2 design § 2
    // (Constructor option) and § 13 Q4.
    if (requireSharcInit !== undefined && typeof requireSharcInit !== 'boolean') {
      throw new TypeError(
        '[SHARCContainer] requireSharcInit must be a boolean '
        + '(got ' + (requireSharcInit === null ? 'null' : typeof requireSharcInit) + ').'
      );
    }

    // Rule 12: `creativeSdkUrl` is undefined or a non-empty string. Strict — no
    // coercion of numbers/objects/booleans. When set, the container auto-injects
    // a `<script src="...sharc-creative.js"></script>` tag into Markup-variant
    // creative HTML at load time so legacy adm (plain HTML / MRAID / SafeFrame)
    // becomes SHARC-compatible without per-creative changes. Mirrors Rule 11.
    // See 0.7.2 design § 6.3 (operator-injection pattern).
    if (creativeSdkUrl !== undefined && (typeof creativeSdkUrl !== 'string' || creativeSdkUrl.length === 0)) {
      throw new TypeError(
        '[SHARCContainer] creativeSdkUrl must be a non-empty string when provided '
        + '(got ' + (creativeSdkUrl === null ? 'null' : typeof creativeSdkUrl) + ').'
      );
    }

    // Rule 13: `hostOwnsClamping` is undefined or a boolean. Strict — no
    // truthy/falsy coercion. This is the L1 safety gate that disables the
    // viewport offscreen-reject, the close-region clamp, and pins resize
    // placement to (0,0); coercing e.g. the string "false" to true would
    // silently open the bypass. Mirrors Rule 11 (requireSharcInit).
    if (hostOwnsClamping !== undefined && typeof hostOwnsClamping !== 'boolean') {
      throw new TypeError(
        '[SHARCContainer] hostOwnsClamping must be a boolean '
        + '(got ' + (hostOwnsClamping === null ? 'null' : typeof hostOwnsClamping) + ').'
      );
    }

    // ── Synchronous isolation guard (proposal Part 7) ──
    // Throws at construction — before any iframe, MessageChannel, or page
    // lifecycle listener is created — if the placement element is already
    // owned by another SHARCContainer.
    if (placementElement.classList.contains('sharc-placement')) {
      const otherId = placementElement.getAttribute('data-sharc-placement-session-id') || 'unknown';
      throw new Error(
        '[SHARCContainer] This placement element is already owned by another SHARC instance '
        + '(data-sharc-placement-session-id="' + otherId + '"). '
        + 'Create a new SHARCContainer with a different element, or call close() on the existing instance first.'
      );
    }

    /**
     * URL of the SHARC-enabled creative HTML when running in Creative URL variant.
     * `null` when running in Creative Markup variant — see `creativeSource`.
     * @type {string|null}
     */
    this.creativeUrl = hasCreativeUrl ? creativeUrl : null;

    /**
     * Inline HTML markup when running in Creative Markup variant.
     * `null` when running in Creative URL variant. Pre-injection markup as supplied
     * by the operator (extension `injectIntoMarkup` hooks run later, in the load
     * path). Not surfaced as a public field per DD-1 — exposed here as a private
     * field for the renderer-protocol implementation in Phase B.
     * @type {string|null}
     * @private
     */
    this._creativeHtml = hasCreativeHtml ? creativeHtml : null;

    /**
     * HTTPS URL of the operator-hosted renderer page in Creative Markup variant.
     * `null` when running in Creative URL variant. Validated at construction
     * (rules 4–7); the actual iframe load lands in Phase B; post-load origin
     * echo lands in Phase C.
     * @type {string|null}
     */
    this.creativeRendererUrl = hasRendererUrl ? creativeRendererUrl : null;

    /**
     * Optional SRI-style SHA-384 digest for the Creative Markup renderer
     * document. When set, `_createIframe()` verifies renderer bytes before
     * assigning `iframe.src`; on mismatch the container terminates with
     * RENDERER_INTEGRITY_FAIL and never sends `SHARC:Renderer:render`.
     *
     * This is a best-effort preflight, not native iframe SRI. Browsers do not
     * support `integrity=` on iframes, so the navigation still happens via
     * normal `iframe.src` after the fetch check passes. Operators should use
     * immutable renderer URLs, allow publisher-side CORS fetches, and treat
     * this as defense in depth.
     *
     * @type {string|null}
     * @private
     */
    this._creativeRendererIntegrity = hasCreativeHtml && creativeRendererIntegrity !== undefined
      ? creativeRendererIntegrity
      : null;

    /**
     * Construction-time-derived renderer origin (`parsedRendererUrl.origin`,
     * sans fragment). Used as `targetOrigin` for the `SHARC:Renderer:render`
     * postMessage and as the envelope-validation origin on the renderer's
     * `:rendered` reply. `null` in Creative URL variant. Frozen at construction
     * so a post-load redirect cannot retroactively widen the trust boundary —
     * Phase C will additionally validate the renderer-supplied `rendererOrigin`
     * field on the `:rendered` reply against this value (post-load origin echo).
     * @type {string|null}
     * @private
     */
    this._rendererOrigin = parsedRendererUrl ? parsedRendererUrl.origin : null;

    /**
     * Root CSPRNG nonce assigned synchronously below in the constructor (it
     * is used as the HMAC-SHA-256 key for the 0.7.7 protocol-router's
     * per-protocol nonce derivation, so it must exist before
     * `this.protocolRouter` is constructed). Distinct from
     * {@link _rendererProtocolNonce}: this root nonce never appears on the
     * wire and is never delivered to any extension. The renderer protocol's
     * wire-level `sharcNonce` is the derived nonce, not this one.
     *
     * @type {string|null}
     * @private
     */
    this._sharcNonce = null;

    /**
     * Per-protocol nonce for the renderer protocol — set by the protocol
     * router's `onReady({protocolNonce})` callback after the HMAC-SHA-256
     * derivation completes. Used as the renderer-URL fragment value and as
     * the `sharcNonce` field on outbound `SHARC:Renderer:render` envelopes.
     * `null` until derivation resolves (and in the Creative URL variant,
     * where the renderer protocol is not registered).
     *
     * @type {string|null}
     * @private
     */
    this._rendererProtocolNonce = null;

    /**
     * Active payload variant: `'url'` for Creative URL, `'html'` for Creative Markup.
     * Stable across the container's lifetime. See proposal § Metadata and Observability.
     * @type {'url'|'html'}
     */
    this.creativeSource = hasCreativeHtml ? 'html' : 'url';

    /**
     * Frozen array of bridge identifiers the renderer will load alongside the
     * creative. Resolved at construction via the three-layer detection
     * pipeline (explicit `bridges` option → `creativeMeta.apis` AdCOM codes → adm
     * content scan); see `_resolveBridges()`. Always `[]` in Creative URL
     * variant — the renderer protocol is Markup-only. Reflected verbatim on
     * the `bridges` field of the outgoing `SHARC:Renderer:render` message.
     *
     * Diagnostic surface for operators correlating "this `placementSessionId`
     * had MRAID bridge loaded" without re-running the detection. See design
     * doc § 6 / § 13 Q6.
     *
     * @type {ReadonlyArray<string>}
     */
    this.bridges = Object.freeze(
      hasCreativeHtml
        ? SHARCContainer._resolveBridges({
            bridges: bridges,
            creativeMeta: creativeMeta,
            creativeHtml: creativeHtml,
          })
        : []
    );

    /**
     * Whether the container enforces the SHARC `createSession` handshake.
     * `true` (default) arms the 5 s `createSession` fatal-timeout in `load()`,
     * matching 0.7.1 behavior. `false` skips the timeout so non-SHARC
     * creatives can load to a stable container instance without fatal-erroring
     * on the missing handshake. See 0.7.2 design § 2 + § 4. Strictly typed —
     * Rule 11 throws `TypeError` for any non-boolean value (including `null`,
     * `0`, strings).
     * @type {boolean}
     * @private
     */
    this._requireSharcInit = requireSharcInit === undefined ? true : requireSharcInit;

    /**
     * Operator-hosted `sharc-creative.js` URL. When set, the container auto-injects
     * a `<script src="...">` tag at the top of Markup-variant creative HTML so
     * legacy adm (plain HTML / MRAID / SafeFrame) becomes SHARC-compatible without
     * per-creative changes. `null` when omitted (no injection). See 0.7.2 design § 6.3.
     * @type {string | null}
     * @private
     */
    // 0.7.4 (#106): store `creativeSdkUrl` on BOTH variants. On the URL
    // variant it is a permanent no-op — the URL variant always loads via
    // `iframe.src` and never injects (the `useMarkupInjection` fetch+srcdoc
    // opt-in was removed 2026-07-05). The 0.7.2 PR 4.1 round-1
    // capability-lie concern (advertising
    // `com.iabtechlab.sharc.creative-injector` on a URL container that
    // couldn't inject) stays closed by the `_creativeSdkInjected` runtime
    // flag below — the feature is only advertised when injection actually
    // ran. See 0.7.4 design § 2.1.
    this._creativeSdkUrl = creativeSdkUrl !== undefined ? creativeSdkUrl : null;

    /**
     * Runtime flag — `true` once the built-in `_injectCreativeSdk` has
     * actually mutated the markup. Gates the
     * `com.iabtechlab.sharc.creative-injector` entry in the
     * supportedFeatures merge so the feature is advertised only when
     * injection actually ran (no capability lie).
     *
     * - Markup variant: set synchronously at construction when
     *   `_creativeSdkUrl !== null` (Markup ALWAYS injects from
     *   `_runMarkupInjection` before the iframe `load` event delivers the
     *   creative to the renderer).
     * - URL variant: always `false` — the URL variant never injects (the
     *   `useMarkupInjection` fetch+srcdoc opt-in was removed 2026-07-05).
     *
     * Distinct from the public `creativeInjected` flag, which tracks any
     * injection (built-in OR operator extensions). This flag is
     * built-in-only and is the merge gate.
     * @type {boolean}
     * @private
     */
    this._creativeSdkInjected = (
      this._creativeSdkUrl !== null && hasCreativeHtml
    );

    /**
     * Idempotency guard for the built-in SDK injection. When `true` (default), markup
     * already containing a `<script src="...sharc-creative.js">` tag passes through
     * unchanged. Set `false` to force-inject (versioned-SDK coexistence test, etc.).
     * No-op when `creativeSdkUrl` is unset. See 0.7.2 design § 6.3.
     * @type {boolean}
     * @private
     */
    this._creativeSdkSkipIfPresent = creativeSdkSkipIfPresent !== false;

    /**
     * Additional `<script>` attributes for the auto-injected SDK tag. Defaults to
     * `{}` — a bare `<script src="...">` (parser-blocking, synchronous), which is
     * the ONLY attribute set that prevents the inline-`mraid.*` race condition for
     * MRAID creatives. Operators with fully event-driven pipelines can pass
     * `{ async: true }`, `{ defer: true }`, `{ integrity: 'sha384-...' }`, etc.
     * Booleans render as bare attrs (`true`) or omit (`false`/`null`/`undefined`);
     * strings render quoted with HTML-escaping. See 0.7.2 design § 6.3.
     * @type {Object}
     * @private
     */
    this._creativeSdkScriptAttrs = (creativeSdkScriptAttrs && typeof creativeSdkScriptAttrs === 'object')
      ? creativeSdkScriptAttrs
      : {};

    /**
     * AdCOM `APIFramework` integer code for the declared container runtime,
     * resolved at construction via the three-layer picker (§ 6.1). `null` when
     * no recognized container-runtime code is declared (or Creative URL
     * variant — `creativeMeta` is Markup-only per Rule 3b). Picker recognizes
     * SHARC, MRAID, SafeFrame; OMID (7) is excluded (measurement, not
     * container runtime); VPAID (1, 2) and SIMID (8, 9) are not picker
     * targets (video-creative protocols).
     *
     * G10 invariant: locked as non-writable + non-configurable below. Neither
     * external code (`container._apiFramework = X`) nor internal code paths
     * (G7 warn read, future feature work) can mutate the value after
     * construction. The public `container.apiFramework` getter reads through
     * to this locked field and is itself non-configurable. See 0.7.2 design
     * § 6 + § 9 G10.
     * @type {number | null}
     * @private
     */
    // Initial assignment establishes the type for TS inference; the
    // immediately-following defineProperty converts the property to
    // locked (non-writable + non-configurable) data semantics. Same shape
    // for both the private `_apiFramework` backing field and the public
    // `apiFramework` accessor — the public form is also assigned so TS
    // picks it up as a class member in the generated .d.ts.
    this._apiFramework = hasCreativeHtml
      ? SHARCContainer._resolveApiFramework(creativeMeta)
      : null;
    Object.defineProperty(this, '_apiFramework', {
      value: this._apiFramework,
      writable: false,
      configurable: false,
      enumerable: false,
    });

    /**
     * AdCOM `APIFramework` integer code for the declared container runtime
     * (per AdCOM v1.0 `APIFramework` list). `null` when no recognized
     * container-runtime code is declared, or when the container is in
     * Creative URL variant (Rule 3b — `creativeMeta` is Markup-only).
     *
     * Frozen at construction (G10): non-writable + non-configurable.
     * Assignment is a no-op in sloppy mode and throws in strict; the
     * accessor cannot be redefined or deleted.
     *
     * Companion to {@link hasSharcSession} — declaration-driven (immediate,
     * frozen) vs. outcome-driven (asynchronous, post-handshake). See 0.7.2
     * design § 6 + § 7.2 + § 9 G10.
     *
     * @type {number | null}
     */
    this.apiFramework = this._apiFramework;
    Object.defineProperty(this, 'apiFramework', {
      value: this._apiFramework,
      writable: false,
      configurable: false,
      enumerable: true,
    });

    /**
     * `true` if injection ran and at least one injector returned a non-empty
     * modified string. Set by the load path; initialized `false` at construction.
     * @type {boolean}
     */
    this.creativeInjected = false;

    /**
     * `true` once the Creative Markup renderer protocol has successfully
     * delivered the creative to the renderer iframe (i.e. the renderer's
     * envelope-validated `SHARC:Renderer:rendered` reply has arrived).
     * `false` for Creative URL in all states; `false` for Creative Markup
     * until the renderer protocol completes. The variant in use is reflected
     * by `creativeSource`, not by this flag.
     * @type {boolean}
     */
    this.creativeRendered = false;

    // ── Slice C — effective-visibility composer state ────────────────────────
    // All composer fields are declared (and axis-2 SEEDED) here so the composer
    // never reads an undefined field: `visibilitychange` does not fire on a
    // plain load, so an event-handler-only write would leave a fully-visible
    // rendered ad composing to 0/'backgrounded' (review F1 blocker). The render
    // anchor is `creativeRendered` above — the composer reads it directly.

    /**
     * Axis-3 raw input — last un-thresholded IntersectionObserver ratio (0..1)
     * surfaced by the lifecycle adapter. 0 until the first IO callback.
     * @type {number}
     * @private
     */
    this._rawIntersection = 0;

    /**
     * Axis-2 raw input — parent-page visibility boolean. Seeded from the REAL
     * `document.visibilityState` (visibilitychange never fires on initial
     * load); default-visible in non-browser environments.
     * @type {boolean}
     * @private
     */
    this._rawParentVisible = (typeof document !== 'undefined' && document.visibilityState)
      ? document.visibilityState === 'visible'
      : true;

    /**
     * In-app host-exposure INPUT (L1 axis-3), percent [0,100]. `null` = no host
     * override — the in-page IO ratio is authoritative (host-wins when set).
     * @type {number|null}
     * @private
     */
    this._hostExposure = null;

    /**
     * Axis-2 sub-state — `true` between Page Lifecycle freeze and resume,
     * driving the `frozen` (vs `backgrounded`) reason.
     * @type {boolean}
     * @private
     */
    this._frozen = false;

    /**
     * Last payload sent on the effectiveVisibilityChange channel — the dedup
     * comparand (INV-1/2/3 analogue) and the replay-of-last cache seed.
     * `undefined` until the first post-session push.
     * @type {{effectivePercent:number, reason:(string|null), visibleRectangle:(Object|null)}|undefined}
     * @private
     */
    this._lastEffectivePayload = undefined;

    /**
     * Last payload delivered on the container-side EXTENSION fan-out (Slice D,
     * PR #413). Separate from the wire's `_lastEffectivePayload` on purpose:
     * the extension fan-out fires regardless of the wire session (a sessionless
     * embed is still measurable by OMID), so a sessionless compose must dedup
     * against its own cache — never seed the wire cache, or the first
     * post-handshake wire push would be suppressed as a duplicate of a value
     * the creative never received.
     * @type {{effectivePercent:number, reason:(string|null), visibleRectangle:(Object|null)}|undefined}
     * @private
     */
    this._lastExtensionEffectivePayload = undefined;

    /** @type {HTMLElement} */
    this.placementElement = placementElement;

    /**
     * Publisher-supplied placement identifier (optional — null when not provided).
     * Distinct from the runtime-generated {@link placementSessionId}.
     * @type {string|null}
     */
    this.placementId = placementId === '' ? null : placementId;

    /**
     * Human-readable placement name (optional — null when not provided).
     * @type {string|null}
     */
    this.placementName = placementName === '' ? null : placementName;

    /**
     * UUID v4 generated at construction time. Unique per SHARCContainer instance.
     * Used for DOM stamping, iframe identification, and diagnostics.
     * Generated above the validation block so any construction-time security
     * event (e.g. wrapper-cross-origin carve-out) carries the same correlation
     * ID as the running container.
     * @type {string}
     */
    // #240: structural-immutability tripwire. `placementSessionId` is the
    // per-impression identifier and the per-protocol nonce salt (router § 5.2);
    // a silent mutation would desynchronize the router's expected nonces from
    // every shim's injected nonce. Define a throwing setter so any future plain
    // assignment fails LOUD rather than silently corrupting the trust boundary.
    // The sanctioned re-mint path (PR 3 / RTR-D21 — deferred) will mutate the
    // backing field `_placementSessionId` directly and call
    // `protocolRouter.rederiveAllProtocolNonces()`; that machinery is NOT in
    // this PR. The guard ships now alongside the OMID bridge core.
    this._placementSessionId = placementSessionId;
    // Declare the property for the type checker (it infers instance shape from
    // `this.X =` assignments), then immediately install the throwing-setter
    // guard over the freshly-assigned (configurable) data property.
    this.placementSessionId = placementSessionId;
    Object.defineProperty(this, 'placementSessionId', {
      configurable: false,
      enumerable: true,
      get() { return this._placementSessionId; },
      set(_value) {
        throw new TypeError(
          '[SHARCContainer] placementSessionId is immutable — direct assignment '
          + 'is forbidden. Use the sanctioned re-mint API (which re-derives all '
          + 'per-protocol nonces) to advance the per-impression session.'
        );
      },
    });

    /** @type {Object} */
    this.environmentData = environmentData;

    // Auto-derive publisherContext from browser APIs if not explicitly provided
    if (!this.environmentData.publisherContext) {
      this.environmentData.publisherContext = SHARCContainer._derivePublisherContext();
    }

    // 0.7.7 protocol router (see docs/design/0.7.7-cross-frame-protocol-router.md).
    // The renderer protocol must be registered before any extension lifecycle
    // hook fires — so the router is constructed AND the renderer prefix is
    // taken before `_resolveExtensions(...)` below and before
    // `_notifyExtensionsLifecycle(...)` runs in `load()`. Throws synchronously
    // if `crypto.subtle` is unavailable (non-secure context — RTR-D22).
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      throw new Error(
        '[SHARCContainer] crypto.randomUUID() is unavailable; cannot mint root nonce. '
        + 'SHARC requires a secure context (HTTPS or localhost).'
      );
    }
    this._sharcNonce = crypto.randomUUID();
    /**
     * Cross-frame protocol router. Owns the single publisher-side `window`
     * `message` listener for all SHARC protocols. Extensions reach it via
     * `event.container.protocolRouter` on their `onContainerLifecycleEvent`
     * hook. See `docs/design/0.7.7-cross-frame-protocol-router.md`.
     *
     * @type {SHARCProtocolRouter}
     */
    this.protocolRouter = new SHARCProtocolRouter({
      container: this,
      iframe: () => this._iframe,
      expectedRendererOrigin: () => this._rendererOrigin,
      expectedPlacementSessionId: () => this.placementSessionId,
      rootNonce: this._sharcNonce,
      onUnauthorizedProtocol: (payload) => this._invokeSecurityCallback(payload),
      initialPhase: 'init',
    });

    if (hasCreativeHtml) {
      this.protocolRouter.register({
        prefix: 'SHARC:Renderer:',
        types: {
          // `rendered` is accepted in `attaching-renderer` (the first render)
          // AND in the post-render phases — a document.open self-rewrite
          // (ADR 2026-06-13-document-open-shim-mechanism.md) re-anchors a
          // nonce-authenticated `:rendered` off the reopened document's `window
          // 'load'`. The router gate (step 7, nonce match) is what makes the
          // post-render acceptance safe: ONLY a renderer-provisioned prelude
          // holds the gen-0 nonce, so a real cross-document navigation (no
          // prelude, no nonce) can never forge a post-render `:rendered` —
          // 2118 still keys on navigation, not harness-silence (SE condition
          // C3). The first `:rendered` runs the full handshake; a subsequent
          // one re-anchors the reopened generation's SDK over the SURVIVING
          // port (`_onRendererReopened`; no re-transfer, ADR 2026-06-15).
          //
          // ADR 2026-06-15 § CRITICAL SEAM: `loadAck`/`loadProbe` are NO LONGER
          // router (window-message) types. The load-probe round-trip is carried
          // exclusively over the bootstrap MessageChannel: the Container posts
          // `SHARC:Container:loadProbe` over `port1` and the renderer answers
          // `SHARC:Creative:loadAck` over the surviving `port2`. Authentication
          // is the ack's ARRIVAL on `port1` (possession) + the strict
          // probeId/temporal gate in `_dispatchRendererLoadAck`, reachable ONLY
          // via the captured-native `port1` listener (`_bindProbePort`). Keeping
          // a window-routed `loadAck` type would re-open a parallel entry to the
          // gate the SE flagged — so it is removed entirely.
          'rendered':  { phases: ['attaching-renderer', 'rendered', 'creative-active', 'omid-active', 'omid-finishing'], direction: 'inbound' },
          'failed':    { phases: ['attaching-renderer'], direction: 'inbound' },
          'render':    { phases: ['attaching-renderer'], direction: 'outbound' },
        },
        handler: this._handleRendererEnvelope.bind(this),
        onReady: ({ protocolNonce }) => {
          this._rendererProtocolNonce = protocolNonce;
        },
      });
    }

    /**
     * Extension plugin instances.
     * Each may contribute a feature name, inject markup, and/or require cleanup.
     * @type {Array}
     * @private
     */
    this._extensions = SHARCContainer._resolveExtensions({
      extensions: extensions,
      creativeMeta: creativeMeta,
      omidAutoInstall: omidAutoInstall,
    });

    /**
     * Explicit supportedFeatures passed directly by the caller.
     * Accepts either plain feature name strings or descriptor objects.
     * Extension-contributed features are merged in at session time, but only as feature names.
     * @type {Array<string | {name: string, version?: string}>}
     * @private
     */
    this._explicitSupportedFeatures = supportedFeatures;

    /** @type {Object} */
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };

    /** @type {boolean} */
    this.autoStart = autoStart;

    /** @private */ this._onStateChange = onStateChange || null;
    /** @private */ this._onClose = onClose || null;
    /** @private */ this._onError = onError || null;
    /** @private */ this._onNavigation = onNavigation || null;
    /**
     * Native-host orientation-properties hook. Called when the creative drives
     * mraid.setOrientationProperties() so an embedding SDK can lock/force the
     * device orientation. null when no host wires it (the default; stock embeds
     * are unaffected).
     * @private
     */
    this._onOrientationProperties = onOrientationProperties || null;
    /** @private */ this._onInteraction = onInteraction || null;
    /** @private */ this._onMessage = onMessage || null;
    /**
     * Native-host placement-change hook. Fired from notifyPlacementChange with the
     * resolved intent + geometry so an embedding native SDK can react to placement
     * transitions — e.g. reparent the container WebView onto a full-screen / resized
     * surface when the creative drives mraid.expand()/resize()/close(). The container
     * runs in the host page and can reach the host SDK, unlike the cross-origin,
     * sandboxed creative iframe, so this is the host's only seam onto placement changes.
     * null when no host wires it (the default; stock embeds are unaffected).
     * @private
     */
    this._onPlacementChange = onPlacementChange || null;
    /**
     * Native-host on-screen offset for the container WebView. SHARC measures geometry
     * WebView-relative (the iframe fills the host's slot at 0,0), so without this
     * getCurrentPosition()/getDefaultPosition() report x:0,y:0. Only the native layer
     * knows the WebView's on-screen rect; it pushes that origin via setHostScreenOffset()
     * after layout. {x,y} in CSS px, screen/max-area relative. null until a host calls the
     * setter (the default), so every offset-guarded branch falls through to the original
     * path unchanged.
     * @private
     */
    this._hostScreenOffset = null;
    /**
     * True when the host SDK owns on-screen positioning and viewport clamping.
     * Skips the offscreen-reject (both policy and no-policy paths) and the
     * close-region clamp, and pins the resized iframe at (0,0).
     * Set via the `hostOwnsClamping` constructor option, which is strictly
     * validated to a boolean (Rule 13) — only literal `true` enables the gate.
     * Fail-closed: undefined/omitted → false, so embeds that wire
     * `onPlacementChange` purely as observers keep normal clamping. No truthy
     * coercion on this safety-affecting flag.
     * @private
     */
    this._hostOwnsClamping = hostOwnsClamping === true;
    /**
     * Structured-event observability hook. Wired by Phase A for the
     * construction-time `wrapper_top_frame_inaccessible` carve-out and by
     * Phase D for all renderer-protocol terminating events
     * (`renderer_origin_mismatch`, `renderer_failed`, `renderer_protocol_error`,
     * `unauthorized_navigation`). Renderer events flow through
     * `_emitSecurityEventAndTerminate` which fires the callback BEFORE
     * `onError` per spec § Security Model line 734.
     * @private
     */
    this._onSecurityEvent = (typeof onSecurityEvent === 'function') ? onSecurityEvent : null;

    /**
     * Sandbox / policy configuration captured at construction. Consumed by
     * `_buildSandboxAttribute()` during Markup-variant iframe construction.
     * See proposal § Iframe sandbox.
     * @type {{
     *   allowPopups: boolean,
     *   allowTopNavigationByUserActivation: boolean,
     *   allowStorageAccessByUserActivation: boolean,
     *   allowModals: boolean,
     *   allowDownloads: boolean,
     *   wrapperPolicy: 'warn'|'block'
     * }}
     * @private
     */
    // Asymmetric coercion intentional, mirrors the configuration philosophy in
    // the proposal (DD-19/20/22 vs DD-23/25): click-through-or-measurement
    // load-bearing tokens default permissive — only literal `false` opts out
    // (`!== false`); UX-disruption-surface tokens default strict — only literal
    // `true` opts in (`=== true`). Documented contract types these as boolean;
    // operators passing other values (0, null, '') get the documented default,
    // not a nuanced coercion.
    this._sandboxConfig = {
      allowPopups: allowPopups !== false,
      allowTopNavigationByUserActivation: allowTopNavigationByUserActivation !== false,
      allowStorageAccessByUserActivation: allowStorageAccessByUserActivation !== false,
      allowModals: allowModals === true,
      allowDownloads: allowDownloads === true,
      wrapperPolicy: wrapperPolicy === 'block' ? 'block' : 'warn',
    };

    /** @type {HTMLIFrameElement|null} @private */
    this._iframe = null;

    /**
     * Load-event navigation backstop. Attached AFTER the iframe's "render
     * anchor" load is observed:
     *   - Markup variant: armed in `_onRendererRendered()` after the
     *     envelope-validated `:rendered` arrives (Phase D, deliverable 1).
     *   - Creative URL variant: armed in the iframe `load` listener in
     *     `_createIframe()` after the first (and only-expected) load
     *     fires (Phase E, deliverable 1).
     *
     * Any subsequent iframe `load` event means the iframe document
     * navigated to a new URL outside the SHARC protocol path — terminate
     * with `RENDERER_UNAUTHORIZED_NAVIGATION (2118)`.
     *
     * This is the universal backstop described by the spec § Click-through
     * audit and policy boundary — defense-in-depth against creatives that
     * bypass the in-renderer navigation bridge by re-overriding `window.open`,
     * redefining `location` getters, etc. Same-document navigations (pushState,
     * hash changes) do NOT fire `load`; only cross-document navigations do.
     *
     * Detached in `_terminate()`. Variant-agnostic — same handler shape
     * for both Markup and Creative URL.
     *
     * @type {((event: Event) => void) | null}
     * @private
     */
    this._rendererBackstopHandler = null;

    /**
     * Timer id for the controlled-context probe deadline armed by `runGate`
     * inside `_armRendererBackstop`. Hoisted to an instance field (rather than
     * living only in `runGate`'s closure) so a probe still outstanding when an
     * unrelated external termination disarms the backstop can be cleared from
     * `_disarmRendererBackstop`. The timeout callback is `_terminated`-guarded,
     * so a survivor is inert — this is lifecycle tidiness, not a fix for a live
     * behavior bug. `null` when no probe is pending.
     *
     * @type {ReturnType<typeof setTimeout> | null}
     * @private
     */
    this._rendererProbeTimeoutId = null;

    /**
     * Per-probe-cycle single-consume latch for the renderer `:loadAck`. Phase 1
     * (#321) gates EVERY post-render load, so `runGate` arms a fresh probe per
     * load and resets this latch to `false` at the start of each cycle. Within
     * a single cycle the probe accepts exactly ONE `loadAck` — the reply to that
     * cycle's `loadProbe`; `_dispatchRendererLoadAck` flips this `true` the
     * instant it resolves the pending probe and refuses every further `loadAck`
     * for the rest of that cycle. This makes the single-consume property an
     * explicit, enforced invariant rather than an emergent side effect of
     * `_pendingLoadProbe` happening to be null after the ack.
     *
     * This latch is intentionally NOT the cross-cycle authenticity guard. An
     * ack from a prior or unrelated cycle is rejected upstream by the router's
     * nonce/origin/source/placementSessionId gate before it ever reaches the
     * handler — that gate, not this per-cycle latch, is what defends against a
     * forged, replayed, or stale `loadAck` re-resolving a probe (#269). The
     * renderer nonce is already hidden from creative code (#254); the latch only
     * closes the within-cycle double-consume gap.
     *
     * @type {boolean}
     * @private
     */
    this._loadAckConsumed = false;

    /**
     * Strict ack-gating state for the port-authenticated load-probe (ADR
     * 2026-06-15 § Ratified SE conditions, condition 1). `runGate` mints a
     * CSPRNG `probeId` per cycle and records the issue timestamp; a `loadAck`
     * is accepted by `_dispatchRendererLoadAck` ONLY if it bears the currently-
     * armed `probeId`, arrived strictly after the probe was issued, and is the
     * single ack consumed for that id. `null` when no probe is armed.
     *
     * This is the replacement for the retired router nonce gate on this path:
     * authentication is the ack's ARRIVAL on `port1` (possession), and the
     * `probeId` + temporal binding is what rejects stale/pre-computed/replayed
     * acks. The `probeId` is a non-secret correlator, never an authenticator.
     * @type {string | null}
     * @private
     */
    this._armedProbeId = null;

    /**
     * `performance.now()` (monotonic, immune to wall-clock skew) captured at the
     * instant `runGate` issues the load-probe. A `loadAck` observed at or before
     * this timestamp is a pre-computed/in-flight ack that outlived a prior
     * realm's teardown and is rejected (temporal binding). `null` when no probe
     * is armed. ADR 2026-06-15 § Ratified SE conditions, condition 1(b).
     * @type {number | null}
     * @private
     */
    this._armedProbeIssuedAt = null;

    /**
     * The container's `port1` end of the bootstrap MessageChannel, captured so
     * the load-probe gate can send `:loadProbe` over it and receive `:loadAck`
     * over it (ADR 2026-06-15 — authenticate by port possession). Bound by
     * `_bindProbePort()` after the first `initChannel`. The renderer IIFE holds
     * the matching `port2`. `null` until the channel exists.
     * @type {MessagePort|null}
     * @private
     */
    this._probePort = null;

    /**
     * Captured-native `message` listener bound on `_probePort` for `:loadAck`
     * dispatch. Kept for detach on terminate. `null` until bound.
     * @type {((event: MessageEvent) => void)|null}
     * @private
     */
    this._probePortHandler = null;

    /**
     * document.open self-rewrite reopen discriminator. Set by the renderer
     * backstop on every post-render iframe-element `load` (a reopen fires one,
     * per the C6 diagnostic); consumed when a post-render `:rendered` is
     * accepted as a reopen re-anchor. Gates `_onRendererReopened` so a bare
     * REPLAYED `:rendered` (no intervening reopen, no new load) is still
     * rejected as out-of-phase — preserving the S1 replay defense (RTR-D15)
     * while admitting the legitimate document.open re-anchor.
     * @type {boolean}
     * @private
     */
    this._postRenderLoadSinceRendered = false;

    /**
     * Wall-clock timestamp (`Date.now()`) at the moment the "render anchor"
     * event was observed and accepted:
     *   - Markup variant: `:rendered` envelope accept (in
     *     `_onRendererRendered()`).
     *   - Creative URL variant: initial iframe `load` (in `_createIframe()`).
     *
     * Used by `_armRendererBackstop()` to compute `details.msSinceRender`
     * on the 2118 `UnauthorizedNavigationEvent`. `null` until the render-
     * anchor event fires. Phase D round-4 SRE HIGH-1; widened in Phase E
     * to cover the Creative URL render-anchor.
     *
     * @type {number | null}
     * @private
     */
    this._renderedAt = null;

    /**
     * Snapshot of `placementElement.getAttribute('class')` taken in
     * `_attachToPlacement()`, before SHARC adds the `sharc-placement` class.
     * `null` means the attribute was absent on the publisher's element.
     * Restored verbatim (or removed) by `_detachFromPlacement()` so the
     * post-`close()` element matches the pre-`load()` element byte-for-byte.
     * @type {string|null}
     * @private
     */
    this._originalClassAttr = null;

    /**
     * Snapshot of `placementElement.getAttribute('style')` taken in
     * `_attachToPlacement()`, before SHARC mutates any inline style.
     * `null` means the attribute was absent on the publisher's element
     * (vs. an empty string, which means the attribute was present but empty).
     * Backs the proposal's "load-bearing cleanup contract."
     * @type {string|null}
     * @private
     */
    this._originalStyleAttr = null;

    /** @type {SHARCContainerProtocol} @private */
    this._protocol = new SHARCContainerProtocol();

    /** @type {SHARCStateMachine} @private */
    this._stateMachine = new SHARCStateMachine(ContainerStates.LOADING);

    /**
     * Lifecycle adapter instance — populated in `load()` via
     * {@link SHARCContainer._selectLifecycleAdapter}. Drives state
     * transitions from browser-native (and in 0.7.3, framework-specific)
     * signals when no SHARC handshake is available. Detached in
     * `_terminate()`. See 0.7.2 design § 8.
     * @type {?import('./lifecycle-adapters/base-adapter.js').BaseLifecycleAdapter}
     * @private
     */
    this._lifecycleAdapter = null;

    /** Active timeout handles (for cleanup). @type {Object.<string,number>} @private */
    this._timeouts = {};

    /** Whether a close has been requested. @type {boolean} @private */
    this._closeRequested = false;

    /** Whether _terminate() has already been called. @type {boolean} @private */
    this._terminated = false;

    /**
     * Whether the protocol router has been torn down inside `_terminate()`.
     * `_terminate()` drains the OMID terminal `sessionFinish` (which drives the
     * router into `omid-finishing`, Risk R1) BEFORE the router teardown, so the
     * `_terminated` flag alone cannot gate the in-terminate `omid-finishing`
     * transition — it is already `true` during the drain. Gate that transition
     * on router liveness instead: allow it while the router is alive, reject any
     * straggler once the router has been destroyed (#337).
     * @type {boolean} @private
     */
    this._routerTorndown = false;

    // Wire up state machine → callback
    this._stateMachine.onChange((newState, prevState) => {
      this._notifyExtensionsLifecycle('stateChange', {
        newState: newState,
        previousState: prevState,
      });
      this._onStateChange && this._onStateChange(newState, prevState);
      // Synchronously stamp data-sharc-state on iframe
      this._stampState(newState);
    });

    // Wire up page lifecycle listeners (for web browser state tracking)
    /** @private */ this._pageFocusHandler = this._onPageFocus.bind(this);
    /** @private */ this._pageBlurHandler = this._onPageBlur.bind(this);
    /** @private */ this._visibilityHandler = this._onVisibilityChange.bind(this);
    /** @private */ this._freezeHandler = this._onFreeze.bind(this);
    /** @private */ this._resumeHandler = this._onResume.bind(this);

    /** @private */ this._initiallyVisible = visible;

    // Debounced handler for viewport changes that may affect placement constraints
    /** @private */ this._constraintsDebounceTimer = null;
    /** @private */ this._constraintsResizeHandler = this._onConstraintsRelevantResize.bind(this);
    /** @private */ this._constraintsOrientationHandler = this._onConstraintsRelevantOrientation.bind(this);

    /**
     * Last placement payload sent via notifyPlacementChange().
     * Used by _syncPlacementState() to skip redundant sends.
     * @type {Object|null}
     * @private
     */
    this._lastSentPlacement = null;

    /**
     * Placement policy — container-local enforcement layer.
     * Never sent over the wire. When undefined, no policy enforcement occurs.
     * @type {Object|undefined}
     * @private
     */
    this._placementPolicy = placementPolicy || undefined;

    /**
     * Publisher customization for the container-rendered close button.
     * Applied via Object.assign over defaults; minimum 50 DIP enforced.
     * @type {Object|null}
     * @private
     */
    this._closeButtonStyles = closeButtonStyles || null;

    /**
     * The container-rendered close button DOM element (sibling to iframe).
     * @type {HTMLElement|null}
     * @private
     */
    this._closeButton = null;

    /**
     * Placement type declared by the creative in createSession.
     * 'inline' (default) or 'interstitial'.
     * @type {string}
     * @private
     */
    this._placementType = 'inline';

    /**
     * Tracks the current placement intent ('resize', 'expand', 'fullscreen', or null).
     * Used by close button click handler to determine restore vs close behavior.
     * @type {string|null}
     * @private
     */
    this._currentIntent = null;

    /**
     * Snapshot of the original placement from construction time.
     * Used by restore to return to the original state, independent of
     * mutations that _handleRequestPlacementChange applies to environmentData.
     * @type {Object}
     * @private
     */
    this._originalPlacement = { ...(this.environmentData.currentPlacement || {}) };

    /**
     * Snapshot of the iframe's CSS state before the first resize.
     * Restored on collapse to fix position reset bug.
     * @type {Object|null}
     * @private
     */
    this._preResizeCSSState = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Creates the iframe, sets up the MessageChannel, and begins the SHARC
   * initialization handshake. This starts the ad lifecycle.
   *
   * @returns {SHARCContainer} this (for chaining)
   */
  load() {
    // 0.7.2: capture load-invocation wall-clock for the G7 framework-aware
    // late-handshake warn (elapsed-since-load forensic field per § 7.4).
    this._loadedAt = Date.now();
    this._notifyExtensionsLifecycle('load');
    this._createIframe();
    this._registerProtocolListeners();
    this._attachPageLifecycleListeners();
    // 0.7.2 § 8 — lifecycle adapter attaches AFTER _createIframe (needs
    // `this._iframe`) and after the page-lifecycle listeners. Adapter
    // attaches regardless of `requireSharcInit`: for handshake-aware
    // creatives it yields to the handshake-driven `LOADING → READY →
    // ACTIVE` path (§ 8.2); for non-handshake creatives it drives the new
    // `LOADING → ACTIVE` edge (§ 4.5). MRAID / SafeFrame subclasses ship
    // in 0.7.3 — selection logic is structured to extend cleanly.
    this._lifecycleAdapter = SHARCContainer._selectLifecycleAdapter(this._apiFramework);
    this._lifecycleAdapter.attach(this);
    // 0.7.2 § 4.2 + Rule 11: skip the `createSession` fatal-timeout when the
    // operator opted out via `requireSharcInit: false`. All other timeouts
    // (renderer protocol, init/start resolve, close sequence) remain armed —
    // they guard different invariants and are not handshake-conditional.
    if (this._requireSharcInit) {
      this._startSessionTimeout();
    }
    return this;
  }

  /**
   * Initiates the Container:close message flow.
   * Sends Container:close, waits up to 2s for creative acknowledgment, then terminates.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  close() {
    if (this._closeRequested) return;
    this._closeRequested = true;
    this._initiateClose();
  }

  /**
   * Sends Container:log to the creative.
   * @param {string} message
   */
  log(message) {
    this._protocol.sendLog(message);
  }

  /**
   * Returns the current container state.
   * @returns {string}
   */
  getState() {
    return this._stateMachine.getState();
  }

  /**
   * Returns the creative session ID (set during the createSession handshake).
   * Null before the handshake completes.
   * @returns {string|null}
   */
  get sessionId() {
    return this._protocol.sessionId || null;
  }

  /**
   * Whether the creative has completed the SHARC `createSession` handshake.
   * `true` once `_handleCreateSession` has accepted a session; `false` until
   * then. Outcome-driven companion to {@link apiFramework} (which is
   * declaration-driven, frozen at construction).
   *
   * Operators querying this in the same microtask as `load()` will always
   * see `false` even for SHARC-aware creatives — the handshake fires
   * asynchronously. Query from `onStateChange` callbacks or after a
   * lifecycle-observation deadline. See 0.7.2 design § 7.1, § 11.2, and G11.
   *
   * Returns `false` (not `null`) when no handshake has occurred — the boolean
   * shape disambiguates "container hasn't loaded yet" from "session ID is
   * unset" that `sessionId !== null` conflates.
   *
   * @returns {boolean}
   */
  get hasSharcSession() {
    return this._protocol.sessionId !== '';
  }

  /**
   * Transitions the container to a new state.
   * Sends a stateChange message to the creative if the new state is creative-queryable.
   * @param {string} newState - A ContainerStates value (e.g. 'active', 'hidden', 'frozen').
   * @returns {boolean} True if the transition was valid and applied.
   */
  setState(newState) {
    const success = this._stateMachine.transition(newState);
    if (success && newState === ContainerStates.ACTIVE && this.protocolRouter) {
      // 0.7.7: the `creative-active` phase governs the steady-state surface
      // (any `SHARC:Renderer:*` envelope arriving here is out-of-phase). The
      // transition is one-way — passive/hidden/frozen do NOT transition the
      // router because no protocol's phase membership distinguishes those
      // visibility states (§ 4.4).
      //
      // 0.7.8 phase-shadowing (design § 3.4 note I3): once the OMID session has
      // entered `omid-active` / `omid-finishing` (a NARROWER window opened after
      // the container went live), `creative-active` MUST NOT shadow it back. The
      // state-machine `onChange` notify (which drives the OMID bridge's session
      // start, and thus the `omid-active` transition) fires before this line in
      // the same `setState` call, so without this guard `creative-active` would
      // clobber `omid-active`. Re-entering ACTIVE later (e.g. after passive)
      // likewise must not downgrade an OMID phase.
      const currentPhase = this.protocolRouter.getPhase();
      if (currentPhase !== 'omid-active' && currentPhase !== 'omid-finishing') {
        this.protocolRouter.transitionTo('creative-active');
      }
    }
    if (success && this._stateMachine.isCreativeQueryable(newState)) {
      this._protocol.sendStateChange(newState);
    }
    return success;
  }

  /**
   * Notifies the creative of an audio state change.
   * Clamps volumePercentage to [0, 100] before storing or sending.
   * isMuted is independent of volumePercentage — muting does NOT zero the volume.
   * LOADING / READY / HIDDEN buffer into environmentData.
   * ACTIVE / PASSIVE send live.
   * FROZEN / TERMINATED warn and drop.
   *
   * @param {Object}  audioState
   * @param {number}  audioState.volumePercentage - Current volume level (0–100)
   * @param {boolean} audioState.isMuted          - Whether audio is muted (independent of volume)
   */
  setAudioState({ volumePercentage, isMuted }) {
    const state = this._stateMachine.getState();

    if (!Number.isFinite(volumePercentage)) {
      console.warn('[SHARCContainer] setAudioState: volumePercentage must be a finite number');
      return;
    }

    // FROZEN / TERMINATED — drop entirely; JS is suspended or protocol is gone.
    if (state === ContainerStates.FROZEN || state === ContainerStates.TERMINATED) {
      console.warn('[SHARCContainer] setAudioState called in invalid state:', state);
      return;
    }

    // Store independently — never derive isMuted from volumePercentage
    this.environmentData.volumePercentage = Math.max(0, Math.min(100, Math.round(volumePercentage)));
    this.environmentData.volume = this.environmentData.volumePercentage / 100;
    this.environmentData.isMuted = isMuted;

    // LOADING — MessagePort not yet established; persist to environmentData only.
    // The updated values will be delivered on the ACTIVE transition via _syncAudioState().
    if (state === ContainerStates.LOADING) {
      return;
    }

    // READY / HIDDEN — MessagePort is live but the creative is not yet interactive.
    // Buffer the value in environmentData only; _syncAudioState() will deliver it
    // on the next ACTIVE transition. Sending now would be redundant — the ACTIVE
    // transition sync is the sole delivery mechanism for preloaded ads.
    if (state === ContainerStates.READY || state === ContainerStates.HIDDEN) {
      return;
    }

    // ACTIVE / PASSIVE — creative is running; send the update live.
    this._protocol.sendAudioVolumeChange(this.environmentData.volumePercentage, isMuted);
  }

  /**
   * Builds the outbound placementChange payload.
   * Priority 2: Automatically enriches the payload with the current iframe position
   * if the iframe exists, so bridges can use it for resize/expand calculations.
   * @param {Object} placementUpdate - Placement data to send.
   * @param {Object} [placementUpdate.size] - {width, height} of the new placement.
   * @param {Object} [placementUpdate.position] - {x, y} of the new placement.
   * @returns {Object}
   * @private
   */
  _buildPlacementChangePayload(placementUpdate) {
    /** @type {Object} */
    const payload = { ...placementUpdate };
    if (this._iframe) {
      try {
        const iframeRect = this._iframe.getBoundingClientRect();
        // Add the native-supplied on-screen offset so getCurrentPosition() reports the
        // container's REAL screen rect, not the WebView-relative 0,0. Guarded — embeds that
        // never set an offset keep the raw iframe rect verbatim.
        const _ho = this._hostScreenOffset;
        payload.position = {
          x: iframeRect.x + (_ho ? _ho.x : 0),
          y: iframeRect.y + (_ho ? _ho.y : 0),
          width: iframeRect.width,
          height: iframeRect.height,
        };
      } catch (e) {
        // Non-browser environment: skip position enrichment
      }
    }
    // Stamp the resolved placement intent into the canonical outbound shape so
    // the creative side (MRAID compatibility bridge) can derive its placement
    // state for OPERATOR-initiated changes — e.g. the container's own dismiss
    // button collapsing an expand, which carries no creative-side pending
    // intent to latch on (#391). Stamping here (not at the send site) also keeps
    // _syncPlacementState's dedup comparison building the SAME shape it sent, so
    // an unchanged ACTIVE re-sync is correctly suppressed.
    payload.intent = this._currentIntent;
    return payload;
  }

  /**
   * Sends a placementChange notification to the creative.
   * The outbound payload may enrich placementUpdate.position with the iframe's
   * current x/y/width/height when that information is available.
   * @param {Object} placementUpdate - Placement data to send.
   * @param {Object} [extra] - Additional fields to include (e.g. transition, closeButtonPosition).
   */
  notifyPlacementChange(placementUpdate, extra) {
    // _buildPlacementChangePayload stamps payload.intent = _currentIntent (single source
    // of truth since #404) so the creative-side MRAID bridge can derive getState() for
    // OPERATOR-initiated changes (#391) — no re-stamp needed here.
    const payload = this._buildPlacementChangePayload(placementUpdate);
    // Send notification with extra fields merged at the args level
    const args = { placementUpdate: payload };
    if (extra) {
      if (extra.transition) args.transition = extra.transition;
      if (extra.closeButtonPosition) args.closeButtonPosition = extra.closeButtonPosition;
    }
    this._protocol._sendMessage(ContainerMessages.PLACEMENT_CHANGE, args);
    this._lastSentPlacement = payload;
    this._notifyExtensionsLifecycle('placementChange', {
      placementUpdate: payload,
      extra: extra || null,
      intent: this._currentIntent,
    });
    // Surface the placement change to the native host. The container runs in the host page and
    // CAN reach the host SDK (unlike the cross-origin, sandboxed creative iframe), so this is the
    // only seam by which native learns the creative drove mraid.expand()/resize()/close().
    // intent ∈ {'expand','fullscreen','resize', null}; payload carries the post-change geometry.
    // Host-callback errors are swallowed so a misbehaving host can never break the container's
    // state machine (matches the _notifyExtensionsLifecycle contract above).
    if (this._onPlacementChange) {
      try {
        this._onPlacementChange({
          intent: this._currentIntent,
          placementUpdate: payload,
          // The creative's REQUESTED resize target (offset relative to the slot). When a host
          // reparents the WebView, the iframe is pinned at (0,0) and the host owns the on-screen
          // frame, so it needs this to position the reparented surface at slot+offset rather than
          // anchoring at the bare slot. null for non-resize / non-host placement changes (carried
          // via notifyPlacementChange's `extra`).
          targetPosition: (extra && extra.hostTargetPosition) || null,
        });
      } catch (e) {
        /* host callback must not break the container */
      }
    }
  }

  /**
   * Native-host hook: the host pushes the container WebView's on-screen origin here, AFTER
   * layout (the WebView is not laid out when the wrapper HTML is built, so a construction-time
   * offset would be a stale 0,0). The container lives in the host page and is reachable from the
   * native layer (e.g. via a host-held reference to the container instance), unlike the
   * cross-origin sandboxed creative iframe's window.mraid. The stored offset is ADDED to the x/y
   * of both the Container:init initialPosition (-> bridge _initialPosition -> getDefaultPosition +
   * resize anchor) and every _buildPlacementChangePayload position (-> bridge _currentPosition ->
   * getCurrentPosition), making MRAID position reporting screen-relative.
   *
   * Re-reports immediately so a setter call after init refreshes getCurrentPosition() live. It
   * emits ONLY the creative-facing PLACEMENT_CHANGE wire message + extension lifecycle — exactly
   * as notifyPlacementChange does MINUS the native _onPlacementChange host callback: a position-only
   * refresh must NOT be mistaken by native for a creative-driven placement change (it would arrive
   * intent-stamped as the current state and could be read as a collapse). Carries intent =
   * _currentIntent so the bridge keeps the current state (matches notifyPlacementChange, which the
   * bridge's getState() derivation relies on — see #391). Safe to call repeatedly (scroll /
   * rotation / reparent); ignores malformed input rather than throwing.
   *
   * @param {{x:number, y:number}} offset CSS-px screen origin of the container WebView.
   */
  setHostScreenOffset(offset) {
    if (!offset || typeof offset.x !== 'number' || typeof offset.y !== 'number'
        || !isFinite(offset.x) || !isFinite(offset.y)) {
      return;
    }
    this._hostScreenOffset = { x: offset.x, y: offset.y };
    try {
      const placement = (this.environmentData && this.environmentData.currentPlacement)
        ? this.environmentData.currentPlacement
        : {};
      // _buildPlacementChangePayload stamps payload.intent (single source of truth since #404).
      const payload = this._buildPlacementChangePayload(placement);
      if (this._placementPayloadUnchanged(payload)) return;
      this._protocol._sendMessage(ContainerMessages.PLACEMENT_CHANGE, { placementUpdate: payload });
      this._lastSentPlacement = payload;
      this._notifyExtensionsLifecycle('placementChange', {
        placementUpdate: payload,
        extra: null,
        intent: this._currentIntent,
      });
    } catch (e) {
      /* re-report is best-effort; never break the container */
    }
  }

  /**
   * Notifies registered extensions about container-owned lifecycle changes.
   * The event shape is intentionally generic so infrastructure extensions
   * (OMID, analytics, diagnostics) can subscribe without adding
   * feature-specific hooks to the container.
   *
   * @param {string} type
   * @param {Object} [detail]
   * @private
   */
  _notifyExtensionsLifecycle(type, detail = {}) {
    if (!this._extensions || this._extensions.length === 0) return;
    const event = {
      type: type,
      timestamp: Date.now(),
      container: this,
      state: this._stateMachine ? this._stateMachine.getState() : null,
      ...detail,
    };
    this._extensions.forEach((ext) => {
      if (!ext) return;
      if (typeof ext.onContainerLifecycleEvent === 'function') {
        try { ext.onContainerLifecycleEvent(event); } catch (e) { /* ignore extension errors */ }
      }
      if (type === 'stateChange' && typeof ext.onContainerStateChange === 'function') {
        try { ext.onContainerStateChange(detail.newState, detail.previousState, this); } catch (e) { /* ignore extension errors */ }
      }
    });
  }

  /**
   * Container-internal handler for the OMID extension's publisher-page session
   * lifecycle signal (0.7.8, OMID-Q2 resolution b / OMID-D19). The OMID bridge
   * is an extension and cannot call `protocolRouter.transitionTo` itself
   * (RTR-D14 keeps `transitionTo` container-internal). Router § 9.6 test #1
   * requires every declared phase to have a `transitionTo` site inside this
   * file — so the OMID `omid-active` / `omid-finishing` transition sites live
   * here, driven by a signal the OMID extension emits off the publisher-page
   * `AdSession.start()` success / `finish()` paths.
   *
   * Trust constraint (§ 3.4): this signal originates ONLY from publisher-page
   * OMID session state. It MUST NOT be reachable from an inbound `SHARC:Omid:`
   * envelope — and it is not: the only caller is the OMID extension's
   * `_signalOmidPhase`, invoked from its own `_createSession` / `_finishSession`
   * paths, never from `_handleOmidEnvelope`.
   *
   * @param {'omid-active'|'omid-finishing'} phase
   * @private
   */
  _onOmidLifecycleSignal(phase) {
    if (!this.protocolRouter) return;
    // #337: gate on router teardown, NOT `_terminated`. The terminal
    // `sessionFinish` drains DURING `_terminate()` (where `_terminated` is
    // already `true`) and legitimately drives the router into `omid-finishing`
    // while it is still live. Reject only post-teardown stragglers.
    if (this._routerTorndown) return;
    if (phase !== 'omid-active' && phase !== 'omid-finishing') return;
    try {
      this.protocolRouter.transitionTo(phase);
    } catch (_) { /* defensive — transitionTo only throws on a bad phase string */ }
  }

  // -------------------------------------------------------------------------
  // Iframe creation
  // -------------------------------------------------------------------------

  /**
   * Creates and inserts the secure iframe for the creative.
   *
   * Two variants:
   *
   * **Creative URL** (`creativeSource === 'url'`):
   *   - Sets `iframe.src` directly — the ONLY load path. OM SDK loads on the
   *     publisher page as a regular `<script>` tag; the container-side bridge
   *     manages the Session Client from the page context. Zero CORS
   *     dependency. No container-side injection into URL creatives, ever
   *     (the `useMarkupInjection` fetch+srcdoc opt-in was removed 2026-07-05).
   *   - Sandbox: `allow-scripts allow-forms allow-popups` (no `allow-same-origin`,
   *     SEC-001).
   *
   * **Creative Markup** (`creativeSource === 'html'`, Phase B):
   *   - `iframe.src` = `creativeRendererUrl + '#sharcNonce=' + crypto.randomUUID()`.
   *   - Sandbox is granted `allow-same-origin` (safe — the renderer is cross-origin
   *     to the publisher, validated by construction-time rules 4–7) plus the
   *     SafeFrame-baseline tokens governed by the constructor `allowPopups` /
   *     `allowTopNavigationByUserActivation` / `allowStorageAccessByUserActivation` /
   *     `allowModals` / `allowDownloads` options. The unsafe `allow-top-navigation`
   *     token is never present.
   *   - Iframe `csp` (Chromium-only) and `allow` (Permissions Policy) attributes
   *     pin a default-deny baseline; the portable enforcement layer is the
   *     renderer's HTTP-response CSP.
   *   - On iframe `load`, posts `SHARC:Renderer:render` to the renderer (with
   *     pre-injected creative HTML), waits for `SHARC:Renderer:rendered` (envelope
   *     checks: source, origin, placementSessionId), then fires `initChannel`
   *     directly off that signal — event-driven, no wall-clock timer (ADR §5.0).
   *
   * Phase B does NOT yet implement: `:failed` receipt + RENDERER_FAILED, post-load
   * origin echo + RENDERER_ORIGIN_MISMATCH, malformed-payload handling +
   * RENDERER_PROTOCOL_ERROR, close() mid-render cleanup, load-event monitoring +
   * RENDERER_UNAUTHORIZED_NAVIGATION, navigation bridge, reference renderer.
   *
   * @private
   */
  _createIframe() {
    const iframe = document.createElement('iframe');

    if (this.creativeSource === 'html') {
      // ── Creative Markup variant (Phase B). ──
      // Full sandbox per proposal § Iframe sandbox: allow-same-origin grants
      // the renderer's origin (cross-origin to publisher per rules 4-7) so the
      // creative gets a real origin — measurement vendors need this. The unsafe
      // `allow-top-navigation` token (no-gesture variant) is NEVER present;
      // only the user-activation variant is exposed via the constructor option.
      iframe.setAttribute('sandbox', this._buildSandboxAttribute());

      // Iframe-level CSP — Chromium-only defense-in-depth. Portable enforcement
      // is the renderer's HTTP response CSP (operator obligation; see proposal
      // § Renderer implementation contract).
      iframe.setAttribute('csp', RENDERER_IFRAME_CSP);

      // Permissions Policy default-deny across sensors / hardware / payment /
      // FedCM / UX-intrusive features. Ad-tech-relevant features
      // (private-state-tokens, browsing-topics, attribution-reporting,
      // shared-storage) deliberately remain operative — see DD-24.
      iframe.setAttribute('allow', RENDERER_PERMISSIONS_POLICY);

      // Prevent the renderer's network requests from leaking the publisher
      // page URL.
      iframe.setAttribute('referrerpolicy', 'no-referrer');
    } else {
      // ── Creative URL variant (existing behavior). ──
      // SEC-001: `allow-same-origin` is intentionally ABSENT.
      // Combining `allow-scripts` + `allow-same-origin` on a same-origin iframe
      // allows the embedded document to remove the sandbox attribute entirely
      // (complete sandbox escape). MessageChannel does NOT require same-origin
      // — the port is transferred and works across origins.
      iframe.setAttribute('sandbox', [
        'allow-scripts',
        // 'allow-same-origin' — REMOVED: defeats sandbox isolation (SEC-001)
        'allow-forms',
        'allow-popups',
        // 'allow-popups-to-escape-sandbox' — REMOVED: grants unsandboxed popup access (SEC-010)
      ].join(' '));

      // Minimal allow policies
      iframe.setAttribute('allow', 'autoplay; fullscreen');
    }

    // Scrolling and styling (shared)
    iframe.style.cssText = [
      'border: none',
      'width: 100%',
      'height: 100%',
      `display: ${this._initiallyVisible ? 'block' : 'none'}`,
    ].join('; ');

    // ── Use placementSessionId instead of Date.now() for iframe ID ──
    iframe.setAttribute('id', `sharc-creative-${this.placementSessionId}`);

    this._iframe = iframe;

    // ── DOM stamping (proposal Part 4): apply class + data-* to both
    // placement element and iframe, snapshot pre-mutation cssText for
    // restoration on detach. ──
    this._attachToPlacement();

    // Attach to DOM now so contentWindow is available when we wire the channel
    this.placementElement.appendChild(iframe);

    if (this.creativeSource === 'html') {
      // Markup variant uses the renderer protocol — initChannel fires after
      // the renderer's :rendered reply, NOT directly on iframe load.
      // 0.7.7 RTR-D10 ordering invariant: the renderer-protocol nonce must
      // be derived before the iframe is wired, so the gate has its expected
      // nonce in place by the time any envelope can arrive and so
      // `_resolvedIframeSrc()` can read the derived nonce.
      this.protocolRouter.ready('SHARC:Renderer:').then(() => {
        if (this._terminated || this._iframe !== iframe) return;
        const src = this._resolvedIframeSrc();
        this._assertResolvedIframeSrcAllowed(src);
        if (this._creativeRendererIntegrity !== null) {
          this._loadVerifiedRendererIframe(iframe, src);
          return;
        }
        this._wireRendererProtocol(iframe);
        iframe.src = src;
      }).catch((err) => {
        if (this._terminated || this._iframe !== iframe) return;
        const message = (err && err.message) ? String(err.message) : '';
        // Distinguish the two async-failure paths:
        //   1. HMAC derivation rejected (RTR-D22 async path) → emit
        //      `feature_load_failed` and abort the load. Dispatched by
        //      the `.code` sentinel the router stamps on the wrapped
        //      rejection (SEC-H2) — substring matching on the message
        //      would silently break under future re-wording.
        //   2. `_assertResolvedIframeSrcAllowed` / `_resolvedIframeSrc`
        //      threw (rule-4..7 guard) → log + terminate without the
        //      crypto-labelled feature event.
        if (err && err.code === 'PROTOCOL_DERIVATION_FAILED') {
          this._emitFeatureLoadFailed(
            'protocol-router-derivation',
            'crypto_subtle_sign_rejected',
            ''
          );
          console.warn('[SHARCContainer] protocol-router derivation failed', message);
        } else {
          console.error('[SHARCContainer] iframe wiring aborted:', message);
        }
        this._terminate();
      });
      return;
    }

    // ── Creative URL variant (existing behavior). ──
    // Wire MessageChannel directly on iframe load.
    //
    // Phase E deliverable 1: arm the load-event navigation backstop after
    // the FIRST load event fires. The Creative URL variant expects exactly
    // one cross-document load (the creative document loading from
    // `creativeUrl`). Any subsequent `load` event = unauthorized navigation
    // and terminates via `_armRendererBackstop()` (variant-agnostic seam
    // extracted in Phase D round-1). `{ once: true }` removes this listener
    // after first fire; the backstop installed by `_armRendererBackstop()`
    // is what handles all subsequent loads. Same-document navigations
    // (pushState, hash changes) do not fire `load`; cross-document do.
    iframe.addEventListener('load', () => {
      // Stamp the render-anchor timestamp so the backstop's eventual
      // `details.msSinceRender` payload reflects the URL-variant anchor
      // (initial load), not the Markup anchor (`:rendered` accept).
      this._renderedAt = Date.now();
      // 0.7.7 (RTR-D9): URL variant has no renderer handshake, so the router
      // jumps directly from `init` to `rendered` on the iframe's initial load.
      // No `attaching-renderer` window because no renderer protocol is wired.
      this.protocolRouter.transitionTo('rendered');
      // Slice C (EV-6): this load event IS the creative-rendered anchor for
      // the URL variant (see R-1 below) — flip the public anchor the
      // effective-visibility composer reads, then push so subscribers learn
      // the anchor changed (a URL creative would otherwise compose
      // 0/'notAttached' forever). Markup-only surfaces are untouched: the
      // renderer envelope path never runs for this variant, the adapter's
      // Markup gate is creativeSource-scoped, and the DOM stamp
      // `data-sharc-creative-rendered` stays 'false' by spec (§ DOM stamping
      // — it discriminates the variant, not this anchor).
      this.creativeRendered = true;
      this._pushEffectiveVisibility();
      // Event-driven handshake (ADR 2026-06-13 §5.2, R-1): the iframe `load`
      // event IS the creative-rendered anchor (≈ inner `window 'load'` for the
      // URL variant). Fire `initChannel` directly off that signal — no
      // wall-clock gate. The retired 200ms timer was a guess, not a signal;
      // the success path is gated only on `creative-rendered ∧ env-ready`.
      this._protocol.initChannel(iframe.contentWindow, '*', this.placementSessionId);
      // Arm the backstop immediately (synchronously, in the same task as
      // the initial-load handler) so any post-load redirect injection that
      // schedules a navigation in a microtask / next-task tick is caught.
      this._armRendererBackstop();
    }, { once: true });

    // The URL variant loads via `iframe.src` — the ONLY load path. The
    // `useMarkupInjection` fetch+srcdoc alternative was removed 2026-07-05
    // (URL-mode no-injection invariant; #259 B1).
    const src = this._resolvedIframeSrc();
    this._assertResolvedIframeSrcAllowed(src);
    iframe.src = src;
  }

  /**
   * Builds the `sandbox` attribute string for the Creative Markup renderer
   * iframe. Tokens follow proposal § Iframe sandbox; conditional tokens are
   * governed by `_sandboxConfig` (captured at construction). The unsafe
   * `allow-top-navigation` token is never emitted — only the user-activation
   * variant is exposed.
   *
   * @returns {string}
   * @private
   */
  _buildSandboxAttribute() {
    const tokens = [
      'allow-scripts',
      // `allow-same-origin` is REQUIRED for Creative Markup — the renderer is
      // cross-origin to the publisher (rules 4-7), so this grants the renderer's
      // own origin to the iframe rather than collapsing to the publisher's.
      // See proposal § Iframe sandbox table.
      'allow-same-origin',
      'allow-forms',
    ];
    if (this._sandboxConfig.allowPopups) {
      tokens.push('allow-popups');
      // `allow-popups-to-escape-sandbox` is bound to `allowPopups` per DD-21.
      tokens.push('allow-popups-to-escape-sandbox');
    }
    if (this._sandboxConfig.allowTopNavigationByUserActivation) {
      tokens.push('allow-top-navigation-by-user-activation');
    }
    if (this._sandboxConfig.allowStorageAccessByUserActivation) {
      tokens.push('allow-storage-access-by-user-activation');
    }
    if (this._sandboxConfig.allowModals) {
      tokens.push('allow-modals');
    }
    if (this._sandboxConfig.allowDownloads) {
      tokens.push('allow-downloads');
    }
    return tokens.join(' ');
  }

  /**
   * Returns the URL to assign to `iframe.src` for the active creative-source
   * variant.
   *
   * - Creative URL: returns `this.creativeUrl`.
   * - Creative Markup: generates a fresh CSPRNG nonce via `crypto.randomUUID()`,
   *   stores it on `this._sharcNonce`, and returns
   *   `creativeRendererUrl + '#sharcNonce=' + nonce`. Calling this method twice
   *   for a Markup container produces two different nonces — by design; the
   *   iframe `src` is assigned exactly once per `_createIframe()` call.
   *   `Math.random`-based UUIDs are explicitly rejected (CSPRNG required per
   *   proposal § Load sequence).
   *
   * Defended by `_assertResolvedIframeSrcAllowed()` at every call site —
   * extensions / subclasses cannot override this method to defeat the rule
   * 4–7 origin guarantee. See issue #65.
   *
   * @returns {string} Resolved iframe src URL.
   * @throws {Error} If invoked for Creative Markup in an environment without
   *   `crypto.randomUUID()` (CSPRNG fallback rejected by spec).
   * @private
   */
  _resolvedIframeSrc() {
    if (this.creativeSource === 'html') {
      // 0.7.7: the URL fragment value is the renderer-protocol-derived nonce
      // (HMAC-SHA-256 over root `_sharcNonce` + `'SHARC:Renderer:'` +
      // placementSessionId), not the root nonce itself. Derivation completes
      // asynchronously inside the protocol router after registration; the
      // container's load path awaits `protocolRouter.ready('SHARC:Renderer:')`
      // before calling this method. A null nonce at this point indicates the
      // await contract was bypassed — fail loudly.
      if (this._rendererProtocolNonce === null) {
        throw new Error(
          '[SHARCContainer] _resolvedIframeSrc() called before the renderer '
          + 'protocol nonce was derived. The Markup-variant load path must '
          + 'await protocolRouter.ready("SHARC:Renderer:") before iframe `src` '
          + 'assignment.'
        );
      }
      return /** @type {string} */ (this.creativeRendererUrl)
        + '#sharcNonce=' + this._rendererProtocolNonce;
    }
    return /** @type {string} */ (this.creativeUrl);
  }

  /**
   * Runtime guard that asserts `_resolvedIframeSrc()`'s return value matches
   * the URL that the construction-time validation (rules 4–7) actually
   * approved. Defends against extensions or subclasses overriding
   * `_resolvedIframeSrc()` to return an arbitrary URL after rule 4–7 already
   * cleared a different URL — which would defeat the cross-origin / HTTPS /
   * no-userinfo guarantees the sandbox model relies on. See issue #65.
   *
   * Throws synchronously (before `iframe.src = ...`) so the iframe never
   * navigates to an unapproved URL.
   *
   * @param {string} resolvedSrc - Value returned by `_resolvedIframeSrc()`.
   * @throws {Error} If `resolvedSrc` does not match the expected URL.
   * @private
   */
  _assertResolvedIframeSrcAllowed(resolvedSrc) {
    if (this.creativeSource === 'url') {
      if (resolvedSrc !== this.creativeUrl) {
        throw new Error(
          '[SHARCContainer] _resolvedIframeSrc() returned a URL that does not match '
          + 'this.creativeUrl. Refusing to load. An extension or subclass appears to '
          + 'have overridden _resolvedIframeSrc() — the SEC-001 sandbox isolation '
          + 'depends on this method returning exactly this.creativeUrl.'
        );
      }
      return;
    }
    // Markup variant — must be exactly creativeRendererUrl + '#sharcNonce=<derived>'.
    // 0.7.7: fragment value is the renderer-protocol-derived nonce, not the
    // root `_sharcNonce`. See `_resolvedIframeSrc`.
    if (!this._rendererProtocolNonce) {
      throw new Error(
        '[SHARCContainer] _rendererProtocolNonce is not populated. '
        + 'Refusing to load — the renderer protocol nonce derivation did not '
        + 'complete before iframe wiring (RTR-D10 ordering invariant violated).'
      );
    }
    const expected = this.creativeRendererUrl + '#sharcNonce=' + this._rendererProtocolNonce;
    if (resolvedSrc !== expected) {
      throw new Error(
        '[SHARCContainer] _resolvedIframeSrc() returned a URL that does not match '
        + 'creativeRendererUrl + "#sharcNonce=<nonce>". Refusing to load. An extension '
        + 'or subclass appears to have overridden _resolvedIframeSrc() — the rule-4..7 '
        + 'cross-origin guarantee relies on this method returning the exact renderer URL.'
      );
    }
  }

  /**
   * Verifies the configured renderer document integrity before assigning
   * `iframe.src`. This is necessarily best-effort because browsers do not
   * support native Subresource Integrity on iframe navigations. The preflight
   * still prevents the container from sending `SHARC:Renderer:render` when the
   * bytes fetched for `creativeRendererUrl` do not match the operator-supplied
   * digest.
   *
   * @param {HTMLIFrameElement} iframe
   * @param {string} src
   * @private
   */
  _loadVerifiedRendererIframe(iframe, src) {
    const timeoutMs = this.timeouts.rendererLoad || DEFAULT_TIMEOUTS.rendererLoad;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        if (controller) controller.abort();
        reject(new Error(
          'renderer integrity preflight timed out after ' + timeoutMs + 'ms'
        ));
      }, timeoutMs);
    });

    Promise.race([
      this._verifyRendererIntegrity(controller ? { signal: controller.signal } : {}),
      timeoutPromise,
    ])
      .then(() => {
        if (this._terminated || this._iframe !== iframe) return;
        this._wireRendererProtocol(iframe);
        iframe.src = src;
      })
      .catch((err) => {
        if (this._terminated || this._iframe !== iframe) return;
        const reason = err && err.message ? err.message : String(err || 'unknown');
        this._emitSecurityEventAndTerminate(
          'renderer_integrity_failed',
          ErrorCodes.RENDERER_INTEGRITY_FAIL,
          'creativeRendererIntegrity verification failed before renderer load: '
            + this._sanitizeForLog(reason),
          {
            subtype: 'integrity_failed',
            reason: reason,
          }
        );
      })
      .finally(() => {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      });
  }

  /**
   * Fetches `creativeRendererUrl` and verifies it against the configured
   * `sha384-...` digest.
   *
   * @param {{signal?: AbortSignal|undefined}} [options]
   * @returns {Promise<void>}
   * @private
   */
  async _verifyRendererIntegrity(options = {}) {
    if (this._creativeRendererIntegrity === null) return;
    if (typeof fetch !== 'function') {
      throw new Error('fetch is unavailable');
    }
    const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto)
      ? globalThis.crypto
      : (typeof crypto !== 'undefined' ? crypto : null);
    if (!cryptoObj || !cryptoObj.subtle || typeof cryptoObj.subtle.digest !== 'function') {
      throw new Error('Web Crypto SHA-384 is unavailable');
    }

    const response = await fetch(/** @type {string} */ (this.creativeRendererUrl), {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal,
    });
    if (!response || !response.ok) {
      const status = response ? String(response.status || '') : '';
      const statusText = response ? String(response.statusText || '') : '';
      throw new Error(('HTTP ' + status + ' ' + statusText).trim());
    }
    if (response.url) {
      let responseOrigin = null;
      try {
        responseOrigin = new URL(response.url).origin;
      } catch (_) { /* ignore unparsable response.url */ }
      if (responseOrigin !== null && responseOrigin !== this._rendererOrigin) {
        throw new Error(
          'renderer fetch redirected from ' + this._rendererOrigin
          + ' to ' + responseOrigin
        );
      }
    }

    const bytes = await response.arrayBuffer();
    const digest = await cryptoObj.subtle.digest('SHA-384', bytes);
    const actual = 'sha384-' + SHARCContainer._base64FromArrayBuffer(digest);
    if (actual !== this._creativeRendererIntegrity) {
      throw new Error('SHA-384 digest mismatch');
    }
  }

  /**
   * Encodes an ArrayBuffer as base64 without depending on Node Buffer.
   *
   * @param {ArrayBuffer} buffer
   * @returns {string}
   * @private
   */
  static _base64FromArrayBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    if (typeof btoa === 'function') {
      return btoa(binary);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(binary, 'binary').toString('base64');
    }
    throw new Error('No base64 encoder available');
  }

  /**
   * Wires the renderer-protocol message exchange for the Creative Markup
   * variant (Phase B). Attaches:
   *
   * 1. A 5s `rendererLoad` timeout (cleared on iframe `load` event).
   * 2. An iframe `load` listener that:
   *    a. Runs registered extensions' `injectIntoMarkup(creativeHtml)` in
   *       order (synchronously). Sets `creativeInjected = true` if any
   *       injector returned a non-empty modified string.
   *    b. Attaches a `window` `message` listener for `SHARC:Renderer:rendered`
   *       envelope-validated against `event.source`, `event.origin`, and
   *       `event.data.placementSessionId`. Phase B silently ignores messages
   *       failing envelope checks (any frame on the page can postMessage;
   *       mismatches are noise, not errors).
   *    c. Arms a 2s `rendererReply` timeout (cleared on `:rendered` receipt).
   *    d. Posts `SHARC:Renderer:render` to `iframe.contentWindow` with
   *       `targetOrigin = this._rendererOrigin`.
   * 3. On envelope-validated `:rendered`: sets `this.creativeRendered = true`,
   *    detaches the message listener, clears the reply timeout, and fires
   *    `initChannel` directly off that signal — event-driven, no wall-clock
   *    timer (ADR §5.0).
   *
   * Both timeouts terminate via `_handleFatalError(RENDERER_TIMEOUT)`. Phase
   * B does NOT yet implement payload validation, post-load origin echo, or
   * `:failed` receipt — those land in Phase C.
   *
   * @param {HTMLIFrameElement} iframe
   * @private
   */
  _wireRendererProtocol(iframe) {
    // 1. Iframe-load timeout. Per spec § Load sequence step 3:
    // "Iframe-load 'error' events and never-resolving loads are caught by the
    // same timeout." We don't attach a separate 'error' listener — the timeout
    // covers both cases.
    this._startTimeout('rendererLoad', () => {
      this._emitSecurityEventAndTerminate(
        'renderer_protocol_timeout',
        ErrorCodes.RENDERER_TIMEOUT,
        'Renderer iframe `load` event did not fire within '
          + this.timeouts.rendererLoad + 'ms',
        { subtype: 'timeout', reason: 'iframe_load' }
      );
    });

    iframe.addEventListener('load', () => {
      // SRE pass HIGH: drop late `load` after a timeout-induced termination.
      // _handleFatalError schedules _terminate asynchronously (via
      // sendFatalError().then(_terminate) plus a 1s force-terminate
      // setTimeout), so a load racing the timeout window would otherwise
      // re-enter the protocol on a terminated container — duplicate onError,
      // leaked window 'message' listener, mutated creativeInjected.
      if (this._terminated) return;
      // #321 (ADR Decision 1): the render-wiring path owns the FIRST
      // load ONLY. A real compatibility creative's external scripts can
      // navigate / document.open()+write() the renderer iframe ~1s after the
      // first render, firing a SECOND `load`. Without this guard the handler
      // re-enters the entire handshake — re-runs injectors, re-transitions the
      // router to `attaching-renderer` (an illegal transition once `rendered`),
      // re-posts `:render`, and re-arms `rendererReply`. The reloaded document
      // is no longer the SHARC renderer, so no second `:rendered` arrives, the
      // re-armed timeout fires, and a creative that already reached `active` is
      // killed with RENDERER_TIMEOUT (2114, reason `rendered_reply`). Once
      // `creativeRendered` is true, every subsequent iframe `load` belongs
      // exclusively to the navigation backstop (`_armRendererBackstop`, armed
      // in `_onRendererRendered`), which is a SEPARATE listener on this iframe
      // and still receives this event. Within the renderer-protocol
      // implementation; no router-contract change.
      if (this.creativeRendered) return;
      this._clearTimeout('rendererLoad');

      // 2a. Run injectors synchronously. Injection is Markup-variant only —
      // the URL variant never injects. See proposal § Injection Across
      // Variants.
      const html = this._runMarkupInjection();

      // Resolve container origin for the renderer to validate against.
      const containerOrigin = (typeof window !== 'undefined' && window.location)
        ? window.location.origin
        : '';

      // 0.7.7: transition the router into `attaching-renderer` BEFORE posting
      // the render request, so `:rendered` / `:failed` envelopes arriving in
      // response are valid against the type's phase membership. (`:loadAck` is
      // port-routed, not a router type — ADR 2026-06-15.)
      this.protocolRouter.transitionTo('attaching-renderer');

      // 2b. The router's single `message` listener handles `:rendered` /
      // `:failed` envelopes for this protocol — no per-load listener is
      // attached here (single-listener invariant, § 6.1). The renderer-protocol
      // handler is `_handleRendererEnvelope`. `:loadAck` is NOT router-routed —
      // it is carried over `port1` and dispatched by `_bindProbePort` →
      // `_dispatchRendererLoadAck` (ADR 2026-06-15; window path retired).

      // 0.7.8 (§ 4.3 mechanism i): resolve OMID Markup-variant trusted
      // injection. When an OMID extension is active for this placement
      // (`exposeOmid3p` not opted out AND the `SHARC:Omid:` router protocol
      // registered AND its `protocolNonce` derived), the bridge returns the
      // OMID `protocolNonce`. The container threads it onto the render
      // envelope below so the renderer can source-rewrite the shim with the
      // nonce baked as a closure constant. ADDITIVE: when no OMID extension
      // returns a payload (OMID off, or no OMID extension at all), the render
      // envelope is byte-identical to the pre-0.7.8 shape — no `omid` field.
      //
      // The nonce travels ONLY over the renderer-protocol channel (already
      // gated by the renderer's nonce/origin/source) to the trusted renderer.
      // It is NEVER exposed to the creative here. Different per-protocol nonce
      // from the renderer-protocol nonce (router § 5.2 / design § 4.3).
      let omidInjection = null;
      for (let ei = 0; ei < this._extensions.length; ei++) {
        const ext = this._extensions[ei];
        if (ext && typeof ext.getRendererOmidInjection === 'function') {
          const injection = ext.getRendererOmidInjection();
          if (injection
              && typeof injection.protocolNonce === 'string'
              && injection.protocolNonce.length > 0) {
            omidInjection = injection;
            break;
          }
        }
      }

      // 2c. Post the render request BEFORE arming the reply timeout. The
      // outbound envelope is built via the router's `buildOutbound` helper so
      // `sharcNonce` is stamped with the derived renderer-protocol nonce
      // (not the root `_sharcNonce`) and `placementSessionId` is stamped
      // by the router — symmetric with the inbound gate.
      const renderMsg = this.protocolRouter.buildOutbound('SHARC:Renderer:', 'render', {
        // 0.7.1: tells the renderer which compatibility bridges to load
        // alongside the creative. Resolved at construction via the
        // three-layer detection pipeline (`_resolveBridges`); reflected on
        // `this.bridges` for diagnostics. Sent verbatim — sorted &
        // deduplicated by `_sortDedupBridges`. Old renderers ignore the
        // field (forward-compat); new renderers filter against their
        // `knownBridges` allowlist (`['mraid', 'safeframe']` in 0.7.1)
        // before importing. See docs/design/0.7.1-bridges-field.md § 2.
        bridges: this.bridges.slice(),
        containerOrigin: containerOrigin,
        creativeHtml: html,
        rendererProtocolVersion: RENDERER_PROTOCOL_VERSION,
        sharcVersion: SHARC_VERSION,
        // 0.7.8 (§ 4.3 mechanism i): spread the OMID fields ONLY when OMID is
        // active for this placement. When `omidInjection` is null the spread
        // contributes nothing and the envelope keeps its pre-0.7.8 shape — old
        // renderers (and the OMID-off path) see no `omid`/`omidProtocolNonce`
        // and behave exactly as before. The nonce is consumed by the trusted
        // renderer for shim source-rewrite; it is not creative-readable.
        ...(omidInjection ? {
          omid: true,
          omidProtocolNonce: omidInjection.protocolNonce,
        } : {}),
      });
      try {
        iframe.contentWindow.postMessage(renderMsg, this._rendererOrigin);
      } catch (postErr) {
        // postMessage throws synchronously on, e.g., DataCloneError or a null
        // contentWindow — neither should happen on a freshly-loaded iframe,
        // but if the operator's environment is broken in an unanticipated
        // way, surface it cleanly via the standard fatal-error path rather
        // than letting the exception bubble out of the load handler.
        this._emitSecurityEventAndTerminate(
          'renderer_protocol_post_failed',
          ErrorCodes.RENDERER_POST_FAILED,
          'Failed to postMessage SHARC:Renderer:render: '
            + (postErr && postErr.message ? postErr.message : 'unknown'),
          {
            subtype: 'post_failed',
            reason: (postErr && postErr.message) ? String(postErr.message) : 'unknown',
          }
        );
        // Do NOT arm the reply timeout — _terminate has already been requested.
        // (Code-review pass-2 LOW: arming the reply timeout before postMessage
        // could double-fire onError if postMessage threw, since _handleFatalError
        // resolves async.)
        return;
      }

      // 2d. Reply timeout — armed only after postMessage succeeded.
      this._startTimeout('rendererReply', () => {
        this._emitSecurityEventAndTerminate(
          'renderer_protocol_timeout',
          ErrorCodes.RENDERER_TIMEOUT,
          'SHARC:Renderer:rendered reply not received within '
            + this.timeouts.rendererReply + 'ms',
          { subtype: 'timeout', reason: 'rendered_reply' }
        );
      });
    });
  }

  /**
   * Sanitizes a renderer-supplied string for safe inclusion in operator-facing
   * dev-channel logs. Strips ASCII control characters (C0 0x00–0x1f and DEL
   * 0x7f) that could deceive log readers via CR/LF splitting, ANSI escape
   * sequences, or terminal cursor manipulation, and truncates to 200 chars to
   * bound the log line length.
   *
   * C1 (0x80–0x9f) is intentionally not stripped — it would corrupt legitimate
   * UTF-8 multi-byte sequences in non-ASCII reason strings, and the named
   * log-deception threats (ANSI escape via 0x1B, CR/LF splitting via 0x0A/0x0D)
   * are all in C0.
   *
   * The renderer is operator-deployed and partially trusted, so this is
   * defense-in-depth rather than an adversary mitigation — but it closes the
   * log-deception channel cheaply.
   *
   * The 200-char limit operates on UTF-16 code units, not user-perceived
   * characters; for non-BMP content (emoji, supplementary-plane CJK), this is
   * fewer than 200 user-perceived characters. The trailing-high-surrogate
   * strip prevents malformed output but not boundary truncation of multi-
   * codepoint glyphs (combining sequences, ZWJ-joined emoji).
   *
   * @param {string} s
   * @returns {string}
   * @private
   */
  _sanitizeForLog(s) {
    // slice on UTF-16 code units, then drop a trailing lone high surrogate to
    // avoid emitting a malformed pair when the cut lands inside a surrogate.
    // eslint-disable-next-line no-control-regex
    return String(s).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 200).replace(/[\uD800-\uDBFF]$/, '');
  }

  /**
   * Renderer-protocol envelope handler registered with the 0.7.7
   * `SHARCProtocolRouter`. Receives only envelopes that have already passed
   * the router's uniform gate (source, origin, registered prefix,
   * `placementSessionId`, protocol-derived nonce, declared type, phase
   * membership). The handler is responsible only for payload-shape checks
   * and protocol-specific dispatch.
   *
   * `context.type` is the trailing portion of the envelope's `data.type`
   * with the `SHARC:Renderer:` prefix stripped. The handler covers:
   *
   *   - `rendered` — payload-shape check on `rendererOrigin`, then post-load
   *     origin echo. Terminates with RENDERER_PROTOCOL_ERROR (2117) on
   *     malformed payload; RENDERER_ORIGIN_MISMATCH (2116) on origin echo
   *     mismatch; otherwise `_onRendererRendered()`.
   *   - `failed` — payload-shape check on `reason`; terminates with
   *     RENDERER_FAILED (2115) carrying the renderer-supplied reason, or
   *     `bridge_load_failed` when reason === 'bridge_load_failed'.
   *
   * `loadAck` is NOT handled here — it is carried over `port1`, not the router
   * (ADR 2026-06-15); see `_bindProbePort` / `_dispatchRendererLoadAck`.
   *
   * @param {{type: string, placementSessionId?: string,
   *          rendererOrigin?: string, reason?: string,
   *          bridge?: string, url?: string}} data
   * @param {{type: string, phase: string, protocolNonce: string,
   *          raisedAt: number}} context
   * @private
   */
  _handleRendererEnvelope(data, context) {
    if (this._rendererOrigin == null) {
      return;
    }
    // ADR 2026-06-15 § CRITICAL SEAM (SE item 5): there is NO window-message
    // path to the load-probe gate. `:loadAck` is authenticated by MessagePort
    // possession — it arrives ONLY on the captured-native `port1` listener
    // (`_bindProbePort`), which is the single entry to `_dispatchRendererLoadAck`
    // with a `(probeId, observedAt)`. The router no longer registers a `loadAck`
    // window type at all, so a creative spraying `window.postMessage` acks (with
    // any guessed probeId) never reaches the gate. This handler covers only the
    // window-routed `:rendered`/`:failed` envelopes.
    if (context.type === 'rendered') {
      // 1. Payload shape: rendererOrigin is required, must be a non-empty
      //    string. Empty-string is treated as malformed (an empty origin
      //    can't equal `this._rendererOrigin` either, but the protocol-shape
      //    failure is the more accurate diagnosis for an operator).
      if (typeof data.rendererOrigin !== 'string' || data.rendererOrigin.length === 0) {
        this._emitSecurityEventAndTerminate(
          'renderer_protocol_error',
          ErrorCodes.RENDERER_PROTOCOL_ERROR,
          'Malformed SHARC:Renderer:rendered — `rendererOrigin` is missing, '
            + 'not a string, or empty.',
          {
            subtype: 'malformed_payload',
            reason: 'rendered_missing_renderer_origin',
          }
        );
        return;
      }

      // 2. Post-load origin echo. The renderer reports the origin it actually
      //    loaded from; if it differs from the construction-time
      //    `_rendererOrigin`, a redirect collapsed the cross-origin sandbox
      //    guarantee and we refuse to proceed. Per proposal lines 484–491,
      //    the operator-facing log line names both origins so the redirect
      //    misconfiguration is diagnosable from a single console.error.
      //
      //    Note: `_emitSecurityEventAndTerminate` prefixes its console.error
      //    with `[SHARCContainer] [<type>]`, so the message we pass omits
      //    the `[SHARCContainer]` prefix shown in the spec snippet — the
      //    helper adds the bracket-tag prefix to produce the spec-intended
      //    `[SHARCContainer] [renderer_origin_mismatch] Renderer origin
      //    mismatch — refusing to load. …` log line.
      if (data.rendererOrigin !== this._rendererOrigin) {
        // Trust boundary: `this._rendererOrigin` is parsed from the
        // operator-supplied `creativeRendererUrl` at construction (URL.origin
        // canonicalization) — trusted input, concatenated raw. `data.rendererOrigin`
        // is renderer-supplied via postMessage — sanitized before logging
        // because the renderer is partially-trusted (operator-deployed,
        // cross-origin) and could craft control-char sequences for log
        // deception.
        this._emitSecurityEventAndTerminate(
          'renderer_origin_mismatch',
          ErrorCodes.RENDERER_ORIGIN_MISMATCH,
          'Renderer origin mismatch — refusing to load.\n'
            + '  Expected origin: ' + this._rendererOrigin + ' (from creativeRendererUrl)\n'
            + '  Actual origin:   ' + this._sanitizeForLog(data.rendererOrigin) + ' (after redirect)\n'
            + 'Redirects on creativeRendererUrl are not permitted — they can collapse the cross-origin sandbox guarantee. Configure creativeRendererUrl to the post-redirect canonical URL.\n'
            + 'See: https://github.com/IABTechLab/SHARC/blob/main/docs/api-reference.md#10-renderer-protocol',
          {
            // RAW renderer-supplied value — operators on the structured
            // channel get fidelity. Sanitization is dev-channel-only (the
            // multi-line console.error above already runs the value through
            // _sanitizeForLog).
            expectedOrigin: this._rendererOrigin,
            actualOrigin: data.rendererOrigin,
          }
        );
        return;
      }

      // 3. Accept. A post-first-render `:rendered` (creativeRendered already
      //    true) is a document.open self-rewrite re-anchor — re-assert
      //    lifecycle state to the reopened generation's SDK over the SAME
      //    surviving port (ADR 2026-06-15; no re-transfer, no relink) rather
      //    than re-running the one-time handshake (which would illegally
      //    re-transition the router and re-arm timers). The envelope is already
      //    nonce-authenticated by the router gate, so only a renderer-
      //    provisioned reopen reaches here.
      if (this.creativeRendered) {
        // Distinguish a legitimate document.open self-rewrite from a bare
        // REPLAYED `:rendered` (S1 attack, RTR-D15). A real reopen fires a
        // fresh iframe-element `load` (C6 diagnostic) — the backstop sets
        // `_postRenderLoadSinceRendered`. A replay with no intervening reopen
        // has no new load → still rejected as out-of-phase, preserving the
        // S1 replay defense. (The router gate already authenticated the
        // nonce; this discriminator is the reopen-vs-replay decision the
        // router's static phase table cannot make.)
        if (!this._postRenderLoadSinceRendered) {
          this._invokeSecurityCallback({
            type: 'unauthorized_protocol',
            severity: 'error',
            timestamp: Date.now(),
            placementSessionId: this.placementSessionId,
            message: 'Envelope rejected by router (out-of-phase)',
            details: {
              type: 'SHARC:Renderer:',
              phase: /** @type {any} */ (this.protocolRouter.getPhase()),
              reason: 'out-of-phase',
            },
          });
          return;
        }
        // Consume the load marker so the NEXT `:rendered` again requires a
        // fresh reopen load to re-anchor.
        this._postRenderLoadSinceRendered = false;
        this._onRendererReopened();
        return;
      }
      this._onRendererRendered();
      return;
    }

    if (context.type !== 'failed') {
      return;
    }
    // `failed` — payload shape: `reason` is required, must be a non-empty
    // string. Per proposal § Renderer protocol messages, `reason` is the
    // renderer's human-readable explanation of why it could not render.
    if (typeof data.reason !== 'string' || data.reason.length === 0) {
      this._emitSecurityEventAndTerminate(
        'renderer_protocol_error',
        ErrorCodes.RENDERER_PROTOCOL_ERROR,
        'Malformed SHARC:Renderer:failed — `reason` is missing, '
          + 'not a string, or empty.',
        {
          subtype: 'malformed_payload',
          reason: 'failed_missing_reason',
        }
      );
      return;
    }

    // Bridge-load-failed routing (0.7.1, issue #82, SE guardrail #5). The
    // renderer signals a bridge import failure with `reason: 'bridge_load_failed'`
    // plus a `bridge` field carrying the identifier ('mraid', 'safeframe', ...).
    // Routed to the `bridge_load_failed` structured-channel variant so
    // operators on `onSecurityEvent` see bridge-load failures as their own
    // event type — distinct from generic renderer failures even though both
    // surface error code 2115 to `onError`. See design doc § 4 § Failure
    // modes table.
    if (data.reason === 'bridge_load_failed') {
      // `bridge` field is the failed identifier. Defense-in-depth: validate
      // shape, but route to bridge_load_failed regardless (the reason field
      // is already the trust anchor — the bridge name is just a refinement).
      // Length-bound at the container too — the renderer already caps these
      // at 200/500 (`examples/renderer/index.html`), but a forked or hostile
      // renderer page could send unbounded strings; defense-in-depth.
      const bridgeName = (typeof data.bridge === 'string' && data.bridge.length > 0)
        ? data.bridge.slice(0, 200)
        : 'unknown';
      const bridgeUrl = (typeof data.url === 'string')
        ? data.url.slice(0, 500)
        : '';
      this._emitSecurityEventAndTerminate(
        'bridge_load_failed',
        ErrorCodes.RENDERER_FAILED,
        'Renderer reported bridge load failure: '
          + this._sanitizeForLog(bridgeName) + ' — '
          + this._sanitizeForLog(data.reason),
        {
          reason: data.reason,
          // RAW renderer-supplied bridge name + url — operators on the
          // structured channel get fidelity. Sanitization is dev-channel-only.
          bridge: bridgeName,
          url: bridgeUrl,
        }
      );
      return;
    }

    this._emitSecurityEventAndTerminate(
      'renderer_failed',
      ErrorCodes.RENDERER_FAILED,
      'Renderer reported failure: ' + this._sanitizeForLog(data.reason),
      // RAW renderer-supplied reason — operators on the structured channel
      // get fidelity. Sanitization is dev-channel-only (the message string
      // above already runs through _sanitizeForLog).
      { reason: data.reason }
    );
  }

  /**
   * Resolves a pending first-load probe armed by `_armRendererBackstop`. The
   * router has already validated the envelope (source/origin/nonce/
   * placementSessionId/phase); this handler only invokes the waiting callback
   * (if any) and ignores stray `loadAck` envelopes.
   *
   * Single-consume invariant (#269): the legitimate handshake posts exactly
   * one `loadProbe` and expects exactly one `loadAck`. Once that first ack has
   * resolved the probe, `_loadAckConsumed` latches `true` and every subsequent
   * `loadAck` is explicitly dropped here — not merely inert because
   * `_pendingLoadProbe` happens to be null. This keeps the single-use property
   * true by intent, surviving refactors that might otherwise leave a window
   * where `_pendingLoadProbe` is re-armed. A forged / replayed / late second
   * ack therefore cannot re-invoke `onAck`, alter `verifiedFirstLoad`, or
   * suppress the unauthorized-navigation backstop, regardless of phase.
   * @private
   */
  /**
   * Binds the container's `port1` as the load-probe channel (ADR 2026-06-15).
   * Captures `port1` from the protocol's MessageChannel and registers a
   * captured-native `message` listener for `SHARC:Creative:loadAck` envelopes.
   * The SDK protocol's own `port1.onmessage` (session-gated SDK traffic) and
   * this `addEventListener('message', …)` probe listener coexist on the same
   * port — the probe listener filters to `:loadAck` and ignores SDK traffic;
   * the SDK's `onmessage` ignores probe envelopes (no valid `sessionId`).
   *
   * `port1` is stable across `document.open` reopens: the channel is created
   * once at first render and never re-transferred (the relink is retired), so
   * this binds exactly once. Idempotent — a second call is a no-op.
   * @private
   */
  _bindProbePort() {
    if (this._probePort) return;
    const channel = this._protocol && this._protocol._channel;
    const port1 = channel && channel.port1;
    if (!port1) return;
    this._probePort = port1;
    const handler = (event) => {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'SHARC:Creative:loadAck') return;
      // Monotonic observation timestamp for the strict temporal binding.
      const observedAt = (typeof performance !== 'undefined'
        && typeof performance.now === 'function') ? performance.now() : Date.now();
      this._dispatchRendererLoadAck(data.probeId, observedAt);
    };
    this._probePortHandler = handler;
    const aelNative = SHARCContainer._NATIVE_ET_AEL;
    try {
      if (aelNative) {
        aelNative.call(port1, 'message', handler, false);
      } else {
        port1.addEventListener('message', handler, false);
      }
      if (SHARCContainer._NATIVE_PORT_START) {
        SHARCContainer._NATIVE_PORT_START.call(port1);
      } else if (typeof port1.start === 'function') {
        port1.start();
      }
    } catch (_) {
      // Binding the probe listener must never throw into load: a failure leaves
      // the gate to time out → 2118 (fail-closed), the correct posture.
      this._probePort = null;
      this._probePortHandler = null;
    }
  }

  _dispatchRendererLoadAck(probeId, observedAt) {
    // Strict ack gating (ADR 2026-06-15 § Ratified SE conditions, condition 1).
    // Authentication is the ack's ARRIVAL on `port1` (possession); these checks
    // reject stale/pre-computed/replayed acks that also arrive on the port.
    // 1. single-consume per cycle.
    if (this._loadAckConsumed) return;
    // 2. id binding: must bear the currently-armed probeId.
    if (this._armedProbeId === null || probeId !== this._armedProbeId) return;
    // 3. temporal binding: must be observed strictly AFTER the probe was issued.
    //    A pre-computed in-flight ack that outlived a prior realm's teardown is
    //    observed at/before the issue timestamp of the NEXT probe → rejected.
    if (typeof observedAt !== 'number'
      || this._armedProbeIssuedAt === null
      || observedAt <= this._armedProbeIssuedAt) {
      return;
    }
    const cb = this._pendingLoadProbe;
    if (typeof cb === 'function') {
      this._loadAckConsumed = true;
      this._pendingLoadProbe = null;
      cb();
    }
  }

  /**
   * Pipes `this._creativeHtml` through every registered extension's
   * `injectIntoMarkup()` in registration order. Injection is Markup-variant
   * only — the URL variant never injects (proposal § Injection Across
   * Variants; the `useMarkupInjection` fetch+srcdoc opt-in was removed
   * 2026-07-05).
   *
   * @returns {string} The (possibly injected) HTML to post to the renderer.
   * @private
   */
  _runMarkupInjection() {
    let html = /** @type {string} */ (this._creativeHtml);
    let injected = false;

    // Built-in SDK injection runs FIRST so operator extensions see the markup
    // with the SDK already present. No-op when `creativeSdkUrl` was not set
    // at construction.
    if (this._creativeSdkUrl !== null) {
      const beforeBuiltin = html;
      // 0.7.2 PR 4.1 round-1 fix: mirror the operator-extension
      // throw-tolerance contract below. Self-DOS protection — a throwing
      // getter on creativeSdkScriptAttrs or a value whose toString throws
      // shouldn't break the entire iframe load event.
      try {
        html = this._injectCreativeSdk(html);
        if (html !== beforeBuiltin) injected = true;
      } catch (injectErr) {
        console.warn(
          '[SHARCContainer] Built-in SDK injection threw; continuing with original HTML.',
          injectErr && (injectErr.message || injectErr)
        );
      }
    }

    const injectors = this._extensions.filter(
      (ext) => typeof ext.injectIntoMarkup === 'function'
    );
    if (injectors.length === 0) {
      if (injected) this.creativeInjected = true;
      return html;
    }

    for (const injector of injectors) {
      try {
        const result = injector.injectIntoMarkup(html);
        if (typeof result === 'string' && result.length > 0) {
          html = result;
          injected = true;
        }
      } catch (injectErr) {
        console.warn(
          '[SHARCContainer] Extension injectIntoMarkup threw; continuing with prior HTML.',
          injectErr && (injectErr.message || injectErr)
        );
      }
    }
    if (injected) {
      this.creativeInjected = true;
    }
    return html;
  }

  /**
   * HTML-escapes a string for safe insertion inside a double-quoted attribute
   * value. Replaces in order: `&` → `&amp;` (first, so we don't double-escape),
   * `"` → `&quot;`, `<` → `&lt;` (defense-in-depth — `<` inside an attribute
   * is legal but escaping removes any chance an upstream HTML scanner mistakes
   * the boundary). Defense against attribute-injection when operator pipelines
   * thread user-derived data (RTB macros, A/B config) through `creativeSdkUrl`
   * or string `creativeSdkScriptAttrs` values.
   *
   * @param {string|number} value - Raw attribute value. Internal `String(value)`
   *   coercion handles numbers (`creativeSdkScriptAttrs: { 'data-rtb-id': 42 }`);
   *   other non-string types are gated upstream in `_buildCreativeSdkScriptTag`.
   * @returns {string} HTML-attribute-safe escaped value.
   * @private
   */
  static _escapeAttrValue(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  /**
   * Builds the `<script src="...">` tag for the auto-injected creative SDK.
   * Serializes `attrs` with React-style conventions: `true` → bare attribute,
   * `false`/`null`/`undefined` → omitted, strings/coercible → quoted +
   * HTML-escaped via `_escapeAttrValue`.
   *
   * @param {string} url - The validated `creativeSdkUrl`.
   * @param {Object} attrs - The `creativeSdkScriptAttrs` option.
   * @returns {string} A complete `<script ...></script>` tag.
   * @private
   */
  static _buildCreativeSdkScriptTag(url, attrs) {
    let serialized = '';
    if (attrs && typeof attrs === 'object') {
      const keys = Object.keys(attrs);
      for (let i = 0; i < keys.length; i++) {
        const name = keys[i];
        // 0.7.2 PR 4.1 round-1 fix: validate each name against a deliberately
        // strict subset of the HTML5 attribute-name grammar — letter first,
        // then letters/digits/hyphen/underscore/colon/period. Tighter than the
        // formal HTML5 spec (which also allows leading `_`, `:`, or digits)
        // but adequate for the operator-common attribute-name shapes used on
        // <script> tags (async, defer, integrity, nonce, type, data-*, aria-*,
        // etc.). Operators who hit this can rename. The value path is
        // HTML-escaped via _escapeAttrValue, but the name path emits verbatim
        // — a hostile key like `'></script><img src=x onerror=alert(1)'` would
        // break out of the <script> tag despite the value being escaped.
        // Operators threading user-derived data through
        // Object.keys(creativeSdkScriptAttrs) get a loud console.warn rather
        // than silent HTML injection. Rejects whitespace, quotes, angle
        // brackets, `=`, `/`.
        if (!/^[a-zA-Z][a-zA-Z0-9_:.-]*$/.test(name)) {
          console.warn(
            '[SHARCContainer] Skipping invalid attribute name in creativeSdkScriptAttrs: '
            + JSON.stringify(name)
          );
          continue;
        }
        const value = attrs[name];
        if (value === false || value === null || value === undefined) continue;
        if (value === true) {
          serialized += ' ' + name;
        } else if (typeof value === 'string' || typeof value === 'number') {
          // 0.7.3 follow-up (#107): explicitly gate on string|number rather than
          // String(value) on arbitrary types. `Symbol` throws on `String(Symbol)`;
          // objects with throwing `toString` throw; plain objects silently
          // coerce to `"[object Object]"`. Throwing values were caught by the
          // outer try/catch in _runMarkupInjection, but the failure mode was
          // silent re: cause. Plain objects produced corrupt markup with no
          // warning. Now: unsupported value types skipped + warned (same
          // pattern as the attribute-name validation above).
          serialized += ' ' + name + '="' + SHARCContainer._escapeAttrValue(value) + '"';
        } else {
          console.warn(
            '[SHARCContainer] Skipping creativeSdkScriptAttrs[' + JSON.stringify(name) + '] '
            + 'with unsupported value type ' + typeof value
            + ' (expected boolean | string | number | null | undefined)'
          );
        }
      }
    }
    return '<script src="' + SHARCContainer._escapeAttrValue(url) + '"' + serialized + '></script>';
  }

  /**
   * Finds the insertion index for built-in creative SDK injection.
   *
   * This intentionally stays small and dependency-free while avoiding the
   * known regex anchor pitfalls: comment-contained tags, `>` inside quoted tag
   * attributes, and `>` inside legacy doctype internal subsets.
   *
   * @param {string} html - Pre-injection markup.
   * @returns {number|null} Insertion index, or null when no anchor is present.
   * @private
   */
  static _findCreativeSdkInjectionIndex(html) {
    let htmlIndex = null;
    let doctypeIndex = null;

    for (let i = 0; i < html.length; i++) {
      if (html.charCodeAt(i) !== 60 /* < */) continue;

      if (html.startsWith('<!--', i)) {
        const commentEnd = html.indexOf('-->', i + 4);
        if (commentEnd === -1) return htmlIndex !== null ? htmlIndex : doctypeIndex;
        i = commentEnd + 2;
        continue;
      }

      const lower = html.slice(i, i + 9).toLowerCase();
      if (lower.startsWith('<!doctype')) {
        const end = SHARCContainer._findMarkupDeclarationEnd(html, i + 9);
        if (end !== -1 && doctypeIndex === null) doctypeIndex = end + 1;
        if (end !== -1) i = end;
        continue;
      }

      if (html.charCodeAt(i + 1) === 47 /* / */) continue;

      const nameStart = i + 1;
      let nameEnd = nameStart;
      while (/[A-Za-z0-9]/.test(html.charAt(nameEnd))) nameEnd++;
      const tagName = html.slice(nameStart, nameEnd).toLowerCase();
      if (tagName !== 'head' && tagName !== 'html') continue;

      const boundary = html.charAt(nameEnd);
      if (boundary !== '>' && !/\s/.test(boundary)) continue;

      const tagEnd = SHARCContainer._findMarkupTagEnd(html, nameEnd);
      if (tagEnd === -1) continue;
      if (tagName === 'head') return tagEnd + 1;
      if (htmlIndex === null) htmlIndex = tagEnd + 1;
      i = tagEnd;
    }

    return htmlIndex !== null ? htmlIndex : doctypeIndex;
  }

  /**
   * Finds the closing `>` for a markup tag, ignoring `>` inside quoted attrs.
   * @param {string} html
   * @param {number} start
   * @returns {number}
   * @private
   */
  static _findMarkupTagEnd(html, start) {
    let quote = '';
    for (let i = start; i < html.length; i++) {
      const ch = html.charAt(i);
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Finds the closing `>` for declarations such as `<!DOCTYPE ...>`, ignoring
   * quoted text and `>` inside legacy internal subsets.
   * @param {string} html
   * @param {number} start
   * @returns {number}
   * @private
   */
  static _findMarkupDeclarationEnd(html, start) {
    let quote = '';
    let bracketDepth = 0;
    for (let i = start; i < html.length; i++) {
      const ch = html.charAt(i);
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '[') {
        bracketDepth++;
      } else if (ch === ']' && bracketDepth > 0) {
        bracketDepth--;
      } else if (ch === '>' && bracketDepth === 0) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Built-in injection: inserts a `<script src="creativeSdkUrl"></script>` tag
   * into Markup-variant creative HTML at the most-specific position present.
   * Runs FIRST in `_runMarkupInjection` (before any operator extensions), so
   * operator-supplied `extensions: [...]` see the markup with the SDK already
   * present.
   *
   * Position contract (4-step, locked 2026-05-17):
   *
   *   1. After `<head>` open tag — most specific. Token scanning rejects
   *      `<header>`, `<headers>`, comment-contained `<head>`, and `>` inside
   *      quoted attributes.
   *   2. After `<html>` open tag — same token-boundary defense against
   *      `<htmlfoo>` and similar non-`<html>` start sequences.
   *   3. After `<!DOCTYPE>` — fragment with doctype only. Inserting BEFORE the
   *      doctype pushes the browser into quirks-mode rendering, subtly breaking
   *      legacy creatives that rely on standards-mode layout. Explicit AFTER
   *      branch is the refinement (2026-05-17).
   *   4. Prepend — true fragment (no doctype, no `<html>`, no `<head>`).
   *
   * Idempotency: when `_creativeSdkSkipIfPresent` is true (default), markup
   * already containing a `<script src="...sharc-creative.js">` tag passes
   * through unchanged. The script-src context is required — bare substring
   * presence in comments, metadata, or inline-script text does NOT trigger
   * the skip (closes the silent-no-op footgun where a `<!-- sharc-creative.js -->`
   * comment caused the SDK to never load and bridge auto-install to time out).
   *
   * Regex contract (0.7.2 PR 4.1 round-4 fix):
   *
   *   /<script[^>]*(?<![\w.:-])src\s*=\s*["']?(?:[^"'\s>?#]*?\/)?sharc-creative\.js(?=[?#"'\s>]|$)/i
   *
   *   - `(?<![\w.:-])src` is a negative lookbehind that rejects attribute names
   *     ending in `src` like `data-src`, `xsrc`, `1src`, `foo_src`, `data.src`,
   *     `xml:src`, etc. The round-1 form used `\bsrc`, but `\b` fires after `-`
   *     (a non-word char), so `data-src=` matched. Round-2 closed `\b` with
   *     `(?<![\w-])`. Round-3 adds `.` and `:` — both are valid HTML5
   *     attribute-name continuation chars, so `data.src` and `xml:src` are
   *     parsed as single attribute names by browsers but the round-2 form
   *     still matched their trailing `src`. The lookbehind now requires the
   *     char before `src` to NOT be any of `[\w.:-]` — whitespace, `"`/`'`,
   *     `<`, etc. all pass. V8 has supported lookbehind since 2018 so this is
   *     fine for modern browsers/Node.
   *   - `["']?` makes the quote OPTIONAL — `<script src=https://cdn/sharc-creative.js>`
   *     is legal HTML and common in minified ad markup (the exact use case
   *     this option targets). The pre-fix regex required `["']` and missed it.
   *   - `(?:[^"'\s>?#]*?\/)?` is an optional path prefix that MUST end in `/`.
   *     This kills filename-collision false-positives like `notsharc-creative.js`,
   *     `foosharc-creative.js`, etc. — the prefix can't backtrack into the
   *     literal `sharc-creative.js` because it terminates with a slash. The
   *     round-4 fix excludes `?` and `#` from the prefix to close a query-
   *     string-slash bypass: `<script src="loader.js?next=/sharc-creative.js">`
   *     previously matched because the prefix happily consumed `loader.js?next=/`
   *     (the `?` and `=` weren't in the exclusion class). The real load there
   *     is `loader.js`; `sharc-creative.js` only appears in the query value.
   *     Restricting the prefix to URL-path characters (no `?` or `#`) means
   *     the regex only fires when `sharc-creative.js` is actually the
   *     filename being loaded.
   *   - `sharc-creative\.js` literal filename.
   *   - `(?=[?#"'\s>]|$)` lookahead asserts a filename boundary — query (`?`),
   *     fragment (`#`), closing quote, whitespace, `>`, or end-of-string. Kills
   *     extension-collision false-positives like `sharc-creative.js.map`.
   *
   * @param {string} html - Pre-injection markup.
   * @returns {string} Markup with SDK tag injected, or unchanged when no `creativeSdkUrl`
   *   is configured / markup isn't a string / idempotency guard fires.
   * @private
   */
  _injectCreativeSdk(html) {
    if (this._creativeSdkUrl === null) return html;
    if (typeof html !== 'string') return html;
    if (this._creativeSdkSkipIfPresent
        && /<script[^>]*(?<![\w.:-])src\s*=\s*["']?(?:[^"'\s>?#]*?\/)?sharc-creative\.js(?=[?#"'\s>]|$)/i.test(html)) {
      return html;
    }
    const scriptTag = SHARCContainer._buildCreativeSdkScriptTag(
      this._creativeSdkUrl,
      this._creativeSdkScriptAttrs,
    );
    const insertionIndex = SHARCContainer._findCreativeSdkInjectionIndex(html);
    if (insertionIndex !== null) {
      return html.slice(0, insertionIndex) + scriptTag + html.slice(insertionIndex);
    }
    return scriptTag + html;
  }

  /**
   * Handler invoked when the renderer's envelope-validated
   * `SHARC:Renderer:rendered` message arrives. Clears the reply timeout,
   * detaches the message listener, sets `creativeRendered`, and fires
   * `initChannel` directly off that signal — event-driven, no wall-clock
   * timer (ADR §5.0).
   *
   * Reviewer fix (security pass 1 / code pass 1 HIGH): drop late `:rendered`
   * arrivals that race a fatal-error termination. `_handleFatalError` calls
   * `_terminate` asynchronously (after `sendFatalError` resolves), so a
   * `:rendered` racing the timeout-induced termination would otherwise flip
   * `creativeRendered` true on a container that fataled — confusing
   * observability state.
   *
   * @private
   */
  _onRendererRendered() {
    // Drop after fatal termination. The handler may still be on `window` until
    // _terminate's listener-detach runs.
    if (this._terminated) return;
    // Idempotency: duplicate :rendered (stray reply, double-dispatch, etc.).
    if (this.creativeRendered) return;

    this._clearTimeout('rendererReply');
    // 0.7.7: transition the router into `rendered` so any further
    // `SHARC:Renderer:rendered` / `:failed` envelopes are rejected as
    // out-of-phase. The handler's idempotency check above already drops
    // duplicates from the legacy code path; phase enforcement is the
    // defense-in-depth layer.
    this.protocolRouter.transitionTo('rendered');
    this.creativeRendered = true;
    // 0.7.2: poke the lifecycle adapter to re-check its initial-transition
    // gate. The Markup-variant gate in `HtmlAdapter._maybeAdvanceToActive`
    // waits for `creativeRendered === true`. In environments without
    // IntersectionObserver, no other signal would re-trigger the gate
    // after this flips. Real browsers fire a second iframe `load` event
    // after `document.write(creativeHtml)` which also re-triggers the
    // gate — but the explicit poke makes the no-IO fallback path work
    // reliably regardless of load-event ordering. `BaseLifecycleAdapter`
    // declares `_maybeAdvanceToActive` as a `@protected` no-op so the
    // generated `.d.ts` keeps the symbol out of the public type surface;
    // bracket-notation call bypasses TS's protected-visibility check
    // (SHARCContainer is not a subclass of BaseLifecycleAdapter) without
    // weakening the API contract for external consumers.
    if (this._lifecycleAdapter) {
      this._lifecycleAdapter['_maybeAdvanceToActive']();
    }
    // Stamp the wall-clock timestamp at the moment `:rendered` is accepted.
    // The backstop (armed below) reads this to compute `msSinceRender` for
    // the 2118 `UnauthorizedNavigationEvent` payload — operators monitoring
    // 2118 use the delay to distinguish fast-fire (creative immediately
    // reloaded, ~0–100ms) from slow-fire (delayed injection / meta-refresh
    // re-injection, multiple seconds). Phase D round-4 SRE HIGH-1.
    this._renderedAt = Date.now();
    // Reflect to DOM per spec § DOM stamping additions. Defensive
    // `if (this._iframe)` guard mirrors the deferred initChannel pattern
    // below — `_terminate` may run between dispatch and this point and
    // null `_iframe`. The new `_terminated` early-return at the top of this
    // method should already cover the typical case; belt-and-suspenders here
    // matches existing precedent.
    if (this._iframe) {
      this._iframe.setAttribute('data-sharc-creative-rendered', 'true');
      // Markup's renderer posts :rendered from its inner `window 'load'` (R-2)
      // so the SHARC SDK is ready before the MessageChannel bootstrap starts.
      // The written document's normal window load may still be pending while
      // parser/static scripts and other subresources finish. Verify that first
      // load with a renderer probe so the expected document.write completion is
      // allowed, but a real cross-document navigation still fails if the
      // renderer does not answer.
      this._armRendererBackstop({ verifyFirstLoad: true });

      // Event-driven handshake (ADR 2026-06-13 §5.2, R-1): the renderer's
      // `:rendered` post is the creative-rendered anchor (re-anchored to the
      // inner `window 'load'` in examples/renderer/index.html per R-2). Fire
      // `initChannel` directly off that signal — no wall-clock gate. The
      // retired 200ms timer was conservative parity, not a real readiness
      // signal; the success path is gated only on `creative-rendered ∧
      // env-ready`. The OM-SDK-listener-registration concern the 200ms hedged
      // is subsumed: the SDK listener is registered by `window 'load'`, which
      // is now strictly later than the prior DCL anchor.
      //
      // targetOrigin is the construction-time `_rendererOrigin`, NOT '*'. The
      // Markup variant has a stable trust anchor (the renderer URL was
      // rule-4..7-validated at construction); using '*' would leak the
      // MessagePort and placementSessionId to whatever document happens to
      // occupy the iframe.
      this._protocol.initChannel(
        this._iframe.contentWindow,
        /** @type {string} */ (this._rendererOrigin),
        this.placementSessionId
      );
      // ADR 2026-06-15: bind `port1` as the load-probe channel. The renderer
      // IIFE catches the same bootstrap transfer and holds `port2` to answer
      // probes; the gate sends `:loadProbe` over `port1` and authenticates the
      // `:loadAck` by its arrival here.
      this._bindProbePort();
    }
  }

  /**
   * Handles a re-anchored `SHARC:Renderer:rendered` from a document.open
   * self-rewrite (ADR 2026-06-13-document-open-shim-mechanism.md). The first
   * render already ran `_onRendererRendered` (router now in the `rendered`/
   * post-render phase, backstop armed, `creativeRendered` true). A passive
   * legacy creative then reopened its document; the renderer's shim re-injected
   * the harness (protocol→creative→bridge→OMID→load-probe prelude) into the
   * reopened generation and re-posted `:rendered` off its `window 'load'`. The
   * single bootstrap `port2` SURVIVED the `document.open()` in the renderer
   * IIFE's closure (it is held outside the rewritten document's script context),
   * and the IIFE re-pushes that SAME live port to the re-armed in-realm SDK
   * (`window.SHARC.__attachRendererPort`). So the container does NOT re-run
   * `initChannel` and does NOT re-transfer a port — minting a fresh channel here
   * would NEUTER the IIFE's surviving port and kill the load-probe answerer.
   * Instead the container holds `port1` steady and only re-asserts lifecycle
   * state over the SAME surviving channel (ADR 2026-06-15). No port re-transfer,
   * no relink handshake, no router re-transition, no timer re-arm, no new wire
   * type.
   *
   * Security (SE C3): this path is reachable ONLY for a nonce-authenticated
   * `:rendered` (router gate step 7). A real cross-document navigation produces
   * a document the renderer never wrote — no prelude, no nonce — so it cannot
   * forge a `:rendered` to reach here; it still goes unanswered and trips 2118
   * via the backstop. The reopen re-uses the SAME placementSessionId, the SAME
   * surviving channel, and the SAME validated renderer origin — no new trust
   * grant.
   * @private
   */
  _onRendererReopened() {
    if (this._terminated || !this._iframe || !this._iframe.contentWindow) return;
    // Re-stamp the render anchor so a subsequent backstop 2118 (if a LATER
    // real navigation follows the reopen) reports msSinceRender from the most
    // recent legitimate render, not the first.
    this._renderedAt = Date.now();
    // ADR 2026-06-15 § Mechanism point 2: NO port re-transfer on reopen. The
    // single `port2` SURVIVED the `document.open` in the renderer IIFE's
    // closure (verified); the IIFE re-pushes that SAME live port to the
    // re-armed SDK in-realm (`window.SHARC.__attachRendererPort`). Re-running
    // `initChannel` here would mint a FRESH channel and NEUTER the IIFE's
    // surviving port — killing the load-probe answerer. So the container holds
    // `port1` steady and only re-asserts lifecycle state.
    //
    // OMID/bridge re-sync (the KEEP item that formerly rode the retired
    // relink): re-assert the current state over the SAME surviving channel so
    // the reopened SDK re-syncs. `_lastSentState` is reset so the push is not
    // suppressed as a duplicate. Gated on a creative-queryable state with an
    // established session — a gen-1 reopen before createSession completed drives
    // the handshake fresh over the surviving port and the push is a harmless
    // no-op.
    const current = this._stateMachine ? this._stateMachine.getState() : null;
    if (current && this._stateMachine.isCreativeQueryable(current)
        && this._protocol.sessionId !== '') {
      this._protocol._lastSentState = undefined;
      this._protocol.sendStateChange(current);
      // Slice C (F6a) — same replay-precedent reset for the EV channel: the
      // reopened document re-armed the SDK with an EMPTY replay cache, so
      // reset the send dedup and re-push. Without this, an UNCHANGED
      // effective value would be suppressed as a duplicate and the reopened
      // SDK would never receive it.
      this._lastEffectivePayload = undefined;
      // Slice D (#413) — reset the extension cache too: the reopen re-injected
      // the renderer shim, so the creative-side OMID surface the extension
      // relays into starts empty; force a re-fan-out of the (possibly
      // unchanged) value so the extension re-syncs it downstream.
      this._lastExtensionEffectivePayload = undefined;
      this._pushEffectiveVisibility();
    }
  }

  // -------------------------------------------------------------------------
  // Protocol listener registration
  // -------------------------------------------------------------------------

  /**
   * Registers all incoming message listeners on the protocol.
   * @private
   */
  _registerProtocolListeners() {
    const proto = this._protocol;

    // createSession — session establishment
    proto.addListener(ProtocolMessages.CREATE_SESSION, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleCreateSession(msg);
    });

    // Creative:fatalError
    proto.addListener(CreativeMessages.FATAL_ERROR, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleCreativeFatalError(msg);
    });

    // Creative:getContainerState
    proto.addListener(CreativeMessages.GET_CONTAINER_STATE, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      const state = this._stateMachine.getState();
      const responseState = this._stateMachine.isCreativeQueryable(state) ? state : ContainerStates.READY;
      proto._resolve(msg, { currentState: responseState });
    });

    // Creative:getPlacementOptions
    proto.addListener(CreativeMessages.GET_PLACEMENT_OPTIONS, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      proto._resolve(msg, {
        currentPlacementOptions: this.environmentData.currentPlacement || {},
      });
    });

    // Creative:getPlacementConstraints
    proto.addListener(CreativeMessages.GET_PLACEMENT_CONSTRAINTS, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      const policy = this._placementPolicy || {};
      proto._resolve(msg, {
        maxWidth:           policy.maxWidth != null ? policy.maxWidth : null,
        maxHeight:          policy.maxHeight != null ? policy.maxHeight : null,
        allowedIntents:     policy.allowedIntents || ['resize', 'expand', 'fullscreen', 'collapse'],
        requireCloseRegion: !!policy.requireCloseRegion,
        allowOffscreen:     policy.allowOffscreen !== false,
      });
    });

    // Creative:log
    proto.addListener(CreativeMessages.LOG, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      console.log('[SHARC Creative Log]', msg.args && msg.args.message);
    });

    // Creative:reportInteraction
    proto.addListener(CreativeMessages.REPORT_INTERACTION, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleReportInteraction(msg);
    });

    // Creative:requestNavigation
    proto.addListener(CreativeMessages.REQUEST_NAVIGATION, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestNavigation(msg);
    });

    // Creative:setOrientationProperties (fire-and-forget)
    proto.addListener(CreativeMessages.SET_ORIENTATION_PROPERTIES, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleSetOrientationProperties(msg);
    });

    // Creative:requestPlacementChange
    proto.addListener(CreativeMessages.REQUEST_PLACEMENT_CHANGE, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestPlacementChange(msg);
    });

    // Creative:requestClose
    proto.addListener(CreativeMessages.REQUEST_CLOSE, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestClose(msg);
    });

    // Creative:getFeatures
    proto.addListener(CreativeMessages.GET_FEATURES, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      // Return the same merged feature list that was sent in Container:init.
      // _mergedSupportedFeatures is populated during _handleCreateSession.
      proto._resolve(msg, { features: this._mergedSupportedFeatures || this._explicitSupportedFeatures || [] });
    });

    // Creative:requestMessage — SafeFrame $sf.ext.message() bridged via requestFeature
    // The creative calls $sf.ext.message(msg) which maps to:
    //   SHARC.requestFeature('com.iabtechlab.sharc.safeframe.message', { payload: msg })
    // The container receives it here and delivers via onMessage for the publisher to handle.
    proto.addListener('SHARC:Creative:requestMessage', (msg) => {
      this._onMessage && this._onMessage('received', { type: 'safeframe-message', args: msg && msg.args });
      // Resolve immediately — fire-and-forget, SafeFrame spec doesn't define a return value
      proto._resolve(msg, {});
    });
  }

  // -------------------------------------------------------------------------
  // Session lifecycle handlers
  // -------------------------------------------------------------------------

  /**
   * Handles incoming createSession from the creative.
   * Establishes the session, clears the session timeout, and sends Container:init.
   * @param {Object} msg
   * @private
   */
  _handleCreateSession(msg) {
    this._clearTimeout('createSession');

    // ── 0.7.2 unconditional idempotency guard ──────────────────────────
    // A second createSession arriving after one was already accepted is
    // ALWAYS a protocol violation, regardless of `requireSharcInit`. The
    // underlying protocol layer (`acceptSession`) is not idempotent —
    // calling it twice overwrites `sessionId` and re-triggers
    // `Container:init`. Guard at the container layer with an
    // unconditional warn + early-return for both strict and permissive
    // modes. § 7.4 idempotency row, expanded from permissive-only to
    // unconditional during PR #92 review.
    const elapsedMs = this._loadedAt ? (Date.now() - this._loadedAt) : 0;
    // G10: `this._apiFramework` is locked at construction (non-writable +
    // non-configurable). Internal reads are safe by construction.
    const apiFrameworkValue = this._apiFramework;
    const bridgesSnapshot = this.bridges.slice();
    const placementSessionId = this.placementSessionId;
    if (this._protocol.sessionId !== '') {
      console.warn(
        '[SHARC] Duplicate createSession received at T+' + elapsedMs + 'ms '
        + 'for placement ' + placementSessionId + '; '
        + 'apiFramework=' + (apiFrameworkValue === null ? 'null' : apiFrameworkValue) + ', '
        + 'bridges=[' + bridgesSnapshot.join(',') + ']. '
        + 'The original session remains active; this duplicate is rejected.'
      );
      return;
    }

    // ── 0.7.2 G7: framework-aware handshake-mismatch warn (permissive) ─
    // When the operator opted out of the strict path (`requireSharcInit:
    // false`) and a handshake arrives from a creative whose declaration
    // doesn't match SHARC, emit the confused-deputy warn. Closes the SE
    // confused-deputy diagnostic gap: an unexpected SHARC-handshake from
    // a declared-non-SHARC creative is the exact signal operators want.
    //
    // Matrix per § 7.4:
    //   - apiFramework === SHARC_API_CODE  → silent (declaration matches)
    //   - otherwise (any non-SHARC code or null) → confused-deputy warn
    //
    // The warn fires ONLY when `requireSharcInit === false`. The strict
    // path (default) fatal-errors on the missing handshake before any
    // arrival window opens. Word "Unexpected" rather than "Late" — the
    // diagnostic is about declaration mismatch, not timing (a prompt
    // T+5ms handshake from a non-SHARC-declared creative is still a
    // confused-deputy signal worth surfacing).
    if (this._requireSharcInit === false && apiFrameworkValue !== SHARC_API_CODE) {
      const apiFrameworkLabel = apiFrameworkValue === null
        ? 'null (no container-runtime declared)'
        : String(apiFrameworkValue);
      console.warn(
        '[SHARC] Unexpected createSession received at T+' + elapsedMs + 'ms '
        + 'for placement ' + placementSessionId + '; '
        + 'apiFramework=' + apiFrameworkLabel + ', '
        + 'bridges=[' + bridgesSnapshot.join(',') + ']. '
        + 'Container was constructed with requireSharcInit:false; accepting the handshake. '
        + 'If this creative is expected to be SHARC-aware, declare creativeMeta.apis or '
        + 'set requireSharcInit:true.'
      );
    }

    // Establish session
    this._protocol.acceptSession(msg);

    // ── 0.7.2 invalid-UUID early-return ────────────────────────────────
    // `acceptSession` validates UUID v4 format (SEC-006); on invalid it
    // calls `_reject` and returns without setting `sessionId`. The
    // pre-0.7.2 code path continued the init flow anyway, which would
    // send `Container:init` with an empty sessionId (filtered at the
    // protocol port). Fail-closed instead: if the session wasn't
    // established, do NOT continue with init.
    if (this._protocol.sessionId === '') return;

    // Read placement type declared by the creative ('inline' or 'interstitial')
    const pt = msg.args && msg.args.placementType;
    this._placementType = (pt === 'interstitial') ? 'interstitial' : 'inline';

    // Store the creative's SHARC version for diagnostics/compatibility logging
    /** @private */ this._creativeVersion = (msg.args && msg.args.version) || null;

    // Build the merged supportedFeatures list:
    //   1. Explicit features passed via options.supportedFeatures
    //   2. Feature names contributed by each extension via getFeatureName()
    // Extensions auto-add feature names only. Pass explicit descriptor objects if
    // creatives need metadata such as version/capabilities from Container:init.
    // Extensions that don't implement getFeatureName() are silently skipped.
    const extensionFeatureNames = this._extensions
      .filter((ext) => typeof ext.getFeatureName === 'function')
      .map((ext) => {
        try { return ext.getFeatureName(); } catch (e) { return null; }
      })
      .filter(Boolean);

    // Auto-register placement feature strings
    const placementFeatures = [
      'com.iabtechlab.sharc.placement.resize',
      'com.iabtechlab.sharc.placement.constraints',
      'com.iabtechlab.sharc.placement.animate',
    ];

    // Built-in feature advert: when the container actually auto-injected
    // the SDK, surface the feature name so SHARC-aware creatives can
    // detect the operator-injection pattern and skip their own SDK-load
    // shim. Same canonical name PR #103's standalone
    // SHARCCreativeInjector advertised. Gate on the runtime
    // `_creativeSdkInjected` flag rather than the construction-time
    // `_creativeSdkUrl` so URL-variant containers — which never inject —
    // do NOT advertise a capability they couldn't deliver. Markup variant
    // sets the flag at construction (always injects when `creativeSdkUrl`
    // is set); on the URL variant it stays false. See 0.7.4 design § 2.1
    // (#106).
    const builtinInjectionFeatures = this._creativeSdkInjected
      ? ['com.iabtechlab.sharc.creative-injector']
      : [];

    const mergedFeatures = [
      ...this._explicitSupportedFeatures,
      ...extensionFeatureNames,
      ...builtinInjectionFeatures,
      ...placementFeatures,
    ];

    // Cache for subsequent getFeatures() queries from the creative
    /** @private */ this._mergedSupportedFeatures = mergedFeatures;

    // Build the full init payload
    // Priority 2: Include iframe's absolute position so bridges can use it for resize/expand
    // Fallback: when the iframe is hidden (display:none, e.g. visible:false preload),
    // its bounding rect is all-zero, which would make MRAID resize offsets target
    // viewport (0,0) and reject any negative offset as offscreen. The placementElement
    // anchor is laid out independently, so use it as the placement anchor whenever
    // the iframe rect is degenerate. The iframe is width:100%/height:100% of the
    // placementElement, so the rectangles match once the iframe becomes visible.
    let initialPosition = null;
    const rectSource = this._iframe || this.placementElement;
    if (rectSource) {
      try {
        let rect = rectSource.getBoundingClientRect();
        const degenerate = rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0;
        if (degenerate && this.placementElement && rectSource !== this.placementElement) {
          rect = this.placementElement.getBoundingClientRect();
        }
        // Add the native-supplied on-screen offset so the bridge's _initialPosition
        // (-> getDefaultPosition + resize anchor) is screen-relative, not the WebView-relative
        // 0,0. Guarded — embeds that never set an offset keep the raw rect verbatim. The host
        // usually sets the offset AFTER init (the WebView lays out post-construct), so this branch
        // commonly applies offset 0; getCurrentPosition is corrected live by setHostScreenOffset's
        // re-report.
        const _hoInit = this._hostScreenOffset;
        initialPosition = {
          x: rect.x + (_hoInit ? _hoInit.x : 0),
          y: rect.y + (_hoInit ? _hoInit.y : 0),
          width: rect.width,
          height: rect.height,
        };
      } catch (e) {
        // getBoundingClientRect may fail in non-browser environments; initialPosition stays null
      }
    }

    // R1 D2 — carry the REAL current lifecycle state, not hard-coded READY.
    // The field, name, type and envelope position are unchanged — this is a
    // value change, not a wire/schema change. When the adapter has promoted the
    // container past READY before init is sent (already-ACTIVE-at-init), the
    // creative gets a synchronously-correct currentState in onReady's env.
    // Non-queryable states (loading / terminated) fall back to READY so the
    // creative never observes a state it cannot query.
    const r1CurrentState = this._stateMachine.isCreativeQueryable(this._stateMachine.getState())
      ? this._stateMachine.getState()
      : ContainerStates.READY;

    const initArgs = {
      environmentData: {
        ...this.environmentData,
        currentState: r1CurrentState,
        version: SHARC_VERSION,
        ...(initialPosition !== null ? { initialPosition } : {}),
      },
      supportedFeatures: mergedFeatures,
    };

    // Send Container:init
    const _initTimeout = this._startTimeout('initResolve', () => {
      console.error('[SHARCContainer] Timeout waiting for Container:init resolve');
      this._handleFatalError(ErrorCodes.RESOLVE_TIMEOUT, 'Timeout waiting for init resolve');
    });

    this._protocol.sendInit(initArgs.environmentData, initArgs.supportedFeatures)
      .then((resolveValue) => {
        this._clearTimeout('initResolve');
        this._onMessage && this._onMessage('sent-resolved', { type: ContainerMessages.INIT, resolveValue });
        this._handleInitResolved(resolveValue);
      })
      .catch((rejectValue) => {
        this._clearTimeout('initResolve');
        console.error('[SHARCContainer] Creative rejected init:', rejectValue);
        this._handleFatalError(
          rejectValue && rejectValue.errorCode || ErrorCodes.CANNOT_EXECUTE_CREATIVE,
          'Creative rejected Container:init'
        );
      });
  }

  /**
   * Called when the creative resolves Container:init.
   * Transitions to READY, optionally fires startCreative.
   *
   * In permissive mode (`requireSharcInit: false`) with a late SHARC
   * handshake, the HTML lifecycle adapter may have already promoted the
   * container past READY (e.g. to ACTIVE via iframe-load + intersection).
   * In that case the `setState(READY)` would be rejected by the state
   * machine ("Invalid transition: 'active' → 'ready'") and the
   * handshake-driven lifecycle would be broken. Detect that the adapter
   * has already advanced past where this handler would transition us and
   * skip the redundant `setState` — the session is established correctly
   * regardless, and `_sendStartCreative` still fires.
   *
   * **Narrow gap remains:** the skip below only fires when state is no
   * longer LOADING. In permissive mode + bfcache-during-handshake (the
   * adapter's `_transitionToFrozen` walks the container from LOADING
   * through HIDDEN to FROZEN), a subsequent late `_handleInitResolved`
   * still produces a one-shot `'frozen' → 'ready'` invalid-transition
   * warn. Narrow combo (permissive + bfcache + handshake-aware creative
   * arriving slowly) — accepted as cosmetic warn for the edge case;
   * session is still established correctly via `acceptSession`.
   *
   * @param {*} _resolveValue
   * @private
   */
  _handleInitResolved(_resolveValue) {
    if (this._stateMachine.getState() === ContainerStates.LOADING) {
      this.setState(ContainerStates.READY);
    }
    // Else: adapter promoted us past READY (permissive-mode late
    // handshake). State is already at/past where we'd take it; skip the
    // setState to avoid an invalid-transition warn. Continue with the
    // post-init flow (autoStart) so the handshake's downstream effects
    // still apply.

    if (this.autoStart) {
      this._sendStartCreative();
    }
    // If autoStart is false, caller is responsible for calling _sendStartCreative()
    // via a public method (e.g., start()).

    // G5 T2 — URL-variant OMID tier-2 nonce delivery. Anchored HERE because
    // init-resolve is session convergence: the creative accepted Container:init
    // (its SDK is booted and listening on the port), so the port-only
    // omidShimInit cannot race the SDK's listener registration.
    this._maybeSendOmidShimInit();
  }

  /**
   * Sends Container:omidShimInit over the established port when OMID is armed
   * on a Creative URL placement (G5 T2 — the URL-path adaptation of the locked
   * srcdoc OMID-D2 mechanism ii, 0.7.8 design § 4.3).
   *
   * The markup variant keeps mechanism i (renderer source-rewrite bakes the
   * nonce); this send is URL-variant only. "OMID armed" reuses the exact
   * accessor the markup render-envelope site uses: an extension exposing
   * `getRendererOmidInjection()` with a derived protocolNonce (OmidCompatBridge
   * registers the `SHARC:Omid:` router protocol on the container 'load'
   * lifecycle event; nonce derivation resolves long before the handshake, so a
   * null here honestly means OMID is not active for this placement).
   *
   * Fire-and-forget: measurement delivery must never break the lifecycle.
   * @private
   */
  _maybeSendOmidShimInit() {
    if (!this.creativeUrl) return;
    let omidInjection = null;
    for (let ei = 0; ei < this._extensions.length; ei++) {
      const ext = this._extensions[ei];
      if (ext && typeof ext.getRendererOmidInjection === 'function') {
        const injection = ext.getRendererOmidInjection();
        if (injection
            && typeof injection.protocolNonce === 'string'
            && injection.protocolNonce.length > 0) {
          omidInjection = injection;
          break;
        }
      }
    }
    if (!omidInjection) return;
    const p = this._protocol._sendMessage(ContainerMessages.OMID_SHIM_INIT, {
      protocolNonce: omidInjection.protocolNonce,
      placementSessionId: this.placementSessionId,
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  /**
   * Sends Container:startCreative.
   * @private
   */
  _sendStartCreative() {
    this._startTimeout('startResolve', () => {
      console.error('[SHARCContainer] Timeout waiting for Container:startCreative resolve');
      this._handleFatalError(ErrorCodes.NO_START_REPLY, 'Timeout waiting for startCreative resolve');
    });

    this._protocol.sendStartCreative()
      .then((resolveValue) => {
        this._clearTimeout('startResolve');
        this._onMessage && this._onMessage('sent-resolved', { type: ContainerMessages.START_CREATIVE, resolveValue });
        this._handleStartCreativeResolved();
      })
      .catch((rejectValue) => {
        this._clearTimeout('startResolve');
        console.error('[SHARCContainer] Creative rejected startCreative:', rejectValue);
        this._handleFatalError(
          rejectValue && rejectValue.errorCode || ErrorCodes.CANNOT_EXECUTE_CREATIVE,
          'Creative rejected Container:startCreative'
        );
      });
  }

  /**
   * Manually triggers startCreative (when autoStart is false).
   * Only valid when the container is in the READY state.
   * @returns {void}
   */
  start() {
    if (this._stateMachine.getState() !== ContainerStates.READY) {
      console.warn('[SHARCContainer] start() called but state is not READY');
      return;
    }
    this._sendStartCreative();
  }

  /**
   * Called when the creative resolves Container:startCreative.
   * Makes the iframe visible and transitions to ACTIVE.
   * @private
   */
  _handleStartCreativeResolved() {
    // Make the iframe visible
    if (this._iframe) {
      this._iframe.style.display = 'block';
    }
    this._transitionToActive();

    // R1 D1 — push the current lifecycle state on session-establish.
    // By the time startCreative has resolved, the creative's protocol session
    // is fully established (its sessionId is set from Container:init), so this
    // stateChange passes the creative-side session gate (_onPortMessage). This
    // is the #336 source fix: it fires UNCONDITIONALLY — even when
    // _transitionToActive took no transition because the adapter already
    // promoted the container to ACTIVE before the handshake (the already-ACTIVE
    // skip would otherwise leave the creative never learning it is active). The
    // mid-handshake setState(ACTIVE) was dropped at the creative's port before
    // it had a sessionId; this push lands after the session is established.
    // Mirrors the _syncAudioState / _syncPlacementState re-sync above —
    // R1 adds the missing lifecycle-state sync alongside them.
    // Native / plain-HTML (no handshake, sessionId === '') no-ops in
    // sendStateChange; loading / terminated are gated by isCreativeQueryable.
    const r1State = this._stateMachine.getState();
    if (this._stateMachine.isCreativeQueryable(r1State)) {
      this._protocol.sendStateChange(r1State);
    }
  }

  // -------------------------------------------------------------------------
  // Environment state sync helpers
  // -------------------------------------------------------------------------

  /**
   * Transitions the container to ACTIVE and syncs environment state to the creative.
   * Shared by four ACTIVE transition sites:
   *   - `_handleStartCreativeResolved` (initial start)
   *   - `_onPageFocus` (focus regained from PASSIVE)
   *   - `_onResume` (unfreeze with visible + focused page)
   *   - HTML lifecycle adapter (0.7.2) — in permissive mode, the adapter
   *     may drive ACTIVE ahead of the handshake; the late-handshake's
   *     `_handleStartCreativeResolved` then hits this helper with state
   *     already at ACTIVE
   *
   * Skips the `setState` when the container is already in ACTIVE — this
   * is the late-handshake-after-adapter-promotion case (0.7.2 permissive
   * mode): the adapter advanced LOADING → ACTIVE via iframe-load +
   * intersection before the SHARC handshake completed. The handshake's
   * `_handleStartCreativeResolved` would otherwise trigger an invalid
   * `'active' → 'active'` self-transition warn. Environment-state sync
   * still fires so the post-handshake creative gets current audio /
   * placement state.
   * @private
   */
  _transitionToActive() {
    if (this._stateMachine.getState() !== ContainerStates.ACTIVE) {
      this.setState(ContainerStates.ACTIVE);
    }
    this._syncAudioState();
    this._syncPlacementState();
    this._syncEffectiveVisibility();
  }

  /**
   * Re-sends the current audio state (volumePercentage, isMuted) to the creative
   * as an audioVolumeChange message. Called on every ACTIVE transition so that
   * creatives which were preloaded in READY/HIDDEN state receive any audio updates
   * that were buffered in environmentData but not yet delivered.
   *
   * No-op when volumePercentage or isMuted are not defined (e.g. the publisher
   * never initialised audio state).
   * @private
   */
  _syncAudioState() {
    const { volumePercentage, isMuted } = this.environmentData;
    if (volumePercentage === undefined || isMuted === undefined) return;
    this._protocol.sendAudioVolumeChange(volumePercentage, isMuted);
  }

  // ---------------------------------------------------------------------------
  // Slice C — effective-visibility composer + additive channel.
  //
  // The container owns both raw visibility sources (axis 2 parent-visibility,
  // axis 3 intersection), the session, and the wire — so composition lives here
  // (EV-1), never in a bridge and never creative-side. Purely additive: this
  // computes + pushes on a NEW effectiveVisibilityChange channel and re-points
  // NO existing consumer (that is Slice D). See ADR 2026-06-20 Addendum B.
  // ---------------------------------------------------------------------------

  /**
   * Axis-3 raw setter — the un-thresholded IntersectionObserver ratio, surfaced
   * alongside (not instead of) the adapter's existing setState path. Pushes
   * live (F3): MRAID exposureChange / IO are change-driven event streams; the
   * push's own integer rounding + dedup absorb quantization noise.
   * @param {number} ratio 0..1
   * @private
   */
  _onRawIntersection(ratio) {
    this._rawIntersection = ratio;
    this._pushEffectiveVisibility();
  }

  /**
   * Axis-2 raw setter — parent-page visibility boolean, surfaced alongside the
   * existing setState path in _onVisibilityChange. Pushes live (F3).
   * @param {boolean} visible
   * @private
   */
  _onRawParentVisibility(visible) {
    this._rawParentVisible = visible;
    this._pushEffectiveVisibility();
  }

  /**
   * In-app host-exposure INPUT (L1 axis-3). The host reports the device-screen
   * percentage of the container [0,100]; the composer prefers it over the
   * in-page IO ratio when present (host-wins, L1 C2). Pass `null` to clear the
   * host override and fall back to the in-page IntersectionObserver ratio
   * (platform null-to-clear convention, F5 — without it host-wins is sticky
   * forever). Validate-first + best-effort-swallow, mirroring
   * setHostScreenOffset: ignore non-finite / non-number (except the explicit
   * `null` clear); clamp to [0,100]. Pushes live (F3).
   * @param {?number} pct
   */
  setHostExposure(pct) {
    if (pct === null) {
      this._hostExposure = null;
      this._pushEffectiveVisibility();
      return;
    }
    if (typeof pct !== 'number' || !isFinite(pct)) return;
    this._hostExposure = Math.max(0, Math.min(100, pct));
    this._pushEffectiveVisibility();
  }

  /**
   * The single effective-visibility composer (container-private). Composes the
   * two raw axes (host exposure wins axis-3 when present) into one surface every
   * consumer reads. Gate: effective = parentVisible ? round(intersection*100) : 0
   * — an INTEGER percent (see the rounding rationale inline). Pre-render
   * (before P3 creative-rendered, read directly off the public
   * `creativeRendered` anchor) is notAttached/0.
   * @returns {{effective:number, reason:(string|null), raw:{parentVisible:boolean, intersection:number}}}
   * @private
   */
  _composeEffectiveVisibility() {
    const ioRatio = this._rawIntersection || 0;
    const intersection = (this._hostExposure != null)
      ? this._hostExposure / 100
      : ioRatio;
    const parentVisible = !!this._rawParentVisible;

    if (!this.creativeRendered) {
      return { effective: 0, reason: 'notAttached', raw: { parentVisible, intersection } };
    }

    // Integer-rounded percent (F3): the IO feed is 0.05-step quantized, so
    // integers lose nothing real — and rounding BEFORE the dedup comparison
    // kills float-jitter dedup defeat (0.333333333 vs 0.333333334 must be ONE
    // push). MRAID exposes float 0–100; our wire carries the rounded integer.
    const effective = parentVisible ? Math.round(intersection * 100) : 0;

    let reason;
    if (!parentVisible) {
      reason = this._frozen ? 'frozen' : 'backgrounded';
    } else {
      // Compared on the ROUNDED integer (F6e): IO subpixel wobble at
      // visual-full (e.g. ratio 0.999 → 99.9 → 100) is null, not a phantom
      // 'offscreen'.
      reason = effective >= 100 ? null : 'offscreen';
    }

    return { effective, reason, raw: { parentVisible, intersection } };
  }

  /**
   * Composes the current effective-visibility and pushes it on the additive
   * channel. Dedup consecutive-identical (effectivePercent AND reason both match
   * the last sent), mirroring _lastSentState (INV-1/2/3). Caches the last payload
   * for replay-of-last to a late listener (INV-14).
   * @private
   */
  _pushEffectiveVisibility() {
    const out = this._composeEffectiveVisibility();
    const payload = {
      effectivePercent: out.effective,
      reason: out.reason,
      // Web tier carries no visible-rect geometry in Slice C (G6-deferred); the
      // field is present-but-null so consumers can rely on its shape (EV-8).
      visibleRectangle: null,
    };
    // Slice D (#413): the container-side extension fan-out (OMID) sits ABOVE
    // the session gate — extensions are container-side consumers of the ONE
    // composer output (EV-1) and do not depend on a creative wire session.
    // A sessionless embed (requireSharcInit: false, no handshake) is still on
    // screen and still measurable; gating extensions behind the wire session
    // starved OMID of visibility entirely. The fan-out dedups on its OWN
    // cache so a sessionless compose never touches the wire's dedup/replay
    // state below.
    const lastExt = this._lastExtensionEffectivePayload;
    if (!lastExt || lastExt.effectivePercent !== payload.effectivePercent
        || lastExt.reason !== payload.reason) {
      this._lastExtensionEffectivePayload = payload;
      this._notifyExtensionsLifecycle('effectiveVisibilityChange', { payload });
    }
    // The session check stays HERE (not only inside the sender) because it
    // gates the dedup CACHE: a sessionless compose must never seed
    // _lastEffectivePayload, or the first post-session send would be
    // suppressed as a duplicate of a value that was never delivered.
    if (this._protocol.sessionId === '') {
      return;
    }
    const last = this._lastEffectivePayload;
    if (last && last.effectivePercent === payload.effectivePercent
        && last.reason === payload.reason) {
      return;
    }
    this._lastEffectivePayload = payload;
    // Wire + rejected-send swallow live in the protocol sender (F6b) — no
    // inlined _sendMessage here.
    this._protocol.sendEffectiveVisibilityChange(payload);
  }

  /**
   * C7 replay-on-ACTIVE — re-push the current effective value on every ACTIVE
   * transition so a preloaded creative receives it. Mirrors _syncAudioState; the
   * push's own dedup suppresses a redundant re-send when nothing changed.
   * @private
   */
  _syncEffectiveVisibility() {
    this._pushEffectiveVisibility();
  }

  /**
   * Re-sends the current placement to the creative as a placementChange message.
   * Called on every ACTIVE transition to catch orientation / layout changes that
   * occurred during preload (READY or HIDDEN state).
   *
   * Skips the send only when the normalized outbound payload matches the last
   * placementChange payload sent via notifyPlacementChange().
   *
   * No-op when currentPlacement is null or undefined.
   * @private
   */
  _syncPlacementState() {
    const placement = this.environmentData.currentPlacement;
    if (placement == null) return;

    const payload = this._buildPlacementChangePayload(placement);
    if (this._placementPayloadUnchanged(payload)) return;

    this.notifyPlacementChange(placement);
  }

  /**
   * Returns true when the given placement payload is structurally identical
   * to the last payload sent via notifyPlacementChange().
   *
   * Compares the full normalized payload, not just geometry. The earlier
   * geometry-only comparison silently suppressed legitimate updates whenever
   * a non-geometric placement field (e.g. inline, placementType, dataspec,
   * data) changed without geometry changing — for example, a publisher
   * mutating environmentData.currentPlacement mid-preload to swap the
   * dataspec while keeping slot dimensions identical. See issue #6.
   *
   * Tradeoff: deep-equal comparison is stricter than geometry-only and may
   * occasionally pass a redundant message through when an irrelevant field
   * differs in serialization. That is recoverable; silent suppression of a
   * real placement update is not.
   *
   * @param {Object} payload
   * @returns {boolean}
   * @private
   */
  _placementPayloadUnchanged(payload) {
    const last = this._lastSentPlacement;
    if (!last) return false;

    // JSON.stringify is sufficient for the shape that travels over the
    // MessagePort. Property-order differences would produce false negatives
    // (sending a redundant message), which is recoverable; the bug we are
    // fixing is the inverse — silently suppressing a real update.
    try {
      return JSON.stringify(last) === JSON.stringify(payload);
    } catch (e) {
      // Defensive: if either payload contains a circular reference (should
      // never happen with the protocol's structured-clone contract), fall
      // back to "different" to err on the side of sending the update.
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Creative request handlers
  // -------------------------------------------------------------------------

  /**
   * Handles Creative:fatalError.
   * @param {Object} msg
   * @private
   */
  _handleCreativeFatalError(msg) {
    const { errorCode, errorMessage } = (msg.args || {});
    console.error('[SHARCContainer] Creative fatal error:', errorCode, errorMessage);
    this._notifyExtensionsLifecycle('error', {
      errorCode: errorCode,
      errorMessage: errorMessage || '',
      source: 'creative',
    });
    this._onError && this._onError(errorCode, errorMessage);
    this._terminate();
  }

  /**
   * Handles Creative:reportInteraction — fires tracking URIs.
   * @param {Object} msg
   * @private
   */
  _handleReportInteraction(msg) {
    const MAX_TRACKERS = 20;
    const { trackingUris = [] } = (msg.args || {});
    // SEC-004: Validate tracker URIs — only https/http allowed, cap at MAX_TRACKERS
    const safeUris = trackingUris
      .slice(0, MAX_TRACKERS)
      .filter((uri) => this._isNavigationUrlSafe(uri));
    this._onInteraction && this._onInteraction(safeUris);
    this._fireTrackers(safeUris).then((results) => {
      this._protocol._resolve(msg, { results });
    });
  }

  /**
   * Validates a URL for safe navigation/tracking use.
   * Only allows https: and http: schemes (SEC-003, SEC-004).
   * Rejects javascript:, data:, file:, and all other schemes.
   * @param {string} url
   * @returns {boolean}
   * @private
   */
  _isNavigationUrlSafe(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  /**
   * Handles Creative:requestNavigation.
   * Validates the URL before acting (SEC-003).
   * Resolves or rejects the message — the creative awaits this result.
   * @param {Object} msg
   * @private
   */
  _handleRequestNavigation(msg) {
    const navArgs = msg.args || {};
    const { url, target } = navArgs;

    // SEC-003: Validate URL before any navigation action
    if (url && !this._isNavigationUrlSafe(url)) {
      this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION, 'Invalid or unsafe navigation URL');
      return;
    }

    if (this._onNavigation) {
      // Observation hook only. Handler return value does not affect protocol
      // response; runtime allow/deny/rewrite is not part of the 0.7.x contract.
      try { this._onNavigation(navArgs); } catch (e) { /* ignore handler errors */ }
      this._protocol._resolve(msg, {});
    } else {
      // Default behavior: open clickthrough in new tab
      if (url && (target === 'clickthrough' || !target)) {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }
        this._protocol._resolve(msg, {});
      } else {
        // Container cannot handle this navigation type — reject so creative can try itself
        this._protocol._reject(msg, ErrorCodes.UNSPECIFIED_CONTAINER, 'Navigation type not handled by container');
      }
    }
  }

  /**
   * Handles Creative:setOrientationProperties (fire-and-forget).
   * Forwards the creative's requested orientation properties to the native-host
   * observation hook so the embedding SDK can drive the device orientation lock.
   * No protocol response (not in MESSAGES_REQUIRING_RESPONSE).
   * @param {Object} msg
   * @private
   */
  _handleSetOrientationProperties(msg) {
    if (!this._onOrientationProperties) return;
    // L1 trust boundary (Native Host Interface contract C5): creative-supplied
    // args are UNTRUSTED at this seam. The MRAID bridge's enum guard alone is
    // bypassable — the creative surface exposes SHARC.requestOrientationProperties
    // directly — so validate + payload-minimize HERE before anything crosses to
    // the native host (mirrors _isNavigationUrlSafe). Invalid fields are
    // field-wise omitted; unknown fields never cross; nothing valid ⇒ no call.
    const args = (msg && msg.args) || {};
    const payload = {};
    if (typeof args.allowOrientationChange === 'boolean') {
      payload.allowOrientationChange = args.allowOrientationChange;
    }
    if (args.forceOrientation === 'portrait'
        || args.forceOrientation === 'landscape'
        || args.forceOrientation === 'none') {
      payload.forceOrientation = args.forceOrientation;
    }
    if (Object.keys(payload).length === 0) return;
    try {
      this._onOrientationProperties(payload);
    } catch (e) { /* host callback must not break the container */ }
  }

  /**
   * Handles Creative:requestPlacementChange.
   * @param {Object} msg
   * @private
   */
  _handleRequestPlacementChange(msg) {
    const args = msg.args || {};
    const { intent, targetDimensions, targetPosition, anchorPoint, closeRegion, allowOffscreen, transition } = args;

    // ── Basic type guards — run regardless of policy ──
    if (intent !== undefined && typeof intent !== 'string') {
      this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION,
        'intent must be a string, got ' + typeof intent);
      return;
    }
    if (targetDimensions) {
      if (typeof targetDimensions.width !== 'number' || !isFinite(targetDimensions.width) || targetDimensions.width <= 0 ||
          typeof targetDimensions.height !== 'number' || !isFinite(targetDimensions.height) || targetDimensions.height <= 0) {
        this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION,
          'targetDimensions width and height must be finite positive numbers');
        return;
      }
    }

    // ── Validation pipeline (only when policy is configured) ──
    let validationResolvedClose = null;
    if (this._placementPolicy) {
      const validation = this._validatePlacementRequest(args);
      if (!validation.valid) {
        const failed = /** @type {ValidationFail} */ (validation);
        this._protocol._reject(msg, failed.code, failed.message);
        return;
      }
      validationResolvedClose = (/** @type {ValidationOk} */ (validation)).resolvedClose || null;
    }

    // ── Offscreen enforcement for no-policy containers ──
    if (!this._placementPolicy) {
      const effectiveAllowOffscreen = allowOffscreen !== undefined ? allowOffscreen : true;
      // Skip the viewport offscreen check when the host owns clamping (hostOwnsClamping: true).
      // There the "viewport" is the host's small ad slot, not the natively-sized resize surface, so
      // this check would reject nearly every reparented resize. The host owns on-screen positioning +
      // clamping in that mode. Embeds without hostOwnsClamping are unchanged.
      if (intent === 'resize' && effectiveAllowOffscreen === false && targetDimensions && this._iframe && !this._hostOwnsClamping) {
        const pos = targetPosition || {
          x: this._iframe.offsetLeft,
          y: this._iframe.offsetTop,
        };
        const viewport = this._getViewportBounds();
        if (pos.x < 0 || pos.y < 0 ||
            pos.x + targetDimensions.width > viewport.width ||
            pos.y + targetDimensions.height > viewport.height) {
          this._protocol._reject(msg, ErrorCodes.UNSUPPORTED_FEATURE,
            'Resize would extend offscreen and allowOffscreen is false');
          return;
        }
      }
    }

    // ── Sub-state guard: prevent stacking placement changes without collapse ──
    if (this._currentIntent && intent !== 'collapse') {
      // Already in a non-default placement — must collapse first
      // Exception: allow same intent (e.g., resize while resized adjusts dimensions)
      if (this._currentIntent !== intent) {
        if (msg.type !== 'synthetic') {
          this._protocol._reject(msg, ErrorCodes.UNSUPPORTED_FEATURE,
            'Must collapse before changing from ' + this._currentIntent + ' to ' + intent);
        }
        return;
      }
    }

    // ── Execution (with position snapshot, animation, and close button) ──
    let updatedPlacement = { ...(this.environmentData.currentPlacement || {}) };
    let skippedTransitionEndDimensions = null;

    // Under the host-reparent model (hostOwnsClamping: true) the host owns the on-screen WebView
    // frame; the resized iframe fills its WebView from (0,0), so the close button AND the close-region
    // resolution must use that same (0,0) origin — not the creative's absolute targetPosition, which
    // would push content/button into dead space and clip the bottom. Embeds without hostOwnsClamping
    // keep targetPosition verbatim (placementPos === targetPosition).
    const placementPos = this._hostOwnsClamping ? { x: 0, y: 0 } : targetPosition;

    // Resolve close button position from hint (use pre-resolved value from validation if available)
    const resolvedClose = validationResolvedClose
      ? validationResolvedClose
      : (closeRegion
        ? this._resolveClosePosition(closeRegion, targetDimensions || updatedPlacement, placementPos)
        : { position: 'top-right', size: 50, overridden: false });

    switch (intent) {
      case 'resize':
        this._snapshotPreResizeState();
        this._currentIntent = 'resize';
        this._stampIntent('resize');
        if (targetDimensions) {
          if (transition && this._supportsAnimation()) {
            const fromDims = { width: updatedPlacement.width || 0, height: updatedPlacement.height || 0 };
            updatedPlacement = { ...updatedPlacement, ...targetDimensions };
            skippedTransitionEndDimensions = this._applyAnimatedDimensions(fromDims, targetDimensions, transition, anchorPoint);
          } else {
            updatedPlacement = { ...updatedPlacement, ...targetDimensions };
            this._applyIframeDimensions(targetDimensions, transition);
            if (transition) {
              skippedTransitionEndDimensions = targetDimensions;
            }
          }
        }
        if (placementPos) {
          this._applyIframePosition(placementPos);
        }
        this._createDismissButton(resolvedClose.position, targetDimensions, placementPos);
        break;
      case 'expand':
      case 'fullscreen':
        this._snapshotPreResizeState();
        this._currentIntent = intent;
        this._stampIntent(intent);
        updatedPlacement = this._getExpandedPlacement(intent);
        if (intent === 'fullscreen') {
          // Break out of ad slot — overlay the entire viewport
          this._iframe.style.position = 'fixed';
          this._iframe.style.top = '0';
          this._iframe.style.left = '0';
          this._iframe.style.width = '100vw';
          this._iframe.style.height = '100vh';
          this._iframe.style.zIndex = '2147483647';
        } else if (transition && this._supportsAnimation()) {
          const fromDims = { width: this.environmentData.currentPlacement.width || 0, height: this.environmentData.currentPlacement.height || 0 };
          skippedTransitionEndDimensions = this._applyAnimatedDimensions(fromDims, updatedPlacement, transition, anchorPoint);
        } else {
          this._applyIframeDimensions(updatedPlacement, transition);
          if (transition) {
            skippedTransitionEndDimensions = updatedPlacement;
          }
        }
        this._createDismissButton('top-right', updatedPlacement);
        break;
      case 'collapse':
        this._currentIntent = null;
        this._stampIntent(null);
        updatedPlacement = this._restorePreResizeState();
        this._removeDismissButton();
        break;
      default:
        this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION,
          "Unknown placement intent: '" + intent + "'");
        return;
    }

    this.environmentData.currentPlacement = updatedPlacement;
    const resolvePayload = { placementUpdate: updatedPlacement };
    if (transition && this._supportsAnimation()) {
      resolvePayload.transition = this._clampTransition(transition);
    }
    // Include close button position in resolve when a close button is rendered
    if (this._closeButton && (intent === 'resize' || intent === 'expand' || intent === 'fullscreen')) {
      resolvePayload.closeButtonPosition = {
        position: resolvedClose.position,
        x: this._closeButton.getBoundingClientRect ? this._closeButton.getBoundingClientRect().x : 0,
        y: this._closeButton.getBoundingClientRect ? this._closeButton.getBoundingClientRect().y : 0,
        width: 50,
        height: 50,
      };
    }
    if (msg.type !== 'synthetic') {
      this._protocol._resolve(msg, resolvePayload);
    }
    // Build notification extras (transition, closeButtonPosition)
    const notifyExtra = {};
    if (resolvePayload.transition) notifyExtra.transition = resolvePayload.transition;
    if (resolvePayload.closeButtonPosition) notifyExtra.closeButtonPosition = resolvePayload.closeButtonPosition;
    // Forward the creative's REQUESTED resize target to the native host callback so it can place the
    // reparented surface at slot+offset. `targetPosition` here is the bridge-computed offset (it
    // anchors at _initialPosition, which is the WebView-relative 0,0 for a host-reparented WebView, so
    // this is the raw creative offset). Host-reparent + resize only.
    // targetPosition is creative-supplied (untrusted); validate finite before handing to native.
    if (this._onPlacementChange && intent === 'resize' && targetPosition
        && isFinite(targetPosition.x) && isFinite(targetPosition.y)) {
      notifyExtra.hostTargetPosition = { x: targetPosition.x, y: targetPosition.y };
    }
    this.notifyPlacementChange(updatedPlacement, Object.keys(notifyExtra).length > 0 ? notifyExtra : undefined);
    if (skippedTransitionEndDimensions) {
      this._protocol._sendMessage(ContainerMessages.PLACEMENT_TRANSITION_END, {
        finalDimensions: skippedTransitionEndDimensions,
      });
    }
  }

  /**
   * Validates a placement request against the configured placement policy.
   * Returns { valid: true, resolvedClose?: {...} } if the request is valid,
   * or { valid: false, code, message } for rejection.
   * @param {Object} args - The requestPlacementChange args.
   * @returns {ValidationOk | ValidationFail}
   * @private
   */
  _validatePlacementRequest(args) {
    const policy = this._placementPolicy;
    if (!policy) return { valid: true };

    const { intent, targetDimensions, closeRegion } = args;

    // 1. Intent allowlist
    const knownIntents = ['resize', 'expand', 'fullscreen', 'collapse'];
    if (intent && knownIntents.indexOf(intent) === -1) {
      return { valid: false, code: ErrorCodes.MESSAGE_SPEC_VIOLATION, message: "Unknown placement intent: '" + intent + "'" };
    }
    const allowedIntents = policy.allowedIntents || knownIntents;
    if (intent && allowedIntents.indexOf(intent) === -1) {
      return { valid: false, code: ErrorCodes.UNSUPPORTED_FEATURE, message: "Intent '" + intent + "' not allowed by placement policy" };
    }

    // 2. Dimension limits
    if (intent === 'resize' && targetDimensions) {
      const maxW = policy.maxWidth != null ? policy.maxWidth : Infinity;
      const maxH = policy.maxHeight != null ? policy.maxHeight : Infinity;
      if (targetDimensions.width > maxW || targetDimensions.height > maxH) {
        return { valid: false, code: ErrorCodes.UNSUPPORTED_FEATURE, message: 'Dimensions exceed placement policy limits (max: ' + maxW + 'x' + maxH + ')' };
      }
    }

    // 3. Close region presence (when required by policy)
    if (intent === 'resize' && policy.requireCloseRegion && !closeRegion) {
      return { valid: false, code: ErrorCodes.MESSAGE_SPEC_VIOLATION, message: 'Placement policy requires closeRegion hint on resize requests' };
    }

    // 4. Close hint resolution (Section 4.3 step 4)
    // Resolve close position here so it runs before offscreen and custom validator.
    // Note: closeRegion.size is clamped (not rejected) by _resolveClosePosition — the
    // container renders its own close button, so the size field is informational.
    let resolvedClose = null;
    if (closeRegion) {
      resolvedClose = this._resolveClosePosition(
        closeRegion,
        targetDimensions || (this.environmentData.currentPlacement || {}),
        args.targetPosition
      );
    }

    // 5. Offscreen enforcement (Section 4.3 step 5)
    const effectiveAllowOffscreen = args.allowOffscreen !== undefined
      ? args.allowOffscreen
      : (policy.allowOffscreen !== undefined ? policy.allowOffscreen : true);

    if (intent === 'resize' && effectiveAllowOffscreen === false && targetDimensions && this._iframe && !this._hostOwnsClamping) {
      const pos = args.targetPosition || {
        x: this._iframe.offsetLeft,
        y: this._iframe.offsetTop,
      };
      const viewport = this._getViewportBounds();
      if (pos.x < 0 || pos.y < 0 ||
          pos.x + targetDimensions.width > viewport.width ||
          pos.y + targetDimensions.height > viewport.height) {
        return { valid: false, code: ErrorCodes.UNSUPPORTED_FEATURE, message: 'Resize would extend offscreen and allowOffscreen is false' };
      }
    }

    // 6. Custom validator (synchronous)
    if (typeof policy.customValidator === 'function') {
      try {
        var result = policy.customValidator(args);
        if (result && result.allowed === false) {
          return { valid: false, code: 2203, message: result.reason || 'Rejected by custom validator' };
        }
      } catch (e) {
        console.warn('[SHARCContainer] customValidator threw:', e);
        return { valid: false, code: 2203, message: 'Custom validator error: ' + (e.message || 'unknown') };
      }
    }

    return { valid: true, resolvedClose: resolvedClose };
  }

  /**
   * Validates a close region hint and returns the effective close position.
   * The container always renders its own close button — this determines WHERE.
   * @param {Object} closeRegion - { position: string, size: number } hint from creative
   * @param {Object} targetDimensions - { width, height }
   * @param {Object} targetPosition - { x, y } or null
   * @returns {{ position: string, size: number, overridden: boolean }}
   * @private
   */
  _resolveClosePosition(closeRegion, targetDimensions, targetPosition) {
    const size = Math.max(closeRegion.size || 50, 50);
    const hintedPosition = closeRegion.position || 'top-right';

    const adX = targetPosition ? targetPosition.x : (this._iframe ? this._iframe.offsetLeft : 0);
    const adY = targetPosition ? targetPosition.y : (this._iframe ? this._iframe.offsetTop : 0);
    const adW = targetDimensions.width || 0;
    const adH = targetDimensions.height || 0;

    // Under the host-reparent model (hostOwnsClamping: true) the viewport is the host's small ad slot,
    // not the natively-sized resize surface, so this clamp would spuriously override every non-top-right
    // creative close hint. The host owns on-screen clamping in that mode; honour the creative's resolved
    // hint. Embeds without hostOwnsClamping keep the clamp (including policy-validated paths).
    if (!this._hostOwnsClamping) {
      const rect = this._computeCloseRegionRect(adX, adY, adW, adH, hintedPosition, size);
      const viewport = this._getViewportBounds();

      if (rect.left < 0 || rect.top < 0 ||
          rect.right > viewport.width || rect.bottom > viewport.height) {
        console.warn('[SHARCContainer] Close region hint offscreen at', hintedPosition, '— defaulting to top-right');
        return { position: 'top-right', size: size, overridden: true };
      }
    }

    return { position: hintedPosition, size: size, overridden: false };
  }

  /**
   * Computes the screen-space rect for a close region position.
   * @param {number} adX - Ad left position
   * @param {number} adY - Ad top position
   * @param {number} adW - Ad width
   * @param {number} adH - Ad height
   * @param {string} position - Position enum
   * @param {number} size - Close button size
   * @returns {{ left: number, top: number, right: number, bottom: number }}
   * @private
   */
  _computeCloseRegionRect(adX, adY, adW, adH, position, size) {
    let closeX, closeY;
    switch (position) {
      case 'top-left':      closeX = adX; closeY = adY; break;
      case 'top-center':    closeX = adX + (adW - size) / 2; closeY = adY; break;
      case 'top-right':     closeX = adX + adW - size; closeY = adY; break;
      case 'center-left':   closeX = adX; closeY = adY + (adH - size) / 2; break;
      case 'center-right':  closeX = adX + adW - size; closeY = adY + (adH - size) / 2; break;
      case 'bottom-left':   closeX = adX; closeY = adY + adH - size; break;
      case 'bottom-center': closeX = adX + (adW - size) / 2; closeY = adY + adH - size; break;
      case 'bottom-right':  closeX = adX + adW - size; closeY = adY + adH - size; break;
      default:              closeX = adX + adW - size; closeY = adY; break;
    }
    return { left: closeX, top: closeY, right: closeX + size, bottom: closeY + size };
  }

  /**
   * Snapshots the iframe's CSS state before resize, if not already captured.
   * @private
   */
  _snapshotPreResizeState() {
    if (this._preResizeCSSState || !this._iframe) return;
    this._preResizeCSSState = {
      position: this._iframe.style.position,
      left:     this._iframe.style.left,
      top:      this._iframe.style.top,
      width:    this._iframe.style.width,
      height:   this._iframe.style.height,
      zIndex:   this._iframe.style.zIndex,
      containerWidth:  this.placementElement.style.width,
      containerHeight: this.placementElement.style.height,
    };
  }

  /**
   * Restores iframe CSS state to the pre-resize snapshot.
   * Clears the snapshot so the next resize captures fresh state.
   * @returns {Object} The original placement dimensions to use as updatedPlacement.
   * @private
   */
  _restorePreResizeState() {
    if (this._preResizeCSSState && this._iframe) {
      this._iframe.style.position = this._preResizeCSSState.position;
      this._iframe.style.left     = this._preResizeCSSState.left;
      this._iframe.style.top      = this._preResizeCSSState.top;
      this._iframe.style.width    = this._preResizeCSSState.width;
      this._iframe.style.height   = this._preResizeCSSState.height;
      this._iframe.style.zIndex   = this._preResizeCSSState.zIndex;
      this.placementElement.style.width  = this._preResizeCSSState.containerWidth;
      this.placementElement.style.height = this._preResizeCSSState.containerHeight;
    }
    this._preResizeCSSState = null;
    return { ...(this._originalPlacement || this.environmentData.currentPlacement || {}) };
  }

  /**
   * Returns the current viewport bounds.
   * @returns {{ width: number, height: number }}
   * @private
   */
  _getViewportBounds() {
    return {
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
    };
  }

  /**
   * Handles Creative:requestClose by entering the Container:close message flow.
   * @param {Object} msg
   * @private
   */
  _handleRequestClose(msg) {
    // Container can choose to honor or reject. Default: honor.
    this._protocol._resolve(msg, {});
    this.close();
  }

  // -------------------------------------------------------------------------
  // Container:close flow
  // -------------------------------------------------------------------------

  /**
   * Initiates the Container:close message flow.
   * Sends Container:close and terminates after 2s max.
   * @private
   */
  _initiateClose() {
    this._notifyExtensionsLifecycle('close');
    // Start close timeout — force terminate after 2s if the Container:close flow does not complete
    this._startTimeout('closeSequence', () => {
      this._terminate();
    });

    this._protocol.sendClose()
      .then(() => {
        this._clearTimeout('closeSequence');
        // Allow a brief moment for creative to run its close animation
        // then terminate. The creative had its chance, we gave it resolve.
        setTimeout(() => this._terminate(), 100);
      })
      .catch(() => {
        this._clearTimeout('closeSequence');
        this._terminate();
      });
  }

  /**
   * Terminates the container instance — removes the iframe, terminates the protocol,
   * and fires the onClose callback.
   * Guards against multiple calls (e.g. from _handleFatalError timeout races).
   * @private
   */
  _terminate() {
    if (this._terminated) return; // Guard: _terminate can be called from multiple code paths
    this._terminated = true;

    // Clear all pending timeouts
    Object.keys(this._timeouts).forEach((key) => this._clearTimeout(key));

    // Phase D deliverable 1: detach the load-event navigation backstop.
    // The iframe is removed from the DOM further down (which would GC the
    // listener anyway), but explicit detach matches the message-listener
    // pattern above and keeps `_terminate` idempotent if some future change
    // re-orders the DOM removal. MUST run BEFORE the iframe DOM removal
    // below — the seam preserves that ordering invariant.
    this._disarmRendererBackstop();

    // #337 (OMID design Risk R1): drain the OMID terminal `sessionFinish`
    // WHILE the protocol router is still live. The destroy lifecycle drives the
    // bridge's `_finishSession()`, which transitions the router into
    // `omid-finishing` and relays the terminal `sessionFinish` Event via
    // `buildOutbound`. Tearing the router down first (the pre-#337 order)
    // relayed that terminal event into an already-terminated router — out of
    // phase. The iframe is still attached here (it is removed further down),
    // so the relay reaches the creative.
    this._notifyExtensionsLifecycle('destroy');

    // State-Delivery Contract INV-13 (terminated → hidden): `terminated` is
    // non-queryable and MUST NOT go on the wire (INV-12), but the creative MUST
    // receive exactly one terminal lifecycle signal. The ratified terminal value
    // is `hidden`. Deliver it through the normal send chokepoint (so the §3 dedup
    // suppresses a redundant `hidden` if the container was already hidden), while
    // the protocol is still live — BEFORE the state machine enters TERMINATED and
    // before `_protocol.terminate()`. After this, the protocol is torn down, so
    // no further `stateChange` can be delivered (INV-11).
    this._protocol.sendStateChange(ContainerStates.HIDDEN);

    // 0.7.7: transition the router into `terminated` defense-in-depth so any
    // post-termination straggler is rejected, then detach its single
    // `window.message` listener. MUST run AFTER the OMID terminal drain above
    // (#337) — the terminal `sessionFinish` is relayed through this router while
    // it is still live. `_routerTorndown` then rejects any later
    // `_onOmidLifecycleSignal` straggler.
    if (this.protocolRouter) {
      try { this.protocolRouter.transitionTo('terminated'); } catch (_) { /* ignore */ }
      try { this.protocolRouter.destroy(); } catch (_) { /* ignore */ }
    }
    this._routerTorndown = true;

    // Transition to terminated
    this._stateMachine.transition(ContainerStates.TERMINATED);

    // Terminate protocol
    this._protocol.terminate();

    // Remove close button
    this._removeDismissButton();

    // Remove iframe from DOM
    if (this._iframe && this._iframe.parentNode) {
      this._iframe.parentNode.removeChild(this._iframe);
      this._iframe = null;
    }

    // Detach: remove SHARC-owned class/attrs and restore original inline style
    this._detachFromPlacement();

    // Remove page lifecycle listeners
    this._detachPageLifecycleListeners();

    // 0.7.2 § 8 — detach the lifecycle adapter (disconnects the
    // IntersectionObserver, removes bfcache + freeze / resume listeners).
    // Guarded for the case where _terminate runs before load() (e.g.
    // construction-time fatal error: adapter was never attached).
    if (this._lifecycleAdapter) {
      try { this._lifecycleAdapter.detach(); } catch (_) { /* ignore */ }
      this._lifecycleAdapter = null;
    }

    // Clean up extensions
    this._extensions.forEach((ext) => {
      if (typeof ext.destroy === 'function') {
        try { ext.destroy(); } catch (e) { /* ignore extension destroy errors */ }
      }
    });

    // Fire close callback
    this._onClose && this._onClose();
  }

  // -------------------------------------------------------------------------
  // Fatal error handling
  // -------------------------------------------------------------------------

  /**
   * Handles a fatal error — sends Container:fatalError if possible, then terminates.
   * @param {number} errorCode
   * @param {string} [message]
   * @private
   */
  _handleFatalError(errorCode, message = '') {
    this._notifyExtensionsLifecycle('error', {
      errorCode: errorCode,
      errorMessage: message,
      source: 'container',
    });
    this._onError && this._onError(errorCode, message);
    this._protocol.sendFatalError(errorCode, message)
      .then(() => this._terminate())
      .catch(() => this._terminate());
    // Force terminate after 1s regardless
    setTimeout(() => this._terminate(), 1000);
  }

  /**
   * Attaches the creative iframe's load-event navigation backstop. Called
   * AFTER the variant-specific "render anchor" event:
   *   - Markup: envelope-validated `:rendered` accept (in
   *     `_onRendererRendered()`).
   *   - Creative URL: initial iframe `load` event (in `_createIframe()`,
   *     Phase E deliverable 1).
   *
   * Any subsequent iframe `load` event means the iframe document
   * navigated to a new URL outside the SHARC protocol path —
   * defense-in-depth against creatives that bypass the in-renderer
   * navigation bridge (window.open re-override, location getter
   * redefinition, meta refresh that the bridge missed, etc.). Spec §
   * Click-through audit and policy boundary.
   *
   * Same-document navigations (pushState, hash changes) do not fire
   * `load`; cross-document navigations do. Detection is precise.
   *
   * Variant-agnostic by construction — the `details.variant` field is
   * derived from `this.creativeSource` at fire time, so the seam is
   * usable from both arm sites with no per-call argument shaping.
   *
   * @private
   */
  _armRendererBackstop(options = {}) {
    if (this._terminated || !this._iframe) return;
    // 0.7.10 Phase 1: the controlled-context gate now runs on EVERY post-render
    // load, not only the first. `gateEveryLoad` is true whenever a renderer
    // protocol channel exists to answer the probe (Markup variant, armed with
    // `verifyFirstLoad: true`). The URL variant arms without it: a plain
    // creative-URL document has no SHARC prelude to answer a probe, so the gate
    // would always go unanswered — its post-render-load policy is unchanged
    // (any subsequent cross-document load terminates), preserving the URL
    // variant's existing 2118 contract.
    const gateEveryLoad = options && options.verifyFirstLoad === true;
    // True only while a probe is outstanding (armed, awaiting ack or timeout).
    // A second load arriving in this window is latched and re-evaluated once
    // the outstanding probe resolves.
    let probePending = false;
    // Latched when a load fires while a probe is already pending. The
    // additional load means the renderer document changed again before the
    // first probe resolved; once the outstanding probe is answered we re-run the
    // gate for the latched load rather than assuming it benign.
    let loadWhileProbePending = false;
    // Monotonic count of post-render loads observed, for the `loadKind` hint on
    // `renderer_load_observed` ('first' vs 'subsequent').
    let observedLoadCount = 0;
    // #332 answered probe-cycle rate ceiling. Sliding-window timestamps of
    // ANSWERED cycles (each `onAck`). Bounds both log volume (the
    // `renderer_load_observed` console.info + callback per cycle) and the
    // keep-alive-abuse window. Once MAX answered cycles land inside WINDOW_MS we
    // THROTTLE: suppress further `renderer_load_observed` and emit the reserved
    // non-terminating `renderer_navigation_blocked` (2122) exactly once. We do
    // NOT terminate — a legitimate-but-chatty renderer stays alive (Decision
    // 0/2); 2118 remains reserved for lost-control (gate unanswered). The window
    // SLIDES (timestamps expire), so a renderer that goes quiet recovers and a
    // fresh burst re-arms the diagnostic. This is purely ON TOP of the
    // authenticated gate — it touches no nonce, latch, phase, or wire contract.
    const answeredCycleTimestamps = [];
    let ceilingTripped = false;
    // Closure-scoped state for the PORT-routed loadAck. The captured-native
    // `port1` listener (`_bindProbePort`) receives the `:loadAck`, and invokes
    // `_dispatchRendererLoadAck(probeId, observedAt)` only after the strict
    // possession/id/temporal gate passes — which in turn calls the callback
    // installed below. The window/router path for loadAck is fully RETIRED
    // (ADR 2026-06-15): port possession is the sole load-probe authenticator.
    this._pendingLoadProbe = null;
    const emitUnauthorizedNavigation = () => {
      if (this._terminated) return;
      // _emitSecurityEventAndTerminate is the chokepoint — fires
      // onSecurityEvent first (with details.{variant, msSinceRender}), then
      // the dev-channel log, then onError + terminate. Detaching the listener
      // happens in `_disarmRendererBackstop`.
      //
      // `details.variant` discriminates Markup ('markup') from Creative
      // URL ('url'). Operators key off the structured event type + code +
      // message; the variant field is for triage only — both variants
      // share the same root cause (renderer iframe navigated post-render).
      //
      // `details.msSinceRender` is the wall-clock delay between the
      // variant-specific render-anchor (Markup: `:rendered` accept; URL:
      // initial iframe load) and this load event. Operators monitoring
      // 2118 distinguish fast-fire (creative immediately reloaded —
      // typically a redirect-injected `<meta http-equiv="refresh"
      // content="0;url=...">` or a `window.location` assignment in the
      // creative's first script tag) from slow-fire (multiple-second
      // delay — DOM-injected redirects, setTimeout-based redirects).
      // Field name is preserved across variants for grep-stable operator
      // dashboards. Phase D round-4 SRE HIGH-1; widened in Phase E.
      //
      // `creativeSource` is constructor-set and stable across the
      // container's lifetime — see field doc at the constructor. Safe
      // to read at fire time; no stale-state hazard. Type is constrained
      // to `'url' | 'html'` (typedef-enforced); both expected values are
      // mapped explicitly so a future variant added without updating this
      // derivation surfaces loudly via console.error rather than silently
      // coercing to 'url'.
      let variant;
      if (this.creativeSource === 'html') {
        variant = 'markup';
      } else if (this.creativeSource === 'url') {
        variant = 'url';
      } else {
        console.error(
          '[SHARCContainer] [' + this.placementSessionId
          + '] [unauthorized_navigation] unexpected creativeSource: '
          + String(this.creativeSource)
          + ' — defaulting variant to "url" (update _armRendererBackstop'
          + ' AND UnauthorizedNavigationEvent.details typedef when adding'
          + ' a new creativeSource).'
        );
        variant = 'url';
      }
      const msSinceRender = (typeof this._renderedAt === 'number')
        ? Math.max(0, Date.now() - this._renderedAt)
        : 0;
      this._emitSecurityEventAndTerminate(
        'unauthorized_navigation',
        ErrorCodes.RENDERER_UNAUTHORIZED_NAVIGATION,
        (variant === 'markup' ? 'Renderer' : 'Creative URL') + ' iframe navigated '
          + 'post-render after ' + msSinceRender + 'ms — refusing to proceed. '
          + 'The new document is cross-origin and its URL is not inspectable; '
          + 'check the creative\'s HTML for redirect-injection patterns '
          + '(window.location, meta refresh re-injection, form submits with '
          + 'action=).',
        { variant: variant, msSinceRender: msSinceRender }
      );
    };
    // Arms one controlled-context probe/ack cycle for a single post-render
    // load. Answered within the deadline ⇒ CONTROLLED ⇒ keep the ad alive +
    // emit a non-terminating `renderer_load_observed`. Unanswered ⇒ LOST
    // CONTROL ⇒ terminate (2118). This is the same authenticated round-trip the
    // first load always used (0.7.7); Phase 1 (0.7.10) runs it on EVERY load.
    const runGate = () => {
      probePending = true;
      loadWhileProbePending = false;
      observedLoadCount += 1;
      const loadKind = observedLoadCount === 1 ? 'first' : 'subsequent';
      const cleanup = () => {
        this._pendingLoadProbe = null;
        this._armedProbeId = null;
        this._armedProbeIssuedAt = null;
        if (this._rendererProbeTimeoutId !== null) {
          clearTimeout(this._rendererProbeTimeoutId);
          this._rendererProbeTimeoutId = null;
        }
      };
      const onAck = () => {
        if (this._terminated) {
          cleanup();
          return;
        }
        cleanup();
        probePending = false;
        // CONTROLLED: the nonce-authenticated probe was answered → SHARC still
        // holds the renderer channel. Keep the ad alive (Decision 0/2). If a
        // further load latched while this probe was outstanding, re-run the
        // gate for it rather than assuming it benign.
        //
        // #332 ceiling: record this answered cycle, expire timestamps older than
        // the window, then decide whether to emit the per-cycle diagnostic or
        // throttle. Below the ceiling ⇒ emit `renderer_load_observed` as Phase 1
        // does. At/over the ceiling ⇒ suppress the redundant observed log and, on
        // the FIRST crossing only, emit one non-terminating
        // `renderer_navigation_blocked` (2122). The ad is NOT terminated.
        const now = Date.now();
        answeredCycleTimestamps.push(now);
        const windowStart = now - PROBE_CYCLE_CEILING_WINDOW_MS;
        while (answeredCycleTimestamps.length > 0
          && answeredCycleTimestamps[0] < windowStart) {
          answeredCycleTimestamps.shift();
        }
        if (answeredCycleTimestamps.length <= PROBE_CYCLE_CEILING_MAX) {
          // Window slid back under the ceiling (or never reached it): re-arm the
          // diagnostic so a fresh burst after a quiet period trips it again.
          ceilingTripped = false;
          this._emitRendererLoadObserved(loadKind);
        } else if (!ceilingTripped) {
          // First answered cycle PAST the ceiling within this window: throttle.
          // Emit the reserved 2122 once; suppress this and subsequent observed
          // logs until the window slides back under the ceiling.
          ceilingTripped = true;
          this._emitRendererNavigationBlocked('answered_probe_cycle_ceiling');
        }
        // (ceilingTripped && over ceiling) ⇒ suppress silently: log volume bound.
        if (loadWhileProbePending) {
          loadWhileProbePending = false;
          runGate();
        }
      };
      // ADR 2026-06-15: the loadAck reception is PORT-routed. The captured-
      // native `port1` listener (`_bindProbePort`) calls
      // `_dispatchRendererLoadAck(probeId, observedAt)`, which invokes the
      // callback below only after the strict possession/id/temporal gate passes.
      // Phase 1: arming a fresh probe resets the single-consume latch (#269) so
      // each post-render load gets its own probe/ack cycle while the latch still
      // guards against a forged/replayed/late ack re-resolving a stale probe
      // within a cycle.
      this._loadAckConsumed = false;
      this._pendingLoadProbe = onAck;

      // ADR 2026-06-15: authenticate by PORT POSSESSION, not by nonce. Mint a
      // CSPRNG-unpredictable per-cycle probeId and record the monotonic issue
      // timestamp; `_dispatchRendererLoadAck` accepts a `:loadAck` only if it
      // arrived on `port1`, bears THIS probeId, and was observed strictly after
      // this instant (single-consume). The probeId is a non-secret correlator —
      // unpredictability defeats a creative that pre-computes acks for a guessed
      // next probeId; the arrival-on-port is the actual proof. (The router
      // nonce-chain is RETIRED — the port is now the SOLE load-probe
      // authenticator; the router gate authenticates only `:rendered`/`:failed`.)
      const probeId = SHARCContainer._mintProbeId();
      this._armedProbeId = probeId;
      this._armedProbeIssuedAt = (typeof performance !== 'undefined'
        && typeof performance.now === 'function') ? performance.now() : Date.now();

      // 100ms loadAck deadline. Inherited verbatim from the original first-load
      // gate (0.7.7), which armed exactly one probe after the first post-render
      // load. Phase 1 (#321) runs the gate on EVERY post-render load, so this
      // same 100ms now applies per post-render load under the gate-every-load
      // model — not once per container lifetime. The companion rate/count
      // ceiling on how many ANSWERED gate cycles may run per window landed in
      // #332 (see `answeredCycleTimestamps` / `PROBE_CYCLE_CEILING_MAX` above);
      // this 100ms deadline value itself is still inherited and unchanged.
      this._rendererProbeTimeoutId = setTimeout(() => {
        cleanup();
        probePending = false;
        loadWhileProbePending = false;
        // LOST CONTROL: the gate went unanswered within the deadline. This is
        // the narrowed, genuinely-fatal 2118 (uncontrolled external-webpage
        // escape / replaced controlled document with no prelude).
        emitUnauthorizedNavigation();
      }, 100);
      try {
        // ADR 2026-06-15: send the `:loadProbe` over `port1` (possession), NOT
        // via `window.postMessage`. The renderer IIFE holds the surviving
        // `port2` and answers over it; the ack's arrival on `port1` is the
        // authenticator. On a real cross-document navigation `port2` died with
        // its realm, so the probe goes unanswered → 100ms timeout → 2118
        // (fail-closed). The probeId is the per-cycle correlator. Captured-
        // native `postMessage.call(port1, …)` is defense-in-depth (the top frame
        // is trusted, but it costs nothing).
        const port1 = this._probePort;
        if (!port1) {
          throw new Error('renderer probe port unavailable');
        }
        const probeMsg = {
          type: 'SHARC:Container:loadProbe',
          placementSessionId: this.placementSessionId,
          probeId,
        };
        SHARCContainer._NATIVE_PORT_POST.call(port1, probeMsg);
      } catch (_) {
        cleanup();
        probePending = false;
        loadWhileProbePending = false;
        emitUnauthorizedNavigation();
      }
    };
    const backstop = (loadEvent) => {
      if (this._terminated) return;
      void loadEvent;
      // document.open self-rewrite discriminator (SE C3): a reopen fires a
      // fresh iframe-element `load` (empirically confirmed, C6 diagnostic).
      // Record that a post-render load occurred since the last accepted
      // `:rendered` — the `rendered`-envelope handler re-anchors the reopened
      // generation (over the SAME surviving port) ONLY when this is set, so a
      // bare REPLAYED `:rendered` (no intervening reopen, no new load) is still
      // rejected as out-of-phase
      // (preserves the S1 replay defense, RTR-D15). Consumed (cleared) when a
      // reopen `:rendered` is accepted.
      this._postRenderLoadSinceRendered = true;
      if (gateEveryLoad) {
        // A load arriving while a probe is still outstanding is latched and
        // re-evaluated when the outstanding probe resolves (preserves the
        // double-load-in-one-window defense).
        if (probePending) {
          loadWhileProbePending = true;
          return;
        }
        runGate();
        return;
      }
      // URL variant (no renderer protocol channel): unchanged policy — any
      // post-render cross-document load is unauthorized navigation.
      emitUnauthorizedNavigation();
    };
    this._rendererBackstopHandler = backstop;
    this._iframe.addEventListener('load', backstop, false);
  }

  /**
   * Detaches the renderer iframe's load-event navigation backstop.
   * Called from `_terminate` BEFORE iframe DOM removal — the iframe
   * is removed from the DOM further down (which would GC the listener
   * anyway), but explicit detach matches the message-listener pattern
   * and keeps `_terminate` idempotent if some future change re-orders
   * the DOM removal.
   *
   * @private
   */
  _disarmRendererBackstop() {
    if (this._rendererBackstopHandler && this._iframe) {
      try {
        this._iframe.removeEventListener('load', this._rendererBackstopHandler, false);
      } catch (_) { /* ignore */ }
    }
    this._rendererBackstopHandler = null;
    // Lifecycle tidiness: clear any probe timeout still pending when an
    // unrelated external termination disarms the backstop. The timer's
    // callback (`emitUnauthorizedNavigation`) and `onAck` are both
    // `_terminated`-guarded, so a survivor is harmless — but a dangling
    // timer is still a leak. The probe timeout id lives on the instance
    // (set in `runGate`) precisely so it can be cleared from out here.
    if (this._rendererProbeTimeoutId !== null) {
      clearTimeout(this._rendererProbeTimeoutId);
      this._rendererProbeTimeoutId = null;
    }
    this._armedProbeId = null;
    this._armedProbeIssuedAt = null;
    // Detach the captured-native probe listener from `port1`.
    if (this._probePort && this._probePortHandler) {
      try {
        this._probePort.removeEventListener('message', this._probePortHandler, false);
      } catch (_) { /* ignore */ }
    }
    this._probePortHandler = null;
    this._probePort = null;
  }

  /**
   * Invokes `this._onSecurityEvent` with try/catch and standardized error
   * logging. Used by both the chokepoint (`_emitSecurityEventAndTerminate`)
   * and — via the static peer `_safeInvokeSecurityCallback` — by the
   * wrapper-cross-origin carve-out at construction (the only non-terminating
   * security event, fired before `this._onSecurityEvent` is wired).
   *
   * Per spec § Security Model line 729 (`onSecurityEvent` error-handling
   * contract): when the callback throws, the catch log MUST NOT echo the
   * original event payload to console — the dev-channel surface only
   * reports a sanitized handler error, defending against a malicious
   * throwing handler exfiltrating event details into adjacent
   * error-tracking pipelines.
   *
   * See: constructor wrapper carve-out (search for `_safeInvokeSecurityCallback` call)
   *
   * @param {SHARCSecurityEvent} payload
   * @private
   */
  _invokeSecurityCallback(payload) {
    SHARCContainer._safeInvokeSecurityCallback(
      this._onSecurityEvent,
      this.placementSessionId,
      payload
    );
  }

  /**
   * Static peer of `_invokeSecurityCallback`. Same try/catch + spec-compliant
   * log behavior, but accepts the callback and `placementSessionId` as
   * explicit arguments so the wrapper-cross-origin carve-out can use it
   * during construction — before `this._onSecurityEvent` and
   * `this.placementSessionId` are wired (lines ~716/765 of the constructor).
   *
   * @param {SHARCSecurityEventCallback|null|undefined} callback
   * @param {string} placementSessionId
   * @param {SHARCSecurityEvent} payload
   * @private
   */
  static _safeInvokeSecurityCallback(callback, placementSessionId, payload) {
    if (typeof callback !== 'function') return;
    try {
      callback(payload);
    } catch (cbErr) {
      // Spec § onSecurityEvent error-handling contract (line 729): a throwing
      // callback MUST NOT prevent container actions, MUST NOT propagate, and
      // MUST log via console.error. Per the contract we explicitly do NOT
      // include the original event payload in the catch log.
      console.error('[SHARCContainer] [' + placementSessionId
        + '] onSecurityEvent callback threw; continuing.', cbErr);
    }
  }

  /**
   * Single funnel for renderer-protocol terminations. Owns FOUR concerns:
   *   1. Re-entrancy guard (post-microtask idempotency)
   *   2. Internal-type → structured-channel-type translation (5-event spec vocabulary)
   *   3. Structured-channel emission (`onSecurityEvent`)
   *   4. Dev-channel emission (`console.error`) + `_handleFatalError`
   *
   * Phase D added (2) and (3); the prior chokepoint did only (1) and (4).
   *
   * Emits a structured `onSecurityEvent` and terminates via
   * `_handleFatalError`. Single chokepoint for all renderer-protocol
   * terminations — Phase D plugs the structured-event emission HERE rather
   * than at every call site, so the spec ordering (`onSecurityEvent` fires
   * BEFORE `onError`) and re-entrancy guard hold for every variant.
   *
   * Two `type` vocabularies are in play:
   *
   *   1. **Dev-channel `[type]` log tag** (the `internalType` argument). Seven
   *      granular values for grep-ability in production console output:
   *      `renderer_protocol_timeout`, `renderer_protocol_post_failed`,
   *      `renderer_integrity_failed`,
   *      `renderer_protocol_error`, `renderer_origin_mismatch`,
   *      `renderer_failed`, `bridge_load_failed`, `unauthorized_navigation`.
   *
   *   2. **Structured-channel `event.type`** — six reserved values: five from
   *      proposal § Security Model line 715–723 (`renderer_origin_mismatch`,
   *      `renderer_protocol_error`, `renderer_failed`,
   *      `unauthorized_navigation`, `wrapper_top_frame_inaccessible`) plus
   *      `bridge_load_failed` added in 0.7.1 (issue #82). Both timeout
   *      (2114) and post-failed (2119) flow through the structured channel
   *      as `renderer_protocol_error` with a `details.subtype` discriminating
   *      timeout vs post-failed vs integrity-failed vs malformed-payload — the
   *      spec vocabulary has only one event type for renderer protocol
   *      failures, so we honor it. `bridge_load_failed` carries error code 2115 (same as
   *      `renderer_failed`) but gets its own `event.type` for operator
   *      observability — bridge import failures are a distinct deployment
   *      concern from creative-side render failures.
   *
   * Console output is prefixed with the `placementSessionId` (Compliance
   * Auditor F1, Phase D) to make multi-container pages diagnosable.
   *
   * @param {string} internalType - Dev-channel `[type]` tag for the
   *   `console.error` line. Seven granular values; see above.
   * @param {number} errorCode - SHARC error code (e.g. RENDERER_TIMEOUT 2114).
   * @param {string} message - Human-readable description (already sanitized
   *   if it interpolates renderer-supplied strings).
   * @param {Object<string, unknown>} [details={}] - Per-event-type payload
   *   matching the discriminated-union schema. Passed RAW to operators on the
   *   structured channel (no sanitization — operators get fidelity; only the
   *   dev-channel `console.error` is sanitized).
   * @private
   */
  _emitSecurityEventAndTerminate(internalType, errorCode, message, details = {}) {
    // Re-entrancy guard (post-microtask idempotency). _handleFatalError is
    // async — between this call and _terminate actually detaching the listener
    // and setting _terminated, microtasks drain. A second terminating message
    // delivered AFTER that microtask boundary would otherwise dispatch through
    // here a second time, double-firing _onError, console.error, and (Phase D)
    // _onSecurityEvent.
    //
    // Scope: this guard protects against post-microtask re-entry (the realistic
    // browser scenario, where cross-origin postMessage queues messages as
    // separate tasks with microtasks draining between). It does NOT claim
    // protection against synchronous double-dispatch — cross-origin postMessage
    // cannot deliver two messages synchronously, so that case doesn't occur
    // outside of test code.
    //
    // Mirror of _onRendererRendered's _terminated guard at the chokepoint, so
    // all renderer-protocol terminate paths AND the Phase D onSecurityEvent
    // emission are idempotent at a single source.
    if (this._terminated) return;

    // 1. Structured-channel emission — fires BEFORE the dev-channel log and
    //    BEFORE _handleFatalError (which fires onError). Spec ordering
    //    (proposal § Security Model line 734): `onSecurityEvent` first, then
    //    container terminates, then `onError`. Operators that hook both
    //    callbacks rely on this ordering for security-event correlation.
    //
    //    Map the granular internal type to the spec's 5-event vocabulary.
    //    Both timeout and post-failed surface as `renderer_protocol_error`
    //    (the subtype discriminates inside `details`).
    if (typeof this._onSecurityEvent === 'function') {
      let structuredType;
      if (internalType === 'renderer_protocol_timeout'
          || internalType === 'renderer_protocol_post_failed'
          || internalType === 'renderer_integrity_failed') {
        structuredType = 'renderer_protocol_error';
      } else {
        structuredType = internalType;
      }
      // The helper accepts loose argument types because every renderer-
      // protocol call site builds its own per-variant `details` payload.
      // Each call site is documented to provide the right shape for its
      // `internalType`; we cast at the call to the discriminated-union
      // callback signature here. (TypeScript can't statically prove the
      // payload-shape correspondence without splitting the helper into
      // five per-event-type functions, which would re-introduce the
      // chokepoint-fragmentation Phase B/C deliberately avoided.)
      this._invokeSecurityCallback(/** @type {SHARCSecurityEvent} */ ({
        type: structuredType,
        severity: 'error',
        errorCode: errorCode,
        timestamp: Date.now(),
        placementSessionId: this.placementSessionId,
        message: message,
        details: details,
      }));
    }

    // 2. Dev-channel log so a bare `console.error` filter still catches the
    //    failure. The `[<placementSessionId>] [<internalType>]` tags make the
    //    failure mode grep-able and correlatable across multi-container
    //    pages. (Phase D Compliance Auditor F1 — placementSessionId
    //    consistency.)
    console.error('[SHARCContainer] [' + this.placementSessionId + '] ['
      + internalType + '] ' + message + ' — terminating container.');

    // 3. Standard fatal-error path — fires onError synchronously, then
    //    sendFatalError().then(_terminate).
    this._handleFatalError(errorCode, message);
  }

  /**
   * Emits a non-terminating `feature_load_failed` structured security event.
   * Parallels `_emitSecurityEventAndTerminate` but WITHOUT the fatal-error
   * tail — extensions that fail to load their publisher-page assets must
   * not kill the container. Added 0.7.4 (issue #125).
   *
   * Generalizable beyond OMID: any extension that loads remote scripts on
   * the publisher page can route its load-failure through this helper.
   * `OmidCompatBridge` is the first in-tree consumer.
   *
   * Bounds `scriptUrl` to 500 chars at the chokepoint (parity with
   * `bridge_load_failed.details.url` cap on the renderer-failure call site)
   * so a hostile or buggy extension cannot smuggle unbounded strings into
   * an operator's event-tracking pipeline.
   *
   * Suppresses emission if the container has already terminated — late
   * promise-rejection arrivals after `_terminate()` are normal teardown,
   * not feature-load failures.
   *
   * @param {string} featureName - Canonical `supportedFeatures` entry
   *   identifying the extension whose load failed (e.g.
   *   `'com.iabtechlab.sharc.omid'`).
   * @param {string} reason - Classified failure token. Current in-tree
   *   bridges emit `'timeout'`, `'network'`, or `'evaluation_throw'`
   *   (script-tag loaders can't distinguish 404 vs. transport failure).
   *   The parameter accepts any non-empty string so future fetch-based
   *   loaders can emit additional tokens (e.g. `'http_404'`).
   * @param {string} scriptUrl - URL of the asset that failed to load.
   *   Bounded to 500 chars before emission.
   * @private
   */
  _emitFeatureLoadFailed(featureName, reason, scriptUrl) {
    if (this._terminated) return;

    const safeFeatureName = (typeof featureName === 'string' && featureName.length > 0)
      ? featureName
      : 'unknown';
    const safeReason = (typeof reason === 'string' && reason.length > 0)
      ? reason
      : 'unknown';
    const safeUrl = (typeof scriptUrl === 'string')
      ? scriptUrl.slice(0, 500)
      : '';

    const message = 'Extension feature load failed: '
      + this._sanitizeForLog(safeFeatureName) + ' — '
      + this._sanitizeForLog(safeReason);

    if (typeof this._onSecurityEvent === 'function') {
      this._invokeSecurityCallback(/** @type {SHARCSecurityEvent} */ ({
        type: 'feature_load_failed',
        severity: 'error',
        timestamp: Date.now(),
        placementSessionId: this.placementSessionId,
        message: message,
        details: {
          featureName: safeFeatureName,
          reason: safeReason,
          scriptUrl: safeUrl,
        },
      }));
    }

    // Dev-channel log mirrors the chokepoint pattern but uses console.warn
    // (non-terminating event). The `[<placementSessionId>] [feature_load_failed]`
    // tags keep the failure grep-able across multi-container pages.
    console.warn('[SHARCContainer] [' + this.placementSessionId
      + '] [feature_load_failed] ' + message);
  }

  /**
   * Emits a non-terminating `omid_resource_cap` structured security event
   * (#244 design D7). Parallels `_emitFeatureLoadFailed`: an extension's
   * per-session resource bound tripping must be LOUD (operators see reduced
   * measurement coverage in their event pipeline) but must never kill the ad
   * — resource governance is L1 policy, not a creative failure.
   *
   * Suppresses emission after termination (parity with the other
   * non-terminating emitters).
   *
   * @param {string} featureName - Canonical `supportedFeatures` entry whose
   *   resource bound tripped (e.g. `'com.iabtechlab.sharc.omid'`).
   * @param {number} requestedCount - Distinct resources configured.
   * @param {number} keptCount - Resources kept after truncation.
   * @param {number} limit - The enforced bound.
   * @private
   */
  _emitOmidResourceCap(featureName, requestedCount, keptCount, limit) {
    if (this._terminated) return;

    const safeFeatureName = (typeof featureName === 'string' && featureName.length > 0)
      ? featureName
      : 'unknown';
    const safeRequested = (typeof requestedCount === 'number' && Number.isFinite(requestedCount))
      ? requestedCount
      : 0;
    const safeKept = (typeof keptCount === 'number' && Number.isFinite(keptCount))
      ? keptCount
      : 0;
    const safeLimit = (typeof limit === 'number' && Number.isFinite(limit))
      ? limit
      : 0;

    const message = 'OMID verification resource cap tripped for '
      + this._sanitizeForLog(safeFeatureName) + ': ' + safeRequested
      + ' distinct resources configured, ' + safeKept
      + ' kept (limit ' + safeLimit + ').';

    if (typeof this._onSecurityEvent === 'function') {
      this._invokeSecurityCallback(/** @type {SHARCSecurityEvent} */ ({
        type: 'omid_resource_cap',
        severity: 'warning',
        timestamp: Date.now(),
        placementSessionId: this.placementSessionId,
        message: message,
        details: {
          featureName: safeFeatureName,
          requestedCount: safeRequested,
          keptCount: safeKept,
          limit: safeLimit,
        },
      }));
    }

    console.warn('[SHARCContainer] [' + this.placementSessionId
      + '] [omid_resource_cap] ' + message);
  }

  /**
   * Emits a non-terminating `renderer_load_observed` structured security event
   * (0.7.10 Phase 1). Fired when a post-render renderer-frame `load` event
   * occurred and the controlled-context gate (loadProbe/loadAck) was answered
   * within the deadline — SHARC still holds the authenticated protocol channel,
   * so the ad is kept alive. This is the controlled half of the formerly
   * blanket-fatal 2118.
   *
   * Mirrors `_emitFeatureLoadFailed`'s non-terminating shape: no
   * `_handleFatalError` tail. The `variant` derivation is identical to the 2118
   * call site so operators can correlate observed vs. terminating outcomes on
   * the same discriminator.
   *
   * @param {'first' | 'subsequent'} loadKind - Coarse hint distinguishing the
   *   first verified post-render load from later ones.
   * @private
   */
  _emitRendererLoadObserved(loadKind) {
    if (this._terminated) return;
    const variant = (this.creativeSource === 'html') ? 'markup' : 'url';
    const msSinceRender = (typeof this._renderedAt === 'number')
      ? Math.max(0, Date.now() - this._renderedAt)
      : 0;
    const message = (variant === 'markup' ? 'Renderer' : 'Creative URL')
      + ' iframe load observed ' + msSinceRender + 'ms post-render; '
      + 'controlled-context gate answered — ad kept alive.';
    if (typeof this._onSecurityEvent === 'function') {
      this._invokeSecurityCallback(/** @type {SHARCSecurityEvent} */ ({
        type: 'renderer_load_observed',
        severity: 'info',
        timestamp: Date.now(),
        placementSessionId: this.placementSessionId,
        message: message,
        details: {
          variant: variant,
          msSinceRender: msSinceRender,
          loadKind: loadKind,
          // Numeric telemetry symmetry with the 2118 terminating event.
          // Lives in `details` (NOT top-level `errorCode`) because this event
          // is non-terminating and must never reach `onError` — tests pin
          // `errorCode === undefined`.
          code: ErrorCodes.RENDERER_LOAD_OBSERVED,
        },
      }));
    }
    console.info('[SHARCContainer] [' + this.placementSessionId
      + '] [renderer_load_observed] ' + message);
  }

  /**
   * Emits the reserved non-terminating `renderer_navigation_blocked` (2122)
   * structured security event (#332). Fired when the answered probe-cycle rate
   * ceiling (`PROBE_CYCLE_CEILING_MAX` answered cycles within
   * `PROBE_CYCLE_CEILING_WINDOW_MS`) is crossed in `_armRendererBackstop`: a
   * renderer that answers the controlled-context probe on every load cycle is
   * driving a keep-alive / log-volume DoS-adjacent flood. Crossing the ceiling
   * THROTTLES — the per-cycle `renderer_load_observed` emissions are suppressed
   * and this single diagnostic surfaces the classified behavior — while keeping
   * the ad ALIVE (Decision 0/2). It is non-terminating: SHARC still holds the
   * authenticated channel, so it does not escalate to 2118 (reserved for
   * lost-control).
   *
   * Mirrors `_emitRendererLoadObserved`'s non-terminating shape (no
   * `_handleFatalError` tail, `details.code` for numeric symmetry, NO top-level
   * `errorCode`). `severity: 'warning'` per the reserved
   * `RendererNavigationBlockedEvent` typedef — a classified-blocked behavior is a
   * step above an observed-and-tolerated load.
   *
   * @param {string} navKind - Classification of the blocked behavior. #332 uses
   *   `'answered_probe_cycle_ceiling'` (chatty-renderer rate bound). Phase-2
   *   intent classification will contribute further kinds later.
   * @private
   */
  _emitRendererNavigationBlocked(navKind) {
    if (this._terminated) return;
    const variant = (this.creativeSource === 'html') ? 'markup' : 'url';
    const message = (variant === 'markup' ? 'Renderer' : 'Creative URL')
      + ' iframe answered the controlled-context probe more than '
      + PROBE_CYCLE_CEILING_MAX + ' times within '
      + PROBE_CYCLE_CEILING_WINDOW_MS + 'ms — throttling redundant '
      + 'renderer_load_observed diagnostics. Ad kept alive (SHARC still holds '
      + 'the channel); classified ' + navKind + '.';
    if (typeof this._onSecurityEvent === 'function') {
      this._invokeSecurityCallback(/** @type {SHARCSecurityEvent} */ ({
        type: 'renderer_navigation_blocked',
        severity: 'warning',
        timestamp: Date.now(),
        placementSessionId: this.placementSessionId,
        message: message,
        details: {
          variant: variant,
          navKind: navKind,
          // Numeric telemetry symmetry with 2118/2121. In `details` (NOT
          // top-level `errorCode`) because this event is non-terminating and
          // must never reach `onError`.
          code: ErrorCodes.RENDERER_NAVIGATION_BLOCKED,
        },
      }));
    }
    console.warn('[SHARCContainer] [' + this.placementSessionId
      + '] [renderer_navigation_blocked] ' + message);
  }

  // -------------------------------------------------------------------------
  // Page Lifecycle tracking (web browser)
  // -------------------------------------------------------------------------

  /**
   * Attaches browser Page Lifecycle event listeners.
   * Maps browser visibility/focus events to SHARC state transitions.
   * @private
   */
  _attachPageLifecycleListeners() {
    document.addEventListener('visibilitychange', this._visibilityHandler, false);
    window.addEventListener('focus', this._pageFocusHandler, false);
    window.addEventListener('blur', this._pageBlurHandler, false);
    document.addEventListener('freeze', this._freezeHandler, false);
    document.addEventListener('resume', this._resumeHandler, false);
    // Constraint-relevant: viewport resize and orientation change
    window.addEventListener('resize', this._constraintsResizeHandler, false);
    window.addEventListener('orientationchange', this._constraintsOrientationHandler, false);
  }

  /**
   * Removes browser Page Lifecycle event listeners.
   * @private
   */
  _detachPageLifecycleListeners() {
    document.removeEventListener('visibilitychange', this._visibilityHandler, false);
    window.removeEventListener('focus', this._pageFocusHandler, false);
    window.removeEventListener('blur', this._pageBlurHandler, false);
    document.removeEventListener('freeze', this._freezeHandler, false);
    document.removeEventListener('resume', this._resumeHandler, false);
    window.removeEventListener('resize', this._constraintsResizeHandler, false);
    window.removeEventListener('orientationchange', this._constraintsOrientationHandler, false);
    if (this._constraintsDebounceTimer) {
      clearTimeout(this._constraintsDebounceTimer);
      this._constraintsDebounceTimer = null;
    }
  }

  /** @private */
  _onPageFocus() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.PASSIVE) {
      this._transitionToActive();
    }
  }

  /** @private */
  _onPageBlur() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.ACTIVE) {
      // Defer so document.activeElement reflects the new focus target.
      // If focus moved to our own iframe, the user is interacting with
      // the ad — do not transition to passive.
      setTimeout(() => {
        if (document.activeElement === this._iframe) return;
        if (this._stateMachine.getState() === ContainerStates.ACTIVE) {
          this.setState(ContainerStates.PASSIVE);
        }
      }, 0);
    }
  }

  /** @private */
  _onVisibilityChange() {
    // Slice C — surface the raw axis-2 boolean alongside the existing setState
    // path (additive; the enum path below is untouched).
    this._onRawParentVisibility(document.visibilityState === 'visible');
    const state = this._stateMachine.getState();
    if (document.visibilityState === 'hidden') {
      if (state === ContainerStates.ACTIVE) {
        // The Page Lifecycle can fire visibilitychange without a prior blur on
        // mobile (for example Android backgrounding). Mirror the actual browser
        // state and transition directly once hidden is already true.
        this.setState(ContainerStates.HIDDEN);
      } else if (state === ContainerStates.PASSIVE) {
        this.setState(ContainerStates.HIDDEN);
      }
    } else if (document.visibilityState === 'visible') {
      // Slice C (F6c) — a freeze whose `resume` never fired (missed-resume
      // bfcache oddity) would leave `_frozen` latched and the NEXT
      // backgrounding would misreport 'frozen'. A visible visibilitychange is
      // proof the page is running again — clear the stale flag here too.
      this._frozen = false;
      if (state === ContainerStates.HIDDEN) {
        // Return to passive (may become active on next focus event)
        this.setState(ContainerStates.PASSIVE);
      }
    }
  }

  /** @private */
  _onFreeze() {
    // Slice C — freeze is the axis-2 sub-state driving the `frozen` reason.
    this._frozen = true;
    // Push the transition: a hidden creative that already received
    // 0/'backgrounded' must receive 0/'frozen'. When the axis-2 gate is OPEN
    // (freeze while visible) the compose is unchanged and the push dedups to
    // a no-op — 'frozen' only surfaces when parentVisible is false.
    this._pushEffectiveVisibility();
    const state = this._stateMachine.getState();
    if (state === ContainerStates.HIDDEN) {
      this.setState(ContainerStates.FROZEN);
    }
  }

  /** @private */
  _onResume() {
    // Slice C — resume clears the axis-2 freeze sub-state.
    this._frozen = false;
    // Push the transition (symmetric with _onFreeze): a resume that leaves
    // the page hidden moves 0/'frozen' back to 0/'backgrounded'. Sits BEFORE
    // the adapter-yield below — the yield governs restore AUTHORITY (who
    // drives the state machine), not the effective-visibility channel.
    this._pushEffectiveVisibility();
    // R3 §3.1 (INV-R1/R2/R3): single restore authority. When a lifecycle
    // adapter is attached it OWNS the FROZEN-exit destination — it holds the
    // IntersectionObserver ratio and therefore resolves the *correct*
    // destination (visible+intersecting≥0.5 ⇒ ACTIVE), where this focus-only
    // container chain would under-resolve a visible-but-unfocused page to
    // PASSIVE. The container yields, mirroring the existing strict-LOADING
    // yield in the adapter. The adapter's own `resume`/`pageshow` handlers
    // drive the restore (and the §3.2 level re-assert). When NO adapter is
    // attached (native-SHARC, no IntersectionObserver), the container chain
    // remains the authority — it is the only driver.
    if (this._lifecycleAdapter) return;

    const state = this._stateMachine.getState();
    if (state === ContainerStates.FROZEN) {
      // Resume to appropriate state based on current visibility
      if (document.visibilityState === 'visible') {
        if (document.hasFocus()) {
          this._transitionToActive();
        } else {
          this.setState(ContainerStates.PASSIVE);
        }
      } else {
        this.setState(ContainerStates.HIDDEN);
      }
      // R3 §3.2 (INV-R4/R5): re-assert the current visibility LEVEL after the
      // restore resolves, so an extension (e.g. OMID) that lost the level
      // across the freeze re-receives it even when the restore produced no
      // fresh edge into the current state. No-adapter native path.
      this._reassertCurrentStateAfterRestore();
    }
  }

  /**
   * R3 §3.2 — level-triggered visibility replay on restore (INV-R4..R7).
   *
   * On a confirmed bfcache/freeze restore, re-asserts the CURRENT lifecycle
   * level to registered extensions exactly once, regardless of whether the
   * restore produced a state-machine transition edge. This is the bfcache
   * analogue of R1's establish-push: deliver the level, not just the edge.
   *
   * The OMID bridge's `onContainerStateChange('active')` reaches
   * `_signalVisibility('visible')`; the OMID-side `lastVisibilityState` guard
   * keeps it idempotent. This re-assert carries `newState === previousState`
   * (so it fabricates NO intermediate edge, INV-R6) and is marked
   * `restored: true` so consumers can distinguish it from a fresh transition.
   *
   * Only delivers a creative-queryable, non-`loading`/`terminated` state
   * (INV-R7); a restore that resolves to a non-queryable state delivers
   * nothing. It does NOT touch the state machine and produces no `onChange`.
   * @private
   */
  _reassertCurrentStateAfterRestore() {
    if (this._terminated) return;
    const current = this._stateMachine ? this._stateMachine.getState() : null;
    if (!current || !this._stateMachine.isCreativeQueryable(current)) return;
    this._notifyExtensionsLifecycle('stateChange', {
      newState: current,
      previousState: current,
      restored: true,
    });
  }

  /**
   * R3 §3.3 — dead-port detect + relink (INV-R8..R12), detection D-a.
   *
   * bfcache discards the MessageChannel, so on a `pageshow{persisted:true}`
   * restore `this._protocol._port` references a dead port — a push into it is
   * lost. This re-establishes the per-session creative channel by re-running
   * the EXISTING `initChannel` bootstrap (new MessageChannel, new `port2`
   * transferred to the same creative iframe origin), then delivers the current
   * lifecycle state over the new live port so R1's creative-side replay
   * (MRAID/SafeFrame) re-syncs.
   *
   * Transport-only (INV-R10): reuses the SAME `placementSessionId` and the SAME
   * `sessionId` (INV-R9) — the placement session did not end (the page was
   * parked, not navigated away), so the session-validation gate and the 0.7.7
   * router nonces (derived over `placementSessionId`) are unchanged. NO new
   * message type, NO envelope field, NO `rederiveAllProtocolNonces()` re-mint:
   * the OMID iframe shim survives bfcache (confirmed by the build-phase Chrome
   * probe), and its relay rides the router's `window`-message transport, not
   * this per-session MessagePort.
   *
   * Clean failure (INV-R12): when there is no established session (native /
   * plain-HTML, `sessionId === ''`), no MessageChannel transport, or no creative
   * iframe to re-bootstrap, this no-ops without throwing and without emitting
   * into the dead port. The publisher-page level re-assert (INV-R4/R5) runs
   * independently of this and is unaffected.
   * @private
   */
  _relinkCreativeChannel() {
    if (this._terminated) return;
    const proto = this._protocol;
    if (!proto) return;
    // Only relink an established MessageChannel session. Native / plain-HTML
    // creatives never establish a session (sessionId === '') and have no port
    // to relink; the fallback postMessage transport is not a MessagePort.
    if (proto.sessionId === '') return;
    if (proto._usingMessageChannel === false) return;
    const iframe = this._iframe;
    if (!iframe || !iframe.contentWindow) return;

    // Re-run the existing bootstrap with the SAME identity. The targetOrigin
    // mirrors the original `initChannel` call sites: '*' for the URL variant
    // (the port carries no sensitive data), the validated renderer origin for
    // the Markup variant.
    const targetOrigin = this.creativeSource === 'html'
      ? /** @type {string} */ (this._rendererOrigin)
      : '*';
    try {
      proto.initChannel(iframe.contentWindow, targetOrigin, this.placementSessionId);
    } catch (_) {
      // Defensive — a bootstrap postMessage into a torn-down window can throw.
      // Fail cleanly per INV-R12; do not propagate into the page.
      return;
    }

    // INV-R11: deliver the current lifecycle state over the new live port so
    // R1's creative-side replay re-syncs. Reset the per-session send dedup so
    // the first post-relink send is never suppressed against a pre-freeze value
    // sent over the now-dead port. Respects the send-layer dedup thereafter.
    const current = this._stateMachine ? this._stateMachine.getState() : null;
    if (current && this._stateMachine.isCreativeQueryable(current)) {
      proto._lastSentState = undefined;
      proto.sendStateChange(current);
      // Slice C (F6a) — same replay-precedent reset for the EV channel: the
      // restored creative's replay cache did not survive the park the way this
      // relink path assumes for state, so reset the send dedup and re-push the
      // current effective value over the NEW live port. An unchanged value
      // would otherwise be dedup-suppressed against a pre-freeze send into the
      // now-dead port.
      this._lastEffectivePayload = undefined;
      // Slice D (#413) — reset the extension cache too: this is what lets the
      // bfcache restore RE-DELIVER the current effective value to OMID even
      // when it composes identically to the pre-freeze value (restore into the
      // same visible viewport), so the extension re-asserts visibility after
      // the park instead of dedup-suppressing against a pre-freeze delivery.
      this._lastExtensionEffectivePayload = undefined;
      this._pushEffectiveVisibility();
    }
  }

  // -------------------------------------------------------------------------
  // Constraint change notifications
  // -------------------------------------------------------------------------

  /**
   * Handles viewport resize events that may affect placement constraints.
   * Debounced at 200ms to avoid flooding the creative during drag-resize.
   * @private
   */
  _onConstraintsRelevantResize() {
    this._debounceConstraintsNotification('viewportResize');
  }

  /**
   * Handles device orientation changes that may affect placement constraints.
   * @private
   */
  _onConstraintsRelevantOrientation() {
    this._debounceConstraintsNotification('rotation');
  }

  /**
   * Debounces constraint change notifications.
   * @param {string} reason - 'rotation', 'viewportResize', or 'policyUpdate'
   * @private
   */
  _debounceConstraintsNotification(reason) {
    if (this._constraintsDebounceTimer) {
      clearTimeout(this._constraintsDebounceTimer);
    }
    this._constraintsDebounceTimer = setTimeout(() => {
      this._constraintsDebounceTimer = null;
      this._sendConstraintsChange(reason);
    }, 200);
  }

  /**
   * Sends a placementConstraintsChange notification to the creative.
   * @param {string} reason - Why constraints changed
   * @private
   */
  _sendConstraintsChange(reason) {
    if (this._terminated || this._protocol._terminated) return;
    const policy = this._placementPolicy || {};
    this._protocol._sendMessage(ContainerMessages.PLACEMENT_CONSTRAINTS_CHANGE, {
      maxWidth:           policy.maxWidth != null ? policy.maxWidth : null,
      maxHeight:          policy.maxHeight != null ? policy.maxHeight : null,
      allowedIntents:     policy.allowedIntents || ['resize', 'expand', 'fullscreen', 'collapse'],
      requireCloseRegion: !!policy.requireCloseRegion,
      allowOffscreen:     policy.allowOffscreen !== false,
      reason:             reason,
    });
  }

  /**
   * Public method for publishers to update placement policy at runtime.
   * Triggers a constraintsChange notification to the creative.
   * @param {Object} newPolicy - New placement policy (same shape as constructor option).
   */
  updatePlacementPolicy(newPolicy) {
    this._placementPolicy = newPolicy || undefined;
    this._sendConstraintsChange('policyUpdate');
  }

  // -------------------------------------------------------------------------
  // Timeout helpers
  // -------------------------------------------------------------------------

  /**
   * Starts a named timeout.
   * @param {string} name - Timeout identifier.
   * @param {Function} callback - Called when timeout fires.
   * @returns {number} The timeout handle.
   * @private
   */
  _startTimeout(name, callback) {
    this._clearTimeout(name);
    const duration = this.timeouts[name] || DEFAULT_TIMEOUTS[name] || 5000;
    this._timeouts[name] = setTimeout(callback, duration);
    return this._timeouts[name];
  }

  /**
   * Clears a named timeout.
   * @param {string} name
   * @private
   */
  _clearTimeout(name) {
    if (this._timeouts[name]) {
      clearTimeout(this._timeouts[name]);
      delete this._timeouts[name];
    }
  }

  /**
   * Starts the createSession receipt timeout.
   * @private
   */
  _startSessionTimeout() {
    this._startTimeout('createSession', () => {
      console.error('[SHARCContainer] Timeout waiting for createSession — terminating container');
      this._handleFatalError(ErrorCodes.NO_CREATE_SESSION, 'createSession not received within timeout');
    });
  }

  // -------------------------------------------------------------------------
  // Tracker firing
  // -------------------------------------------------------------------------

  /**
   * Fires tracking URIs in parallel via HTTP GET.
   * @param {string[]} uris - Array of tracking URIs to fire.
   * @returns {Promise<Array>} Array of result objects.
   * @private
   */
  _fireTrackers(uris) {
    if (!uris || uris.length === 0) return Promise.resolve([]);

    const TRACKER_TIMEOUT = 5000;
    const _MAX_REDIRECTS = 5;

    const fireOne = (uri) => {
      return new Promise((resolve) => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutHandle = setTimeout(() => {
          if (controller) controller.abort();
          resolve({ uri, success: false, reason: 'timeout' });
        }, TRACKER_TIMEOUT);

        /** @type {RequestInit} */
        const fetchOptions = {
          method: 'GET',
          redirect: 'follow',
          mode: 'no-cors',
          ...(controller ? { signal: controller.signal } : {}),
        };

        fetch(uri, fetchOptions)
          .then(() => {
            clearTimeout(timeoutHandle);
            resolve({ uri, success: true });
          })
          .catch((err) => {
            clearTimeout(timeoutHandle);
            resolve({ uri, success: false, reason: err.message || 'fetch error' });
          });
      });
    };

    return Promise.all(uris.map(fireOne));
  }

  // -------------------------------------------------------------------------
  // Close button rendering (container-owned, outside sandbox)
  // -------------------------------------------------------------------------

  /**
   * Creates the container-owned dismiss button (sibling to iframe, outside sandbox).
   * Always collapses the ad to its default size. Expand/fullscreen are treated
   * as resizes — dismiss collapses, it does not close/terminate the ad.
   * @param {string} position - Resolved position ('top-right', 'top-left', etc.)
   * @param {Object} [targetDims] - Target dimensions {width, height} for positioning
   * @param {Object} [targetPos] - Target position {x, y} offset for positioning
   * @private
   */
  _createDismissButton(position, targetDims, targetPos) {
    this._removeDismissButton();

    // ── Upgrade: use <button type="button"> for proper semantics ──
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sharc-close-button';
    btn.setAttribute('aria-label', 'Close ad');

    // 50×50 tap target (MRAID minimum), 30×30 visible close icon centered inside.
    btn.style.cssText = [
      'position:absolute',
      'width:50px',
      'height:50px',
      'min-width:50px',
      'min-height:50px',
      'z-index:2147483647',
      'cursor:pointer',
      'background:transparent',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'user-select:none',
      '-webkit-user-select:none',
      'pointer-events:auto',
      'box-sizing:border-box',
      'border:none',
      'padding:0',
      'margin:0',
      'outline:none',
      'font:inherit',
      'color:inherit',
    ].join(';');

    // ── DOM stamping: close button ──
    btn.setAttribute('data-sharc-placement-session-id', this.placementSessionId);

    // Apply publisher customization if provided
    if (this._closeButtonStyles) {
      Object.assign(btn.style, this._closeButtonStyles);
      // Enforce visibility — close button must always be interactive and visible
      btn.style.opacity = '1';
      btn.style.visibility = 'visible';
      btn.style.pointerEvents = 'auto';
      btn.style.display = 'flex';
    }

    // Enforce minimum 50px regardless — parseInt is fragile with non-px units
    // (e.g. '3em', 'auto'). CSS min-width/min-height enforces the floor
    // regardless of what the publisher set for width/height.
    btn.style.minWidth = '50px';
    btn.style.minHeight = '50px';

    // Prevent size collapse via max-width/max-height or overflow clipping
    btn.style.maxWidth = 'none';
    btn.style.maxHeight = 'none';
    btn.style.overflow = 'visible';

    // Position relative to the target dimensions
    this._applyClosePosition(btn, position, targetDims, targetPos);

    // 30×30 visible icon centered inside the 50×50 tap target
    const icon = document.createElement('span');
    icon.textContent = '\u00D7';
    icon.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'width:30px',
      'height:30px',
      'background:rgba(0,0,0,0.6)',
      'border-radius:50%',
      'color:#fff',
      'font-size:18px',
      'line-height:1',
      'pointer-events:none',
    ].join(';');
    btn.appendChild(icon);

    // Dismiss button always collapses to default size.
    // Expand/fullscreen are resizes — collapse, don't close.
    // Close (ad termination) is a separate action, not triggered by this button.
    const self = this;
    const handleClick = () => {
      self._handleRequestPlacementChange({
        args: { intent: 'collapse' },
        messageId: -1,
        type: 'synthetic',
      });
    };

    btn.addEventListener('click', handleClick);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    });

    if (this._currentIntent === 'fullscreen') {
      // Fullscreen: fixed-position button on top of the viewport-covering iframe
      btn.style.position = 'fixed';
      btn.style.top = '8px';
      btn.style.right = '8px';
      btn.style.left = 'auto';
      btn.style.zIndex = '2147483647';
      document.body.appendChild(btn);
    } else {
      // Resize/expand: absolute-position button within the container element
      var computedPosition = window.getComputedStyle(this.placementElement).position;
      if (computedPosition === 'static') {
        this.placementElement.style.position = 'relative';
      }
      this.placementElement.appendChild(btn);
    }
    this._closeButton = btn;

    // Stamp the close button with session ID
    this._stampCloseButton();

    // Notify OMID extension (if present) to register the close button as a
    // friendly obstruction so it doesn't count against viewability.
    this._notifyOmidObstruction(btn, true);
  }

  /**
   * Removes the container-owned close button.
   * Called on collapse, close, and destroy.
   * @private
   */
  _removeDismissButton() {
    if (this._closeButton) {
      // Notify OMID extension to unregister the friendly obstruction
      this._notifyOmidObstruction(this._closeButton, false);
      if (this._closeButton.parentNode) {
        this._closeButton.parentNode.removeChild(this._closeButton);
      }
    }
    this._closeButton = null;
  }

  /**
   * Notifies the OMID extension (if registered) to add or remove a friendly
   * obstruction for the given element. No-op if no OMID extension is present.
   * @param {HTMLElement} element - The DOM element (close button).
   * @param {boolean} register - true to register, false to unregister.
   * @private
   */
  _notifyOmidObstruction(element, register) {
    if (!this._extensions || !element) return;
    for (let i = 0; i < this._extensions.length; i++) {
      const ext = this._extensions[i];
      if (ext && typeof ext.getFeatureName === 'function' &&
          ext.getFeatureName() === 'com.iabtechlab.sharc.omid') {
        if (register && typeof ext.registerFriendlyObstruction === 'function') {
          ext.registerFriendlyObstruction(element);
        } else if (!register && typeof ext.unregisterFriendlyObstruction === 'function') {
          ext.unregisterFriendlyObstruction();
        }
        break;
      }
    }
  }

  /**
   * Positions the close button relative to the iframe based on the
   * resolved position string.
   * @param {HTMLElement} btn - The close button element
   * @param {string} position - Position enum value
   * @private
   */
  _applyClosePosition(btn, position, targetDims, targetPos) {
    // Reset all positioning
    btn.style.top = btn.style.bottom = btn.style.left = btn.style.right = 'auto';
    btn.style.transform = '';

    // When target dimensions are provided, use explicit pixel positioning
    // so the button tracks the resized iframe, not the original container bounds.
    const btnSize = 50;
    const offsetX = (targetPos && targetPos.x) || 0;
    const offsetY = (targetPos && targetPos.y) || 0;
    const w = (targetDims && targetDims.width) || 0;
    const h = (targetDims && targetDims.height) || 0;

    if (targetDims) {
      switch (position) {
        case 'top-left':      btn.style.top = offsetY + 'px'; btn.style.left = offsetX + 'px'; break;
        case 'top-center':    btn.style.top = offsetY + 'px'; btn.style.left = (offsetX + w / 2 - btnSize / 2) + 'px'; break;
        case 'top-right':     btn.style.top = offsetY + 'px'; btn.style.left = (offsetX + w - btnSize) + 'px'; break;
        case 'center-left':   btn.style.top = (offsetY + h / 2 - btnSize / 2) + 'px'; btn.style.left = offsetX + 'px'; break;
        case 'center-right':  btn.style.top = (offsetY + h / 2 - btnSize / 2) + 'px'; btn.style.left = (offsetX + w - btnSize) + 'px'; break;
        case 'bottom-left':   btn.style.top = (offsetY + h - btnSize) + 'px'; btn.style.left = offsetX + 'px'; break;
        case 'bottom-center': btn.style.top = (offsetY + h - btnSize) + 'px'; btn.style.left = (offsetX + w / 2 - btnSize / 2) + 'px'; break;
        case 'bottom-right':  btn.style.top = (offsetY + h - btnSize) + 'px'; btn.style.left = (offsetX + w - btnSize) + 'px'; break;
        default:              btn.style.top = offsetY + 'px'; btn.style.left = (offsetX + w - btnSize) + 'px'; break;
      }
    } else {
      // Fallback: CSS-relative positioning (for expand/fullscreen where container matches)
      switch (position) {
        case 'top-left':      btn.style.top = '0'; btn.style.left = '0'; break;
        case 'top-center':    btn.style.top = '0'; btn.style.left = '50%';
                              btn.style.transform = 'translateX(-50%)'; break;
        case 'top-right':     btn.style.top = '0'; btn.style.right = '0'; break;
        case 'center-left':   btn.style.top = '50%'; btn.style.left = '0';
                              btn.style.transform = 'translateY(-50%)'; break;
        case 'center-right':  btn.style.top = '50%'; btn.style.right = '0';
                              btn.style.transform = 'translateY(-50%)'; break;
        case 'bottom-left':   btn.style.bottom = '0'; btn.style.left = '0'; break;
        case 'bottom-center': btn.style.bottom = '0'; btn.style.left = '50%';
                              btn.style.transform = 'translateX(-50%)'; break;
        case 'bottom-right':  btn.style.bottom = '0'; btn.style.right = '0'; break;
        default:              btn.style.top = '0'; btn.style.right = '0'; break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Animation support
  // -------------------------------------------------------------------------

  /**
   * Returns whether this container supports animated placement transitions.
   * @returns {boolean}
   * @private
   */
  _supportsAnimation() {
    // Animation support is opt-in via feature string registration.
    // Check if the merged features include the animation feature.
    const features = this._mergedSupportedFeatures || this._explicitSupportedFeatures || [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (f === 'com.iabtechlab.sharc.placement.animate' ||
          (f && f.name === 'com.iabtechlab.sharc.placement.animate')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Applies an animated dimension change using direct CSS `width`/`height` transitions.
   * Sets the transition property on both the placement element and iframe, applies
   * the target dimensions, then cleans up the transition property on `transitionend`
   * (or a safety timeout). Sends `PLACEMENT_TRANSITION_END` to the creative on completion.
   *
   * @param {Object} fromDims - { width, height } current dimensions
   * @param {Object} toDims - { width, height } target dimensions
   * @param {Object} transition - { duration, easing }
   * @param {string} [_anchorPoint] - 'top-left', 'top-right', 'bottom-left', 'bottom-right'
   * @private
   */
  _applyAnimatedDimensions(fromDims, toDims, transition, _anchorPoint) {
    if (!this._iframe) return null;

    const duration = this._clampDuration(transition.duration);
    const easing = this._sanitizeEasing(transition.easing || 'ease-out');

    // Duration 0 means instant — skip animation and let the caller
    // fire placementTransitionEnd after resolve + placementChange.
    if (duration === 0) {
      this._applyIframeDimensions(toDims);
      return toDims;
    }

    // Ensure starting dimensions are applied before transition begins
    this._applyIframeDimensions(fromDims);

    // Force a layout recalc so the browser registers the starting size
    // before the transition property is set.
    void this._iframe.offsetHeight;

    const dur = (duration / 1000) + 's';
    const transitionVal = 'width ' + dur + ' ' + easing + ', height ' + dur + ' ' + easing;
    this.placementElement.style.transition = transitionVal;
    this._iframe.style.transition = transitionVal;

    // Apply target dimensions — CSS transition will animate the change
    const w = this._sanitizeDimension(toDims.width);
    const h = this._sanitizeDimension(toDims.height);
    if (w !== null) { this._iframe.style.width = w; this.placementElement.style.width = w; }
    if (h !== null) { this._iframe.style.height = h; this.placementElement.style.height = h; }

    let cleanedUp = false;
    const iframe = this._iframe;
    const container = this.placementElement;
    const protocol = this._protocol;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      iframe.removeEventListener('transitionend', onEnd);
      this._clearTimeout('animatedDimensionsTransition');
      container.style.transition = '';
      iframe.style.transition = '';

      // Notify creative that transition completed
      protocol._sendMessage(ContainerMessages.PLACEMENT_TRANSITION_END, {
        finalDimensions: toDims,
      });
    };

    const onEnd = (e) => {
      if (e.target === iframe && (e.propertyName === 'width' || e.propertyName === 'height')) cleanup();
    };

    iframe.addEventListener('transitionend', onEnd);

    // Safety timeout: if transitionend never fires (tab hidden, etc.), clean up anyway.
    // Tracked in this._timeouts so _terminate()'s clear-all loop cancels it
    // if close() runs mid-animation (otherwise the post-terminate timer would
    // mutate placementElement.style.transition after _detachFromPlacement
    // already restored the original cssText).
    this._timeouts.animatedDimensionsTransition = /** @type {number} */ (/** @type {*} */ (setTimeout(cleanup, duration + 300)));
    return null;
  }

  /**
   * Clamps animation duration to safe bounds.
   * Max 500ms, min 0. Non-numbers treated as 0.
   * @param {*} duration
   * @returns {number}
   * @private
   */
  _clampDuration(duration) {
    if (typeof duration !== 'number' || duration < 0) return 0;
    return Math.min(duration, 500);
  }

  /**
   * Sanitizes an easing value to one of the five CSS keywords.
   * Anything else is replaced with 'ease-out'.
   * @param {string} easing
   * @returns {string}
   * @private
   */
  _sanitizeEasing(easing) {
    const ALLOWED = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];
    return ALLOWED.indexOf(easing) !== -1 ? easing : 'ease-out';
  }

  /**
   * Clamps a transition hint to safe values.
   * @param {Object} transition - { duration, easing }
   * @returns {Object} - { duration, easing }
   * @private
   */
  _clampTransition(transition) {
    return {
      duration: this._clampDuration(transition.duration),
      easing: this._sanitizeEasing(transition.easing || 'ease-out'),
    };
  }

  // -------------------------------------------------------------------------
  // Placement helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the maximum available placement.
   * For 'fullscreen' intent, returns viewport dimensions so the creative
   * fills the screen. For 'expand' or any other intent, fills the
   * container element.
   * @param {string} [intent] - The placement change intent
   * @returns {Object}
   * @private
   */
  _getExpandedPlacement(intent) {
    if (intent === 'fullscreen') {
      // Prefer visualViewport — stable on mobile Safari where innerHeight
      // fluctuates with the address bar show/hide.
      const vv = window.visualViewport;
      return {
        width: (vv ? vv.width : window.innerWidth) || 300,
        height: (vv ? vv.height : window.innerHeight) || 250,
      };
    }
    // expand: use maxExpandSize from environmentData, fall back to viewport
    const cp = this.environmentData.currentPlacement || {};
    const maxExpand = cp.maxExpandSize || {};
    const vv = window.visualViewport;
    return {
      width: maxExpand.width || (vv ? vv.width : window.innerWidth) || 300,
      height: maxExpand.height || (vv ? vv.height : window.innerHeight) || 250,
    };
  }

  /**
   * Sanitizes a position coordinate value to a safe CSS string.
   * Unlike _sanitizeDimension(), negative values are valid (e.g. resize offsets
   * that move the ad left of or above its initial position).
   * @param {*} val
   * @returns {string|null} Safe CSS value (e.g. "-20px"), or null if invalid.
   * @private
   */
  _sanitizePosition(val) {
    if (typeof val === 'number' && isFinite(val)) {
      return Math.round(val) + 'px';
    }
    if (typeof val === 'string' && /^-?\d+(\.\d+)?(px)?$/.test(val)) {
      return parseFloat(val) + 'px';
    }
    return null;
  }

  /**
   * Sanitizes a dimension value to a safe CSS string (SEC-012).
   * Accepts: positive numbers, strings matching "\d+(px|%)". Rejects all else.
   * @param {*} val
   * @returns {string|null} Safe CSS value, or null if invalid.
   * @private
   */
  _sanitizeDimension(val) {
    if (typeof val === 'number' && isFinite(val) && val >= 0) {
      return `${Math.round(val)}px`;
    }
    if (typeof val === 'string' && /^\d+(\.\d+)?(px|%)$/.test(val)) {
      return val;
    }
    return null; // Reject arbitrary strings to prevent CSS injection
  }

  /**
   * Applies dimensions to the iframe.
   * @param {Object} dims - { width, height }
   * @private
   */
  _applyIframeDimensions(dims, transition) {
    if (!this._iframe) return;
    const w = this._sanitizeDimension(dims.width);
    const h = this._sanitizeDimension(dims.height);

    // Apply CSS transition for smooth resize when a transition hint is provided
    if (transition && transition.duration > 0) {
      const dur = (transition.duration / 1000) + 's';
      const ease = transition.easing || 'ease';
      const val = `width ${dur} ${ease}, height ${dur} ${ease}`;
      this.placementElement.style.transition = val;
      this._iframe.style.transition = val;

      // Match the cleanup pattern in _applyAnimatedDimensions: a flag-guarded
      // cleanup that removes its own listener and a registered safety timeout
      // we can clear from _terminate() so post-close mutations cannot fire.
      let cleanedUp = false;
      const placement = this.placementElement;
      const iframe = this._iframe;
      const onEnd = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        placement.removeEventListener('transitionend', onEnd);
        this._clearTimeout('applyDimensionsTransition');
        placement.style.transition = '';
        iframe.style.transition = '';
      };
      placement.addEventListener('transitionend', onEnd);
      // Store the safety timeout in this._timeouts so _terminate()'s clear-all
      // loop cancels it if close() runs mid-animation. Without this, the
      // setTimeout fires post-detach and mutates an already-restored element.
      this._timeouts.applyDimensionsTransition = /** @type {number} */ (/** @type {*} */ (setTimeout(onEnd, transition.duration + 50)));
    }

    if (w !== null) this._iframe.style.width = w;
    if (h !== null) this._iframe.style.height = h;
    if (w !== null) this.placementElement.style.width = w;
    if (h !== null) this.placementElement.style.height = h;
  }

  /**
   * Applies a position (x, y) to the iframe for resize intent.
   * Sets position:absolute so left/top take effect. Only called for
   * 'resize' intent — expand/collapse have their own positioning logic.
   * @param {Object} pos - { x, y } in pixels
   * @private
   */
  _applyIframePosition(pos) {
    if (!this._iframe) return;
    const x = this._sanitizePosition(pos.x);
    const y = this._sanitizePosition(pos.y);
    if (x !== null || y !== null) {
      this._iframe.style.position = 'absolute';
      if (x !== null) this._iframe.style.left = x;
      if (y !== null) this._iframe.style.top = y;
    }
  }

  /**
   * Stamps the placement element and iframe with all SHARC-owned classes and
   * data attributes (proposal Part 4). Snapshots `placementElement.style.cssText`
   * before any SHARC-driven inline style mutation so `_detachFromPlacement()`
   * can restore the pre-`load()` value.
   *
   * Called by `_createIframe()` after the iframe element is created and
   * assigned to `this._iframe`, but before it is appended to the DOM.
   *
   * Stamp surface (per proposal):
   *   placement element: `class="sharc-placement"`, data-sharc-placement-session-id,
   *     data-sharc-placement-id (if option set), data-sharc-placement-name (if
   *     option set), data-sharc-version, data-sharc-state, data-sharc-intent
   *     (only when an intent is active).
   *   iframe: `class="sharc-creative"`, data-sharc-placement-session-id (back-pointer).
   *
   * @private
   */
  _attachToPlacement() {
    // Snapshot the literal `class` and `style` attribute strings (or null
    // for absent) BEFORE any SHARC mutation. This is required — not just
    // cssText — because `classList.remove()` and `style.cssText = ''`
    // leave behind empty `class=""` and `style=""` attributes that break
    // outerHTML byte-equality with elements that had no such attributes
    // pre-attach.
    this._originalClassAttr = this.placementElement.getAttribute('class');
    this._originalStyleAttr = this.placementElement.getAttribute('style');

    // ── Placement element stamps ──
    this.placementElement.classList.add('sharc-placement');
    this.placementElement.setAttribute('data-sharc-placement-session-id', this.placementSessionId);
    if (this.placementId) {
      this.placementElement.setAttribute('data-sharc-placement-id', this.placementId);
    }
    if (this.placementName) {
      this.placementElement.setAttribute('data-sharc-placement-name', this.placementName);
    }
    this.placementElement.setAttribute('data-sharc-version', SHARC_VERSION);
    this.placementElement.setAttribute('data-sharc-state', this._stateMachine.getState());
    if (this._currentIntent) {
      this.placementElement.setAttribute('data-sharc-intent', this._currentIntent);
    }

    // ── Iframe stamps ──
    if (this._iframe) {
      this._iframe.classList.add('sharc-creative');
      this._iframe.setAttribute('data-sharc-placement-session-id', this.placementSessionId);
      // Per spec § DOM stamping additions: both attributes are always
      // present on the iframe. `data-sharc-creative-source` reflects the
      // immutable variant choice; `data-sharc-creative-rendered` starts
      // 'false' and only flips 'true' for the Markup variant when an
      // envelope-valid SHARC:Renderer:rendered arrives. Symmetric with the
      // existing `data-sharc-creative-injected` precedent — devtools queries
      // like `[data-sharc-creative-rendered="false"]` select Creative URL
      // instances explicitly.
      this._iframe.setAttribute('data-sharc-creative-source', this.creativeSource);
      this._iframe.setAttribute('data-sharc-creative-rendered', 'false');
    }
  }

  /**
   * Removes every SHARC-owned class and data attribute from the placement
   * element and restores its `style.cssText` to the pre-`load()` snapshot.
   *
   * Called by `_terminate()` after the iframe and close button have been
   * removed. Idempotent — safe to call multiple times; the snapshot guard
   * keeps the second-and-later calls as no-ops.
   *
   * Backs the proposal's "load-bearing cleanup contract": after `close()`,
   * `placementElement.outerHTML` must equal its pre-`load()` value.
   *
   * @private
   */
  _detachFromPlacement() {
    this.placementElement.removeAttribute('data-sharc-placement-session-id');
    this.placementElement.removeAttribute('data-sharc-placement-id');
    this.placementElement.removeAttribute('data-sharc-placement-name');
    this.placementElement.removeAttribute('data-sharc-version');
    this.placementElement.removeAttribute('data-sharc-state');
    this.placementElement.removeAttribute('data-sharc-intent');

    // Restore literal `class` attribute. Setting it directly (rather than
    // mutating classList) handles the corner where `classList.remove()`
    // would leave an empty `class=""` attribute on an element that had
    // none pre-attach. `null` means "attribute was absent" — removeAttribute.
    if (this._originalClassAttr === null) {
      this.placementElement.removeAttribute('class');
    } else {
      this.placementElement.setAttribute('class', this._originalClassAttr);
    }
    this._originalClassAttr = null;

    // Restore literal `style` attribute. Same null-vs-string distinction:
    // null → attribute was absent → removeAttribute; string → restore verbatim.
    if (this._originalStyleAttr === null) {
      this.placementElement.removeAttribute('style');
    } else {
      this.placementElement.setAttribute('style', this._originalStyleAttr);
    }
    this._originalStyleAttr = null;
  }

  /**
   * Synchronously stamps the current state on the placement element's
   * `data-sharc-state` attribute. No-op when the container is not currently
   * attached (pre-`load()` or post-`close()`).
   * @param {string} state
   * @private
   */
  _stampState(state) {
    if (this._iframe) {
      this.placementElement.setAttribute('data-sharc-state', state);
    }
  }

  /**
   * Synchronously stamps the current placement intent on the placement
   * element's `data-sharc-intent` attribute. When intent is null/empty, the
   * attribute is removed entirely (rather than set to "") so that
   * `[data-sharc-intent]` selectors only match active intents.
   * @param {string|null} intent
   * @private
   */
  _stampIntent(intent) {
    if (!this._iframe) return;
    if (intent) {
      this.placementElement.setAttribute('data-sharc-intent', intent);
    } else {
      this.placementElement.removeAttribute('data-sharc-intent');
    }
  }

  /**
   * Synchronously stamps the placement session ID on the close button.
   * @private
   */
  _stampCloseButton() {
    if (this._closeButton) {
      this._closeButton.setAttribute('data-sharc-placement-session-id', this.placementSessionId);
    }
  }

  /**
   * Validates Creative URL vs Creative Markup constructor inputs and returns
   * the construction-time values needed by the instance setup path.
   *
   * Evaluated in order; first violation throws. Shape errors (rules 1-3,
   * TypeError) precede value errors (rules 4-8, Error). See proposal:
   * docs/proposals/creative-sources.md § Validation Rules.
   *
   * @param {{
   *   creativeUrl?: string|null|undefined,
   *   creativeHtml?: string|null|undefined,
   *   creativeRendererUrl?: any,
   *   creativeRendererIntegrity?: any,
   *   onSecurityEvent?: SHARCSecurityEventCallback|undefined,
   *   wrapperPolicy?: string|undefined,
   *   bridges?: string[]|null|undefined,
   *   creativeMeta?: Object|null|undefined,
   * }} options
   * @param {{window?: Window|undefined}} env
   * @returns {{
   *   placementSessionId: string,
   *   parsedRendererUrl: URL|null,
   *   hasCreativeUrl: boolean,
   *   hasCreativeHtml: boolean,
   *   hasRendererUrl: boolean,
   * }}
   * @private
   */
  static _validateCreativeSources(options, env = {}) {
    const {
      creativeUrl,
      creativeHtml,
      creativeRendererUrl,
      creativeRendererIntegrity,
      onSecurityEvent,
      wrapperPolicy = 'warn',
      bridges,
    } = options || {};
    const win = env.window;

    // Generate the placementSessionId up-front so any structured event fired
    // during construction (e.g. the wrapper-cross-origin carve-out below)
    // carries the SAME UUID that the constructed instance will expose.
    const placementSessionId = SHARCContainer._generateUUID();

    // Note on `''` (empty string) handling: empty strings for `creativeUrl`,
    // `creativeHtml`, and `creativeRendererUrl` are intentionally treated as
    // "not provided" — same as `null`/`undefined`. Operators passing an empty
    // string have nothing to load; conflating that with absent makes rule 1
    // fire with the more useful "got neither" message instead of "got empty
    // string."
    const hasCreativeUrl = creativeUrl != null && creativeUrl !== '';
    const hasCreativeHtml = creativeHtml != null && creativeHtml !== '';
    const hasRendererUrl = creativeRendererUrl != null && creativeRendererUrl !== '';

    // Rule 1: exactly one of `creativeUrl` or `creativeHtml`. Neither or both -> TypeError.
    if (!hasCreativeUrl && !hasCreativeHtml) {
      throw new TypeError(
        '[SHARCContainer] creativeUrl is required (or pass creativeHtml + creativeRendererUrl '
        + 'for inline-markup Creative Markup variant). Got neither.'
      );
    }
    if (hasCreativeUrl && hasCreativeHtml) {
      throw new TypeError(
        '[SHARCContainer] creativeUrl and creativeHtml are mutually exclusive — '
        + 'exactly one must be provided. Got both.'
      );
    }

    // Rule 2: `creativeHtml` requires `creativeRendererUrl`.
    if (hasCreativeHtml && !hasRendererUrl) {
      throw new TypeError(
        '[SHARCContainer] creativeHtml requires creativeRendererUrl '
        + '(operator-hosted renderer page). Bare srcdoc is not supported — '
        + 'see proposal § Bare srcdoc breaks silently.'
      );
    }

    // Rule 3: `creativeRendererUrl` is only valid alongside `creativeHtml`.
    if (hasCreativeUrl && hasRendererUrl) {
      throw new TypeError(
        '[SHARCContainer] creativeRendererUrl is only valid alongside creativeHtml '
        + '(Creative Markup variant). Remove creativeRendererUrl when using creativeUrl.'
      );
    }

    if (creativeRendererIntegrity !== undefined && !hasCreativeHtml) {
      throw new TypeError(
        '[SHARCContainer] creativeRendererIntegrity is only valid alongside '
        + 'creativeHtml + creativeRendererUrl (Creative Markup variant).'
      );
    }

    if (creativeRendererIntegrity !== undefined) {
      if (typeof creativeRendererIntegrity !== 'string'
          || !/^sha384-[A-Za-z0-9+/]+={0,2}$/.test(creativeRendererIntegrity)) {
        throw new TypeError(
          '[SHARCContainer] creativeRendererIntegrity must be an SRI-style '
          + 'SHA-384 digest string in the form "sha384-<base64>".'
        );
      }
    }

    // Rule 3b (0.7.1, issue #82; narrowed in #185): `bridges` is Creative
    // Markup variant only. The Creative URL variant doesn't load bridges (no
    // renderer protocol), so silently dropping this option would mislead
    // operators. `creativeMeta` is allowed on URL variant for measurement
    // sidecars such as OMID auto-install, but still does not drive renderer
    // bridge loading or `apiFramework` there.
    if (hasCreativeUrl && bridges !== undefined) {
      throw new TypeError(
        '[SHARCContainer] bridges is only valid alongside '
        + 'creativeHtml (Creative Markup variant); the Creative URL variant does not load bridges. '
        + 'Remove the bridges option when using creativeUrl.'
      );
    }

    /** @type {URL|null} */
    let parsedRendererUrl = null;
    if (hasRendererUrl) {
      // Rule 4: `creativeRendererUrl` must parse via `new URL(...)`.
      try {
        parsedRendererUrl = new URL(creativeRendererUrl);
      } catch (_) {
        throw new Error(
          '[SHARCContainer] creativeRendererUrl is not a parseable URL: '
          + JSON.stringify(creativeRendererUrl)
        );
      }

      const rendererOrigin = parsedRendererUrl.origin;
      const windowOrigin = (win && win.location) ? win.location.origin : null;
      const isDevWindowOrigin = windowOrigin !== null
        && DEV_ORIGIN_PATTERNS.some((pattern) => pattern.test(windowOrigin));
      const isDevRendererOrigin =
        DEV_ORIGIN_PATTERNS.some((pattern) => pattern.test(rendererOrigin));
      const isLocalHttpDevRenderer = parsedRendererUrl.protocol === 'http:'
        && isDevWindowOrigin
        && isDevRendererOrigin;

      // Rule 5: must use exactly the `https:` scheme, with a narrow localhost
      // carve-out for bundled HTTP dev-server tests.
      if (parsedRendererUrl.protocol !== 'https:' && !isLocalHttpDevRenderer) {
        throw new Error(
          '[SHARCContainer] creativeRendererUrl must use the https: scheme '
          + '(got "' + parsedRendererUrl.protocol + '"). http: is allowed only '
          + 'for localhost-style renderer URLs when the publisher page is also '
          + 'running on a recognized dev origin. javascript:, data:, blob:, file:, '
          + 'about:, and other schemes are rejected — they collapse the '
          + 'cross-origin sandbox guarantee.'
        );
      }

      // Rule 6: must not contain userinfo.
      if (parsedRendererUrl.username !== '' || parsedRendererUrl.password !== '') {
        throw new Error(
          '[SHARCContainer] creativeRendererUrl must not contain userinfo '
          + '(username or password). Strip credentials from the URL before passing it.'
        );
      }

      // Rule 7: must be cross-origin to `window.location` and `window.top.location`.
      // When `window.top.location` access throws (cross-origin top frame), the
      // wrapper carve-out applies — `wrapperPolicy` governs warn-vs-block behavior.
      if (windowOrigin !== null && rendererOrigin === windowOrigin) {
        throw new Error(
          '[SHARCContainer] creativeRendererUrl must be cross-origin to window.location '
          + '(got same-origin: "' + rendererOrigin + '"). Same-origin renderer collapses '
          + 'the sandbox isolation that makes Creative Markup safe.'
        );
      }
      let topOrigin = null;
      let topAccessThrew = false;
      try {
        topOrigin = (win && win.top && win.top.location) ? win.top.location.origin : null;
      } catch (err) {
        if (err && err.name === 'SecurityError') {
          topAccessThrew = true;
        } else {
          throw err;
        }
      }
      if (!topAccessThrew && topOrigin !== null && rendererOrigin === topOrigin) {
        throw new Error(
          '[SHARCContainer] creativeRendererUrl must be cross-origin to window.top.location '
          + '(got same-origin: "' + rendererOrigin + '"). Same-origin to publisher top '
          + 'collapses the sandbox isolation that makes Creative Markup safe.'
        );
      }
      if (topAccessThrew) {
        const severity = wrapperPolicy === 'block' ? 'error' : 'warning';
        const message = 'Validation rule 7 carve-out applied — cross-origin top frame '
          + 'detected; cannot verify creativeRendererUrl is cross-origin to the '
          + "publisher's top-level page. This is an unsupported deployment unless "
          + 'the operator has independently guaranteed creativeRendererUrl is not '
          + 'same-origin with any publisher top this wrapper is embedded into.';
        const consoleMethod = wrapperPolicy === 'block' ? 'error' : 'warn';
        console[consoleMethod]('[SHARCContainer] [' + placementSessionId + '] ' + message);
        SHARCContainer._safeInvokeSecurityCallback(onSecurityEvent, placementSessionId, {
          type: 'wrapper_top_frame_inaccessible',
          severity: severity,
          timestamp: Date.now(),
          placementSessionId: placementSessionId,
          message: message,
          details: {
            wrapperOrigin: windowOrigin,
            creativeRendererUrl: creativeRendererUrl,
          },
        });
        if (wrapperPolicy === 'block') {
          throw new Error('[SHARCContainer] ' + message);
        }
      }

      // Production-block guard (issue #55 / Phase F): block known SHARC
      // reference renderers from non-dev publisher origins.
      const stripTrailingSlash = (s) => s.replace(/\/+$/, '');
      const candidatePathKey = stripTrailingSlash(
        parsedRendererUrl.origin + parsedRendererUrl.pathname
      );
      const isKnownTestRenderer = KNOWN_TEST_RENDERERS.some((testUrl) => {
        const t = new URL(testUrl);
        const tKey = stripTrailingSlash(t.origin + t.pathname);
        return candidatePathKey === tKey
          || candidatePathKey.startsWith(tKey + '/');
      });
      if (isKnownTestRenderer) {
        const isDevOrigin = windowOrigin !== null
          && DEV_ORIGIN_PATTERNS.some((pattern) => pattern.test(windowOrigin));
        if (!isDevOrigin) {
          throw new Error(
            '[SHARCContainer] creativeRendererUrl "' + parsedRendererUrl.href
            + '" is a known SHARC reference test renderer. Production deployments '
            + 'must use an operator-controlled renderer URL. Recognized dev origins '
            + 'are localhost / 127.0.0.1 / *.localhost / *.test / *.local / [::1] / '
            + '0.0.0.0. See docs/proposals/creative-sources.md § Renderer Ownership Model.'
          );
        }
      }
    }

    // Rule 8: `creativeHtml` size must not exceed 256 KiB at construction (pre-injection).
    if (hasCreativeHtml) {
      let byteLength;
      if (typeof TextEncoder !== 'undefined') {
        byteLength = new TextEncoder().encode(creativeHtml).length;
      } else if (typeof Buffer !== 'undefined') {
        byteLength = Buffer.byteLength(creativeHtml, 'utf8');
      } else {
        throw new Error(
          '[SHARCContainer] Cannot measure creativeHtml byte size: neither '
          + 'TextEncoder nor Buffer is available in this environment.'
        );
      }
      const MAX_BYTES = 256 * 1024;
      if (byteLength > MAX_BYTES) {
        throw new Error(
          '[SHARCContainer] creativeHtml exceeds 256 KiB at construction '
          + '(' + byteLength + ' bytes; cap is ' + MAX_BYTES + '). RTB markup norms '
          + 'are well below this — payloads this large almost always indicate a bug.'
        );
      }
    }

    return {
      placementSessionId,
      parsedRendererUrl,
      hasCreativeUrl,
      hasCreativeHtml,
      hasRendererUrl,
    };
  }

  /**
   * Derives publisherContext from the browser's runtime environment.
   * Resolution: window.top.location.href → document.referrer → "".
   * Rejects non-http(s) schemes (file://, about:blank, data:, etc.).
   * Follows MRAID 3.0 §2.1 pattern: empty string for unavailable string fields.
   *
   * @returns {Object} { pageUrl, domain, bundleId, platform }
   */
  static _derivePublisherContext() {
    const ctx = {
      pageUrl: '',
      domain: '',
      bundleId: '',
      platform: 'web',
    };
    try {
      let pageUrl = '';
      try {
        // Same-origin iframe: access top-level URL directly
        if (window.top && window.top.location && window.top.location.href) {
          pageUrl = window.top.location.href;
        }
      } catch (_) {
        // Cross-origin: fall back to referrer
        if (document.referrer) {
          pageUrl = document.referrer;
        }
      }

      // Only accept http(s) schemes
      if (pageUrl && /^https?:/.test(pageUrl)) {
        ctx.pageUrl = pageUrl;
        try {
          const a = document.createElement('a');
          a.href = pageUrl;
          ctx.domain = a.hostname || '';
        } catch (_) {
          ctx.domain = '';
        }
      }
    } catch (_) {
      // Best-effort — return empty strings if anything fails
    }
    return ctx;
  }

  /**
   * Resolves the extension plugin list, appending container-owned measurement
   * sidecars inferred from bid metadata. #185 keeps OMID out of the renderer
   * `bridges` vocabulary: auto-installing OMID means adding an
   * `OmidCompatBridge` extension, not sending `'omid'` to the renderer.
   *
   * @param {{
   *   extensions?: Object[]|null|undefined,
   *   creativeMeta?: Object|null|undefined,
   *   omidAutoInstall?: Object|null|undefined,
   * }} opts
   * @returns {Object[]}
   * @private
   */
  static _resolveExtensions(opts) {
    const explicit = Array.isArray(opts && opts.extensions) ? opts.extensions.slice() : [];
    const autoOmid = SHARCContainer._resolveAutoOmidExtension({
      extensions: explicit,
      creativeMeta: opts && opts.creativeMeta,
      omidAutoInstall: opts && opts.omidAutoInstall,
    });
    if (autoOmid) explicit.push(autoOmid);
    return explicit;
  }

  /**
   * Creates an OmidCompatBridge from bid-signaled metadata when:
   *   1. `creativeMeta.apis` declares AdCOM OMID code 7.
   *   2. The operator provided trusted OM SDK defaults via `omidAutoInstall`.
   *   3. The bid supplied `creativeMeta.measurement.omid.verificationScripts`.
   *
   * Missing or invalid measurement sidecar data warns and continues. OMID is
   * measurement, not container correctness, so this path must not make
   * otherwise-renderable creatives fail construction.
   *
   * @param {{
   *   extensions?: Object[],
   *   creativeMeta?: Object|null|undefined,
   *   omidAutoInstall?: Object|null|undefined,
   * }} opts
   * @returns {Object|null}
   * @private
   */
  static _resolveAutoOmidExtension(opts) {
    const creativeMeta = opts && opts.creativeMeta;
    const apis = creativeMeta && Array.isArray(creativeMeta.apis) ? creativeMeta.apis : [];
    if (apis.indexOf(7) === -1) return null;

    const config = opts && opts.omidAutoInstall;
    if (!config) return null;

    if (SHARCContainer._hasExplicitOmidExtension(opts.extensions || [])) {
      return null;
    }

    const sidecar = creativeMeta
      && creativeMeta.measurement
      && creativeMeta.measurement.omid;
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
      SHARCContainer._warnAutoOmid(
        'creativeMeta.apis declares OMID (7), but creativeMeta.measurement.omid '
        + 'is missing or not an object; skipping OMID auto-install.'
      );
      return null;
    }
    if (!Array.isArray(sidecar.verificationScripts) || sidecar.verificationScripts.length === 0) {
      SHARCContainer._warnAutoOmid(
        'creativeMeta.apis declares OMID (7), but creativeMeta.measurement.omid.verificationScripts '
        + 'is missing or empty; skipping OMID auto-install.'
      );
      return null;
    }

    const allowedSidecarKeys = [
      'verificationScripts',
      'creativeType',
      'impressionType',
      'mediaType',
      'contentUrl',
      'vastProperties',
    ];
    const sidecarOptions = {};
    for (let i = 0; i < allowedSidecarKeys.length; i++) {
      const key = allowedSidecarKeys[i];
      if (sidecar[key] !== undefined) sidecarOptions[key] = sidecar[key];
    }

    try {
      const bridge = new OmidCompatBridge({
        ...config,
        ...sidecarOptions,
      });
      const featureName = /** @type {any} */ (bridge).getFeatureName;
      if (typeof featureName === 'function' && !featureName.call(bridge)) {
        SHARCContainer._warnAutoOmid(
          'creativeMeta.apis declares OMID (7), but omidAutoInstall must include '
          + 'omSdkServiceScriptUrl and omSdkSessionClientUrl; skipping OMID auto-install.'
        );
        return null;
      }
      return bridge;
    } catch (err) {
      const reason = err && err.message ? err.message : String(err || 'unknown');
      SHARCContainer._warnAutoOmid(
        'creativeMeta.apis declares OMID (7), but OMID auto-install configuration '
        + 'was invalid: ' + reason + '; skipping OMID auto-install.'
      );
      return null;
    }
  }

  /**
   * Returns true when the caller already supplied an OMID extension. Explicit
   * extensions win over auto-install to avoid duplicate AdSession ownership.
   *
   * @param {Object[]} extensions
   * @returns {boolean}
   * @private
   */
  static _hasExplicitOmidExtension(extensions) {
    for (let i = 0; i < extensions.length; i++) {
      const ext = extensions[i];
      if (!ext) continue;
      if (ext.name === 'com.iabtechlab.sharc.omid') return true;
      if (typeof ext.getFeatureName === 'function') {
        try {
          if (ext.getFeatureName() === 'com.iabtechlab.sharc.omid') return true;
        } catch (_) { /* ignore extension getter failures */ }
      }
    }
    return false;
  }

  /**
   * Emits a non-fatal OMID auto-install warning in dev/test surfaces.
   *
   * @param {string} message
   * @private
   */
  static _warnAutoOmid(message) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[SHARCContainer] ' + message);
    }
  }

  /**
   * Three-layer bridge detection pipeline. Resolves the array of bridge
   * identifiers the renderer should load. Result is the value that goes on
   * the `bridges` field of the `SHARC:Renderer:render` message and on
   * `container.bridges`.
   *
   * Layers, in strict precedence order:
   *
   *   1. Explicit constructor `bridges` option. If provided as an array
   *      (including `[]`), that value wins verbatim. `null` / `undefined`
   *      fall through.
   *   2. `creativeMeta.apis` AdCOM `APIFramework` integer codes. If present and
   *      non-empty AND maps to a non-empty bridge set, layer 2 wins.
   *      Unrecognized codes (vendor-specific 500+, OMID 1.0 = 7 — deferred
   *      to 0.7.2, future enum) are ignored. If the layer's mapped result
   *      is empty (e.g. only OMID code 7 declared), fall through to layer 3.
   *   3. Adm content scan. Tightened substrings (`'mraid.js'`, `'$sf.ext'`)
   *      so common false-positive tokens (`mraid` in a comment) don't
   *      trigger an unwanted bridge load.
   *
   * Result is sorted alphabetically and deduplicated for replay-safe logs
   * and stable test snapshots. Same shape across all three layers.
   *
   * Static so the constructor's bridges-resolution call doesn't need a
   * `this` reference (it runs before `this.bridges` is assigned).
   *
   * @param {{
   *   bridges?: string[]|null|undefined,
   *   creativeMeta?: {apis?: number[]}|null|undefined,
   *   creativeHtml?: string|null|undefined,
   * }} opts
   * @returns {string[]} Resolved bridge identifier list.
   * @see docs/design/0.7.1-bridges-field.md § 3.4 Resolution algorithm
   * @private
   */
  static _resolveBridges(opts) {
    // Layer 1 — explicit override. `null`/`undefined` fall through; any
    // array (including `[]`) wins.
    if (opts && Array.isArray(opts.bridges)) {
      return SHARCContainer._sortDedupBridges(opts.bridges);
    }

    // Layer 2 — creativeMeta.apis (AdCOM APIFramework codes).
    if (opts && opts.creativeMeta && Array.isArray(opts.creativeMeta.apis) && opts.creativeMeta.apis.length > 0) {
      const fromBidMeta = SHARCContainer._mapAdComApisToBridges(opts.creativeMeta.apis);
      if (fromBidMeta.length > 0) return fromBidMeta;
      // Empty mapping (e.g. only OMID code 7 declared) → fall through to layer 3.
    }

    // Layer 3 — adm content scan. Markup variant only; Creative URL has no adm.
    if (opts && typeof opts.creativeHtml === 'string' && opts.creativeHtml.length > 0) {
      return SHARCContainer._detectBridgesFromAdmScan(opts.creativeHtml);
    }

    return [];
  }

  /**
   * Maps an array of AdCOM `APIFramework` integer codes to deduplicated,
   * sorted SHARC bridge identifiers. See `ADCOM_API_TO_BRIDGE` for the
   * mapping table.
   *
   * Unrecognized codes are silently ignored — they never produce a "load
   * nothing on purpose" signal; that's what an explicit `bridges: []` is
   * for. See design doc § 3.5 multi-framework truth table.
   *
   * **G12 supersession (0.7.2):** when `apis` contains `SHARC_API_CODE`
   * AND a container-API code (MRAID or `SAFEFRAME_API_CODE`), SHARC
   * supersedes — the lower-priority container-runtime bridges are inhibited
   * so a SHARC container does not load dead-weight MRAID/SafeFrame bridges
   * for portable creatives that declare both. OMID (`7`) is orthogonal and
   * NEVER superseded — `[SHARC_API_CODE, 7]` resolves to SHARC runtime with
   * OMID measurement coexisting. SHARC itself is a runtime, not a bridge,
   * so the SHARC code never produces a bridge entry. See 0.7.2 design § 6.7
   * and § 9 G12.
   *
   * @param {number[]} apis - AdCOM APIFramework integer codes.
   * @returns {string[]} Sorted, deduplicated bridge identifier array.
   * @private
   */
  static _mapAdComApisToBridges(apis) {
    const contributors = Object.create(null);
    const hasSharcCode = apis.indexOf(SHARC_API_CODE) !== -1;
    for (let i = 0; i < apis.length; i++) {
      const code = apis[i];
      // SHARC is a runtime, not a bridge — never produces a bridge entry.
      if (code === SHARC_API_CODE) continue;
      // G12 supersession: SHARC presence inhibits MRAID + SafeFrame bridges.
      // OMID (7) is orthogonal and NEVER skipped here (measurement axis).
      if (hasSharcCode) {
        if (code === 3 || code === 5 || code === 6) continue; // MRAID family
        if (code === SAFEFRAME_API_CODE) continue;             // SafeFrame
      }
      const bridge = ADCOM_API_TO_BRIDGE[code];
      if (!bridge) continue;
      if (!contributors[bridge]) contributors[bridge] = [];
      contributors[bridge].push(code);
    }
    // #124: emit one warn per collapse group so operators can diagnose
    // ambiguous upstream AdCOM configuration. Multiple codes mapping to the
    // same bridge identifier is structurally valid but worth surfacing.
    for (const bridge in contributors) {
      if (contributors[bridge].length >= 2) {
        console.warn(
          '[SHARCContainer] AdCOM API codes [' + contributors[bridge].join(', ') +
          "] collapsed to single bridge '" + bridge +
          "' (from " + contributors[bridge].length + ' input codes)'
        );
      }
    }
    return SHARCContainer._sortDedupBridges(Object.keys(contributors));
  }

  /**
   * Three-layer API-framework detection pipeline (0.7.2 § 6). Resolves the
   * AdCOM `APIFramework` integer code declared by the creative for the
   * container runtime, or `null` when none is declared. Result drives the
   * frozen `container.apiFramework` accessor (G10).
   *
   * Layers, in strict precedence order:
   *   1. Explicit `creativeMeta.apis` — pick highest-priority container-
   *      runtime code from the array per the priority ladder.
   *   2. Reserved no-op (future bid-context-derived detection).
   *   3. Fallthrough to `null`.
   *
   * Picker priority ladder:
   *   - 1 (highest): SHARC (`SHARC_API_CODE`)
   *   - 2:           MRAID — `6` (3.0) > `5` (2.0) > `3` (1.0). Higher wins.
   *   - 3:           SafeFrame (`SAFEFRAME_API_CODE`)
   *
   * **Excluded from picker:**
   *   - OMID (`7`): measurement, not container runtime. § 6.4.
   *   - VPAID (`1`, `2`) and SIMID (`8`, `9`): video-creative protocols, not
   *     display-container runtimes. Operators read `creativeMeta.apis`
   *     directly if they need to branch on these. § 6.2.
   *   - Vendor codes (≥ 500): unrecognized; return `null`.
   *
   * Static so the constructor's resolution call doesn't need a `this`
   * reference (it runs before `this._apiFramework` is assigned).
   *
   * @param {{apis?: number[]}|null|undefined} creativeMeta
   * @returns {number|null}
   * @private
   */
  static _resolveApiFramework(creativeMeta) {
    if (!creativeMeta || !Array.isArray(creativeMeta.apis) || creativeMeta.apis.length === 0) {
      return null;
    }
    const apis = creativeMeta.apis;
    // Layer 1: pick highest-priority recognized container-runtime code.
    // SHARC > MRAID-latest > SafeFrame. Within MRAID, higher number wins.
    let best = null;
    let bestPriority = Infinity;
    const priorityOf = (code) => {
      if (code === SHARC_API_CODE) return 1;
      if (code === 6) return 2;          // MRAID 3.0
      if (code === 5) return 2.1;        // MRAID 2.0 (within-family tiebreak)
      if (code === 3) return 2.2;        // MRAID 1.0
      if (code === SAFEFRAME_API_CODE) return 3;
      return Infinity; // OMID, VPAID, SIMID, vendor codes: not picker targets
    };
    for (let i = 0; i < apis.length; i++) {
      const p = priorityOf(apis[i]);
      if (p < bestPriority) {
        best = apis[i];
        bestPriority = p;
      }
    }
    if (best !== null) return best;
    // Layer 2: reserved no-op for forward bid-context-derived detection.
    // Layer 3: fallthrough to null.
    return null;
  }

  /**
   * Picks the lifecycle adapter for the resolved `apiFramework`. 0.7.2
   * ships only the HTML adapter — it handles generic creatives
   * (`apiFramework === null`) and is also the fallback baseline for
   * frameworks whose dedicated adapters have not shipped yet (MRAID,
   * SafeFrame). See 0.7.2 design § 8.1 and § 8.5.
   *
   * Selection structure is intentionally extensible so 0.7.3 can add
   * MRAID / SafeFrame branches without restructuring:
   *
   * ```javascript
   * // 0.7.3 (illustrative — not shipped):
   * if (MRAID_CODES.has(apiFramework)) return new MraidAdapter();
   * if (apiFramework === SAFEFRAME_API_CODE) return new SafeFrameAdapter();
   * return new HtmlAdapter();
   * ```
   *
   * @param {number|null} apiFramework - The resolved AdCOM `APIFramework`
   *   code from {@link _resolveApiFramework}, or `null`.
   * @returns {import('./lifecycle-adapters/base-adapter.js').BaseLifecycleAdapter}
   * @private
   */
  static _selectLifecycleAdapter(apiFramework) {
    // 0.7.2 first half: HTML adapter is the only adapter. Branches for
    // MRAID / SafeFrame land in 0.7.3 (per § 8.5 forward path). The
    // function intentionally reads `apiFramework` so the parameter shape
    // and the linter-visible usage are stable as adapter branches land.
    void apiFramework;
    return new HtmlAdapter();
  }

  /**
   * Last-resort heuristic: scans `creativeHtml` for tighter substrings than
   * the bare token names. Returns sorted, deduplicated bridge identifier
   * array.
   *
   * Match conditions (case-sensitive):
   *   - `'mraid'`     ← `creativeHtml.indexOf('mraid.js') !== -1`
   *   - `'safeframe'` ← `creativeHtml.indexOf('$sf.ext') !== -1`
   *
   * Both substrings are far more specific than the loose token (`mraid` /
   * `safeframe` — which collide with comments, CSS class names, analytics
   * tags, etc.). False positives are tolerable (extra harmless bridge
   * load); false negatives break the creative.
   *
   * Cost: two `String.prototype.indexOf` calls on a 256 KiB-max payload;
   * sub-millisecond on V8. Asserted in the perf test.
   *
   * @param {string} html - The pre-injection `creativeHtml`.
   * @returns {string[]} Sorted, deduplicated bridge identifier array.
   * @private
   */
  static _detectBridgesFromAdmScan(html) {
    const result = new Set();
    if (html.indexOf('mraid.js') !== -1) result.add('mraid');
    if (html.indexOf('$sf.ext') !== -1) result.add('safeframe');
    return SHARCContainer._sortDedupBridges([...result]);
  }

  /**
   * Sort + dedupe a bridge identifier array. Stable lexicographic sort so
   * `['safeframe', 'mraid']` always yields `['mraid', 'safeframe']`
   * regardless of layer or input order.
   * @param {string[]} ids
   * @returns {string[]}
   * @private
   */
  static _sortDedupBridges(ids) {
    return [...new Set(ids)].sort();
  }

  /**
   * Generates a UUID v4 string.
   * Uses crypto.randomUUID() when available, otherwise falls back to a manual
   * construction. Used for placementSessionId.
   * @returns {string} A UUID v4 string.
   */
  static _generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Mints a non-secret, CSPRNG-unpredictable per-probe `probeId` correlator
   * (ADR 2026-06-15 § Ratified SE conditions, condition 1). 128 bits from
   * `crypto.getRandomValues`, base64url-encoded. Unpredictability is what
   * defeats a creative that pre-computes acks for a GUESSED next probeId; the
   * id is NOT an authenticator (the ack's arrival on `port1` is). Throws if a
   * CSPRNG is unavailable — fail-closed: an unpredictable probeId is mandatory.
   * @returns {string}
   * @private
   */
  static _mintProbeId() {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      throw new Error('crypto.getRandomValues unavailable — cannot mint a CSPRNG probeId');
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHARCContainer, DEFAULT_TIMEOUTS, SHARC_VERSION, SHARC_BUILD_MODE };
} else if (typeof window !== 'undefined') {
  window.SHARC = window.SHARC || {};
  window.SHARC.Container = SHARCContainer;
  window.SHARC.ContainerBuildMode = SHARC_BUILD_MODE;
}

// ESM exports
const SHARC = (typeof window !== 'undefined') ? window.SHARC : {};

export { SHARCContainer, DEFAULT_TIMEOUTS, SHARC_VERSION, SHARC_BUILD_MODE, SHARC };
