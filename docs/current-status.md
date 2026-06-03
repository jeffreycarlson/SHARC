# SHARC Current Status

## Summary

SHARC is an IAB Tech Lab reference implementation in active **pre-1.0** development.

- Repository package version: `0.7.9`
- npm publication status: **not yet published**
- Current implementation scope: **web iframe**, **iOS WKWebView**, **Android WebView**
- Current repo posture: suitable for technical evaluation and standards review; not yet presented here as a broadly adopted production release line

## What Is Stable Enough to Read as Current

The following are the most reliable descriptions of the present implementation:

- [api-reference.md](./api-reference.md)
- [architecture-design.md](./architecture-design.md)
- [creative-cookbook.md](./creative-cookbook.md)
- [getting-started.md](./getting-started.md)
- [proposals/creative-sources.md](./proposals/creative-sources.md) — design rationale, threat model, and decision log for the 0.7.0 Creative Sources work
- bridge design docs under [`docs/design/`](./design)
- the current source and generated `dist/` artifacts
- [CHANGELOG.md](../CHANGELOG.md) — what shipped in `0.7.7` and earlier

As of `0.6.0`, every public package subpath ships generated TypeScript declaration files (`.d.ts`) alongside its `.mjs` bundle. TypeScript consumers get full IntelliSense and compile-time argument validation when importing any subpath. 0.7.0 expands the typedef surface to cover the Creative Markup variant — `creativeUrl` is optional, `creativeHtml` / `creativeRendererUrl` / `onSecurityEvent` are added, and `SHARCSecurityEvent` is a discriminated union that now covers seven reserved variants (0.7.1 added `bridge_load_failed`; 0.7.4 added `feature_load_failed`).

## What Shipped in 0.7.8

0.7.8 is the OMID spec-compliance release. It completes the OMID bridge transition staged across 0.7.3 (publisher-page `AdSession`) and 0.7.7 (protocol router foundation) — the publisher-page `AdSession` stays the single source of truth, and the iframe now exposes the exact IAB OMID surface that vendor verification scripts expect. It also lands the private creative validator stack — the harness that lets us classify OMID, MRAID, and SafeFrame outcomes across real bidder corpora before 1.0.

**OMID spec-compliant bridge + shim** ([#217](https://github.com/jeffreycarlson/SHARC/issues/217) / [#228](https://github.com/jeffreycarlson/SHARC/issues/228)). New `src/sharc-omid-shim.js` artifact installs `window.omid3p` in the creative iframe with the exact IAB OMID surface (`registerSessionObserver`, `addEventListener`), so OMID-aware verification scripts arriving inline in the `adm` (DoubleVerify, IAS, Moat, Integral) detect SHARC's OMID integration. `OmidCompatBridge` becomes the SHARC Protocol Router's second consumer (prefix `SHARC:Omid:`), inheriting the 0.7.7 router's uniform gate and per-protocol nonce derivation with no bespoke envelope-gating and zero router-side changes. Late-registering observers receive full chronological replay; the OMID nonce is stripped before observer delivery and never reaches vendor JS. `exposeOmid3p` defaults to `true`; a pre-existing `window.omid3p` loud-fails at shim install.

**OMID Markup-variant nonce wiring** ([#217](https://github.com/jeffreycarlson/SHARC/issues/217)). Completes the Creative Markup delivery path for the OMID shim: the container threads the OMID `protocolNonce` onto the outbound `SHARC:Renderer:render` envelope whenever OMID is active for the placement, and the shared renderer (`examples/renderer/index.html`) source-rewrites `sharc-omid-shim.js` into the creative markup **before** `document.write`, baking the OMID nonce as a closure constant — the same trusted-injection pattern as the 0.7.7 renderer load-probe prelude. The nonce never transits `location.hash`, a query param, a DOM attribute, or any creative-readable surface. The change is additive — with OMID off (or an old container), the render envelope keeps its pre-0.7.8 shape.

**0.7.8 OMID shim/bridge hardening** ([#250](https://github.com/jeffreycarlson/SHARC/issues/250)). Three production-impacting fixes land alongside the new surface. The iframe-side shim's inbound `message` listener was attaching to the cross-origin parent window — throwing a swallowed `SecurityError` and leaving vendors with zero session callbacks; it now attaches to the window the shim runs in. The shim's `postRegister` and the bridge's `_relayOmidEvent` both refuse to fall back to a `'*'` `targetOrigin`, closing the nonce-broadcast hazard. And `#250` itself covers four discrete bridge edge cases — re-entrant double-delivery, dropped active-burst events when the OMID nonce had not yet resolved, the `'*'` targetOrigin fallback above, and per-session counters not resetting on `sessionFinish`.

**Creative validator stack.** A private-first hardening harness under `tools/creative-validator/` runs normalized OpenRTB corpora through the local SHARC Creative Markup renderer in headless Chrome. The runner ships with MRAID/SafeFrame active bridge method probes, an OMID measurement signal path that distinguishes API `7` capability declarations from actual sidecar installs, network/script-load diagnostics, and triage summaries aggregating outcomes by status, diagnosis bucket, bidder, media type, adm kind, and API declaration. The real private corpus and generated reports remain gitignored.

**Protocol router 0.7.7 follow-up hardening** ([#234](https://github.com/jeffreycarlson/SHARC/issues/234)–[#237](https://github.com/jeffreycarlson/SHARC/issues/237)). Four surgical fixes to the 0.7.7 router primitive: `_deriveAndDeliver` now surfaces synchronous throws as the typed `PROTOCOL_DERIVATION_FAILED` rejection (#234); sequential-impression re-derivation ordering (`rederiveAllProtocolNonces()`) gains integration coverage pinning the re-derive-before-gate-accepts contract (0.7.8 OMID is the first consumer) (#235); dispatch now requires a non-empty colon-bounded type segment so a bare prefix envelope cannot match (#236); a throwing `onReady` callback now surfaces via `console.warn` instead of being silently swallowed (#237).

**`placementSessionId` structural-immutability tripwire** ([#240](https://github.com/jeffreycarlson/SHARC/issues/240)). The container's `placementSessionId` is now defined with a throwing setter, so any future direct mutation fails loud rather than silently desynchronizing the router's per-protocol nonces from the injected shim nonce.

## What Shipped in 0.7.7

0.7.7 hardens cross-frame protocol handling on the publisher page and lays the protocol-router foundation that 0.7.8 OMID consumes.

**Cross-frame protocol router** ([#231](https://github.com/jeffreycarlson/SHARC/issues/231)). New `SHARCProtocolRouter` internal primitive owns the single publisher-side `window` `message` listener for every SHARC cross-frame protocol. It validates every inbound envelope uniformly: source, origin, registered prefix, `placementSessionId`, protocol nonce, declared type, and current lifecycle phase. Extensions register via `event.container.protocolRouter.register({prefix, types, handler, onReady})` from their `onContainerLifecycleEvent` hook; prefix collisions throw synchronously. The renderer protocol is retrofitted onto the router with no semantic change. Exposed at `container.protocolRouter`; not part of the creative-facing public API. Design doc: [`docs/design/0.7.7-cross-frame-protocol-router.md`](./design/0.7.7-cross-frame-protocol-router.md).

**`unauthorized_protocol` security event.** New non-terminating discriminated-union variant on `onSecurityEvent`. Fires when an inbound envelope passes every trust-anchor check (source, origin, registered prefix, placementSessionId, protocol-derived nonce, declared type) but arrives in a lifecycle phase outside the type's declared phase membership. Payload is deliberately minimized to three enumerated, attacker-uncontrolled fields: `details.{type, phase, reason}`. Defends against cross-protocol envelope-type impersonation by iframe-side extensions landing in later releases.

**Per-protocol HMAC-SHA-256 nonce derivation.** The router derives a per-protocol nonce as `HMAC-SHA-256(key=_sharcNonce, message=prefix+":"+placementSessionId)`, sliced to 16 raw bytes (128 bits entropy) then base64url-encoded to 22 chars (UUID parity). The renderer protocol's wire-level `sharcNonce` is now the renderer-protocol-derived, session-bound nonce; the root `_sharcNonce` never appears on the wire. Sequential-impression `placementSessionId` re-mints re-derive every registered protocol's nonce atomically before iframe wiring (RTR-D21 ordering invariant).

**Breaking — secure-context requirement.** `SHARCContainer` now requires `window.crypto.subtle` at construction time. Non-secure contexts (HTTP iframes lacking `SubtleCrypto`) throw synchronously. Operators running staging on plain HTTP must move to HTTPS or `localhost` before upgrading.

## What Shipped in 0.7.6

0.7.6 ships three parallel features (Claude + Codex co-authored) plus a release-design doc, all targeting the next layer of operator-experience hardening on top of 0.7.4's OMID work.

**bfcache round-trip Puppeteer coverage** ([#178](https://github.com/jeffreycarlson/SHARC/issues/178)). The scaffold shipped in 0.7.4 (5 `IMPLEMENTOR-TODO` chokepoints, red on `main`) is now live in real Chrome. New `test/browser/bfcache-fixture.html`, `bfcache-away.html`, and `bfcache-creative.html` drive a permissive non-SHARC container through bfcache entry/restore and exercise the HTML lifecycle adapter's `pagehide`/`pageshow` paths end-to-end. Two-tier flake policy (per [`docs/design/0.7.6-bfcache-puppeteer-wiring.md`](./design/0.7.6-bfcache-puppeteer-wiring.md) ADR-178-E): structural assertions (bf-1 eligibility, bf-5 no "invalid transition" warns) run once; behavioral assertions (bf-2 LOADING→ACTIVE→HIDDEN→FROZEN, bf-3 FROZEN→ACTIVE restore, bf-4 strict-mode yield with `pageshow.persisted === true` guard) retry up to 3× inside the runner. New `npm run test:bfcache` script, deliberately NOT added to `test:all` (CI gets a dedicated step with `BFCACHE_INSTALL_MS=750`). No production code changes — the adapter under test was already jsdom-validated; this closes the real-browser-bfcache gap jsdom cannot model.

**Optional `creativeRendererIntegrity` preflight for Creative Markup** ([#24](https://github.com/jeffreycarlson/SHARC/issues/24)). Operators can pass a `sha384-<base64>` digest for `creativeRendererUrl`; the container fetches and verifies the renderer document bytes before assigning `iframe.src`. On mismatch or unverifiable bytes, the container fires `RENDERER_INTEGRITY_FAIL` (2120), emits a `renderer_protocol_error` security event with `details.subtype='integrity_failed'`, and never sends `SHARC:Renderer:render`. This is defense-in-depth rather than native iframe SRI, because browsers do not support `integrity=` on iframe navigations; cross-origin renderer hosts must allow the verification fetch with CORS.

**Bid-signaled OMID auto-installation** ([#185](https://github.com/jeffreycarlson/SHARC/issues/185)). When bid metadata declares AdCOM OMID code `7` via `creativeMeta.apis` and supplies `creativeMeta.measurement.omid.verificationScripts`, operators can pass `omidAutoInstall` with trusted OM SDK URLs and partner defaults. The container appends an `OmidCompatBridge` extension without adding `'omid'` to the renderer bridge list — preserving the locked 0.7.3 decision that OMID is measurement, not a renderer bridge. Missing or invalid OMID sidecar data warns and continues without installing measurement. Closes the narrow follow-up scope from #118.

**Release-design pattern.** 0.7.6 is the third release in the family to ship with a locked release-level design doc front-loading the decisions (after 0.7.3 and 0.7.4 — 0.7.5 was small enough to skip). The bfcache wiring locked 10 ADRs (A–J) via PR #187 before any implementation; the implementor (Senior Developer) executed against the contract rather than re-deciding it. The pattern continues to compress per-PR cycles and gives reviewers a stable source of truth.

Further reading:

- Release design + ADRs (bfcache): [`docs/design/0.7.6-bfcache-puppeteer-wiring.md`](./design/0.7.6-bfcache-puppeteer-wiring.md)
- CHANGELOG entries: [CHANGELOG.md `[0.7.6]` section](../CHANGELOG.md#076---2026-05-24)
- API reference updates: [`api-reference.md`](./api-reference.md) (`creativeRendererIntegrity`, `omidAutoInstall`, `creativeMeta.measurement.omid` documented)

## What Shipped in 0.7.5

0.7.5 is a small cleanup and release-infrastructure patch.

**Bridge `getWrapperUrl` helpers retired** ([#149](https://github.com/jeffreycarlson/SHARC/issues/149)). `MRAIDCompatBridge`, `SafeFrameCompatBridge`, and `OmidCompatBridge` no longer expose `getWrapperUrl(creativeUrl)`. The helper constructed wrapper-page URLs that the container never consumed; operators that still need wrapper-page flows can construct those URLs inline. The browser-harness wrapper HTML files remain unchanged.

**`npm run test:all` now rebuilds `dist/` first** ([#182](https://github.com/jeffreycarlson/SHARC/issues/182)). The public all-tests script now runs `npm run build` before dist-based tests, preventing stale generated artifacts from causing misleading failures after source or version changes. The previous no-build chain is available as `test:all:built` for callers that already built artifacts; `npm run check` uses that path after its upfront build.

**0.7.2 process artifacts archived** ([#180](https://github.com/jeffreycarlson/SHARC/pull/180)). Historical 0.7.2 handoff/WIP/comparison docs moved from `docs/design/` to `docs/archive/0.7.2/` with archive README markers; `docs/README.md` updated to separate historical process artifacts from current design docs.

Further reading:

- CHANGELOG entries: [CHANGELOG.md `[0.7.5]` section](../CHANGELOG.md#075---2026-05-24)

## What Shipped in 0.7.4

0.7.4 is an **OMID hardening release**. It finishes five OMID-adjacent items deferred from the 0.7.3 design so PR #122 could merge clean, ships the headline URL-variant `creativeSdkUrl` injection feature that closes the 0.7.2 PR #105 follow-up, and ships a bfcache round-trip coverage scaffold (full Puppeteer wiring deferred to issue [#178](https://github.com/jeffreycarlson/SHARC/issues/178), target 0.7.6).

**Headline feature — URL-variant `creativeSdkUrl` injection** ([#106](https://github.com/jeffreycarlson/SHARC/issues/106)). The built-in SHARC creative SDK auto-injection added in 0.7.2 now reaches the Creative URL variant. With `useMarkupInjection: true`, the container fetches the creative URL, injects the `<script src="...sharc-creative.js">` tag, and loads via `iframe.srcdoc` — mirroring the Markup-variant ordering contract (built-in runs first, operator `injectIntoMarkup()` extensions run after and see the markup with the SDK already present). Activation is **explicit opt-in only**: without `useMarkupInjection: true`, the URL variant continues to load via `iframe.src` and `creativeSdkUrl` is a no-op, so operators sharing constructor config across Markup and URL bid variants don't see iframe-loading semantics flip from `src` to `srcdoc` under them. Fetch failures (CORS, 404, transport) emit a `console.warn` diagnostic and fall through to the un-injected `iframe.src` load; no `SHARCSecurityEvent` fires for this path. The runtime `_creativeSdkInjected` flag gates feature advertising — `com.iabtechlab.sharc.creative-injector` is advertised only when injection actually ran (no capability lie on fetch failure).

**New SHARCSecurityEvent variant — `feature_load_failed`** ([#125](https://github.com/jeffreycarlson/SHARC/issues/125)). Sibling to `bridge_load_failed`; covers the publisher-page extension-load path while `bridge_load_failed` covers the renderer-side dynamic bridge import. Non-terminating (the container keeps running, the failed extension goes inert), no `errorCode` (extensions are outside the 21xx renderer-error-code namespace), `details: { featureName, reason, scriptUrl }` with `reason` as a classified token (current in-tree bridges emit `'timeout'`, `'network'`, or `'evaluation_throw'` — script-tag loaders cannot distinguish HTTP status). `OmidCompatBridge` is the first in-tree consumer; the variant is generalizable to any future extension that loads remote scripts. Operators monitoring `onSecurityEvent` now get a structured non-terminating signal when OM SDK script-load fails.

**Extension-lifecycle error event payload contract pinned** ([#123](https://github.com/jeffreycarlson/SHARC/issues/123)). Both fatal-error paths (`_handleCreativeFatalError` and `_handleFatalError`) already dispatched a canonical `{ errorCode, errorMessage, source }` payload to extensions via `onContainerLifecycleEvent({ type: 'error', ... })`. 0.7.4 adds test coverage to pin the contract against regression — the field is `errorMessage` (not `message`), `source` discriminates `'creative'` vs. `'container'`, and the assertion outright rejects any `message` alias per the 0.7.4 ADR. `docs/api-reference.md` § 9 gains a new "Lifecycle event payloads" subsection documenting the base event shape (including `state`), per-type detail fields (including the correct `intent` field on `placementChange`), and the error event payload contract.

**Multi-bridge dedup observability** ([#124](https://github.com/jeffreycarlson/SHARC/issues/124)). When multiple AdCOM `creativeMeta.apis` codes resolve to the same renderer bridge (e.g. two MRAID-version codes that both load `sharc-mraid-bridge.js`), the container emits a single `console.warn` at `_mapAdComApisToBridges` identifying which AdCOM codes collapsed and which bridge they collapsed to. Scope is AdCOM-only; explicit `bridges: [...]` arrays and adm-scan paths don't surface this race in practice.

**Legacy `requestOmid` audit closure** ([#121](https://github.com/jeffreycarlson/SHARC/issues/121)). The creative-frame `installOmidBridge()` helper and the `SHARC:Creative:requestOmid` message type that were added in 0.2.0 were removed during the 0.7.2/0.7.3 cycle when OMID became fully container-driven, but neither 0.7.2 nor 0.7.3 changelog recorded the removal. 0.7.4 closes the audit (zero residual symbols across `src/`, `test/`, `examples/`, `dist/`, `scripts/`) and adds historical-artifact banners to the two pre-0.7.3 docs that proposed the rejected path.

**Termination-mid-load coverage** ([#126](https://github.com/jeffreycarlson/SHARC/issues/126)). Pins the deferred-follow-up edge case from PR #122: when termination or destroy fires while the OM SDK script-load promise is still pending, the resolved promise must NOT create a session, must NOT fire late callbacks, and must NOT emit `feature_load_failed`. Five-section coverage (H1–H5) in `test/node/test-omid-container-lifecycle.js` — regression guards only; no production code change.

**bfcache round-trip Puppeteer coverage scaffold** ([#102](https://github.com/jeffreycarlson/SHARC/issues/102)). Ships `test/browser/test-html-lifecycle-adapter-bfcache.js` as a 5-section assertion contract scaffold (bf-1 through bf-5) for the bfcache round-trip behavior the HTML lifecycle adapter honors. Full Puppeteer + Chrome wiring is deferred to issue [#178](https://github.com/jeffreycarlson/SHARC/issues/178) (current target 0.7.6, may slip with devops capacity for bfcache CI tuning). The file is NOT in `npm run test:all`; ships as an orphaned coverage marker until #178 wires the harness.

Further reading:

- Release design + ADRs: [`docs/design/0.7.4-omid-hardening.md`](./design/0.7.4-omid-hardening.md)
- CHANGELOG entries: [CHANGELOG.md `[0.7.4]` section](../CHANGELOG.md#074---2026-05-24)
- API reference updates: [`api-reference.md`](./api-reference.md)
- Operator integration recipes: [`operator-cookbook.md`](./operator-cookbook.md)

## What Shipped in 0.7.3

0.7.3 ships container-owned OMID measurement through a new `OmidCompatBridge` extension. The publisher page loads OM SDK; the container drives the full `AdSession` lifecycle (start on `READY`, `loaded()` and impression on first `ACTIVE`, viewability tracking on state changes, finish on termination) from its own state transitions. MRAID, SafeFrame, and SHARC-native creatives all receive OMID measurement transparently — no creative-side OMID code is required.

OMID is intentionally an *extension*, not a renderer-loaded bridge. The `bridges` vocabulary stays scoped to runtime API compatibility (`'mraid'`, `'safeframe'`); `bridges: ['omid']` is rejected at construction and AdCOM `APIFramework` code `7` (OMID 1.0) is intentionally excluded from the auto-instantiation picker.

0.7.3 also formalizes the container's extension dispatch surface. Extensions receive `onContainerLifecycleEvent({ type, timestamp, container, state, ...detail })` for `'load'`, `'stateChange'`, `'placementChange'`, `'close'`, `'destroy'`, and `'error'` phases.

Bridge-managed URL validation throws synchronously at construction: both `omSdkServiceScriptUrl` and `omSdkSessionClientUrl` must be valid HTTPS URLs with no userinfo, and every `verificationScripts[].resourceUrl` entry is validated and deduplicated under the same rules. Missing (vs invalid) URLs do not throw — the bridge silently goes inert, advertising no OMID feature.

Further reading:

- Architecture spec: [`docs/design/0.7.3-omid-wiring.md`](./design/0.7.3-omid-wiring.md)
- Operator overview: README [Open Measurement (OMID)](../README.md#open-measurement-omid)
- Integration recipe: [`operator-cookbook.md` §5](./operator-cookbook.md#5-wire-container-owned-omid-measurement)
- API reference: [`api-reference.md` §9 OmidCompatBridge](./api-reference.md#omidcompatbridge)

## What Shipped in 0.7.2

0.7.2 closes the first transition-state path for operators loading mixed inventory. `requireSharcInit: false` lets a container load non-SHARC creatives without fatal-erroring on the missing `createSession` handshake, while keeping the default SHARC-aware path strict. `creativeSdkUrl` lets operators auto-inject the creative-side SDK into Markup-variant adm so legacy plain HTML, MRAID, and SafeFrame markup can be lifted toward SHARC without per-creative edits.

0.7.2 also adds the declaration/outcome diagnostics operators need while evaluating that path: `container.apiFramework` reports the declared AdCOM `APIFramework` runtime resolved at construction, and `container.hasSharcSession` reports whether the SHARC handshake actually completed.

## What Shipped in 0.7.1

0.7.1 adds container-driven compatibility bridge loading for the Creative Markup variant. `bridges` provides an explicit override, `creativeMeta.apis` lets the container select MRAID or SafeFrame bridges from bid metadata, and `container.bridges` exposes the resolved bridge list for dashboards and diagnostics.

The renderer imports requested bridges before writing creative HTML and reports bridge import failures through the structured `bridge_load_failed` security-event variant. That brings `SHARCSecurityEvent` to six reserved `type` values.

## What Shipped in 0.7.0

0.7.0 closes [issue #41 — Creative Sources](https://github.com/jeffreycarlson/SHARC/issues/41) — the Creative Markup variant ships, complete with the renderer protocol, navigation bridge, reference renderer, structured `onSecurityEvent`, and load-event navigation backstop.

### Creative payload polymorphism

`SHARCContainer` accepts a second creative-payload variant alongside the existing Creative URL flow:

- **Creative URL** (existing) — `creativeUrl: string`. The browser fetches the creative document directly from the creative server's origin.
- **Creative Markup** (new) — `creativeHtml: string` + `creativeRendererUrl: string`. The container posts the markup to an operator-hosted renderer page that writes it into its own document via `document.open() / document.write() / document.close()`. The creative gets a real cross-origin origin (the renderer's), so measurement SDKs (OMID, IAS, DV, Moat), `localStorage`, credentialed `fetch`, and CORS all work — without forcing operators to pre-host every markup blob as a URL.

Constructor validation enforces the variant XOR via 8 sequenced rules; first violation throws synchronously.

### Constructor validation rules + new error codes

Eight rules run synchronously in the constructor before any I/O happens:

| Rule | Enforces | Throw type |
|---|---|---|
| 1 | Exactly one of `creativeUrl` or `creativeHtml` | `TypeError` |
| 2 | `creativeHtml` requires `creativeRendererUrl` | `TypeError` |
| 3 | `creativeRendererUrl` is forbidden alongside `creativeUrl` | `TypeError` |
| 4 | `creativeRendererUrl` parses via `new URL(...)` | `Error` |
| 5 | `creativeRendererUrl` uses exactly the `https:` scheme | `Error` |
| 6 | `creativeRendererUrl` contains no userinfo | `Error` |
| 7 | `creativeRendererUrl` is cross-origin to `window.location` and (when accessible) `window.top.location` | `Error` |
| 8 | `creativeHtml` ≤ 256 KiB UTF-8 bytes pre-injection | `Error` |

Six new renderer-protocol error codes:

| Code | Name | When |
|---|---|---|
| `2114` | `RENDERER_TIMEOUT` | iframe `load` did not fire within 5s, or `:rendered` / `:failed` did not arrive within 2s |
| `2115` | `RENDERER_FAILED` | Renderer sent `SHARC:Renderer:failed` with a reason (Service Worker detected, container origin mismatch, nonce mismatch, etc.) |
| `2116` | `RENDERER_ORIGIN_MISMATCH` | `:rendered` payload's `rendererOrigin` does not equal the construction-time `creativeRendererUrl` origin (defeats 30x-redirect attack) |
| `2117` | `RENDERER_PROTOCOL_ERROR` | Envelope-valid `:rendered` or `:failed` with malformed payload (missing `rendererOrigin` / `reason`, wrong type) |
| `2118` | `RENDERER_UNAUTHORIZED_NAVIGATION` | Iframe `load` event fired beyond the expected sequence (load-event backstop) |
| `2119` | `RENDERER_POST_FAILED` | Synchronous throw from `iframe.contentWindow.postMessage(...)` (`DataCloneError`, null `contentWindow`) |

Code 2118 fires for both Creative URL and Creative Markup variants; the `details.variant` field on the structured event payload discriminates `'url'` from `'markup'` for triage. Codes 2114 / 2115 / 2116 / 2117 / 2119 are Markup-variant-only.

### Reference renderer

Canonical operator-fork starting point at `examples/renderer/index.html`. Implements the renderer-side protocol contract: nonce extraction from URL fragment, envelope validation (parent-source, container-origin echo, fragment-nonce, version compatibility), Service Worker detection, meta-refresh strip, `document.write` (with `DOMParser` + `replaceChildren` fallback), `:rendered` post after `DOMContentLoaded`.

The SHARC project hosts a deployment of the reference renderer at:

- `https://jeffreycarlson.github.io/SHARC/renderer/` — **SDK evaluation only**

Production deployments must fork the renderer and host on operator-controlled infrastructure. The container's `KNOWN_TEST_RENDERERS` production-block guard refuses to load this URL from non-dev origins (see next section). When SHARC is contributed upstream to IABTechLab, the upstream URL will be added to the same guard.

The reference renderer exposes a `RENDERER_CONFIG` named-constants block (operator-tunable values: `TEST_ONLY`, `RENDERER_PROTOCOL_VERSION`, `ALLOWED_PROTOCOL_VERSIONS`, `FORCE_DOMPARSER_FALLBACK`) and four `window.__sharcRenderer` lifecycle hooks (`onBeforeRender`, `onAfterRender`, `customSecurityLog`, `beforeStorageClear`). Operators tweak the config block and override the hooks in their fork without touching canonical code.

### `KNOWN_TEST_RENDERERS` production-block guard

A frozen list of canonical SHARC reference renderer URLs is hardcoded in `src/sharc-container.js`. The constructor throws synchronously when `creativeRendererUrl` matches a known test renderer URL AND `window.location.origin` is not a recognized dev origin.

Recognized dev-origin patterns (anchored regexes; suffix-style spoofing such as `notlocalhost.example` does NOT match):

- `localhost` (any port; `http(s)`)
- `127.0.0.1` (any port; `http(s)`)
- `*.localhost` (any port; `http(s)`)
- `*.test` (any port; `http(s)`)
- `*.local` (any port; `http(s)`)
- `[::1]` (IPv6 loopback, any port; `http(s)`)
- `0.0.0.0` (any port; `http(s)`)

The guard runs after rule 7 (cross-origin) succeeds, so it only fires when the URL would otherwise pass validation. The error message names the rejected URL and lists the dev-origin allowlist so the operator sees the failure mode immediately.

### Structured `onSecurityEvent` callback

Production observability hook fired with a `SHARCSecurityEvent` discriminated-union payload. Seven reserved `type` values:

| `type` | `severity` | `errorCode` | When |
|---|---|---|---|
| `wrapper_top_frame_inaccessible` | `'warning'` (or `'error'` when `wrapperPolicy: 'block'`) | — | Validation rule 7's wrapper-cross-origin carve-out — `window.top.location` access threw at construction |
| `renderer_origin_mismatch` | `'error'` | `2116` | Post-load origin echo found a redirect-chain origin |
| `renderer_protocol_error` | `'error'` | `2114` \| `2117` \| `2119` | Timeout, malformed payload, or postMessage threw — `details.subtype` discriminates |
| `renderer_failed` | `'error'` | `2115` | Renderer sent `SHARC:Renderer:failed` |
| `bridge_load_failed` | `'error'` | `2115` | Renderer failed to dynamically import a requested compatibility bridge; payload includes the failed `bridge` identifier |
| `unauthorized_navigation` | `'error'` | `2118` | Load-event backstop fired (`details.variant: 'markup' \| 'url'`) |
| `feature_load_failed` (0.7.4+) | `'error'` | — (non-terminating) | An extension's load-time asset failed to load on the publisher page (e.g. `OmidCompatBridge`'s OM SDK script 404'd or timed out); container keeps running, failed extension goes inert; payload includes `featureName`, classified `reason`, and 500-char-bounded `scriptUrl` |

Callbacks are synchronous; throws are caught and logged. For terminating events, `onSecurityEvent` fires BEFORE `onError` — operators that hook both rely on the sequence. Console output continues regardless of whether the callback is provided. Console-log prefix format now includes a `[<placementSessionId>]` segment (`[SHARCContainer] [<placementSessionId>] [<internalType>] <message>`); operators with log-grep regexes / dashboard parsers must update for the new format.

### SDK-auto-installed navigation bridge

`sharc-navigation-bridge` (a first-class bridge at `src/sharc-navigation-bridge.js`, sibling to MRAID/SafeFrame/OMID bridges) intercepts non-IAB-spec'd web-native navigation patterns: `window.open`, `<a>` clicks (including `target="_blank"`, `target="_top"`, and shadow-DOM cases via `composedPath`), `<form>` submits, `location.href` setter, `location.assign()`, `location.replace()`, and `<meta http-equiv="refresh">`. Routes through `SHARC.requestNavigation()` for operator URL review.

Auto-install logic differs per variant:

- **Creative Markup** — the renderer page imports the bridge and installs it BEFORE `document.write(creativeHtml)` so capture-phase listeners apply to all creative code (Phase D).
- **Creative URL** — the SHARC Creative SDK auto-installs the bridge synchronously at SDK init when running outside the reference renderer (variant detected via `window.__sharcRenderer` presence). Operators upgrading Creative URL placements get click-through audit coverage and the `RENDERER_UNAUTHORIZED_NAVIGATION` (2118) backstop without code changes (Phase E). SDK bundle grew +0.6 kB brotli.

The bridge is best-effort. The container-side load-event backstop (`RENDERER_UNAUTHORIZED_NAVIGATION` 2118) is the JS-bypass-resistant defense-in-depth catch — it fires on any iframe `load` event beyond the expected sequence (1 for Creative URL, 2 for Creative Markup) and terminates the session. Operators monitor 2118 across both variants once and branch on `details.variant` only when they need variant-specific triage.

When the SHARC SDK is missing on the page, anchor / form / `location.*` interceptions throw `SHARCNavigationError`. The throws fire INSIDE the renderer iframe — operators install `window.addEventListener('error', ...)` on the renderer page (NOT publisher-side) to capture them. Cross-origin error scrubbing renders publisher-side error listeners blind. See [api-reference.md § Navigation Bridge Error Contract](./api-reference.md#navigation-bridge-error-contract).

### Local Creative Markup demo

`examples/demos/creative-markup/index.html` is a self-contained page that constructs a `SHARCContainer` against the hosted reference renderer with a ~1.5 KiB inline HTML banner payload (visible click target with `window.open()` handler intercepted by the auto-installed navigation bridge, plus a `creative-loaded` postMessage probe). A live message log subscribes to `onStateChange`, `onSecurityEvent`, `onError`, `onNavigation`, `onClose`, `onMessage` and renders each as a tagged scrolling row.

Runs ONLY via `node server.cjs` — the demo and the Pages-hosted renderer are intentionally on different origins to satisfy validation rule 7. Open at `http://localhost:8765/examples/demos/creative-markup/index.html`.

## Pre-0.7.0 Carry-Over (still current)

The 0.6.0 surface remains in place. Highlights:

- **Placement identity fields** — `placementId` and `placementName` constructor options, both normalize empty strings to `null` and are readable as instance properties.
- **`placementSessionId` instance property** — UUID v4 generated at construction time, unique per `SHARCContainer` instance, never `null`. Used for DOM stamping, console-log prefixes, and diagnostics.
- **DOM stamping** — `data-sharc-*` attributes on the placement element and creative iframe, removed on `close()` to restore the element byte-for-byte. 0.7.0 adds `data-sharc-creative-source` and `data-sharc-creative-rendered` on the iframe.
- **Isolation guard** — synchronous throw at construction if `placementElement` already carries `class="sharc-placement"`. Error message names the existing `placementSessionId`.
- **`placementType` in `createSession`** — creatives declare placement type (`"inline"` | `"interstitial"`) in the wire message; defaults to `"inline"` when omitted.

The full set of 0.6.x changes is in [CHANGELOG.md](../CHANGELOG.md).

## What to Treat Carefully

This repository also includes proposals, research notes, and review snapshots that were kept for context. They are helpful, but they are not all normative or current.

Use extra caution with:

- dated review documents
- proposal drafts (the proposal under [`docs/proposals/creative-sources.md`](./proposals/creative-sources.md) is the design rationale for 0.7.0 and remains useful; older proposals may be partially superseded)
- strategy material
- research notes written before recent security and sandbox hardening

## Using SHARC Today

Until the first npm publish, external evaluators should treat this repo as the source of truth and use local builds.

Supported package entry points are already defined for eventual publication:

- `@iabtechlab/sharc/sharc-container`
- `@iabtechlab/sharc/sharc-creative`
- `@iabtechlab/sharc/sharc-protocol`
- `@iabtechlab/sharc/sharc-mraid-bridge`
- `@iabtechlab/sharc/sharc-safeframe-bridge`
- `@iabtechlab/sharc/sharc-omid-bridge`
- `@iabtechlab/sharc/sharc-navigation-bridge` (new in 0.7.0; also re-exported from `sharc-creative` for ESM consumers)

## Security Model Snapshot

The container uses a sandboxed iframe. Sandbox tokens differ per creative-payload variant.

**Creative URL** (default sandbox tokens — third-party iframe loaded directly via `src`):

- `allow-scripts`
- `allow-forms`
- `allow-popups`

`allow-same-origin` is intentionally **not** present — the creative URL's own origin is the trust boundary, and combining `allow-scripts` + `allow-same-origin` on a same-origin iframe would let the document remove the sandbox attribute entirely. `allow-popups-to-escape-sandbox` is also omitted by default for Creative URL — the unsandboxed-popup capability is gated behind the Markup variant's renderer ownership model.

**Creative Markup** (default sandbox tokens — strict superset of the URL set, introduced in 0.7.0 for the rendered iframe at the operator-controlled renderer origin):

- `allow-scripts`
- `allow-same-origin`
- `allow-forms`
- `allow-popups`
- `allow-popups-to-escape-sandbox`
- `allow-top-navigation-by-user-activation`
- `allow-storage-access-by-user-activation`

The Markup variant requires a richer capability set because the renderer iframe loads operator-hosted infrastructure (not third-party creative origin) and exposes the rendered creative to measurement SDKs that need same-origin storage and CORS. `allow-same-origin` is safe here (see [proposal § Iframe sandbox](./proposals/creative-sources.md)) because validation rules 4–7 (HTTPS-only, no userinfo, parseable URL, cross-origin to publisher) eliminate every URL shape that would cause the browser to collapse the iframe origin onto the publisher's. The renderer iframe runs at the operator's renderer origin, so measurement SDKs, `localStorage`, and credentialed `fetch` work without compromising the publisher origin.

Five sandbox-token constructor options expose per-token control for the Markup variant: `allowPopups`, `allowTopNavigationByUserActivation`, `allowStorageAccessByUserActivation`, `allowModals`, `allowDownloads`. The first three default `true`; `allowModals` and `allowDownloads` default **`false`** (asymmetric — operators opt in for age gates and in-iframe downloads).

The renderer iframe also gets defense-in-depth attributes:

- `csp` attribute: `object-src 'none'; base-uri 'none'` — `RENDERER_IFRAME_CSP` constant in `src/sharc-container.js`. Chromium-only enforcement; portable enforcement comes from the operator's HTTP-response CSP on the renderer page.
- `referrerpolicy = "no-referrer"` — the renderer URL is opaque to the creative
- A Permissions-Policy denylist on camera, microphone, geolocation, USB, serial, payment, screen-wake-lock, web-share, idle-detection, xr-spatial-tracking, identity-credentials-get (full list: `RENDERER_PERMISSIONS_POLICY` in `src/sharc-container.js`)

The `KNOWN_TEST_RENDERERS` production-block guard (described above) is enforced against a 7-pattern dev-origin allowlist.

SHARC communication uses a transferred `MessageChannel` port after bootstrap. Navigation and tracker execution are mediated by the container.

## External Readiness Notes

For external and standards-facing review, the clearest framing today is:

1. SHARC is real, implemented, and testable — Creative Sources (the 0.7.0 thesis) is shippable as of this release.
2. The implementation is still pre-release and should be described that way.
3. The authoritative documents are concentrated in a small subset of this repo.
4. Historical review and research material is preserved for transparency, not because every file reflects current policy.
