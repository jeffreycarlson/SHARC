# Changelog

All notable changes to the SHARC Reference Implementation are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a `MAJOR.MINOR.PATCH` convention where:

- **MAJOR** — Breaking API or protocol changes
- **MINOR** — New features, backwards-compatible extensions
- **PATCH** — Bug fixes, internal improvements only

---

## [Unreleased]

### Fixed
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
[Unreleased]: https://github.com/jeffreycarlson/SHARC/compare/v0.3.0...main
[0.3.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/jeffreycarlson/SHARC/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffreycarlson/SHARC/releases/tag/v0.1.0
