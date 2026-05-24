# Changelog

All notable changes to the SHARC Reference Implementation are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a `MAJOR.MINOR.PATCH` convention where:

- **MAJOR** — Breaking API or protocol changes
- **MINOR** — New features, backwards-compatible extensions
- **PATCH** — Bug fixes, internal improvements only

---

## [Unreleased]

### Added

- **Optional `creativeRendererIntegrity` preflight for Creative Markup**
  ([#24]). Operators can pass a `sha384-<base64>` digest for
  `creativeRendererUrl`; the container fetches and verifies the renderer
  document bytes before assigning `iframe.src`. On mismatch or unverifiable
  bytes, the container fires `RENDERER_INTEGRITY_FAIL` (2120), emits a
  `renderer_protocol_error` security event with
  `details.subtype='integrity_failed'`, and never sends
  `SHARC:Renderer:render`. This is defense-in-depth rather than native iframe
  SRI, because browsers do not support `integrity=` on iframe navigations;
  cross-origin renderer hosts must allow the verification fetch with CORS.

- **Bid-signaled OMID auto-installation** ([#185]). When bid metadata declares
  AdCOM OMID code `7` via `creativeMeta.apis` and supplies
  `creativeMeta.measurement.omid.verificationScripts`, operators can pass
  `omidAutoInstall` with trusted OM SDK URLs and partner defaults. The
  container appends an `OmidCompatBridge` extension without adding `'omid'` to
  the renderer bridge list. Missing or invalid OMID sidecar data warns and
  continues without installing measurement.

- **bfcache round-trip Puppeteer harness wired** ([#178]). The
  `test/browser/test-html-lifecycle-adapter-bfcache.js` scaffold shipped in
  0.7.4 (5 `IMPLEMENTOR-TODO` chokepoints, red on `main`) is now live in real
  Chrome. New fixtures `test/browser/bfcache-fixture.html`,
  `test/browser/bfcache-away.html`, and `test/browser/bfcache-creative.html`
  drive a permissive non-SHARC container through bfcache entry / exit and
  exercise the HTML lifecycle adapter's `pagehide` / `pageshow` paths
  end-to-end. Two-tier flake policy (per `docs/design/0.7.6-bfcache-puppeteer-wiring.md`
  ADR-178-E): structural assertions (bf-1 eligibility, bf-5 no
  "invalid transition" warns) run once; behavioral assertions (bf-2
  LOADING→ACTIVE→HIDDEN→FROZEN, bf-3 FROZEN→ACTIVE restore, bf-4 strict-mode
  yield) retry up to 3× inside the runner. New `npm run test:bfcache` script,
  deliberately NOT added to `test:all` (CI gets a dedicated step with
  `BFCACHE_INSTALL_MS=750`); no production code changes.

[#24]: https://github.com/jeffreycarlson/SHARC/issues/24
[#178]: https://github.com/jeffreycarlson/SHARC/issues/178
[#185]: https://github.com/jeffreycarlson/SHARC/issues/185

## [0.7.5] - 2026-05-24

### Fixed

- **`npm run test:all` now rebuilds `dist/` before running dist-based
  tests** ([#182]). The public all-tests script now runs `npm run build`
  first, preventing stale generated artifacts from causing misleading
  failures after source or version changes. The existing no-rebuild chain
  moved to `test:all:built` so `npm run check` can continue building once
  up front without paying for a duplicate build.

### Docs

- **0.7.2 process artifacts archived** ([#180]). Historical 0.7.2 handoff,
  WIP, and stage-3 comparison docs moved from `docs/design/` to
  `docs/archive/0.7.2/`. Archive README files added to mark the material
  as non-normative; `docs/README.md` updated to distinguish historical
  process artifacts from current design docs. Operators bookmarking the
  pre-archive paths under `docs/design/` should update links.

### Removed

- **Bridge `getWrapperUrl` helpers retired** ([#149]). `MRAIDCompatBridge`,
  `SafeFrameCompatBridge`, and `OmidCompatBridge` no longer expose
  `getWrapperUrl(creativeUrl)`. The helper constructed a
  `<baseUrl>/<feature>-wrapper.html?creative=<encoded>` string, but the
  container never consumed it; the OMID variant was explicitly documented
  as a dead compatibility stub since 0.7.3. Operators wiring wrapper-page
  flows can construct the URL inline. The wrapper HTML pages themselves
  (`test/browser/mraid-wrapper.html` and
  `test/browser/safeframe-wrapper.html`) are unchanged.

## [0.7.4] - 2026-05-24

**OMID hardening release.** Finishes five OMID hardening items
deferred from the 0.7.3 design (#121 legacy `requestOmid` audit closure,
#123 extension error payload contract, #124 multi-bridge dedup warn,
#125 `feature_load_failed` SecurityEvent variant, #126 termination-mid-load
coverage), ships the headline URL-variant `creativeSdkUrl` injection
feature (#106 — closes the 0.7.2 PR #105 follow-up), and ships a bfcache
round-trip coverage scaffold (#102, wiring deferred to #178). See
[`docs/design/0.7.4-omid-hardening.md`](docs/design/0.7.4-omid-hardening.md)
for the release-level design and ADRs.

### Added

- **`feature_load_failed` `SHARCSecurityEvent` variant** ([#125]). New
  non-terminating discriminated-union variant fired when an extension's
  load-time asset (e.g. the OM SDK script for `OmidCompatBridge`) fails to
  load on the publisher page. Sibling to `bridge_load_failed`; this variant
  covers the publisher-page extension-load path while `bridge_load_failed`
  covers the renderer-side dynamic bridge import. Carries
  `details: { featureName, reason, scriptUrl }` with `reason` as a
  classified token (current in-tree bridges emit `'timeout'`, `'network'`,
  or `'evaluation_throw'`) and `scriptUrl` bounded to 500 chars (parity
  with `bridge_load_failed.details.url`). `OmidCompatBridge` is the first
  in-tree consumer; the variant is generalizable to any future extension
  that loads remote scripts. No `errorCode` (non-terminating; outside the
  21xx renderer-error-code namespace).
- **Extension-lifecycle error event payload contract pinned** ([#123]).
  Both fatal-error paths (`_handleCreativeFatalError` and
  `_handleFatalError`) already dispatched a canonical
  `{ errorCode, errorMessage, source }` payload to extensions via
  `onContainerLifecycleEvent({ type: 'error', ... })`. PR D adds
  `test/node/test-omid-container-lifecycle.js` § H6 coverage to pin the
  contract against future regression — the field is `errorMessage` (not
  `message`), `source` discriminates `'creative'` vs. `'container'`, and
  the assertion outright rejects any `message` alias per the 0.7.4 ADR.
  `docs/api-reference.md` § 9 gains a new "Lifecycle event payloads"
  subsection documenting the base event shape (including `state`),
  per-type detail fields (including the correct `intent` field on
  `placementChange`), and the error event payload contract. No production
  code change — the implementation already met the contract.
- **Termination-mid-load coverage** ([#126]). Pins the deferred-follow-up
  edge case from PR #122: when termination or destroy fires while the OM
  SDK script-load promise is still pending, the resolved promise must NOT
  create a session, must NOT fire late callbacks, and must NOT emit
  `feature_load_failed` (the failure here is normal teardown, not a
  script-load failure). Five-section coverage (H1–H5) in
  `test/node/test-omid-container-lifecycle.js`. No production code change —
  the implementation already enforces the contract; these are regression
  guards.
- **bfcache round-trip Puppeteer coverage scaffold** ([#102]).
  `test/browser/test-html-lifecycle-adapter-bfcache.js` ships a 5-section
  contract scaffold (bf-1 through bf-5) covering the bfcache round-trip
  behavior the HTML lifecycle adapter must honor — eligibility,
  `LOADING → ACTIVE → HIDDEN → FROZEN` entry sequence, `FROZEN → ACTIVE`
  restoration on `pageshow(persisted:true)`, strict-mode + LOADING yield
  regression guard from PR #98, and no `invalid transition` warns across
  the round-trip. The file documents the assertion contract; full
  Puppeteer + Chrome wiring of the 4 `IMPLEMENTOR-TODO` harness functions
  (`setupPuppeteerBfcacheHarness`, `loadPermissiveContainerInPuppeteer`,
  `captureStateChangeSequence`, `triggerBfcacheEntry/Restore`) plus the
  `test/browser/bfcache-fixture.html` page is deferred to a follow-up
  ([#178], targeting 0.7.6). Architect's commit `44aeb7f` explicitly
  sanctions this fallback path when devops capacity is short. File is
  NOT wired into `npm run test:all`; ships as an orphaned coverage
  marker until #178 wires the harness.
- **URL-variant `creativeSdkUrl` injection** ([#106]). The built-in SDK
  auto-injection added in 0.7.2 now reaches the Creative URL variant. With
  `useMarkupInjection: true` set, the container fetches the creative URL,
  injects the `<script src="...sharc-creative.js">` tag, and loads the
  result via `iframe.srcdoc` — mirroring the Markup-variant ordering
  contract (built-in runs first, operator `injectIntoMarkup()` extensions
  run after and see the markup with the SDK already present). Explicit
  opt-in: without `useMarkupInjection: true` the URL variant continues to
  load via `iframe.src` and `creativeSdkUrl` is a no-op, so operators
  sharing constructor config across Markup and URL bid variants don't see
  iframe-loading semantics flip from `src` to `srcdoc` under them. Fetch
  failures (CORS, 404, transport) emit a `console.warn` and fall through
  to the un-injected `iframe.src` load; no SHARCSecurityEvent fires, and
  `com.iabtechlab.sharc.creative-injector` is NOT advertised (no
  capability lie). Closes the 0.7.2 PR #105 follow-up.

### Changed

- **Multi-bridge dedup observability** ([#124]). When multiple AdCOM
  `creativeMeta.apis` codes resolve to the same renderer bridge (e.g. two
  MRAID-version codes that both load `sharc-mraid-bridge.js`), the
  container now emits a single `console.warn` at `_mapAdComApisToBridges`
  identifying which AdCOM codes collapsed and which bridge they
  collapsed to. Scope is AdCOM-only (explicit `bridges: [...]` arrays
  and adm-scan paths don't surface this race in practice).
- **Creative placement type validation** ([#59]). `setPlacementType()` now
  throws `TypeError` for values other than `inline` or `interstitial`, surfacing
  creative-side misconfiguration before `createSession`.
- **`com.iabtechlab.sharc.creative-injector` advertise gate** ([#106]).
  The supportedFeatures merge now gates on a runtime `_creativeSdkInjected`
  flag instead of construction-time `_creativeSdkUrl !== null`. Markup
  variant sets the flag at construction (always injects when
  `creativeSdkUrl` is set); URL variant sets it inside
  `_fetchAndInjectCreative` only after a successful fetch + inject. The
  operator-visible contract is unchanged on Markup; URL variant now
  advertises the feature when (and only when) injection actually ran.

### Fixed

- **Freeze-from-READY lifecycle state walk** ([#164]). The HTML lifecycle
  adapter's `_transitionToFrozen` previously handled ACTIVE / PASSIVE /
  HIDDEN starting states but not READY. A container frozen directly from
  READY now correctly walks READY → ACTIVE → HIDDEN → FROZEN (the state
  machine only has a direct `HIDDEN → FROZEN` edge). Test coverage added
  in `test/node/test-html-lifecycle-adapter.js`.
- **Spoofed-renderer-marker warning** ([#175]). When the
  `__sharcRenderer` marker is present on the creative window but the
  navigation bridge is not installed, the creative SDK now emits a
  `console.warn` instead of silently skipping the auto-install. Catches
  the spoofed-marker case where a creative or wrapper sets the marker
  but doesn't actually wire up the bridge, which would otherwise let
  native `target="_blank"` clickthroughs bypass SHARC's navigation
  audit.

### Docs

- **Navigation callback semantics clarification** ([#177]). Updates
  `docs/api-reference.md`, `docs/creative-cookbook.md`, and
  `docs/getting-started.md` to clarify navigation-callback behavior;
  small fix to `docs/design/0.7.2-WORK-IN-PROGRESS.md`.
- **Legacy `requestOmid` audit closure** ([#121]). Historical-artifact
  banners on `docs/research/OM-sdk-research.md` and
  `docs/reviews/OM-sdk-architect-recommendations.md` — both pre-0.7.3 docs
  proposed a creative-initiated `SHARC:Creative:requestOmid` measurement
  path that was later removed in favor of fully container-driven OMID
  (decision log D7/D17 in `docs/design/0.7.3-omid-wiring.md`). Audit
  confirmed zero residual symbols across `src/`, `test/`, `examples/`,
  `dist/`, `scripts/` for the bidirectional grep
  `requestOmid|installOmidBridge|SHARC:Creative:requestOmid|omid.*request|request.*omid`.
  The banners preserve the historical docs while pointing future readers
  to the as-shipped design.

### Removed

- **Legacy creative-side OMID APIs audit closure** ([#121]). The
  creative-frame `installOmidBridge()` helper and the
  `SHARC:Creative:requestOmid` message type that were added in 0.2.0 were
  removed during the 0.7.2/0.7.3 cycle when OMID became fully
  container-driven, but neither 0.7.2 nor 0.7.3 changelog recorded the
  removal. PR C of 0.7.4 closed the audit (zero residuals in production
  code); this `Removed` entry records the closure under the version that
  finalized it.

[#59]: https://github.com/jeffreycarlson/SHARC/issues/59
[#102]: https://github.com/jeffreycarlson/SHARC/issues/102
[#121]: https://github.com/jeffreycarlson/SHARC/issues/121
[#123]: https://github.com/jeffreycarlson/SHARC/issues/123
[#124]: https://github.com/jeffreycarlson/SHARC/issues/124
[#125]: https://github.com/jeffreycarlson/SHARC/issues/125
[#126]: https://github.com/jeffreycarlson/SHARC/issues/126
[#149]: https://github.com/jeffreycarlson/SHARC/issues/149
[#164]: https://github.com/jeffreycarlson/SHARC/pull/164
[#175]: https://github.com/jeffreycarlson/SHARC/pull/175
[#177]: https://github.com/jeffreycarlson/SHARC/pull/177
[#178]: https://github.com/jeffreycarlson/SHARC/issues/178
[#180]: https://github.com/jeffreycarlson/SHARC/pull/180
[#182]: https://github.com/jeffreycarlson/SHARC/issues/182

## [0.7.3] - 2026-05-21

Closes PR [#122]. This release keeps OMID container-owned and removes the last
review blocker around friendly-obstruction lifecycle coverage.

### Added

- **Container-owned OMID lifecycle coverage** ([#122]). Added
  test/node/test-omid-container-lifecycle.js coverage for
  friendly-obstruction registration, re-registration, swap, and destroy cleanup
  through the real container close-button path.

### Changed

- **OMID remains container-owned** ([#122]). OmidCompatBridge continues to
  advertise OMID as an extension-owned feature, not a renderer bridge. AdCOM
  code 7 still resolves to no renderer bridge and explicit bridges: ['omid']
  remains invalid.

- **OM SDK URL validation now applies to bridge-managed SDK script URLs**
  ([#122]). omSdkServiceScriptUrl and omSdkSessionClientUrl now use the same
  HTTPS-only, no-userinfo validation surface already used for OMID
  verification scripts.

### Fixed

- **OMID review cleanup** ([#122]). Updated the OMID demo to use explicit HTTPS
  placeholder URLs and fixed the duplicate 11.2 heading in the 0.7.3 wiring
  design doc.

## [0.7.2] - 2026-05-18

Closes the first half of issue [#89] and issue [#97]. This release
documents the transition-state operator path: SHARC creatives still
handshake directly with the container in the steady state, while
operators can now load legacy plain HTML, MRAID, and SafeFrame adm
without per-creative changes.

### Added

- **`requireSharcInit` constructor option** ([#89], [#92]). Boolean,
  default `true`. When `false`, the container skips the `createSession`
  fatal-timeout so non-SHARC creatives load to a stable, queryable,
  terminable container instance without timing out on the missing
  handshake. Throws `TypeError` for non-boolean values (Rule 11).
  See the README transition section and the operator cookbook.

- **`creativeSdkUrl` constructor option** ([#97], [#105]). String,
  optional. When set, the container auto-injects
  `<script src="...sharc-creative.js"></script>` into Markup-variant
  creative HTML at load time, lifting legacy adm into SHARC without
  per-creative changes. Throws `TypeError` for non-string or empty
  values (Rule 12). Markup variant only in 0.7.2; Creative URL variant
  parity is tracked in [#106].

- **`creativeSdkSkipIfPresent` constructor option** ([#105]). Boolean,
  default `true`. Idempotency guard for built-in SDK injection; markup
  already containing a real `<script src="...sharc-creative.js">` tag
  passes through unchanged. Set `false` only when the operator needs
  forced injection, such as versioned-SDK coexistence tests.

- **`creativeSdkScriptAttrs` constructor option** ([#105]). Object,
  default `{}`. Adds attributes to the auto-injected SDK tag.
  Serialization follows React-style rules: `true` becomes a bare
  attribute, `false` / `null` / `undefined` are omitted, and strings
  are quoted and HTML-escaped. Attribute names are validated against a
  strict HTML5 subset; invalid names are skipped with `console.warn`.

- **`container.apiFramework` getter** ([#89], [#92]). Returns the
  declared container runtime as an AdCOM `APIFramework` integer code
  (`number | null`), resolved through the three-layer picker. The
  property is frozen non-writable and non-configurable.

- **`container.hasSharcSession` getter** ([#89], [#92]). Returns
  `true` once the SHARC `createSession` handshake has been accepted and
  `false` before then. This outcome-driven signal complements the
  declaration-driven `apiFramework` accessor.

- **`com.iabtechlab.sharc.creative-injector` feature flag** ([#105]).
  Advertised in `supportedFeatures` when `creativeSdkUrl` is set, so
  SHARC-aware creatives and operator extensions can detect
  operator-side SDK injection and skip their own SDK-load shim.

- **HTML lifecycle adapter** ([#89], [#98]). New
  `src/lifecycle-adapters/html-adapter.js` drives the `LOADING -> ACTIVE`
  transition for Markup-variant creatives without a SHARC handshake
  using iframe `load` plus IntersectionObserver visibility. It also
  routes browser lifecycle signals such as visibility, freeze, and
  bfcache restore.

- **`LOADING -> ACTIVE` state-machine edge** ([#89], [#92]). Allows
  non-handshake creatives to become active without synthesizing a
  misleading `READY` state. The SHARC handshake path remains unchanged.

- **`SHARC_API_CODE` (9001) and `SAFEFRAME_API_CODE` (9002)
  placeholder constants** ([#89], [#92]) exported from
  `sharc-protocol.js`. They are pending IAB AdCOM enum registration;
  the dual SafeFrame 1.0 and SHARC 1.0 registration path is tracked in
  the upstream contribution roadmap.

### Changed

- **`sendStateChange` is now a no-op when no SHARC session exists**
  ([#89], [#98]). Non-handshake creatives still transition locally, but
  the container no longer posts lifecycle messages into a renderer that
  has no session port.

- **`_runMarkupInjection` now runs built-in SDK injection first**
  ([#97], [#105]). When `creativeSdkUrl` is set, the container injects
  the SDK before running operator-supplied extensions in registration
  order. Extensions see markup with the SDK already present.

### Migration from PR [#103] preview

The closed PR [#103] preview exposed a standalone
`SHARCCreativeInjector` extension. That class was never released. In
0.7.2, the same capability is part of `SHARCContainer` itself.

Before:

```js
import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';
import { SHARCCreativeInjector } from '@iabtechlab/sharc/sharc-creative-injector';

const container = new SHARCContainer({
  // ...
  extensions: [
    new SHARCCreativeInjector({
      creativeSdkUrl: 'https://cdn.operator.example/sharc-creative.js',
      skipIfPresent: true,
      scriptAttrs: { async: true },
    }),
  ],
});
```

After:

```js
import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';

const container = new SHARCContainer({
  // ...
  creativeSdkUrl: 'https://cdn.operator.example/sharc-creative.js',
  creativeSdkSkipIfPresent: true,
  creativeSdkScriptAttrs: { async: true },
});
```

The rewrite is mechanical because the injector was folded into the
container after the architectural redirect on [#97]. Operators should
also remove any custom extension that injects `sharc-creative.js`
unless it is explicitly idempotent.

### Notes

- Pre-1.0 releases ship breaking changes cleanly: no aliases and no
  deprecation shims. Operators upgrading from 0.7.1 only need to act if
  they tracked the closed PR [#103] preview branch.
- `creativeSdkUrl` applies to the Markup variant in 0.7.2. Setting it
  on a Creative URL container is a no-op and does not advertise the
  injector feature; parity is tracked in [#106].
- Operator extension idempotency is documented in the operator cookbook
  and closes [#108]. Static-helper relocation remains tracked in [#109].
- Internal hardening for non-string-coercible attribute values is
  tracked in [#107]. Deferred skip-detection regex edge cases are
  cataloged in [#104].

[#89]: https://github.com/jeffreycarlson/SHARC/issues/89
[#92]: https://github.com/jeffreycarlson/SHARC/pull/92
[#97]: https://github.com/jeffreycarlson/SHARC/issues/97
[#98]: https://github.com/jeffreycarlson/SHARC/pull/98
[#103]: https://github.com/jeffreycarlson/SHARC/pull/103
[#104]: https://github.com/jeffreycarlson/SHARC/issues/104
[#105]: https://github.com/jeffreycarlson/SHARC/pull/105
[#106]: https://github.com/jeffreycarlson/SHARC/issues/106
[#107]: https://github.com/jeffreycarlson/SHARC/issues/107
[#108]: https://github.com/jeffreycarlson/SHARC/issues/108
[#109]: https://github.com/jeffreycarlson/SHARC/issues/109
[#122]: https://github.com/jeffreycarlson/SHARC/pull/122

## [0.7.1] - 2026-05-10

### Added

- **Container-driven bridge loading** ([#82]). `SHARCContainer` now detects
  MRAID/SafeFrame creatives at construction and tells the renderer which
  compatibility bridges to load via a new `bridges: string[]` field on
  `SHARC:Renderer:render`. Three-layer detection pipeline — explicit
  `bridges` constructor option → `creativeMeta.apis` AdCOM `APIFramework`
  integer codes → adm content scan (`indexOf('mraid.js')` /
  `indexOf('$sf.ext')`). Reserved identifiers: `'mraid'`, `'safeframe'`.
  New constructor options `bridges` (explicit override / suppression
  via `[]`) and `creativeMeta.apis` (forward-compatible bag for OpenRTB 2.6+
  bid metadata). New instance property `container.bridges` (frozen
  array) for operator dashboards. Reference renderer loads bridges via
  dynamic `import()` before `document.write(creativeHtml)` with five
  Security Engineer guardrails: allowlist-only `import()` path,
  same-origin URL assertion post-substitution, `Object.freeze(RENDERER_CONFIG)`,
  CSP `script-src 'self'` operator-fork guidance, and a new
  `bridge_load_failed` `onSecurityEvent` variant (error code `2115` —
  same as `renderer_failed` but distinct `event.type` discriminator).
  Backward-compatible: old containers omitting the field and old
  renderers ignoring the field both keep working. See
  [`docs/design/0.7.1-bridges-field.md`](docs/design/0.7.1-bridges-field.md)
  for the full design.

### Changed

- `sharc-mraid-bridge.mjs` and `sharc-safeframe-bridge.mjs` gain a
  renderer-side opt-in auto-install path gated on
  `window.__sharcMraidBridgeAutoInstall` /
  `window.__sharcSafeFrameBridgeAutoInstall` (mirrors the existing
  `__sharcNavBridgeAutoInstall` from Phase D/E). Existing wrapper-page
  (`<script>`-tag) install paths via `test/browser/{mraid,safeframe}-wrapper.html`
  are unchanged. New path uses `setTimeout(0)` polling for
  `window.SHARC.onReady` to appear (after the inner SDK script runs
  post-`document.write`), then installs the bridge once. Idempotency
  via `window.__sharc{Name}BridgeInstalled`. ([#82])

- `SHARCSecurityEvent` discriminated union extended to a sixth variant:
  `bridge_load_failed` (error code `2115`, payload
  `{ reason, bridge }`). Operators consuming the structured channel
  should add a case to their `switch (event.type)` for this new
  variant — see [api-reference.md §10](docs/api-reference.md#onsecurityevent-surface). ([#82])

[#82]: https://github.com/jeffreycarlson/SHARC/issues/82

## [0.7.0] - 2026-05-05

Closes Creative Sources (issue #41) — the Creative Markup variant
ships, complete with the renderer protocol, navigation bridge,
reference renderer, structured `onSecurityEvent`, and load-event
navigation backstop.

### Upgrade notes (0.6.x → 0.7.0)

Operators upgrading should review the following operator-observable
changes (full detail in the sections below):

- **Console-log prefix format** now includes a `[<placementSessionId>]`
  segment between `[SHARCContainer]` and `[<internalType>]`. Update any
  log-grep regexes / dashboard parsers that match the old format.
- **`SHARCSecurityEvent.type`** is now a discriminated union over five
  reserved variants. Consumers should narrow via `switch (event.type)`
  / `if (event.type === ...)` rather than treating `details` as `any`.
- **Navigation bridge throw contract.** When the bridge is installed
  but the SHARC SDK is missing on the page, anchor / form / `location.*`
  interceptions throw `SHARCNavigationError`. The throws fire INSIDE
  the renderer iframe — install `window.addEventListener('error', ...)`
  on the renderer page (NOT publisher-side) to capture them. Cross-
  origin error scrubbing renders publisher-side error listeners blind.
- **Reference renderer requires HTTP serving.** Round-4 introduced a
  `<script type="module">` import for the navigation bridge; browsers
  refuse module imports from `file://` origins. The renderer no longer
  opens cleanly via direct file open. Use the included dev server
  (`node server.cjs`) or any HTTP(S) origin.
- **Creative URL flow gains the navigation bridge and load-event
  backstop in 0.7.0** (Phase E). The SDK now auto-installs the bridge
  at init time when running outside the reference renderer (variant
  detected via `window.__sharcRenderer` presence), and the container
  arms the load-event backstop after the first iframe `load` for the
  URL variant. Operators upgrading Creative URL placements get
  click-through audit coverage and the `RENDERER_UNAUTHORIZED_
  NAVIGATION` (2118) backstop without code changes — the SDK module
  bundle now includes the bridge code (+0.6 kB brotli). If you rely
  on `<a target="_top">` or `window.open` returning a `WindowProxy`
  in the URL flow, audit those code paths against the bridge's
  intercept contract documented in `docs/api-reference.md`
  § Navigation Bridge Error Contract.
- **Trust model clarification (operator-observable).** The navigation
  bridge (`sharc-navigation-bridge`) provides best-effort URL audit for
  legitimate creatives — operators see what URLs the creative wants to
  navigate to and can apply allowlist policy. Adversarial creatives can
  bypass the bridge by setting `window.__sharcRenderer = {}` before
  SHARC modules load (suppresses the SDK's auto-install), or by
  re-overriding `window.open` / `location` getters after install. The
  load-event backstop (`RENDERER_UNAUTHORIZED_NAVIGATION`, code 2118)
  is the load-bearing enforcement that catches actual cross-document
  navigation regardless of bridge state — it fires on any iframe `load`
  event beyond the expected sequence (1 for Creative URL, 2 for
  Creative Markup). See `docs/proposals/creative-sources.md` § Security
  Model for full threat-model framing.

### Added

- **Creative Markup variant** — new constructor options `creativeHtml`
  + `creativeRendererUrl` deliver markup via a cross-origin renderer
  iframe rather than fetching a creative URL. Phases A–E landed
  across PRs #66, #67, #68, #71, and this release (Phase E closes
  [#70](https://github.com/jeffreycarlson/SHARC/issues/70)).
  Construction-time validation rules 4–8 (HTTPS scheme, no userinfo,
  cross-origin to publisher, 256 KiB cap), CSPRNG fragment-nonce URL
  assembly, sandbox token configuration via 5 new options
  (`allowPopups`, `allowTopNavigationByUserActivation`,
  `allowStorageAccessByUserActivation`, `allowModals`,
  `allowDownloads`), HTTP-CSP-portable iframe `csp` baseline.
- **Creative URL click-through audit coverage** (Phase E, closes
  [#70](https://github.com/jeffreycarlson/SHARC/issues/70)). The
  navigation bridge is now bundled into the `sharc-creative` SDK and
  auto-installs synchronously at SDK init when running outside the
  reference renderer (variant detected via `window.__sharcRenderer`
  presence). The container arms the load-event backstop after the
  first iframe `load` for the URL variant; any subsequent `load`
  fires `RENDERER_UNAUTHORIZED_NAVIGATION (2118)` with
  `details.variant === 'url'`. Pairs with the Phase D Markup-variant
  backstop (`details.variant === 'markup'`) so both flows ship with
  identical click-through audit semantics in 0.7.0. SDK bundle grows
  +0.6 kB brotli (4.92 → 5.54 kB); `installNavigationBridge` and
  `SHARCNavigationError` are re-exported from `sharc-creative` for
  ESM consumers.
- **Renderer protocol** (`SHARC:Renderer:render` / `:rendered` /
  `:failed`). Container posts the markup once the iframe loads; the
  renderer validates the envelope (parent-origin, fragment nonce,
  version) and replies after `DOMContentLoaded` on the inner document.
  Container-side envelope/payload validation per spec § Container-side
  message validation.
- **Reference renderer** at `examples/renderer/index.html`. Canonical
  fork starting point for operators. Implements proposal § Renderer
  implementation contract: nonce read, envelope validation, Service
  Worker detection, meta-refresh strip, `document.write` + post
  `:rendered` after DOMContentLoaded.
- **Navigation bridge** at `src/sharc-navigation-bridge.js`. Intercepts
  `window.open`, `<a>` clicks, form submits, and `location.href` /
  `assign` / `replace` setters and routes them through
  `SHARC.requestNavigation()` for operator URL review. Auto-install
  is opt-in via `window.__sharcNavBridgeAutoInstall = true` BEFORE
  load; named export `installNavigationBridge(window?)` returns an
  uninstall function.
- **Load-event navigation backstop (both variants)** — the container
  watches for unexpected iframe `load` events after the variant-
  specific render-anchor: Markup anchors on the envelope-validated
  `:rendered` accept (Phase D); Creative URL anchors on the first
  iframe `load` event (Phase E). Any subsequent `load` means the
  iframe navigated outside the SHARC protocol path (`<a target="_top">`,
  `location.assign`, meta refresh that bypassed the bridge).
  Terminates with `RENDERER_UNAUTHORIZED_NAVIGATION (2118)`; the
  `onSecurityEvent` payload's `details.variant` field discriminates
  `'markup'` from `'url'` for triage. Defense-in-depth backstop
  catches navigations the in-renderer bridge missed due to
  adversarial JS-level overrides — works identically in both flows.
- **Structured `onSecurityEvent` callback** — operator observability
  hook. Discriminated-union payload over five reserved variants
  (`wrapper_top_frame_inaccessible`, `renderer_origin_mismatch`,
  `renderer_protocol_error`, `renderer_failed`,
  `unauthorized_navigation`). Fires BEFORE `onError` for terminating
  events (spec ordering — operators that hook both rely on the
  sequence). Throwing handlers are caught + logged + container action
  proceeds. Closes #62.
- **`wrapperPolicy: 'warn' | 'block'`** constructor option for the
  validation-rule-7 wrapper-cross-origin carve-out. `'warn'` (default)
  emits `console.warn` + `onSecurityEvent` and proceeds; `'block'`
  emits `console.error` + `onSecurityEvent` and throws synchronously.
- **6 new error codes** — `2114` `RENDERER_TIMEOUT`, `2115`
  `RENDERER_FAILED`, `2116` `RENDERER_ORIGIN_MISMATCH`, `2117`
  `RENDERER_PROTOCOL_ERROR`, `2118` `RENDERER_UNAUTHORIZED_NAVIGATION`,
  `2119` `RENDERER_POST_FAILED`.
- **3 new instance properties** — `creativeSource: 'url' | 'html'`,
  `creativeRendered: boolean`, `creativeRendererUrl: string | null`.
- **DOM stamping additions** — `data-sharc-creative-source` and
  `data-sharc-creative-rendered` on the creative iframe, alongside
  the existing `data-sharc-creative-injected`.
- **`placementSessionId` console-log prefix** — chokepoint
  `console.error` and the wrapper carve-out's `console.{warn,error}`
  now emit `[SHARCContainer] [<placementSessionId>] [<internalType>]
  <message>`. Multi-container pages can correlate failures back to a
  specific instance. Partially closes #42 (broader callback-meta +
  non-security log tagging stays in #42).
- **Renderer Protocol section** in `docs/api-reference.md` — operator-
  facing documentation extracted from the proposal. Covers envelope
  shapes, validation rules, origin-echo contract, close-mid-render
  contract, load-event backstop semantics, `onSecurityEvent` payload
  schemas, and reference-renderer hosting checklist.
- **Browser harness** at `test/browser/test-creative-sources.html`
  with companion `renderer-fixture.html`. Manual-load smoke for the
  five renderer-protocol scenarios (happy path, `:failed`, origin
  mismatch via 302, Service Worker detected, load-event backstop).
- **2-port dev server** — `node server.cjs` now listens on ports
  8765 (publisher) and 8766 (renderer). Browsers treat the two ports
  as distinct origins, satisfying rule 7's cross-origin requirement
  for local Creative Markup testing. `?redirect=<url>` harness hook
  for driving the origin-mismatch path. The redirect endpoint is
  localhost-gated (rejects non-`localhost` / non-`127.0.0.1` targets)
  and CRLF-guarded (raw control chars in the redirect URL → reject)
  to avoid making the dev server an open-redirector or header-
  injection vector when bound to `0.0.0.0` for cross-device testing.
- **Shadow-DOM anchor-click coverage in `sharc-navigation-bridge`**.
  The capture-phase anchor walk-up now uses `event.composedPath()`
  to cross open shadow boundaries, so `<sharc-button>` / `<lit-anchor>`
  / similar Web Component creatives that wrap an `<a>` inside an open
  shadow root are routed through `SHARC.requestNavigation()` instead
  of bypassing the bridge. Falls back to the parentNode walk on older
  browsers without `composedPath` (closed shadow roots remain a
  documented bypass — out of scope, the load-event backstop catches
  them).
- **Reference renderer fallback banner uses safe DOM API** —
  `examples/renderer/index.html` builds the dev-banner via
  `createElement` + `textContent` rather than `innerHTML`. The banner
  string is currently static so no XSS today, but `innerHTML` invites
  future regressions if a contributor interpolates `location.hash` /
  `.search` / `.origin` into it. Defense-in-depth: never reach for
  `innerHTML` on a page that runs creative code.
- **Reference renderer extension surface** (`examples/renderer/index.html`):
  - `RENDERER_CONFIG` named-constants block exposes operator-tunable values
    (`TEST_ONLY`, `RENDERER_PROTOCOL_VERSION`, `ALLOWED_PROTOCOL_VERSIONS`).
    Forks edit values here instead of source-code-archaeologying for bare
    constants. `ALLOWED_PROTOCOL_VERSIONS` is a list (not a single value)
    so forks can widen the accept-list during a renderer-first deployment
    cutover.
  - Four lifecycle hooks on `window.__sharcRenderer` for operator forks:
    `onBeforeRender`, `onAfterRender`, `customSecurityLog`,
    `beforeStorageClear`. Default implementations are no-ops (or thin
    pass-throughs to `console.warn`/`error` for `customSecurityLog`);
    operators override to inject custom behavior. All hooks MUST be
    synchronous — async hooks would race the container's
    `RENDERER_TIMEOUT` (2114). Closes proposal AC L1190 + L1191.
- **Reference renderer DOMParser fallback path**
  (`examples/renderer/index.html`):
  - `tryDomParserReplaceChildren(html)` helper installs creative HTML
    via `DOMParser` + `replaceChildren` when `document.write` fails or
    is restricted by the browser. Two-pass: structural replacement
    via `documentElement.replaceChildren(parsed.head, parsed.body)`
    (or `document.appendChild(parsed.documentElement)` when
    `document.open()` already cleared documentElement to null), then
    a script-recreation pass that swaps each inert parsed `<script>`
    for a freshly-created live-document `<script>` so the browser's
    insertion steps execute the script body.
  - Runtime detection: the `try/catch` around `document.write` falls
    back automatically to the DOMParser path before posting `:failed`.
    Insurance against future browser restrictions on `document.write`
    for cross-origin iframes.
  - Operator opt-in: `RENDERER_CONFIG.FORCE_DOMPARSER_FALLBACK = true`
    skips `document.write` entirely so forks can verify the fallback
    works in their browser fleet without simulating a `document.write`
    failure.
  - DOMContentLoaded handling: `replaceChildren` does NOT trigger a
    fresh DCL on the live document, so the fallback path schedules
    `onInnerDCL` via `Promise.resolve().then(...)` to keep the existing
    `onAfterRender` hook + `:rendered` postMessage flow intact.
  - Test coverage in `test-renderer-domparser-fallback.js`
    (`npm run test:renderer-fallback`): jsdom-driven verification that
    the recreation pass executes inline scripts in document order with
    attributes copied, plus an integration test that monkey-patches
    `document.write` to throw and asserts the fallback completes the
    render and posts `:rendered`.
  - Closes proposal AC L1201 + L1202.
- **GitHub Pages reference renderer + CI deploy** (Phase F, closes
  [#55](https://github.com/jeffreycarlson/SHARC/issues/55) and
  [#23](https://github.com/jeffreycarlson/SHARC/issues/23)). Adds
  `_config.yml` and `.github/workflows/pages.yml` to deploy the
  reference renderer at
  `https://jeffreycarlson.github.io/SHARC/renderer/` and a minimal
  landing page at `/SHARC/`. Workflow triggers on push to `main` and
  `workflow_dispatch` (deliberately not on PR branches — Pages has one
  production environment per repo). Build job stages `examples/
  renderer/index.html` at `_site/renderer/` and `dist/*` at
  `_site/dist/`, then sed-rewrites the renderer's relative import
  `../../dist/` → `../dist/` so module paths resolve correctly under
  the `/SHARC/` base path. Verification step fails the build if the
  patch doesn't fully apply.
- **`KNOWN_TEST_RENDERERS` production-block guard** (Phase F).
  Operator-observable: `SHARCContainer` constructor throws
  synchronously when `creativeRendererUrl` matches a known SHARC
  reference test renderer URL AND `window.location.origin` is not a
  recognized dev origin. Recognized dev origins: `localhost`,
  `127.0.0.1`, `*.localhost`, `*.test`, `*.local`, `[::1]`, `0.0.0.0`
  (anchored regex patterns; suffix-style spoofing such as
  `notlocalhost.example` does NOT match). The guard runs after rule 7
  (cross-origin) succeeds, so it only fires when the URL would
  otherwise pass validation. Production deployments must use an
  operator-controlled renderer URL — fork `examples/renderer/
  index.html` and host on operator infrastructure. New module
  constants: `KNOWN_TEST_RENDERERS` (frozen array; single entry today
  for the fork URL, upstream URL added at IABTechLab contribution),
  `DEV_ORIGIN_PATTERNS` (frozen array of anchored regexes). Test
  coverage in `test-creative-sources.js` block 9.5 (14 new
  assertions). The error message names the rejected URL and lists the
  full dev-origin pattern set so the operator sees the failure mode
  immediately at construction.
- **Local Creative Markup demo** at `examples/demos/creative-markup/
  index.html` (Phase F). Self-contained page that constructs a
  `SHARCContainer` against the hosted reference renderer with a
  ~1.5 KiB inline HTML banner payload (visible click target with
  `window.open()` handler, plus a `creative-loaded` postMessage probe).
  Live message log subscribes to `onStateChange`,
  `onSecurityEvent`, `onError`, `onNavigation`, `onClose`,
  `onMessage` and renders each as a tagged scrolling row. Runs ONLY
  via `node server.cjs` (the demo and the Pages-hosted renderer are
  intentionally on different origins to satisfy rule 7). The
  `_config.yml` exclude list keeps `examples/demos/` out of the Pages
  artifact.

### Changed

- **`SHARCSecurityEvent` typedef** is now a discriminated union over
  the five reserved variants. Each variant has a per-discriminant
  `details` shape and (for terminating variants) an `errorCode`
  literal type. Replaces the loose `{ type: string; details: object }`
  typedef from Phase A. Closes #62.
- **`docs/api-reference.md`** error-code table descriptions (2114–
  2119) re-pointed at the in-document `#10-renderer-protocol` anchor
  instead of the proposal-document anchor.
- **Console-log prefix format (operator-observable).** Renderer-protocol
  terminations and the `wrapper_top_frame_inaccessible` carve-out now emit
  `[SHARCContainer] [<placementSessionId>] [<internalType>] <message>` —
  the `[<placementSessionId>]` segment is new. Operators with log-grep
  regexes that match the OLD format `[SHARCContainer] [<internalType>]`
  must update to tolerate the inserted UUID segment. (Issue #42 partial.)
- **`sharc-navigation-bridge` `window.open` return value (operator-observable).**
  When the bridge is installed in the renderer page, `window.open()` calls
  from creative HTML are intercepted, routed through `SHARC.requestNavigation()`,
  and return `null` — matching the IAB popup-blocker pattern. Creatives
  expecting a `WindowProxy` should call `SHARC.requestNavigation()` directly.
  This matches MRAID/SafeFrame/SIMID precedent (all void/null return). When
  the SDK is missing on the page, `window.open` STILL returns null but ALSO
  emits a `console.error` naming the audit failure (does NOT throw — the
  IAB popup-blocker idiom `var w = window.open(); if (w) { ... }` is
  preserved). See the bridge JSDoc for rationale.
- **`sharc-navigation-bridge` `<a>` / `<form>` / `location.*` SDK-missing
  behavior (operator-observable, fail-loud-to-creative).** When the bridge
  is installed and `window.SHARC.requestNavigation` is unavailable, anchor
  clicks, form submits, and `location.assign` / `replace` / `href = ...`
  setters now THROW the new `SHARCNavigationError({ code: 'SDK_UNAVAILABLE'
  })` after `event.preventDefault()`. This replaces the prior silent-drop
  behavior — defensive creatives can `try { ... } catch (e) { if (e
  instanceof SHARCNavigationError) ... }`, and operator monitoring captures
  the throw via `window.addEventListener('error', ...)` for SDK-missing
  alerting. `window.open` is the documented exception (preserves the IAB
  popup-blocker null-return pattern). Container declines (allowlist refusal,
  policy denial) still resolve through the SDK's Promise reject path; the
  throw is reserved for the operator-misconfiguration SDK-missing case.
  **Cross-origin caveat:** the throw fires INSIDE the renderer iframe
  (operator's fork origin), NOT the publisher window — operators must
  install the `'error'` listener on the renderer page itself. Publisher-
  side `window.onerror` will see only `"Script error."` due to cross-origin
  scrubbing, and the container's `onSecurityEvent` channel does NOT carry
  bridge-internal failures. See `docs/api-reference.md` § Navigation Bridge
  Error Contract.
- **Reference renderer (`examples/renderer/index.html`) clears `location.hash`
  via `history.replaceState` after `:render` envelope+nonce validation
  passes.** Defense-in-depth: the consumed nonce is single-use per iframe
  load (no replay value), but minimizing exposure prevents the creative
  HTML from reading the nonce out of the URL fragment after document.write.
  Operators forking the renderer SHOULD preserve this behavior. See
  `docs/api-reference.md` § Renderer post-validation behavior.
- **Reference renderer auto-installs `sharc-navigation-bridge` (Markup
  variant) AND the SHARC SDK auto-installs it at init time (Creative
  URL variant).** Both variants now ship with click-through audit
  coverage by default. Markup: operators forking `examples/renderer/
  index.html` get the navigation bridge wired in via the renderer's
  ES-module import + `installNavigationBridge(window)` call BEFORE
  `document.write(creativeHtml)`. Creative URL (Phase E): the
  navigation bridge is now bundled into `sharc-creative` (+0.6 kB
  brotli; size-limit budget raised 5 kB → 7 kB) and auto-installs at
  SDK init when `window.__sharcRenderer` is absent (URL flow).
  `installNavigationBridge` and `SHARCNavigationError` are re-
  exported from `sharc-creative` so ESM consumers loading only the
  SDK get the bridge API without a second import. The standalone
  `sharc-navigation-bridge` module continues to ship for operators
  that prefer to load it separately (the reference renderer uses
  this path). Required corollary (already shipped in Phase D round-4):
  `server.cjs` serves `.mjs` files with MIME `application/javascript`
  for renderer-side module imports. Operators using nginx /
  CloudFront / other static origins must configure the
  `.mjs → application/javascript` MIME mapping explicitly. The
  bridge module itself stays opt-in at the standalone-module level
  (default-off `__sharcNavBridgeAutoInstall`); the reference renderer
  and `sharc-creative` are the canonical install points.
- **Removed `event.stopPropagation()` from navigation bridge interception
  handlers (operator-observable, behavior-preserving on the audit path).**
  The capture-phase anchor-click and form-submit handlers no longer call
  `event.stopPropagation()` — they continue to call `event.preventDefault()`
  to block the native navigation, but creative-installed click / submit
  handlers (analytics, validation, custom UI logic) now run normally
  through the bubble phase. Prior to this fix, the bridge silently
  swallowed every click / submit event, breaking creatives that observed
  their own navigation events for telemetry.
- **`UnauthorizedNavigationEvent.details.msSinceRender` (operator-observable,
  schema extension).** The 2118 `unauthorized_navigation` payload now
  carries `details.msSinceRender: number` — the wall-clock delay between
  the renderer's `:rendered` accept and the post-render iframe `load`
  event firing. Operators monitoring 2118 use this to distinguish fast-
  fire (creative immediately reloaded — typically `<meta http-equiv=
  "refresh" content="0;url=...">` or `window.location` in the first script
  tag) from slow-fire (DOM-injected redirects, setTimeout-based redirects,
  multi-second delay). Existing `details.variant` field unchanged.
- **2118 `console.error` message names `msSinceRender` and adds redirect-
  injection diagnostic hint (operator-observable).** The dev-channel log
  body changed from `"Renderer iframe navigated post-render — refusing to
  proceed."` to `"Renderer iframe navigated post-render after Nms —
  refusing to proceed. The new document is cross-origin and its URL is
  not inspectable; check the creative's HTML for redirect-injection
  patterns (window.location, meta refresh re-injection, form submits with
  action=)."`. Operators with log-grep regexes that match the OLD literal
  body must update.
- **Reference renderer requires HTTP serving (operator-observable).**
  `examples/renderer/index.html` now uses `<script type="module">` to
  import the navigation bridge. Browsers refuse `import` from `file://`
  origins; the renderer no longer opens cleanly via direct file open.
  Use the included dev server (`node server.cjs`) or any HTTP(S) origin.
  Operators forking the renderer for production deployment must serve
  the fork over HTTP(S) and configure `.mjs → application/javascript`
  MIME on their static origin (CDN / nginx / CloudFront / Cloudflare).

### Tests

- 293 jsdom assertions in `test-creative-sources-load.js` (up from 263
  in the Phase D round-3 commit). Phase D round-4 added msSinceRender
  field asserts, the round-2-text → round-4-text redirect-injection
  hint assertion, and a non-negative-number type guard. Phase E added
  section 18 (Creative URL load-event backstop) covering arm-on-first-
  load, second-load → 2118 (`details.variant === 'url'`), terminate
  detach, re-entrancy, and one-shot-arm idempotency.
- 34 jsdom assertions in `test-navigation-bridge.js` (3 additional
  cases — `location.assign` / `location.replace` / `location.href`
  setter — are documented as deferred to issue #69 because jsdom's
  Location is non-configurable and the bridge's descriptor swap cannot
  run). Phase D round-4 expanded section 9 from a single warn-only test
  to cover the new throw contract: `SHARCNavigationError` class shape,
  throw on anchor click / form submit (captured via `window`'s `error`
  event, which the WHATWG DOM "report the exception" algorithm dispatches
  synchronously during dispatchEvent), `window.open` IAB null-return
  preservation, and a creative-side
  click-handler propagation test (proves no `stopPropagation`).
- New build-mode FATAL guard in `test-navigation-bridge.js` mirrors the
  pre-existing guard in `test-creative-sources-load.js` — probes
  `dist/sharc-navigation-bridge.mjs` for `console.warn(` AND
  `console.error(` call-form presence, bails out early on a prod-mode
  build that would cause vacuous assertion passes. The regex matches the
  call paren (not just the property reference) so terser's dead-code
  property stubs (`"undefined"!=typeof console&&console.warn,...`) do
  NOT slip past the guard.
- Shadow-DOM anchor-click test (`4c`) tightened: the prior assertion
  was vacuous (`routed || true`) and would have silently kept passing
  if a future change broke the `composedPath` walk-up. Now asserts the
  positive routing outcome unconditionally; jsdom version dependency
  documented inline.
- `npm run test:navigation-bridge` is now invoked from
  `.github/workflows/ci.yml` (was missing — script existed in
  `package.json` but no CI step called it).
- Browser harness pass/fail rendered to DOM for manual smoke.
- **Performance harness** (`test-creative-sources-perf.js`):
  - Measures Creative Markup vs. Creative URL load time (P95) on a
    50 KiB representative payload (style block, DOM, inline click-handler
    script, ASCII filler padded to exactly 51200 bytes). Asserts Markup
    P95 does not exceed URL P95 by more than 600ms (per proposal AC at
    `docs/proposals/creative-sources.md:1170`). Closes AC L1170 — the
    final missing AC from the depth-pass traceability audit.
  - 20 iterations per variant after a 1-iteration warm-up. Both flows
    converge at `_protocol.initChannel` (the shared 200ms-deferred
    bootstrap); the harness times from container construction to that
    point so the delta isolates renderer-protocol overhead (postMessage
    round-trip, envelope validation, `:rendered` dispatch).
  - jsdom-based; real-browser timing characteristics may differ.
    Operators with strict perf SLAs should verify via a Puppeteer-driven
    browser harness (deferred to issue #69).
  - CI step uses pass-if-any-of-3-runs to balance false-failure rate
    (CI runner noise) against true regression detection. A real
    regression fails all 3 attempts; a single noisy iteration does not
    fail the build.
  - Run via `npm run test:perf`.
  - **Spec inconsistency flagged**: the Release Readiness Checklist at
    `creative-sources.md:1235` cites a +500ms regression budget while
    the AC at `:1170` cites +600ms. The harness aligns on +600ms per
    the AC (canonical engineering deliverable). Inconsistency tracked
    for future spec cleanup.

## [0.6.2] - 2026-04-27

### Fixed
- **TypeScript build failure on `_placementType` cross-class access.**
  The `@private` annotation pass in 0.6.1 (PR #49) tightened the typing
  of `SHARCCreativeProtocol._placementType`, but `sharc-creative.js`
  was still assigning to it directly across class boundaries
  (`this._proto._placementType = this.placementType` at line 189),
  which `tsc` correctly flagged as a TS2341 error. Added a typed
  `setPlacementType(type)` accessor on `SHARCCreativeProtocol`; the
  Creative SDK now goes through the accessor instead of touching the
  private field. Build is green.

## [0.6.1] - 2026-04-27

### Fixed
- **Stale JSDoc on `_applyAnimatedDimensions` (#48).** Method comment previously
  described a `transform: scale()` / GPU compositor approach that was replaced
  with direct CSS `width`/`height` transitions. JSDoc updated to match the
  implementation.
- **Typed constructor default (#34).** Removed `/** @type {any} */ ({})` cast
  on the `SHARCContainer` constructor default argument — unnecessary suppression
  of type checking on an already-typed parameter shape.
- **`@private` annotation pass on `SHARCProtocolBase` internals (#35).** Internal
  members missing `@private` JSDoc tags were leaking into the generated
  `dist/sharc-protocol.d.ts`. Tags added; `dist/` regenerated.

## [0.6.0] - 2026-04-26

### Changed
- **`placementId` / `placementName` null-safety (breaking).** Both fields on
  `SHARCContainer` now type as `string|null` instead of `string|undefined`.
  When the constructor option is omitted the field is `null`; passing an empty
  string `''` also normalizes to `null`. Downstream TypeScript consumers must
  update their type annotations from `string | undefined` to `string | null`.
- **`sessionId` getter returns `null` before handshake (breaking).** Previously
  returned `''`. Callers that tested `if (!container.sessionId)` are unaffected
  since both `''` and `null` are falsy; strict-equality checks `=== ''` must
  be updated to `=== null`.
- **Close-button `aria-label` updated.** `'Collapse advertisement'` →
  `'Close ad'` — shorter, plain-language label per accessibility proposal
  Part 4. Matches the function (user-initiated close) rather than the
  mechanical action (collapse).

## [0.5.4] - 2026-04-25

### Fixed
- **Placement-change dedup correctness (#6).** `_placementPayloadUnchanged`
  in `SHARCContainer` previously compared only six geometric fields
  (`width`, `height`, and the four `position` rect bounds). Any non-geometric
  placement field — `inline`, `placementType`, `dataspec`, `data` — that
  changed without geometry changing would be silently suppressed when
  `_syncPlacementState()` ran on the next ACTIVE transition, so a creative
  could miss a real placement update. Replaced with a full normalized
  payload compare (`JSON.stringify` both sides). Tradeoff is one extra
  potentially-redundant message in the rare property-order-shuffle case;
  silent suppression of a real update is no longer possible.
  Behavior unchanged when the payload is genuinely identical or when
  geometry alone changes.
- New regression test `test-placement-dedup.js` (run via `npm run test:placement`)
  covers the bug and the four common non-geometric mutations (`inline`,
  `dataspec`, `placementType`, `data`).

### Changed
- **External-readiness documentation pass (#36).** Repointed the README, the
  new `docs/README.md` curated index, and `docs/current-status.md` toward
  external integrators rather than internal contributors. Trimmed
  `docs/getting-started.md` from a 660-line mixed tutorial into a focused
  evaluator quickstart. Retired the stale `0.3.0` security boilerplate in
  `SECURITY.md` (including a sandbox example that recommended the
  `allow-scripts` + `allow-same-origin` combination — the canonical
  iframe-sandbox escape) and updated `architecture-overview.md` for the
  current `src/` + `test/browser/` layout. Added explicit acknowledgment
  across three files of the `0.5.3` typed-bridge ship. Tracking issue #38
  covers the deeper mobile-integration and creative-cookbook content the
  trim deferred. Docs-only — no source or shipped-artifact changes.

## [0.5.3] - 2026-04-24

### Added
- **JSDoc-driven type emission for typed bridges (#29).** Each
  `package.json#exports` subpath now ships a generated `.d.ts` alongside its
  `.mjs` bundle, so TypeScript consumers get IntelliSense and type-checked
  argument shapes for `import { Container } from '@iabtechlab/sharc/sharc-container'`
  and the MRAID / SafeFrame / OMID bridges. Types are derived from the
  existing JSDoc on the JS sources via `tsc --emitDeclarationOnly`; no port
  to TypeScript was required. The build pipeline gains a `build:types` step
  (`tsc -p tsconfig.types.json`) that runs after Rollup; `npm run build`
  invokes both. Tarball grew by the six `.d.ts` files (~77 kB combined,
  uncompressed).
- **TypeScript consumer probe** (`test/types/consumer.ts`,
  `npm run test:types`). Exercises every published subpath against the
  generated `.d.ts` files. Future regressions in JSDoc coverage — dropped
  parameter types, removed exports, weakened argument shapes — fail this
  probe at build time.

### Changed
- **Internal Window augmentation moved to `types/globals.d.ts`** — the
  ambient declarations that describe globals SHARC reads from or writes
  to the host environment (`window.mraid`, `window.$sf`, `window.SHARC`,
  `window.MRAID_ENV`, `window.SHARC_CONFIG`, `window.OmidSessionClient`,
  `window.__sharcOmidInstalled`) now live under `types/`, not `src/`. This
  separates internal typecheck-only declarations from shippable source.
  `tsconfig.json#include` updated; `tsconfig.types.json` added for the
  declaration-emission build.

### Removed
- **`src/sharc-globals.d.ts`** — split between `types/globals.d.ts` (Window
  augmentation, internal-only) and the per-module generated types in
  `dist/`. Bridge interfaces (`MRAIDCompatBridge`, `SafeFrameCompatBridge`,
  `OmidCompatBridge`) are no longer hand-maintained — they are emitted from
  JSDoc on the actual classes, so the parallel hand-written declaration
  cannot drift from the runtime any more.

### Fixed
- **Three latent typecheck issues surfaced by tightening JSDoc** —
  `_validatePlacementRequest` discriminated-union access in
  `sharc-container.js:1106` (cast at access site since JSDoc inline-union
  literals don't narrow reliably under `tsc --strict`); `RequestInit.mode`
  literal type on the cross-origin tracker fetch
  (`sharc-container.js:1773`); and the `SHARCContainer` constructor's
  `options = {}` default conflicting with required-field JSDoc (cast the
  default since the runtime guards on missing `creativeUrl` /
  `containerEl`). Two missing options (`placementPolicy`,
  `closeButtonStyles`) were added to the constructor JSDoc.

## [0.5.2] - 2026-04-24

### Fixed
- **Release workflow validation (#28)** — `.github/workflows/release.yml` had
  failed every push since 2026-04-23 (0s duration, "workflow file issue"
  message) because GitHub Actions does not allow direct evaluation of the
  `secrets` context inside step-level `if:` expressions. Surfaced
  `secrets.NPM_TOKEN`'s presence as a job-level `env: NPM_TOKEN_PRESENT`
  variable; publish vs skip steps now gate on the env var. Behavior is
  unchanged: publish runs only when the token is set; otherwise a skip
  notice is logged. Without this fix the `v*` tag publish path produced no
  artifact.
- **Browser harness `?build=dist` basePath (#27)** — `?build=dist` is the
  documented mechanism for verifying the production bundle behaves
  identically to source before tagging a release (see
  `docs/distribution-design.md` §10 step 3). After the 0.5.1
  `examples/test/` → `test/browser/` move, the dev-mode `basePath` was
  repointed but the dist-mode branch was missed: `../dist/` from
  `test/browser/` resolved to `/test/dist/` (does not exist). Repointed
  `../dist/` → `../../dist/` in `test/browser/index.html` and
  `test/browser/test-creative.html`. Verified by HTTP probes against the
  dev server: both `/src/sharc-*.js` and `/dist/sharc-*.js` resolve.

## [0.5.1] - 2026-04-24

### Changed
- **Source relocation: `examples/sharc-*.js` → `src/sharc-*.js`.** The six SDK
  modules (`sharc-protocol`, `sharc-container`, `sharc-creative`, and the
  MRAID / SafeFrame / OMID bridges) plus `sharc-globals.d.ts` now live under
  `src/`. `examples/` continues to host wrapper pages and reference creatives.
  `dist/` distribution paths, `package.json` `exports`, and CDN URLs are
  unchanged — this is a source-layout move only, not a public-API change.
  Prod (`NODE_ENV=production`) bundle bytes are identical to 0.5.0; dev-build
  sourcemap `sources:` paths change from `../examples/` to `../src/`. Rollup,
  `scripts/sync-version.js`, `tsconfig.json`, the `npm version` hook, and
  `npm run lint` now point at `src/`. Example and test HTML imports repointed
  (`./sharc-*.js` → `../src/sharc-*.js`; `../sharc-*.js` →
  `../../src/sharc-*.js`).
- **Test harness relocation: `examples/test/` → `test/browser/`.** Browser
  validation harnesses, reference test creatives, the MRAID 3.0 compliance
  runner, baseline JSON, and shared harness modules now live under
  `test/browser/`, separating maintainer validation machinery from
  user-facing example integrations. `examples/` now holds only wrapper
  pages and reference creatives (`mraid-wrapper.html`,
  `safeframe-wrapper.html`, `omid-integration-test.html`,
  `compliance-ads/`, `test-classic-loading.html`). Harness depth is
  unchanged (two levels), so relative imports into `src/` remain
  `../../src/*`. `server.cjs` / `server.js` console hints,
  `scripts/regen-mraid3-baseline.js` (baseline dir + runner URL),
  README dev-server examples, CONTRIBUTING verification steps, and the
  architecture, getting-started, and distribution-design docs all repoint
  to the new path. Dated review notes inside the moved directory
  (`CODE-REVIEW-2026-04-09.md`, `FRONTEND-REVIEW-2026-04-09.md`,
  `SECURITY-REVIEW-2026-04-09.md`, `ARCHITECTURE-NOTES.md`) retain their
  historical `examples/test/…` references as point-in-time snapshots.

### Fixed
- **Resize-positive compliance cascade resolved (#20)** — the 6-fail
  known-issue bucket in `resize-positive` was root-caused to three
  compounding defects, not the hypothesized cold-handshake latency:
  1. **`sharc-mraid-bridge.js` anchor drift.** `_initialPosition` was
     overwritten from every `placementChange.position` enrichment, so after
     the first collapse the resize-offset anchor reflected the live iframe
     rect rather than the original slot. Subsequent offset resizes
     accumulated drift until they overshot the viewport. Fixed by treating
     `_initialPosition` as the MRAID default-position anchor: set exactly
     once from `Container:init env.initialPosition` and never mutated.
  2. **`sharc-container.js` hidden-iframe rect.** The init env's
     `initialPosition` was read from `iframe.getBoundingClientRect()` even
     when `visible: false` made the iframe `display: none`, producing
     `{0,0,0,0}` and forcing every MRAID offset resize to target viewport
     `(0,0)` — where any negative offset is rejected as offscreen. The
     container now falls back to `containerEl.getBoundingClientRect()`
     when the iframe rect is degenerate; the iframe is width/height 100%
     of the container, so the rectangles match once the iframe shows.
  3. **`mraid-3-compliance-runner.html` containerEl pollution.** The
     runner called `containerEl.innerHTML = ''` between suites but did not
     reset inline styles that `SHARCContainer.resize()` writes to
     `containerEl.style.width/height`. A previous suite's resize leaked
     into the next suite's anchor. The runner now also resets
     `containerEl.style.cssText = ''` so every suite starts from the
     CSS-declared 320×480 slot.
- **Silent bridge rejection cascade.** `mraid.resize()` / `expand()` /
  `collapse()` surfaced container rejections exclusively through
  `_emit('error', …)`, which is a no-op when the creative has not
  registered an `error` listener. Vendor compliance ads listen only for
  `stateChange` / `sizeChange`, so rejections silently cascaded into
  `waitTimeout`s. All three methods now also `console.warn` the failure
  reason, making the first offending call visible in test runs.

### Test harness
- **`--diagnose` flag on the regen script.** `scripts/regen-mraid3-baseline.js
  --diagnose` propagates `?diagnose=1` to the runner, which captures
  per-suite lifecycle milestones in `suite.diagnosticEvents[]` and adds a
  relative `t` (ms since suite start) to each `protocolTrace` entry. The
  regen script prints a gap analysis after the run to flag latency
  hotspots. Off by default so normal baselines stay diff-stable.
- **Headless viewport bumped to 1280×1024.** Default puppeteer viewport
  was 800×600, which clipped MRAID compliance placements that anchor at
  y≈357 and resize to 320×480 (357+480=837 > 600). Real publisher pages
  are never this narrow; the new viewport is closer to production reality
  and keeps legitimate rejections (offsetY=-50 above viewport, etc.)
  distinguishable from artificial clipping by the test harness.
- **`resize-positive` `knownIssues` #20 rule removed.** The harness drift
  detector flagged `actual=0` vs `expected=6` on the first green run and
  forced a `harness-broken` verdict, prompting the rule's removal per
  policy. Issue #20 closed.

### Infra
- **Release workflow gated on `NPM_TOKEN` presence** — `.github/workflows/release.yml`
  now conditionally skips the `npm publish` step when the secret is absent,
  emitting a GitHub notice instead of failing the run. The build, size-budget,
  pack, and dist-artifact-upload steps still execute, so a tag push produces
  a usable artifact bundle even before the npm scope is provisioned.
- **`RELEASING.md` npm publish section** — documents where the token comes
  from, the `@iabtechlab` scope prerequisite, and the rerun command that
  finalizes publishing once `NPM_TOKEN` lands.

### Test harness
- **MRAID 3.0 baseline regenerated against 0.5.0** — the committed baseline
  carried `sharcVersion: 0.3.0` and the pre-rename intent vocabulary
  (`maximize` / `minimize` / `restore`); replaced with a fresh capture that
  uses `expand` / `collapse` / `resize`. Ships with `scripts/regen-mraid3-baseline.js`,
  a puppeteer-core driver that automates the regen via the autorun hook so
  the next refresh is one command (`npm run regen:baseline`), not a manual
  checklist. `puppeteer-core` is now a direct devDependency rather than
  resolved transitively through `size-limit`.
- **Compliance runner: harness schema v3** — extends the v2 classification
  primitives with two integrity controls so a stale rule cannot silently
  hide a regression OR a positive change:
  - Per-rule `expectedCount` on `acceptedDivergences`. The finalizer asserts
    actual matches === expected; drift in either direction emits a
    `suite.harnessIssues[]` entry and forces the suite verdict to
    `harness-broken`. Catches vendor-wording changes, container-behavior
    changes that newly satisfy the spec, and accidental absorption of new
    fails by an over-broad regex.
  - Per-suite `knownIssues[]` for tracked-bug fail buckets. Distinct from
    `acceptedDivergences` (which records deliberate spec divergence with an
    ADR ref): `knownIssues` records SHARC-side bugs awaiting fix, with an
    `expectedFailCount` that is asserted on every run. Surfaces as a new
    `known-issue` verdict (rendered red, status text `Failed (known #N)`),
    plus `totals.knownFailures` and `totals.knownIssueSuites`.
  - **`resize-positive` was classified as `known-issue` against #20** when
    v3 shipped, but the underlying defects were fixed in the same cycle
    (see `Fixed` above) and the rule was removed. The integrity trip
    (`actual=0` vs `expected=6` → `harness-broken`) is the mechanism that
    forced removal rather than letting a fix hide inside a stale known-red
    bucket.
  - Earlier this cycle: per-suite `acceptedDivergences[]` for fails
    reclassified as expected spec divergence per ADR (e.g. close-button-
    onscreen validation removed in favor of container-owned close per
    ADR-PC-001/006). The 3 `resize-negative` "close button offscreen should
    error" fails register as accepted divergences with `expectedCount: 3`.
- **Per-test `manualNote` for interactive suites** — replaces the previously
  hardcoded `loadandevents` 6-tap note with a per-suite field so each
  interactive suite documents its own manual procedure. `viewability` is now
  `interactive: true` with a chart-review note, since `viewabilityCompliance.v1.js`
  is a Chart.js dashboard rather than an assertion-based test.
- **Compliance runner: `sharcVersion` capture timing fix** — the harness was
  reading `window.SHARC.Protocol.SHARC_VERSION` from a classic `<script>` that
  parses before the deferred `sharc-protocol.js` ES module loads, so every
  artifact recorded `'0.0.0'`. Re-read at `runAllTests()` start, when the
  module is guaranteed to have evaluated.
- **Regen script hardened** — `scripts/regen-mraid3-baseline.js` gained
  crash-proof cleanup (SIGINT/SIGTERM/SIGHUP/uncaught/unhandled handlers all
  reap the spawned dev server), conservative pruning (keeps last 3 baselines
  by mtime, only deletes files that parse as a `schemaVersion >= 1`
  baseline JSON, supports `--dry-run` and `--keep N`), cross-platform Chrome
  resolution (`CHROME_PATH` env, then per-platform candidate paths, then
  hard error — never silently picks a binary), `PORT` env override, and a
  hard schema-version assertion (`results.schemaVersion === 3`) so a stale
  runner cannot produce a malformed baseline. The `--no-sandbox` Chrome flag
  is now documented inline with the trust-boundary justification.

---

## [0.5.0] — 2026-04-21

### Migration guide

If you consume SHARC as an npm package or ESM import, 0.5.0 has breaks that
every caller needs to address:

- **Update your creative import.** The named export `sdk` was renamed to
  `creative` to align with `SHARCContainer` / `SHARCProtocol` terminology:
  ```js
  // Before
  import { sdk } from './sharc-creative.js';
  // After
  import { creative } from './sharc-creative.js';
  ```
- **Update `requestPlacementChange` intent strings** if you call the Creative
  API directly: `maximize` → `expand`, `minimize` / `restore` → `collapse`.
  MRAID and SafeFrame bridge callers are unaffected — the bridges already
  translate the new values.
- **Deploy containers and creatives together.** The bootstrap handshake
  message was renamed from `SHARC:port` to `SHARC:Container:handshake`.
  0.5.0 peers will not handshake with 0.4.x peers in either direction.
- **Private debug handle renamed.** `window.SHARC._sdk` is now
  `window.SHARC._instance`. Not part of the public API, but tooling or
  browser-devtools snippets that poked at it need to update.

See the Breaking section below for the full list.

### Breaking
- **`SHARCCreativeSDK` renamed to `SHARCCreative`** — aligns with `SHARCContainer`
  and `SHARCProtocol` naming. The ESM export is now `SHARCCreative`.
- **ESM export `sdk` renamed to `creative`** — `import { creative } from
  './sharc-creative.js'` replaces the previous `import { sdk }`.
- **`SHARC._sdk` renamed to `SHARC._instance`** — internal property on the
  `window.SHARC` global. Not part of the public API but observable by tooling.
- **Bootstrap message `SHARC:port` renamed to `SHARC:Container:handshake`** —
  follows the `SHARC:<sender>:<action>` naming convention. Containers and creatives
  at 0.5.0 will not handshake with peers at 0.4.x or earlier.
- **Placement intent vocabulary renamed** — `maximize` → `expand`, `minimize`/`restore`
  → `collapse`. The intent enum is now `'resize' | 'expand' | 'fullscreen' | 'collapse'`.
  Bridges updated to send the new values. Containers at 0.5.0 will not honor
  `maximize`/`minimize`/`restore` intents from older creatives.

### Security
- **Placeholder MRAID SDK metadata warning (SEC-004)** — the MRAID bridge
  now emits `console.warn` on bridge install when `MRAID_ENV.sdk` or
  `sdkVersion` still hold the `"TestAdSDK"` / `"0.0.0"` placeholder defaults
  **and** the host origin doesn't look like a dev environment (localhost,
  127.0.0.1, 0.0.0.0, *.local, or `file:`). Prevents shipping the bridge's
  test defaults to a production ad slot without noticing.
- **Bootstrap handshake origin validation (SEC-003)** — the creative-side
  `_onBootstrapMessage` now rejects any message whose `event.source` isn't
  `window.parent`, preventing a sibling frame or rogue script from injecting a
  `MessagePort` into the creative's transport. The same `source` check was
  already enforced on the container side; this makes the defense symmetric.
  The creative SDK also honors an optional `window.SHARC_CONFIG.trustedOrigin`
  declared before load — when set, bootstrap (and fallback-transport) messages
  whose `event.origin` does not match exactly are dropped. Rejected handshakes
  and dropped SHARC-shaped fallback messages emit a scoped `console.warn` so
  misconfigured `trustedOrigin` values or unexpected parent-handshake failures
  are visible in devtools without spamming unrelated postMessage traffic.

### Added
- **`SHARC_VERSION` constant in `sharc-protocol.js`** — single source of truth for
  the protocol version. Imported by the container; used in the bootstrap handshake
  message and in `createSession`. Resolves issue #16.
- **Creative version in `createSession`** — the creative now sends its
  `SHARC_VERSION` in the `createSession` message args. The container stores it as
  `_creativeVersion` for diagnostics and compatibility logging.
- **Audio controls and manual start in default test harness** —
  `examples/test/index.html` now exposes a Mute button + volume slider (wired to
  `setAudioState` / `Container:audioVolumeChange`) and an auto-start toggle with a
  Start Creative button, so the `ready → active` handshake can be driven manually.
  Promoted from the MRAID-only test harness.
- **Collapsible debug log in the default test creative** — click-to-toggle header
  with a log count, default collapsed. Reduces visual noise in the iframe.
- **Sample tracker URLs in `reportInteraction`** — the default test creative now
  sends four realistic cache-busted tracker URLs (IAS, DoubleClick, DSP, Moat
  patterns) so the interaction protocol path exercises a meaningful payload.
- **Pass/fail chips for Get Placement and Navigate** — placement-change test
  creative now reports result state for these two tests alongside the existing
  chips.

### Changed
- **"SDK" terminology replaced with "API" / "library"** — comprehensive rename
  across all source files, bridges, test harness HTML, wrapper pages, docs, README,
  and CHANGELOG. SHARC's container and creative are JavaScript libraries, not SDKs.
  OM SDK, MRAID SDK, and native platform SDK references are unchanged (those are
  genuine SDKs with native components).
- **Documentation references to `sharc-creative-sdk.js` corrected** — the file was
  always named `sharc-creative.js`; docs now match.
- **Terminology standardized to "SHARC Creative API"** — in shared contexts (docs,
  bridge comments, cross-module references), the creative-facing interface is now
  consistently called "SHARC Creative API". Within `sharc-creative.js` itself,
  "SHARC API" is used. "Library" reserved for references to the shipped bundle/file.
- **MRAID_ENV `sdk`/`sdkVersion` corrected** — these fields belong to the host ad
  network (e.g., AdMob), not SHARC. Defaults now use obvious test placeholders
  (`"TestAdSDK"` / `"0.0.0"`) so the values aren't mistaken for real SDK metadata
  when inspected in isolation. Production hosts override both before bridge load.
- **Shared `bridge-harness.{css,js}` module** — extracted ~700 lines of duplicate
  CSS/JS from `mraid-test.html` and `safeframe-test.html` into
  `examples/test/shared/`. Each harness now sets `window.HARNESS_CONFIG` and loads
  the shared runtime.
- **Wrapper module loading simplified** — `mraid-wrapper.html` and
  `safeframe-wrapper.html` consolidated their two `<script type="module">` blocks
  into one and removed the unused dist-vs-dev `?build=dist` URL-param loader.
  Module loading is now a single set of side-effect imports. (Supersedes the
  "dev-vs-`dist` loading paths" claim in the Infra section below.)
- **Placement test button layout** — reordered to
  `Resize → Collapse → Expand → Resize+Offset` (establishes a verb-then-collapse
  pairing), removed the decorative `success` class on the Zero-Order button, and
  shrank button padding/font-size to fit the denser grid.
- **Dropdown / heading naming standardized** — `index.html` dropdown options are
  now "SHARC Default Test" / "SHARC Placement Test"; `test-creative.html` heading
  matches ("SHARC Default Test").

### Fixed
- **MRAID bridge rejects `resize()`, `expand()`, and `collapse()` on interstitial
  placements** — per MRAID 3.0 §4.4.3 (resize) and §4.4.5 (expand/collapse), these
  verbs are inline-only. The bridge previously silently accepted `resize()` /
  `expand()` (emitting `stateChange("resized"/"expanded")`) and no-op'd `collapse()`
  via the idempotency guard. Each verb now emits the canonical error event
  (`"<verb> is not supported for interstitial placements"`, `action="<verb>"`)
  when the placement type is interstitial.
- **Duplicate `sizeChange` emission in MRAID `resize()` removed** — the
  `placementChange` listener is the single source of truth; the manual emit in
  `resize().then()` was double-firing.
- **Auto-scroll toggle in default test harness** — the button bound via
  `querySelector('.log-action-btn')`, which matched the Verbose button instead.
  Now uses `getElementById('autoScrollBtn')`, flips label between ON/OFF, and
  snaps the log to the bottom when re-enabled.
- **Interstitial iframe no longer paints past its ad-slot container** —
  `bridge-harness.js` clamps the simulated interstitial size (390×844 for MRAID,
  full viewport for SafeFrame) to the available slot width, preserving aspect
  ratio.
- **Duplicate creative-side logging in default test harness** — `onNavigation`
  and `onInteraction` callbacks were re-logging wire messages that `onMessage`
  already emitted.

### Docs
- **Version bump checklist added to `CLAUDE.md`** — documents all locations that
  must be updated when cutting a release.
- **`SHARC:Container:handshake` documented** — updated architecture, security audit,
  code review, and proposal docs to reflect the renamed bootstrap message.
- **GitHub metadata topics updated** — `javascript-sdk` → `javascript-library`,
  `creative-sdk` → `creative-api`.
- **Docs reorganized into subfolders** — `docs/design/` (PRDs + architecture),
  `docs/research/` (external landscape, compliance gaps), `docs/reviews/` (audits,
  recommendations), `docs/strategy/` (positioning, vision). Only core reference docs
  remain at `docs/` root.
- **Prefix casing normalized** — `ARCH-` → `arch-`, `PRD-` → `prd-` for consistency.
- **`RELEASING.md` added** — documents the version bump workflow, the auto-update
  table of files touched by `scripts/sync-version.js`, manual `CHANGELOG.md` and
  GitHub release steps, and a manual-sync troubleshooting path. Linked from
  `CONTRIBUTING.md`.

### Infra (from prior `[Unreleased]`)
- **Publishable package scaffolding** — `package.json`, `package-lock.json`,
  `rollup.config.js`, `tsconfig.json`, size-budget config, and guarded GitHub
  Actions CI/release workflows.
- **Repository governance/security scaffolding** — `CODEOWNERS` and `SECURITY.md`.
- **Type-checking support for browser globals** — `examples/sharc-globals.d.ts`
  and JS type-checking enabled.
- **ESM build pipeline** — container, creative, protocol, and bridge source files
  use explicit ESM imports/exports matching `dist/` artifact layout.
- **README repositioned as implementation-facing package guidance** — npm
  install/import usage, local harness startup, distribution/URL guidance.
- **HTML boot-order races narrowed** — MRAID/SafeFrame wrappers and example pages
  use module-based bootstrapping with dev-vs-`dist` loading paths.
- **Dev server entry point renamed to `server.cjs`** — matches `type: "module"`.

---

## [0.4.0] — 2026-04-13

### Added
- **Enhanced Placement Change System** — intent-based `requestPlacementChange` with
  five intents: `resize`, `maximize`, `fullscreen`, `minimize`, `restore`. Replaces
  the previous dimension-only model with explicit intent declarations.
- **Placement policy** — `SHARCContainer` accepts a `placementPolicy` constructor
  option for container-local enforcement of dimension limits (`maxWidth`, `maxHeight`),
  intent allowlists (`allowedIntents`), close region requirements (`requireCloseRegion`),
  offscreen control (`allowOffscreen`), and custom validators (`customValidator`).
  Policy is never sent over the wire.
- **Container-owned close button** — the container renders a 50 DIP close button as a
  DOM sibling to the ad iframe (outside the sandbox, z-index 2147483647) on `resize`,
  `maximize`, and `fullscreen` intents. Removed on `restore`/`minimize`. Accessible:
  `role="button"`, `aria-label`, `tabindex="0"`, Enter/Space keyboard handlers.
  Publisher customization via `closeButtonStyles` constructor option with enforced
  minimum size.
- **Close region hint** — creative can send `closeRegion: { position, size }` on
  `requestPlacementChange` to suggest where the container positions its close button.
  Offscreen hints are silently overridden to `top-right` (never rejected).
  `closeButtonPosition` (position + rect) included in `placementChange` notification
  for OMID `addFriendlyObstruction` registration.
- **`getPlacementConstraints()`** — new Creative API method (async) that queries
  container placement constraints before requesting a change. Follows the Permissions
  API query-before-request pattern. New protocol message
  `SHARC:Creative:getPlacementConstraints`.
- **`getCachedConstraints()`** — synchronous Creative API accessor returning the last
  known constraints. Returns unconstrained defaults (never null) before any query or
  event. Cache updated by `constraintsChange` events and `getPlacementConstraints()`
  responses.
- **`constraintsChange` event** — container sends
  `SHARC:Container:placementConstraintsChange` when placement constraints change
  mid-session (device rotation, viewport resize, publisher policy update). Includes
  `reason` field (`'rotation'`, `'viewportResize'`, `'policyUpdate'`). Debounced at
  200ms.
- **`placementTransitionEnd` event** — container sends
  `SHARC:Container:placementTransitionEnd` when a placement animation completes or is
  skipped. No corresponding start event (avoids hanging states on app background).
  Every `requestPlacementChange` with a `transition` field produces exactly one end
  event.
- **Animated placement transitions** — creative can send `transition: { duration, easing }`
  hint on `requestPlacementChange`. Container animates via `transform: scale()` (GPU
  composited) and snaps to final `width`/`height` on `transitionend`. Duration capped
  at 500ms; easing restricted to five CSS keywords (`linear`, `ease`, `ease-in`,
  `ease-out`, `ease-in-out`). Safety timeout at `duration + 100ms`.
- **Three new feature strings:** `com.iabtechlab.sharc.placement.resize`,
  `com.iabtechlab.sharc.placement.constraints`, `com.iabtechlab.sharc.placement.animate`.
  Auto-registered by the container.
- **`updatePlacementPolicy()`** — container method to update placement policy
  mid-session. Triggers `constraintsChange` notification with `reason: 'policyUpdate'`.

### Changed
- **`requestPlacementChange` can now reject** — rejects with `2203` for policy
  violations (intent not allowed, dimensions exceed limits, offscreen violation) or
  `2211` for malformed requests (missing required `closeRegion`, unknown intent,
  non-string intent). Backward compatible: rejection only occurs when a publisher
  configures a `placementPolicy`.
- **MRAID bridge `resize()` wired end-to-end** — `mraid.resize()` now maps to
  `requestPlacementChange({ intent: 'resize' })` with `closeRegion` hint derived
  from `setResizeProperties()`. Previously fired `COMMAND_NOT_SUPPORTED`.
- **`allowOffscreen: false` now enforced** — previously, `allowOffscreen` was accepted
  but silently ignored (documented as bug 2.2 in architecture doc). Creatives that sent
  `allowOffscreen: false` will now see rejection when the resized ad extends beyond
  viewport bounds. This is a behavioral change even on the zero-policy path.
- **MRAID bridge close indicator injection removed** — `_injectCloseIndicator`,
  `_removeCloseIndicator`, and `_closePositionCSS` removed. The container now owns
  the close button in all placement states.
- **MRAID bridge `useCustomClose` is reporting-only** — the flag is stored but
  triggers no rendering action. The container always renders its own close button.
- **MRAID bridge `supports('resize')` updated** — now checks for the
  `com.iabtechlab.sharc.placement.resize` feature string.
- **`docs/api-reference.md` updated** — new message types, fields, rejection
  semantics, feature strings, and placement policy documentation.

### Fixed
- **`getSupportedFeatures()` not wired into `window.SHARC`** — the class method
  existed but was unreachable from the `window.SHARC` global. Now exposed.
- **`allowOffscreen` accepted but silently ignored** — the field passed through the
  wire and was discarded. Now enforced in the validation pipeline.
- **Position not reset on `restore`/`minimize`** — the container reset dimensions but
  not `position`/`left`/`top` CSS, causing MRAID resize creatives to appear visually
  misplaced after close. Now snapshots pre-resize CSS state and restores it.

### Protocol
- New creative message: `SHARC:Creative:getPlacementConstraints`
- New container messages: `SHARC:Container:placementConstraintsChange`,
  `SHARC:Container:placementTransitionEnd`
- New fields on `SHARC:Creative:requestPlacementChange`: `intent`, `targetDimensions`,
  `targetPosition`, `closeRegion`, `allowOffscreen`, `transition`
- New fields on `SHARC:Container:placementChange`: `transition`, `closeButtonPosition`
- `requestPlacementChange` can now reject (was resolve-only)

---

## [0.3.1] — 2026-04-12

### Fixed
- **Preloaded ads now resync audio and re-check placement on every ACTIVE transition** —
  `setAudioState()` previously dropped calls outside ACTIVE/PASSIVE, so ads
  preloaded in READY/HIDDEN could enter display with stale audio and placement
  state. Now: LOADING buffers into `environmentData` only (no MessagePort yet);
  READY/HIDDEN buffer and defer delivery; ACTIVE/PASSIVE send live;
  FROZEN/TERMINATED drop. On every ACTIVE transition (`_transitionToActive`),
  the container re-sends current audio state via `_syncAudioState()` and runs
  `_syncPlacementState()`, so preloaded creatives receive fresh
  `audioVolumeChange` state and a current `placementChange` when the normalized
  placement payload has changed as they become interactive. Three ACTIVE
  transition sites are covered: initial `startCreative` resolve, page-focus
  regain from PASSIVE, and freeze-resume.
- **Redundant `placementChange` messages on repeated ACTIVE transitions** —
  `_syncPlacementState()` now compares the normalized outbound payload (including
  iframe position enrichment) against the last sent payload. Skips the send when
  width/height and position bounds are unchanged.
- **Duplicate iframe position enrichment in placement handling** — extracted
  `_buildPlacementChangePayload()` and routed both `notifyPlacementChange()` and
  the internal `_handleRequestPlacementChange` response through it, eliminating
  duplicated `getBoundingClientRect` logic.
- **`setAudioState()` accepted `NaN`/`Infinity`** — now rejects non-finite
  `volumePercentage` values with a console warning via `Number.isFinite()`.
- **MRAID bridge `isAudioMuted()` JSDoc stale** — updated from "init-time value,
  no live update" to reflect that it is a live value updated via
  `audioVolumeChange` events on every ACTIVE transition.
- **`.gitignore` missing build artifacts** — added `dist/`, `dist-meta/`, `*.tgz`,
  `.env*` to prevent accidentally committing build output or secrets.
- **"UMD" misnaming across source and docs** — the wrapper pattern is a two-branch
  IIFE (CJS + browser global) with no AMD `define()` branch. Renamed to
  "CJS/browser-global wrapper" in all source files and documentation.
- **MRAID bridge: close-button offscreen check applied unconditionally** —
  `setResizeProperties` now validates close-button visibility regardless of
  `allowOffscreen`. MRAID 3.0 §4.4.3 requires the close zone to remain
  onscreen even when `allowOffscreen` is true (it governs ad content, not the
  close control). Previously the bridge skipped the check entirely when
  `allowOffscreen` was truthy, allowing resize properties that would hide the
  close button. Fixes 3 of 13 resize-negative compliance failures.
- **MRAID bridge: `resize()` state guard** — `mraid.resize()` now fires an
  error event when called from any state other than `default`. MRAID 3.0 §4.4.3
  restricts resize to the default placement. Previously the bridge accepted
  resize requests from the expanded state without error.
- **IAB resize-negative compliance ad: 3 bugs in `EventTester`** —
  `examples/compliance-ads/resize-negative/resize-negative-tests.js` had three
  compounding bugs in the IAB-authored `EventTester` class: (1) `this.event`
  was never assigned in the constructor, so `addEventListener` registered
  listeners on `undefined` instead of `'error'`; (2) the event handler and
  timeout handler could both fire, each calling `done()`→`run()`, causing
  exponential forking (~2^13 concurrent test paths); (3) the bridge dispatches
  `_emit` synchronously, so the handler's `done()`→`run()` recursed before
  `moveNext()` incremented the test index, re-running the same test forever.
  Fixes: added `this.event = event`, a `resolved` guard, and a `setTimeout(0)`
  deferral.
- **MRAID 3.0 compliance runner no-op** — `examples/test/mraid-3-compliance-runner.html`
  never called `container.load()`, so no iframe was ever created and every suite
  timed out against a 30s window. The pass/fail interception was also wired to
  non-existent public properties (`container.onError = ...` against a container
  that stores callbacks in private `_onError` fields), making the booleans dead
  code. Both regressions are fixed: observation-window variables now close over
  the constructor-passed `onError` / `onStateChange` callbacks, `load()` is
  called after construction, and the pass criterion is driven by real
  `CHECK:` / `FAIL:` / `PASSED:` / `FAILED:` signal captured from the creative
  realm rather than a two-bit `reached-active && no-fatal-error` heuristic.
- **Console signal escape from null-origin iframe** — `examples/mraid-wrapper.html`
  now installs an in-realm `console.log`/`warn`/`error` shim (gated on
  `?harness=1`) that forwards every captured line to the parent via
  `postMessage`. Parent-frame interception was architecturally impossible
  (`console` is per-realm); this is the only viable capture path for the IAB
  compliance ads' self-reports. The runner listens, parses the IAB prefix
  conventions, and slugifies the message text for stable cross-run diffing.
- **`pollCheck` setInterval leak on timeout branch** — the runner's old
  observation loop never cleared its poll interval on the timeout path; the
  interval kept firing forever, polluting subsequent tests with stale closures.
  Replaced with a single `Promise` + bounded watchdog that cleans up after itself.
- **Inter-test race with async container teardown** — replaced the
  `await sleep(1500)` constant between tests with `closeContainerAndAwait()`
  which polls until `container === null` (set by `onClose`) with a bounded
  1500ms grace window.
- **Wrapper DOM layout race** — `examples/mraid-wrapper.html` now schedules
  companion-script injection via `requestAnimationFrame(requestAnimationFrame(…))`
  instead of `setTimeout(…, 0)`, so injected-body DOM is fully laid out before
  the creative script runs `getBoundingClientRect` and friends.
- **Wrapper `__SHARC_TEST_mraidCreativeInit` contract too strict** — the wrapper
  previously called `showError()` whenever a loaded companion `.js` did not
  define `window.__SHARC_TEST_mraidCreativeInit`. None of the IAB compliance
  shim files define it (they self-initialize at script parse time, the
  production pattern). The wrapper now tolerates a missing callback silently
  and only fires `showError()` when the `<script src>` actually 404s.
- **Viewability suite DOM-based reporting invisible to console shim** — the
  viewability compliance ad writes results via `displayMessage()` into a DOM
  `<p>` node, not `console.log`. `mraid-wrapper.html` now includes a
  `MutationObserver` (gated on `?harness=1`) that watches the body subtree for
  added elements and forwards their `textContent` to the parent as synthetic
  `level: 'dom'` messages. The runner's prefix parser picks them up like any
  other `CHECK:`/`FAIL:`/`PASSED:`/`FAILED:` line.

### Added
- **Three-layer baseline artifact on `window.__SHARC_HARNESS_RESULTS__`** —
  the MRAID 3.0 compliance runner now emits a structured results object
  containing, per suite, the compliance matrix (`checks`), the raw captured
  console stream (`consoleStream`), the protocol trace (`protocolTrace`),
  plus state history and verdict. Includes `schemaVersion: 1` (no separate
  JSON Schema file — inline comments in the emitter are sufficient until the
  artifact corpus warrants validation). Headless capture scripts can read the
  global directly after waiting on `runFinishedAt`.
- **Export JSON button** on the compliance runner header — serializes
  `window.__SHARC_HARNESS_RESULTS__` to a downloadable
  `sharc-mraid3-baseline-YYYY-MM-DD-HHMMSS.json` for committing as a reference
  baseline or diffing across refactors.
- **Named observation-window constant** — `TEST_OBSERVATION_WINDOW_MS` (45s,
  up from the previous unnamed 30s). `resize-negative` is measured at ~26-35s
  runtime; the previous ceiling flapped across that boundary and silently
  truncated the suite mid-execution.
- **`docs/mraid-compliance-manual-runbook.md`** — procedure for the
  `loadandevents` compliance suite, which requires 6 manual user taps to
  exercise the full 12 `CHECK:` / `FAIL:` assertion sites. A programmatic
  click driver was considered and rejected for this pass under the ~50 LOC
  ceiling agreed in the harness review Decision 2 — the cross-realm step-2
  close coordination pushes the driver over budget. The manual runbook is
  the documented fallback path. Interactive suites are tagged `interactive: true`
  in the runner's `TESTS` array and surface a `Manual` verdict when they
  bootstrap successfully but capture no post-step assertions.

### Changed
- **Architecture overview updated** — added `audioVolumeChange` to container
  capabilities, expanded Creative API section with `on()`, `requestClose()`, and
  full method list.
- **Creative API tree-shake refactor** — removed unused `CreativeMessages` and
  `ContainerStates` imports from `sharc-creative.js`.
- **JSDoc hardening** across `sharc-container.js`, `sharc-protocol.js`,
  `sharc-mraid-bridge.js`, and `sharc-safeframe-bridge.js` — added missing
  `@returns`, replaced vague `{Array}` with `{string[]}` / `{Object[]}`,
  removed stale `@param` annotations, documented constructors with
  `@constructor` / `@param`.

### Protocol
*None.* No wire-format changes. Existing `audioVolumeChange` and `placementChange`
messages are sent at additional transition points; no new message types.

---

## [0.3.0] — 2026-04-10

### Added
- `publisherContext` added to `Container:init` `environmentData` — container-reported publisher
  environment for supply chain integrity verification (`pageUrl`, `domain`, `bundleId`, `platform`).
  Web containers auto-derive from browser APIs at init time; in-app containers set via
  `options.environmentData.publisherContext`. Follows MRAID 3.0 §2.1 pattern: empty string `""`
  for unavailable string fields.
- `$sf.ext.hostURL()` implemented in SafeFrame bridge — returns `publisherContext.pageUrl`
  (SafeFrame 1.1 §6.4 parity). SafeFrame compliance: 10/12 → 11/12.
- `$sf.ext.message()` implemented in SafeFrame bridge — bridges to `SHARC.requestFeature(
  'com.iabtechlab.sharc.safeframe.message')` so messages flow through the SHARC protocol.
  Container routes to `onMessage` callback as `{ type: 'safeframe-message', args }`.
  SafeFrame compliance: 11/12 → 12/12 (full $sf.ext API coverage).
- `window.MRAID_ENV` extended with `publisherPageUrl`, `publisherDomain`, `publisherBundleId`,
  `publisherPlatform` in MRAID bridge — SHARC extension for cross-runtime supply chain verification.
- `audioVolumeChange` live signal — `setAudioState({ volumePercentage, isMuted })` on
  `SHARCContainer`. Protocol message `SHARC:Container:audioVolumeChange` carries
  `{ volumePercentage, volume, isMuted }`. MRAID 3.0 §4.6 compliance. `mraid.isAudioMuted()`
  and `mraid.getVolume()` now update live during playback. Mute state is independent from
  volume level, aligning with `HTMLMediaElement` semantics.
- Ad size presets and inline/interstitial toggle in MRAID and SafeFrame test harnesses —
  320×50, 320×100, 300×250, 320×480, 360×640, and custom. Interstitial snaps to 390×844
  (iPhone 14).
- Node.js dev server (`server.js`) replaces Python `http.server` — adds CORS headers required
  for null-origin sandboxed iframe testing, path traversal guard, `127.0.0.1`-only binding.
- `CREATIVE-AUTHORING.md` and `ARCHITECTURE-NOTES.md` added to `examples/test/` — documents
  the HTML+JS companion file convention and test harness patterns.
- `docs/architecture-overview.md` — contributor quick-start covering reference implementation
  layering and null-origin test wrapper constraints.

### Fixed
- Null-origin sandbox issues across all test harnesses — HTML creatives now load via XHR+DOM
  injection with `__SHARC_TEST_*Init` callback pattern. Eliminates double-sandbox
  `SecurityError` on `window.parent` access.
- SafeFrame wrapper double-sandbox nested iframe bug and cross-frame `$sf` injection
  `SecurityError`.
- `mraid-3-compliance-runner.html` — `getAdUrl()` now called correctly,
  `observeComplianceAd()` promise resolves reliably.

### Removed
- Historical `sharc/` PoC directory and stale `messaging_protocol.md` (superseded by
  `docs/api-reference.md` and current `examples/` implementation).

---

## [0.2.1] — 2026-04-06

### Fixed

- **`window.MRAID_ENV` missing** — MRAID 3.0 §2.1 requires this global before the creative loads. Now set as a static base in `mraid-wrapper.html` and enriched with runtime values (`appId`, `ifa`, `limitAdTracking`, `coppa`) from `Container:init` in the bridge. Fixes failures in `loadandevents` and `viewability` compliance suites.
- **`mraid.unload()` method missing** — MRAID 3.0 §7.3.6 defines `unload()` as a creative-callable method. Now maps to `SHARC.requestClose()`.
- **`close()` not state-aware** — MRAID 3.0 §7.3.3 requires `close()` to collapse the ad when called from `expanded` or `resized` state, not terminate it. The bridge now calls `collapse()` internally when `_placementMode` is `expanded` or `resized`.
- **`terminated` SHARC state unhandled** — SHARC `terminated` state now maps to MRAID `hidden` as a safe fallback, with a `console.warn` for developers.

---

## [0.2.0] — 2026-04-05

### Added

- **OMID bridge** (`sharc-omid-bridge.js`) — new file that maps SHARC container protocol to OM SDK 1.6 JS API. Integrates as a container extension via `supportedFeatures`.
  - Container-side `OmidCompatBridge` for feature registration and OM SDK lifecycle management
  - Creative-frame `installOmidBridge()` that drives OM SDK from SHARC events
  - Maps `stateChange('active')` → `adEvents.loaded()` and visibility-gated `impressionOccurred()`
  - Maps `requestOmid` signals → `MediaEvents` (play, pause, resume, skip, quartiles, buffer, volume, player state)
  - Guards against duplicate `AdEvents`/`MediaEvents` and enforces OM SDK load-before-session
- **Extension system** — container now accepts `extensions` option for plug-in integration features
  - `getFeatureName()` — extensions auto-contribute to `supportedFeatures` in Container:init
  - `injectIntoMarkup(html)` — extensions can inject scripts into creative markup before loading (opt-in via `useMarkupInjection=true`)
  - `destroy()` — extensions receive cleanup on container teardown
- **`requestOmid` handler** in container protocol — forwards creative measurement requests to the OMID bridge
- **Test creative** (`omid-test-creative.html`) — self-contained SHARC creative exercising all OMID event types; useful for WG demos and integration testing
- **Integration test page** (`omid-integration-test.html`) — publisher-side runner that instantiates SHARCContainer with OmidCompatBridge and logs the full protocol trace

### Changed

- **Container now requires extensions at construction** to enable measurement features (MRAID, SafeFrame, OMID). Previously, features were passed as static strings via `supportedFeatures`; extensions now register their own feature names at session time.
- **Creative loads via `iframe.src` by default** (previously `iframe.src` when no wrappers). Markup injection via `srcdoc` is opt-in (`useMarkupInjection=true`) and falls back to `src` on fetch failure.

---

## [0.1.0] — 2026-03-29

### Added

- Core SHARC protocol (`sharc-protocol.js`) — message schema, container states, state machine
- Container implementation (`sharc-container.js`) — secure iframe creation, MessageChannel handshake, Page Lifecycle state machine
- Creative API (`sharc-creative.js`) — `SHARC` global with `onReady()`, `onStart()`, `hasFeature()`, `requestFeature()`
- MRAID compatibility bridge (`sharc-mraid-bridge.js`) — MRAID 2.0/3.0 creatives run unmodified inside SHARC
- SafeFrame compatibility bridge (`sharc-safeframe-bridge.js`) — SafeFrame creatives run unmodified inside SHARC
- `supportedFeatures` extension mechanism

<!-- Version compare links (Update when new tags are pushed) -->
[Unreleased]: https://github.com/jeffreycarlson/SHARC/compare/v0.7.5...main
[0.7.5]: https://github.com/jeffreycarlson/SHARC/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/jeffreycarlson/SHARC/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/jeffreycarlson/SHARC/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/jeffreycarlson/SHARC/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/jeffreycarlson/SHARC/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/jeffreycarlson/SHARC/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/jeffreycarlson/SHARC/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.5.4...v0.6.0
[0.4.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/jeffreycarlson/SHARC/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/jeffreycarlson/SHARC/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffreycarlson/SHARC/releases/tag/v0.1.0
