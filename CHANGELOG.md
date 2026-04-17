# Changelog

All notable changes to the SHARC Reference Implementation are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a `MAJOR.MINOR.PATCH` convention where:

- **MAJOR** — Breaking API or protocol changes
- **MINOR** — New features, backwards-compatible extensions
- **PATCH** — Bug fixes, internal improvements only

---

## [Unreleased]

> Note: The items below were extracted from
> `wip/main-local-cleanup-2026-04-16` and have now landed on `main`.

### Added
- **Publishable package scaffolding** — added `package.json`, `package-lock.json`,
  `rollup.config.js`, `tsconfig.json`, size-budget config, and guarded GitHub
  Actions CI/release workflows so the reference implementation can be built,
  size-checked, tarball-inspected, and prepared for npm publication without
  implying that a public package or CDN release has already occurred.
- **Repository governance/security scaffolding** — added `CODEOWNERS` and
  `SECURITY.md` to support review and disclosure expectations for the package-era
  codebase.
- **Type-checking support for the browser globals** — added
  `examples/sharc-globals.d.ts` and enabled JS type-checking so the ESM build and
  public entry points have a clearer declaration path.

### Changed
- **Reference implementation modules moved toward a real build pipeline** — the
  container, creative SDK, protocol, and bridge source files now use explicit ESM
  imports/exports and package-style entry points that match the current `dist/`
  artifact layout.
- **README repositioned as implementation-facing package guidance** — replaced the
  in-repo spec dump with a concise reference-implementation README covering npm
  install/import usage, local harness startup, and current distribution/URL
  guidance.

### Fixed
- **Narrowed HTML boot-order races in wrappers/test pages** — the MRAID and
  SafeFrame wrappers, plus related example pages, now load SHARC scripts via
  module-based bootstrapping so bridge globals are established before creative
  code runs. This also adds explicit dev-vs-`dist` loading paths for harness use.
- **Review-driven type/JSDoc cleanup across the implementation** — tightened
  constructor annotations, shared global typing, and related source comments so
  JS type-checking catches more integration issues during build/review.
- **Dev server entry point renamed to `server.cjs`** — preserves local harness
  behavior while matching the new package `type: "module"` setup.

### Docs
- **Distribution guidance narrowed to the current package shape** — updated the
  distribution design and related docs to describe the concrete subpath exports,
  canonical URL patterns, deferred bridge CDN policy, and publishability limits
  of the repo as it exists now.
- **Bridge/compliance docs corrected to current status** — refreshed notes where
  recent implementation behavior changed, including current preload/audio status
  and wrapper-loading assumptions.

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
- **`getPlacementConstraints()`** — new creative SDK method (async) that queries
  container placement constraints before requesting a change. Follows the Permissions
  API query-before-request pattern. New protocol message
  `SHARC:Creative:getPlacementConstraints`.
- **`getCachedConstraints()`** — synchronous creative SDK accessor returning the last
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
  SDK-close coordination pushes the driver over budget. The manual runbook is
  the documented fallback path. Interactive suites are tagged `interactive: true`
  in the runner's `TESTS` array and surface a `Manual` verdict when they
  bootstrap successfully but capture no post-step assertions.

### Changed
- **Architecture overview updated** — added `audioVolumeChange` to container
  capabilities, expanded creative SDK section with `on()`, `requestClose()`, and
  full method list.
- **Creative SDK tree-shake refactor** — removed unused `CreativeMessages` and
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
- Creative SDK (`sharc-creative.js`) — `SHARC` global with `onReady()`, `onStart()`, `hasFeature()`, `requestFeature()`
- MRAID compatibility bridge (`sharc-mraid-bridge.js`) — MRAID 2.0/3.0 creatives run unmodified inside SHARC
- SafeFrame compatibility bridge (`sharc-safeframe-bridge.js`) — SafeFrame creatives run unmodified inside SHARC
- `supportedFeatures` extension mechanism

<!-- Version compare links (Update when new tags are pushed) -->
[Unreleased]: https://github.com/jeffreycarlson/SHARC/compare/v0.4.0...main
[0.4.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/jeffreycarlson/SHARC/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/jeffreycarlson/SHARC/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffreycarlson/SHARC/releases/tag/v0.1.0
