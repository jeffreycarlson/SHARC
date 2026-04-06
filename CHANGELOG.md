# Changelog

All notable changes to the SHARC Reference Implementation are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a `MAJOR.MINOR.PATCH` convention where:

- **MAJOR** — Breaking API or protocol changes
- **MINOR** — New features, backwards-compatible extensions
- **PATCH** — Bug fixes, internal improvements only

---

## [Unreleased]

No unreleased changes yet.

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
[Unreleased]: https://github.com/jeffreycarlson/SHARC/compare/v0.2.0...main
[0.2.0]: https://github.com/jeffreycarlson/SHARC/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jeffreycarlson/SHARC/releases/tag/v0.1.0
