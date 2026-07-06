# SHARC Reference Implementation — Architecture Overview

**Audience:** New contributors to the SHARC reference implementation.
**Purpose:** Orient you to how the codebase is laid out, which files are load-bearing, and which conventions are invariants you shouldn't regress.

This is a quick-start orientation. For the deeper material:

- **Why the protocol looks the way it does** — see `docs/architecture-design.md` (transport decision, state machine, session model, platform scope rationale).
- **What goes on the wire** — see `docs/api-reference.md` (definitive message schema, state transitions, error codes).
- **How the compat bridges map to legacy APIs** — see `docs/design/mraid-bridge-design.md` and `docs/design/safeframe-bridge-design.md`.

---

## 1. What's in This Repo

SHARC (Secure HTML Ad Rich-media Container) is an IAB Tech Lab ad-container standard **and** a working reference implementation of that standard. The repo contains both:

| Path | Purpose |
|---|---|
| `README.md` | Top-level project overview and repo entry point. |
| `docs/` | Design documents, API reference, bridge design, research, review artifacts. |
| `src/sharc-*.js` | The JavaScript reference implementation (protocol core, container, creative API, and the MRAID / SafeFrame / OMID bridges). |
| `test/browser/` | Browser-based test harness pages and reference creatives. |
| `examples/compliance-ads/` | MRAID 3.0 compliance test vectors. |
| `examples/compliance-ads-safeframe/` | SafeFrame compliance test vectors. |
| `dist/` | Built browser/IIFE (`.js`) and ESM (`.mjs`) bundles produced by Rollup. |
| `server.cjs` | Minimal static dev server for the harness. Dev-only. |
| `CHANGELOG.md` | Keep a Changelog format; the canonical log of externally visible changes. |

Contributors edit source files in `src/` and the relevant test assets in `test/browser/` or `examples/`, then verify changes in the browser harness. A Rollup build step produces browser/IIFE (`.js`) and ESM (`.mjs`) bundles in `dist/`. Smoke and type-consumer checks live in `test/node/test-smoke.js`, `test/node/test-treeshake.js`, and `test/types/`.

---

## 2. Running the Test Harness

```bash
node server.cjs
```

Serves the repo root at `http://localhost:8765` (bound to `127.0.0.1`, CORS `*`). The main entry points:

| URL | What it does |
|---|---|
| `/test/browser/index.html` | SHARC core test harness (drives the container through its full lifecycle). |
| `/test/browser/mraid-test.html` | MRAID compatibility bridge harness. |
| `/test/browser/safeframe-test.html` | SafeFrame compatibility bridge harness. |
| `/test/browser/mraid-3-compliance-runner.html` | IAB MRAID 3.0 compliance suite runner. |
| `/examples/demos/omid-integration/index.html` | OMID bridge integration test. |

Verification is visual: drive the lifecycle with the UI controls and read the protocol trace in the log pane.

`server.cjs` is **development-only**. It has an intentional path-traversal guard, binds to `127.0.0.1`, and sets permissive CORS headers — none of which is appropriate for production. Do not add production features to it.

---

## 3. The Reference Implementation Stack

The canonical implementation lives in `src/`, with test harness pages and reference creatives under `test/browser/`. The layering, from bottom up:

### 3.1 `sharc-protocol.js` — protocol core

Shared by container and creative. Defines:

- Wire format (`Message` dictionary with `sessionId`, `messageId`, `timestamp`, `type`, `args`)
- Message type enums (`ProtocolMessages`, `ContainerMessages`, `CreativeMessages`)
- Container states (aligned with the **Chrome/WebKit Page Lifecycle API**)
- The `SHARCStateMachine` that enforces valid transitions

It ships **two** protocol classes — `SHARCContainerProtocol` and `SHARCCreativeProtocol` — that both extend `SHARCProtocolBase`. The file uses a CJS/browser-global wrapper (two-branch IIFE, not true UMD — there is no AMD `define()` branch): in the browser it exports `window.SHARC.Protocol`; in Node it exports via `module.exports`. Every other file in the stack consumes protocol constants and classes through this seam.

**Load-bearing invariants in this file — do not regress:**

1. **Transport is `MessageChannel`, not raw `postMessage`.** `MessageChannel` gives a private port pair between container and creative, eliminating cross-frame broadcast risk. `postMessage` is the fallback only for environments where `MessageChannel` is unavailable (effectively zero in the v1 platform scope).
2. **Serialization is Structured Clone, never `JSON.stringify`.** Messages are passed as JS objects and serialized by the browser's structured clone algorithm. Do not introduce `JSON.stringify` on the wire.
3. **The creative generates the session ID** (SIMID-style; called "Option A" in `architecture-design.md`). This is deliberate.
4. **The private `MessagePort` is the trust boundary, not the session ID.** The session ID is a correlation key. Any change to this model requires updating `docs/architecture-design.md`.

### 3.2 `sharc-container.js` — publisher-side container

Used by publishers and SSPs. Exposes `SHARCContainer` with `load()` / `start()` methods and an `extensions` array option. Responsibilities:

- Creating the sandboxed iframe (with `allow-scripts` only — **never** `allow-same-origin`; adding that flag alongside `allow-scripts` lets the creative remove its own sandbox).
- Running the `MessageChannel` handshake.
- Owning the Page-Lifecycle-aligned state machine.
- Handling close, navigation, placement change, and tracker operations.
- Propagating live audio state to creatives via `setAudioState()` → `audioVolumeChange` messages (added in v0.3.0). On every ACTIVE transition, audio and placement state are re-synced to the creative to handle preload scenarios.
- Enforcing rate limits (50 msg/sec/session) and the 100 in-flight request cap.

### 3.3 `sharc-creative.js` — creative-side library

Used by ad creatives. Exposes a single `SHARC` global. Key methods:

- `onReady(callback)` — called when the container sends `Container:init` with environment data and supported features.
- `onStart()` — called when the creative transitions to ACTIVE and can begin rendering.
- `on(eventName, callback)` — subscribe to live events from the container (e.g. `audioVolumeChange`, `placementChange`, `stateChange`). This is the most common method creative authors use after `onReady`/`onStart`.
- `hasFeature(name)` — check if the container supports a feature string (reverse-DNS namespaced).
- `requestFeature(name, args)` — request a container capability (e.g. close, navigate, resize).
- `requestClose()` — request the container to close the ad.

The creative developer never sees session IDs, message IDs, or raw protocol messages.

**Hard design constraints:**

- Target footprint **< 5KB minified** with **zero dependencies**.
- Promise-based public API; no callbacks leaking protocol internals.
- Watchdog timers to prevent a misbehaving creative from blocking the close sequence.

### 3.4 Compatibility bridges

Bridges are **one-way compatibility shims** that let legacy creatives run unmodified inside a SHARC container. The creative believes it is talking to a native MRAID SDK or a SafeFrame host.

| File | What it bridges |
|---|---|
| `sharc-mraid-bridge.js` | Injects `window.mraid` and `window.MRAID_ENV` for MRAID 2.0 / 3.0 creatives. `MRAID_ENV` base is set statically in `mraid-wrapper.html` and enriched at runtime from `Container:init`. |
| `sharc-safeframe-bridge.js` | Injects `window.$sf.ext` for SafeFrame creatives. Full `$sf.ext` API coverage. |
| `sharc-omid-bridge.js` | Maps SHARC events onto the OM SDK 1.6 JS API for viewability and verification. Unlike the first two, this is not a legacy shim — it is a SHARC *extension* (see below) that registers at runtime. |

Bridges have no knowledge of `sessionId`, `messageId`, or `MessageChannel`. They are pure adapter layers on top of `window.SHARC`. This means they are portable to any SHARC library implementation.

### 3.5 Extension system

Added in 0.2.0. The container accepts an `extensions: []` option at construction time. Each extension implements:

- `getFeatureName()` → a reverse-DNS feature string (e.g. `com.iabtechlab.sharc.omid`). This auto-contributes to the `supportedFeatures` list that the container advertises in `Container:init`.
- `injectIntoMarkup(html)` *(optional)* → can inject scripts into creative markup before loading. Creative Markup variant only — always runs when registered; the Creative URL variant never injects (the `useMarkupInjection` fetch+srcdoc opt-in was removed; deliver as `creativeHtml` + `creativeRendererUrl` to inject).
- `destroy()` *(optional)* → cleanup hook on container teardown.

**When adding a new container capability, prefer a new feature string + extension over extending the core protocol.** The core protocol is intentionally minimal; features live at the edges.

A creative asks what the container supports via `SHARC.hasFeature('com.iabtechlab.sharc.audio')`. Feature strings are reverse-DNS namespaced. The container's effective `supportedFeatures` list is the union of:

1. Strings passed to `SHARCContainer({ supportedFeatures: [...] })`
2. `getFeatureName()` from each registered extension

---

## 4. Test Harness Wrapper Pattern (Important Quirk)

The test harness wrappers (`test/browser/mraid-wrapper.html`, `test/browser/safeframe-wrapper.html`) run inside a sandboxed iframe with `allow-scripts` but **not** `allow-same-origin`, which gives them `origin: null`. In that context:

- `fetch()` is blocked by CORS (null origins cannot make CORS requests).
- Nested iframes inherit the sandbox and **lose** `allow-scripts`.
- `window.parent.*` access throws `SecurityError`.
- Synchronous XHR is the only remaining same-document load mechanism.

The wrappers therefore load test creatives with this sequence:

1. Sync XHR fetches the creative `.html` file.
2. `DOMParser` parses it; styles from `<head>` are adopted; the body is injected via `innerHTML`.
3. `innerHTML` silently drops `<script>` tags, so all creative JavaScript lives in a **companion `.js` file** with the same basename. The wrapper derives the `.js` URL by regex from the `.html` URL.
4. The companion script is loaded via `<script src>` (which works from null-origin).
5. After the script finishes parsing, the wrapper calls `window.__SHARC_TEST_mraidCreativeInit()` or `window.__SHARC_TEST_sfCreativeInit()` to start the creative.

**None of this belongs in production creatives.** It is documented at length in `test/browser/CREATIVE-AUTHORING.md` and `test/browser/ARCHITECTURE-NOTES.md`, but the short version:

| Pattern | Allowed in test harness? | Allowed in production creatives? |
|---|---|---|
| `window.__SHARC_TEST_*Init` callback | Yes | **No** — no real library calls these |
| Splitting a creative across `.html` + companion `.js` | Yes | **No** — real MRAID / SafeFrame creatives are self-contained HTML |
| Synchronous XHR creative loading | Yes | **No** — blocks main thread, deprecated |
| `innerHTML` injection of creative body | Yes | **No** — not safe for untrusted third-party markup |

The `__SHARC_TEST_` prefix on the init callbacks is intentionally ugly to discourage copying into production code. Real production creatives use the standard MRAID `mraid.getState() === 'loading'` / `'ready'` event bootstrap, or SafeFrame's `$sf.ext.register()`.

The `compliance-ads/` test vectors bypass this wrapper model — they are loaded through `mraid-3-compliance-runner.html`, which has its own loading path.

---

## 5. Platform Scope

SHARC v1 targets exactly three rendering contexts:

| Platform | Rendering context | Transport |
|---|---|---|
| Web browser | Cross-origin iframe | `MessageChannel` |
| iOS | WKWebView | `MessageChannel` |
| Android | WebView | `MessageChannel` |

All three share the property that they run a full HTML/JS engine where `MessageChannel` has been natively available since 2010. One JavaScript implementation covers all three environments without any platform adapter layer.

**Out of scope for v1** (do not add platform abstractions that imply support):

- CTV (tvOS, Android TV, Tizen, webOS) — WebView support is inconsistent across CTV platforms.
- DOOH — deployment environments are too varied (Chromium kiosk, Electron, native apps, proprietary players).
- Games / intrinsic — Unity / Unreal / web-native game integrations require entirely different bridge patterns.

These may be added as platform adapters in future versions. They are not in v1.

---

## 6. Which Docs in `docs/` Are Authoritative

Most files in `docs/` are point-in-time artifacts — PRDs, reviews, research drafts, proposals. When changing behavior, the authoritative documents that must stay in sync with the code are:

| File | Role |
|---|---|
| `docs/architecture-design.md` | The current design of record. Transport, state machine, session model, platform scope. |
| `docs/api-reference.md` | Definitive wire protocol and public API reference. |
| `docs/design/mraid-bridge-design.md` | MRAID compat bridge design of record. Update when API mapping changes. |
| `docs/design/safeframe-bridge-design.md` | SafeFrame compat bridge design of record. Update when API mapping changes. |
| `CHANGELOG.md` | Every externally visible change, in Keep a Changelog format. |

Review and audit artifacts (`code-review.md`, `security-audit.md`, dated review files under `test/browser/`) are point-in-time snapshots. Do not edit them retroactively — if a fresh review is needed, write a new one.

---

## 7. Conventions

- **No `JSON.stringify` on the wire.** Structured Clone throughout.
- **No new globals on `window`** except `window.SHARC`, the bridge-injected `window.mraid` / `window.$sf` / `window.MRAID_ENV`, and the `__SHARC_TEST_*` init callbacks in the test harness.
- **Feature strings are reverse-DNS namespaced** (e.g. `com.iabtechlab.sharc.audio`). Extensions auto-register them via `getFeatureName()`.
- **Prefer extensions over core protocol changes.** New capabilities should land as a new feature string and an extension, not as a new core message type.
- **Semver in `CHANGELOG.md`:** MAJOR for protocol or public API break, MINOR for backwards-compatible feature, PATCH for fix.
- **Active reference creatives live under `test/browser/`.** The reference implementation itself lives in `src/sharc-*.js`.
