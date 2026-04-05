# Changelog

All notable changes to the SHARC Reference Implementation are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a `MAJOR.MINOR.PATCH` convention where:

- **MAJOR** — Breaking API or protocol changes
- **MINOR** — New features, backwards-compatible additions
- **PATCH** — Bug fixes, no-behavior changes

---

## [Unreleased]

### Added

### Changed

### Fixed

---

## [0.2.0] — 2026-04-05

### Added

- **OM ID bridge** (`sharc-omid-bridge.js`) — UMD-pattern bridge translating SHARC container protocol to OM SDK 1.6
  - Feature registration: `com.iabtechlab.sharc.omid` via `supportedFeatures` mechanism
  - OM SDK Service Script + Session Client lifecycle management (`Partner`, `Context`, `AdSession`)
  - Container state mapping: `stateChange('active')` → `adEvents.loaded()`, `impression` gating on container visibility
  - Media event mapping: `play`, `pause`, `resume`, `complete`, quartiles, buffer, skip, volume, playerStateChange
  - Defensive guards: duplicate `AdEvents`/`MediaEvents` prevention, OM SDK load-before-session enforcement
- **Extension system** — container now accepts an `extensions: []` option, replacing ad-hoc feature arrays
  - `getFeatureName()` — extensions contribute their feature name to `Container:init` supportedFeatures
  - `injectIntoMarkup(html)` — extensions can inject scripts into creative HTML before loading (opt-in)
  - `destroy()` — extensions cleaned up on container teardown
- **Markup injection** (opt-in via `useMarkupInjection=true`) — fetches creative HTML, pipes through extension injectors, loads via `iframe.srcdoc`
- **`requestOmid` protocol handler** — container forwards creative's OM ID request messages to the extension via `postMessage`
- **Test creative** (`omid-test-creative.html`) — WG-demo-ready creative exercising all OM ID event types
- **Integration test page** (`omid-integration-test.html`) — publisher-side container with full protocol trace logging
- **Cross-origin loading options analysis** — documented in `docs/OM-sdk-architect-recommendations.md` §Post-Review

### Changed

- `SHARCContainer` constructor now accepts `extensions` alongside `supportedFeatures`
- `supportedFeatures` is built from extensions at session time rather than passed as a static array
- Default container behavior: creative loads via `iframe.src` directly (no fetch/injection), enabling publisher-page OM SDK loading

### Architectural Decisions

- OM SDK loads on the **publisher page** by default (matches native iOS/Android SDK model)
- `injectIntoMarkup()` is **opt-in** (`useMarkupInjection=true`) — useful for same-origin test environments and controlled deployments
- Five cross-origin loading strategies were evaluated; publisher-page loading (Option 2) was selected for minimal infrastructure dependency

---

## [0.1.0] — 2026-03-29

### Added

- Core SHARC protocol (`sharc-protocol.js`) — message schema, container states, state machine
- Container implementation (`sharc-container.js`) — secure iframe creation, MessageChannel handshake, full Page Lifecycle state machine
- Creative SDK (`sharc-creative.js`) — `SHARC` global, `onReady()`, `onStart()`, `hasFeature()`, `requestFeature()`, `requestNavigation()`, `requestPlacementChange()`, `requestClose()`
- MRAID compatibility bridge (`sharc-mraid-bridge.js` + `mraid-wrapper.html`) — MRAID 2.0/3.0 creatives run unmodified inside SHARC
- SafeFrame compatibility bridge (`sharc-safeframe-bridge.js` + `safeframe-wrapper.html`) — SafeFrame creatives run unmodified inside SHARC
- `supportedFeatures` extension mechanism (baseline — static array)
