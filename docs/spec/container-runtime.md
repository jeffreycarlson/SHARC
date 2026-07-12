<!-- SHARC-DOC-STATUS: NORMATIVE -->

# SHARC Container Runtime Specification

**SHARC Specification 1.0 (Draft)**

| Field | Value |
|---|---|
| Spec version | **1.0-draft** — one spec version shared by the three SHARC Specification documents. Independent of the npm package version; bumps **only on normative change**. Editorial and informative changes bump a document revision, not the spec version. |
| Document | L1 — Container Runtime (mandatory conformance class) |
| Status | **DRAFT** |

## Conventions

The keywords MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) **when, and only when, they appear in all capitals**. Lower-case "must" / "should" / "may" are non-normative prose.

<!-- trace: source=docs/proposals/creative-sources.md §Conventions (promoted per skeleton L1 §1.2 row) | gate=NO-GATE (definitional) -->

## Versioning policy

> RESERVED — extraction slice N (source: skeleton §G versioning-policy skeleton; NEW-PROSE inventory item 2)

## Extraction status (informative)

This document is being assembled by editorial extraction from the existing normative-of-record estate, per the ratified traceability skeleton (`docs/design/0.8.0-g1-spec-traceability-skeleton.md`). Sections marked RESERVED name their source and land in later extraction slices. Filled sections carry a traceability footer (`<!-- trace: source=… | gate=… -->`) naming the estate source and the pinning test gate, matching the skeleton's `section → source → gate` rows. Part 2 below carries wire-format prose moved out of `docs/api-reference.md` in this slice; per the skeleton those rows belong to the L2 Creative API Specification and re-home there when that document is extracted.

---

## Part 1 — Container Runtime (L1)

### 1.1 Scope, audience, and goals

> RESERVED — extraction slice N (source: Legacy Technical Spec §Introduction/§Guiding principles/§Scope/§Out of Scope/§Goals (harvest) + runtime-layering reframe (2026-06-10 ADR))

### 1.2 Terminology

> RESERVED — extraction slice N (source: Legacy §Terminology (incl. the embedded legacy→canonical state-name mapping table) + creative-sources.md §Glossary; the §Conventions RFC-2119 block is already promoted into this document's front matter)

### 1.3 Conformance clause

> RESERVED — extraction slice N (source: NEW-PROSE per skeleton §F, including the profile-governance rule — *no optional class or add-on profile may ever be required to claim SHARC Core conformance* — RATIFIED 2026-07-08)

### 1.4 Supersession of the SHARC-legacy WG drafts

> RESERVED — extraction slice N (source: NEW-PROSE; delta register: dropped VAST-error/SSAI zero-timeout prose, renamed states, renumbered errors)

### 1.5 Container model: slot, construction, DOM stamping, isolation guard

> RESERVED — extraction slice N (source: api-reference.md §1 (Constructor Options, Instance Properties, DOM Stamping, Isolation Guard) + README §Container Constructor Options)

### 1.6 Creative sources

> RESERVED — extraction slice N (source: creative-sources.md §Renderer Ownership Model/§Constructor Changes/§Load Path Matrix/§Injection Across Variants + G5 close record §The ratified contract)

### 1.7 Renderer protocol

The Renderer Protocol is a `window.postMessage` exchange between the container (publisher page) and an operator-hosted renderer iframe, used on the Creative Markup variant to deliver `creativeHtml` to a cross-origin renderer that writes the markup into its own document via `document.open() / document.write() / document.close()`. Once the renderer reports `:rendered`, the standard SHARC `MessageChannel` handshake (Part 2, §2.4) takes over inside the renderer's `contentWindow`.

#### 1.7.1 Message envelope

Three protocol message types flow over `window.postMessage` between the renderer iframe and `window.parent`:

| Message | Direction | When |
|---|---|---|
| `SHARC:Renderer:render` | Container → Renderer | Once, after iframe `load` event |
| `SHARC:Renderer:rendered` | Renderer → Container | Once, after `DOMContentLoaded` on the inner document |
| `SHARC:Renderer:failed` | Renderer → Container | On any renderer-side validation or render failure |

**`SHARC:Renderer:render` (container → renderer):**

```typescript
{
  type: 'SHARC:Renderer:render',
  bridges: string[],              // compat bridges the renderer should load (0.7.1+)
  creativeHtml: string,           // Markup to write into the renderer document
  placementSessionId: string,     // Container's placementSessionId (UUID)
  sharcNonce: string,             // CSPRNG UUID — must match URL fragment
  sharcVersion: string,           // SHARC SDK version
  rendererProtocolVersion: '1',   // Bumps when the protocol breaks
  containerOrigin: string,        // Publisher-page origin (window.location.origin)
}
```

Posted with `targetOrigin = <construction-time creativeRendererUrl origin>` — never `'*'`.

The `bridges` field is a sorted, deduplicated array of compatibility-bridge identifiers the renderer should dynamically load before writing `creativeHtml`. An empty array means "load no bridges." The renderer filters the inbound list against its own allowlist; unknown identifiers are logged and skipped, NOT loaded. A container omitting the field is treated identically to `bridges: []` (forward/backward compatible). Bridge selection and the identifier registry are Compat Profile material (see the Compat Profile Specification).

**`SHARC:Renderer:rendered` (renderer → container):**

```typescript
{
  type: 'SHARC:Renderer:rendered',
  placementSessionId: string,    // Echo of the container's placementSessionId
  rendererOrigin: string,        // window.location.origin AT THE TIME
                                 // OF REPLY — post-redirect canonical
}
```

The renderer-supplied `rendererOrigin` is the trust anchor for redirect detection (§1.7.2).

**`SHARC:Renderer:failed` (renderer → container):**

```typescript
{
  type: 'SHARC:Renderer:failed',
  placementSessionId: string,
  reason: string,                 // Human-readable failure reason
}
```

Reserved `reason` strings the reference renderer emits:

| `reason` | When |
|---|---|
| `service_worker_detected` | A Service Worker is registered or controlling the renderer origin |
| `container_origin_mismatch` | `event.origin` doesn't equal `event.data.containerOrigin` |
| `nonce_mismatch` | `event.data.sharcNonce` doesn't equal the URL-fragment nonce |
| `unsupported_renderer_protocol_version` | Container's `rendererProtocolVersion` is not supported by this renderer |
| `missing_placement_session_id` | `event.data.placementSessionId` is missing or non-string |
| `missing_creative_html` | `event.data.creativeHtml` is missing or non-string |
| `invalid_bridges_field` | `event.data.bridges` is present but not an array of strings |
| `bridge_load_failed` | Dynamic import of a compatibility bridge module rejected. Payload includes a `bridge` field with the failed identifier |
| `omid_shim_inject_failed` | Outer (pre-`document.write`): the renderer could not build the OMID shim prelude. Fatal: the render is aborted before any creative markup is written |
| `omid_shim_install_failed` | Inner (during `document.write`): the prelude ran but `installOmidShim()` threw (a half-install), surfaced from the prelude's catch |
| `document_write_failed: <message>` | `document.write` threw |

Operator forks may extend the vocabulary; the container surfaces the renderer-supplied `reason` raw on the structured event channel and sanitized in dev-channel logs.

#### 1.7.2 Container-side validation rules

Two distinct validation passes — envelope and payload-shape — with different failure semantics.

**Envelope checks (silent ignore on mismatch).** The container MUST ignore — and MUST NOT terminate on — `:rendered` and `:failed` messages that fail any of these checks. Any frame on the page can `postMessage`; mismatches are noise, not protocol errors:

- `event.source === iframe.contentWindow`
- `event.origin === <construction-time rendererOrigin>`
- `event.data` is a non-null object
- `event.data.type` is a string
- `event.data.placementSessionId` equals the container's `placementSessionId`

**Payload-shape checks (terminate with `RENDERER_PROTOCOL_ERROR` 2117).** Once envelope checks pass, the container validates payload shape. Failure terminates the container. For `:rendered`: `data.rendererOrigin` is a non-empty string. For `:failed`: `data.reason` is a non-empty string.

**Origin echo (terminate with `RENDERER_ORIGIN_MISMATCH` 2116).** After payload shape passes, the container compares `data.rendererOrigin` against its construction-time renderer origin (parsed from `creativeRendererUrl`). On mismatch the container MUST terminate with `RENDERER_ORIGIN_MISMATCH (2116)` — a mismatch indicates a redirect collapsed the cross-origin sandbox guarantee.

The order is shape → echo. A malformed payload that ALSO fails the echo comparison surfaces as `RENDERER_PROTOCOL_ERROR (2117)`, not `2116` — protocol-shape is the more accurate diagnosis for the operator.

#### 1.7.3 `close()` mid-render contract

If the container is closed between iframe `load` and receipt of `:rendered`/`:failed`:

- The rendered/failed reply timeout is cancelled
- The renderer message listener is detached
- The iframe is removed from the DOM (terminating renderer script execution)
- The placement element is restored to its pre-load state
- Late `:rendered` / `:failed` messages arriving after close are silently ignored (listener has been removed)

#### 1.7.4 Post-render probe-cycle ceiling

Post-render renderer-frame loads are re-authenticated via a probe/acknowledge round-trip over the held channel. Answered probe cycles are rate-bounded: exceeding the ceiling emits the non-terminating `renderer_navigation_blocked` diagnostic (`navKind: 'answered_probe_cycle_ceiling'`) while the ad is kept alive. The security-event registry that carries this diagnostic is §1.13 material.

> RESERVED (within this section) — renderer implementation contract and container-side message-validation prose held in creative-sources.md §Renderer implementation contract/§Container-side message validation joins in a later extraction slice. The load-event navigation backstop is §1.10 material; the `onSecurityEvent` registry is §1.13 material.

<!-- trace: source=api-reference.md §10 (Message envelope, validation rules, close() mid-render, probe-cycle ceiling) + creative-sources.md §Renderer implementation contract (RESERVED) | gate=test:renderer-protocol-retrofit; test:renderer-out-of-phase; test:renderer-load-reentry; test:renderer-probe-cycle-ceiling; test:renderer-prelude-nonce-self-remove; test:renderer-prelude-script-escaping; test:renderer-fallback -->

### 1.8 Container state machine and unified lifecycle ordering

#### 1.8.1 States

SHARC states are aligned with the **Chrome/WebKit Page Lifecycle API**. Creative developers already understand this model from web development.

| State | Creative-Queryable | Visible | JS Active | Focus/Input |
|-------|-------------------|---------|-----------|-------------|
| `loading` | ❌ Internal | ❌ | Partial | ❌ |
| `ready` | ✅ | ❌ | ✅ | ❌ |
| `active` | ✅ | ✅ | ✅ | ✅ |
| `passive` | ✅ | ✅ | ✅ | ❌ |
| `hidden` | ✅ | ❌ | ✅ | ❌ |
| `frozen` | ✅ | ❌ | ❌ | ❌ |
| `terminated` | ❌ Internal | ❌ | ❌ | ❌ |

`loading` and `terminated` are container-internal bookends. The creative never receives a `stateChange` message with these values — by definition, the creative cannot receive messages before init or after termination.

**`loading`** (internal)
> The container has created the WebView and is loading the creative. The SHARC handshake has not started. The creative may post `createSession` during this phase, which transitions the container to the init sequence.

**`ready`**
> `Container:init` has been resolved by the creative. The container is about to send `Container:startCreative`. The creative is initialized but not yet visible.

**`active`**
> The container is visible and the app/tab is in the foreground with user focus. The creative should be running normally. Maps to: Page Lifecycle `active`, iOS `UIApplicationState.active`, Android `Activity.onResume()`.

**`passive`**
> The container is visible but the app has lost input focus. Common causes: split-screen multitasking, phone call interruption (iOS), a dialog overlay. The creative is still rendering but user interaction may be limited. Maps to: Page Lifecycle `passive`, iOS `applicationWillResignActive`, Android `Activity.onPause()` in multi-window.

**`hidden`**
> The container is not visible. The app is in the background, the tab is hidden, or the screen is off. JavaScript continues to run but creatives should release non-essential resources and pause animations. Maps to: Page Lifecycle `hidden`, iOS `applicationDidEnterBackground`, Android `Activity.onStop()`.

**`frozen`**
> The OS has suspended JavaScript execution. This happens when the OS needs to reclaim CPU or memory. The creative should have saved state when entering `hidden`. From the creative's perspective, `frozen` and OS process termination look identical (JS stops). Maps to: Page Lifecycle `frozen`, iOS WebContent process suspended, Android `WebView.pauseTimers()`.

**`terminated`** (internal)
> The container has terminated and the WebView has been removed. No further communication is possible.

#### 1.8.2 Valid transitions

A conforming container MUST NOT perform a state transition not enumerated in this table. Any state may additionally transition to `terminated` (close, fatal error, or OS kill); `terminated` is terminal.

| From | To | Trigger |
|------|----|---------|
| `loading` | `ready` | `createSession` received → init resolved |
| `loading` | `active` | Non-handshake (HTML lifecycle adapter) route: creative loads without a SHARC handshake; no synthetic `ready` is emitted |
| `loading` | `passive` \| `hidden` | In-app pre-clamped host-lifecycle ceiling: the container comes up under a latched host-lifecycle assertion and lands directly at the clamped destination (unreachable in stock web embeds) |
| `loading` | `terminated` | createSession timeout (default 5s); fatal error |
| `ready` | `active` | `startCreative` resolved |
| `ready` | `passive` \| `hidden` \| `frozen` | In-app pre-clamped host-lifecycle ceiling (as above): the `active` the creative never experienced is not emitted |
| `ready` | `terminated` | startCreative rejected; timeout (default 2s) |
| `active` | `passive` | App/tab loses focus |
| `active` | `hidden` | App backgrounded / tab hidden directly (no prior blur on some platforms) |
| `active` | `frozen` | Direct freeze of a visible creative (bfcache entry / OS suspension); no phantom `hidden` is emitted |
| `active` | `terminated` | Close or fatal error |
| `passive` | `active` | App/tab regains focus |
| `passive` | `hidden` | App goes to background |
| `passive` | `frozen` | Direct freeze of a visible creative (as above) |
| `passive` | `terminated` | Close or fatal error |
| `hidden` | `passive` | App returns to foreground (no focus yet) |
| `hidden` | `frozen` | OS suspends JS |
| `hidden` | `terminated` | Close or OS kills process |
| `frozen` | `active` | OS resumes → focus |
| `frozen` | `passive` | OS resumes → visible, no focus |
| `frozen` | `hidden` | OS resumes → still hidden |
| `frozen` | `terminated` | OS kills process (no event to creative) |

> Editorial note (extraction fidelity): the source table in api-reference.md §5 predates the direct visible-freeze edges (`active`/`passive` → `frozen`), the non-handshake `loading` → `active` route, and the in-app pre-clamped edges. This table is corrected against the reference implementation's `STATE_TRANSITIONS` registry (src/sharc-protocol.js), whose behavior the named gates pin.

#### 1.8.3 Unified lifecycle ordering (load-anchored cascade)

> RESERVED — extraction slice N (source: state-delivery-contract.md §5 (ordering invariants) + unified lifecycle ordering ADR (2026-06-13, Obsidian) — NEW-PROSE-from-ADR where no repo sentence exists)

<!-- trace: source=api-reference.md §5 (corrected against src/sharc-protocol.js STATE_TRANSITIONS) | gate=test:lifecycle-ordering-conformance; test:lifecycle-conjunction-gate; test:lifecycle-load-anchor; test:active-frozen-edge; test:restore-single-authority; test:restore-level-reassert; test:restore-transient-hidden -->

### 1.9 Effective-visibility model

> RESERVED — extraction slice N (source: api-reference.md §7 `effectiveVisibilityChange` + README §OMID "one viewability number" + Slice C composer ADR (2026-06-20, Obsidian)). The wire-message dictionary entry for `effectiveVisibilityChange` is carried in §2.5 of this document pending the L2 extraction.

### 1.10 Navigation policy

> RESERVED — extraction slice N (source: api-reference.md §10 (Load-event navigation backstop) + creative-sources.md §Security Model (click-through audit; sandbox top-frame navigation) + design/0.7.10-post-render-nav-policy-omid-phase.md (harvest ratified rules only))

### 1.11 Consolidated security model

> RESERVED — extraction slice N (source: creative-sources.md §Security Model (whole block) + design/0.7.7-cross-frame-protocol-router.md §5/§7.1 + design/0.7.8-omid-spec-compliant-bridge.md §4.3 corrected prose + api-reference.md §2 Security Guarantees + NEW-PROSE consolidation glue). The protocol-layer enforcement bounds from api-reference §2 are carried in §2.2 of this document pending consolidation.

### 1.12 document.open / self-rewrite policy

> RESERVED — extraction slice N (source: docopen ADRs (2026-06-13 / 2026-06-15, Obsidian); harvest test-file contracts, NEW-PROSE-from-ADR for the policy statement)

### 1.13 Observability

> RESERVED — extraction slice N (source: api-reference.md §10 (`onSecurityEvent`) + §7 (`SHARC:Container:log`) + README §Observability Accessors)

### 1.14 OMID provisioning

> RESERVED — extraction slice N (source: README §Open Measurement (embedded mini-spec) + api-reference.md §9 `OmidCompatBridge` + design/0.7.8/0.7.11 (ratified behavior only))

### 1.15 OMID on the URL variant

> RESERVED — extraction slice N (source: G5 close record §The ratified contract + G5 ADR (2026-07-05) Decision §T2)

### 1.16 Native Host Interface

> RESERVED — extraction slice N (source: NHI ADR (2026-07-03, Obsidian) + api-reference.md §1 (`onOrientationProperties`, `hostOwnsClamping`, `setHostExposure`) + api-reference.md §`setAudioState` + HISTORICAL sources docs/design/{arch,prd}-audio-volume-change.md). The `setHostLifecycle` INPUT member added by the G6 amendment is specified in §1.17 below.

### 1.17 In-App Integration (WKWebView / Android WebView)

The same JavaScript container runs inside the WebView — never a native port. Native integrates through the L1 Native Host Interface (§1.16: ACTIONS and INPUTS) and the app lifecycle adapter. The embedding is operator-declared, never sniffed: the container constructor option `hostContext: 'web' | 'app'` (default `'web'`; a non-enum value MUST throw `TypeError` at construction) selects the app lifecycle adapter for in-app embeds.

#### 1.17.1 Host-lifecycle INPUT: `setHostLifecycle(state)`

In-app, the page's own lifecycle signals are mostly blind: the WebView never fires the WICG `freeze`/`resume` events, so **the host INPUT is the ONLY source of `frozen` in-app**. The host asserts container lifecycle via the HOST-PROVIDED INPUT `setHostLifecycle(state)`:

- **Enum:** `'active' | 'passive' | 'hidden' | 'frozen'` — deliberately the page-lifecycle vocabulary, so one enum serves both platforms and the web semantics stay the reference. No `'terminated'` (an engine-process death leaves no realm to deliver into — that is a host-side disposal event, not an INPUT value); no `null`-to-clear (a lifecycle always has a value; the host simply stops calling and the last assertion stands).
- **Validation (strict):** a value outside the enum MUST throw `TypeError`. A silently dropped `'frozen'` would leave the container measuring a suspended app — the worst silent failure this surface can produce.
- **Precedence (two-axis rule):** `SHARC state = most-severe( host-asserted state, page-derived state )` on `active < passive < hidden < frozen`. The in-page signals remain a defensive floor, not the authority.
- **Declared consumer:** the app lifecycle adapter — NEVER a compat bridge. Exposure feeds the composer, lifecycle feeds the adapter; nothing host-provided ever touches a compat bridge directly.
- **Dedup:** consecutive-identical values are no-ops, so mandatory host re-assertion is free.
- **Replay:** last-value-latched — a value asserted before the adapter attaches (preload) is retained and applied at attach.
- **Delivery-before-suspension:** JS evaluation from a backgrounding callback is asynchronous and may not complete before suspension. The INPUT is best-effort at freeze-entry, and the host MUST re-assert the current state on every foreground return (dedup makes re-assertion idempotent).
- **Web inertness:** the surface ships in the bundle; with no host wired it is never called and stock web embeds are byte-identical.

#### 1.17.2 Host-integration dual assert (normative)

When the app backgrounds or the container's view is covered/off-screen, the host integration MUST assert BOTH inputs:

> `setHostLifecycle('hidden')` **AND** `setHostExposure(0)`

The two surfaces feed deliberately disjoint consumers: **lifecycle feeds state** (the adapter's two-axis most-severe rule → container state, MRAID `stateChange`, OMID session gating), while **exposure feeds measured visibility** (the effective-visibility composer → the wire's `effectiveVisibilityChange`, MRAID `exposureChange`/`viewableChange`, SafeFrame geometry, the OMID relay). A host that asserts only the lifecycle leaves the composer reporting the last on-screen exposure percent for a hidden container — measurement lies while state tells the truth; a host that asserts only the exposure leaves the container's state axis believing the page is interactive. Neither input derives the other by design. The symmetric foreground return re-asserts both (`setHostLifecycle(<current>)` and `setHostExposure(<current pct>)`).

#### 1.17.3 In-app teardown sequence and HOST-REQ-1

1. The host initiates dismissal by asking the *container* to close (invoke `destroy()`/`close()` on the container via the host page — never by deallocating the WebView first).
2. The container's termination sequence runs unchanged: the terminal OMID `sessionFinish` is relayed during the `omid-finishing` phase, BEFORE the transition to `terminated` and destroy (pinned ordering).
3. **HOST-REQ-1 (normative):** the host app MUST hold a strong reference to the WKWebView / Android WebView — and MUST NOT suspend, navigate, or deallocate it — for at least **1.0 s** after session finish (the OM SDK documented minimum). SHARC RECOMMENDS **1.5 s** to cover the container's own `omid-finishing` grace with a single figure. Only then may the host remove the WebView from the hierarchy and release it. On iOS, dismissal-driven teardown must not ride `deinit` ordering; schedule the release.
4. If the host uses the native `JavaScriptSessionService` teardown API — whose documented semantics finish all active ad sessions and may itself require up to one second — it MUST be called only AFTER step 2's JS-side finish has run, or the host accepts that native force-finishes the session out from under the container.
5. Crash-path exception: WebView engine-process death (`webViewWebContentProcessDidTerminate` / `onRenderProcessGone`) means the JS realm is already gone — the grace is forfeit by construction, no `sessionFinish` can be delivered, and the host's only duty is disposal.

#### 1.17.4 OMID In-App

**Service-script mode.** The OM SDK has two service-script builds with different authority models: the in-app JS service (`omsdk-v1.js`, provided/injected by the host's native integration) and the web service (`omweb-v1.js`, a standalone JS binary). In-app, the WebView runs the NATIVE SDK's service script, provided by the host integration — the container MUST NOT boot `omweb-v1.js` in that environment, and the two services do not coexist (one detection point, two claimants is a misconfiguration, not an option). The session client (`omid-session-client-v1.js`) is the same library in both worlds, and the container-side OMID extension retains AdSession ownership (start/finish via the session client) in both modes — the documented `JavaScriptSessionService` division of labor.

The mode is operator-declared via the OMID extension option `serviceMode: 'web' | 'native'` (default `'web'`), never platform-sniffed — a misdetection would silently fork measurement authority, the one failure the switch exists to prevent:

- `'web'` (default) — the web behavior, byte-identical: the extension injects the web service script then the session client.
- `'native'` — the extension MUST NOT inject any service script. It injects only the session client, then waits (bounded by the standard script timeout) for the native-provided service to become reachable via the session client's public `AdSession.isSupported()` probe. Feature advertisement requires only the session-client URL.
- A `serviceMode` value outside the enum MUST throw `TypeError` at construction (no coercion, no silent default-on-garbage).
- `serviceMode: 'native'` combined with a configured service-script URL MUST throw `TypeError` at construction — a contradictory authority declaration ("native provides the service" + "here is a service to inject") is a configuration bug, and injecting the web service next to the native one is the harmful act itself.
- Misconfiguration behavior: `'native'` declared with no native service actually present fails honestly after the bounded wait — the structured `feature_load_failed` event fires with reason `native-service-missing`; the ad still renders and measurement honestly fails. `'web'` left defaulted where the host injected the native service does not stack a second service (the existing service-already-present idempotence check holds); the extension emits a one-time dev-channel warning nudging toward the explicit declaration.

**Single geometry authority.** The single authority in-app is the WebView's on-screen geometry as measured by the host, fed to BOTH consumers from that one physical source: (1) host → SHARC composer, via the existing `setHostExposure(pct)` INPUT (axis-3, host-wins) — everything SHARC emits (the wire's `effectiveVisibilityChange`, MRAID `exposureChange`/`viewableChange`, SafeFrame geometry, and the OMID relay) continues to read the ONE composer; (2) host → OM SDK native, the same WebView registered as the ad view (`isHtmlAdView: true` makes the WebView frame the ad view).

> In-app, `wire == MRAID == SafeFrame == OMID-relay` continues to hold by construction (one composer). The OM SDK's native geometry stream is an *independent measurement of the same WebView frame*, not a SHARC emission; conformance therefore additionally requires **agreement**: at visibility steady state, the composer's `effectivePercent` and the OM SDK's `percentageInView` for the registered WebView MUST agree within rounding tolerance.

The agreement check is asserted by the G6 conformance harness at driven plateaus (fully visible, partially occluded, app-backgrounded). Note the in-app effective-visibility reason vocabulary: `'frozen'` is structurally unreachable in-app (only the page-lifecycle `freeze` event sets the composer's freeze sub-state, and the host-lifecycle INPUT never touches the composer); `'backgrounded'` is the honest in-app token.

<!-- trace: source=docs/design/0.8.0-g6-omid-in-app-design.md (Decisions 1–4; condensed to the normative rulings) | gate=NO-GATE (G6 gate, pending; red contracts: test:g6-red, not in test:all) -->

### 1.18 Error codes

SHARC error codes occupy two namespaces:

- **21xx — creative-side errors**, raised by or attributed to the creative and its load path (including the Creative Markup renderer path, codes 2114–2120).
- **22xx — container errors**, raised by or attributed to the container.

Error codes travel in two wire positions: the `args.value.errorCode` of a `reject` message (scoped to the single message being rejected; the session continues), and the `args.errorCode` of a `fatalError` message or termination path (the session ends). The same code can appear in either position; the position, not the code, determines severity.

Semantics that implementations rely on:

- **A reject is not always a failure.** Code `2105` on a `requestNavigation` reject means "the container cannot handle navigation; the creative should open the URL itself" — a handoff, not an error.
- **Timeout-driven terminations** carry dedicated codes: `2212` (creative did not send `createSession` in time), `2208` (creative did not resolve `Container:init` in time), `2213` (creative did not resolve `Container:startCreative` in time). See §1.19 for the windows.
- **Validation rejects:** `2211` (message spec violation — malformed messages, disallowed URL schemes), `2203` (feature or intent not supported / policy-disallowed), `2204` (feature known but execution failed), `2205` (message channel overloaded).
- **Renderer-protocol codes** (Creative Markup variant): `2114` timeout, `2115` renderer failed, `2116` origin mismatch, `2117` protocol error, `2119` post failed, `2120` integrity failed. `2118` (unauthorized navigation) applies to both variants. Code `2115` is shared by two structured security-event variants (generic renderer failure and bridge-module load failure); the structured event's `type` field, not the code, is the triage discriminator.
- Codes `2121`/`2122` are **non-terminating diagnostics** carried only in structured security-event details — they never reach the fatal-error channel.

> RESERVED (within this section) — the citable code↔name registry table (21xx and 22xx, with the supersession diff against Legacy §Error Codes) lands in `docs/spec/registries.md` in a later slice. Until then, the table in api-reference.md §11 is the informative companion listing.

<!-- trace: source=api-reference.md §11 (semantics prose) + Legacy §Error Codes (supersession diff deferred) | gate=registry cross-check (test:spec-structure phase b); test:smoke (exercises 2212) -->

### 1.19 Timeouts

| Event | Default Timeout | On Expiry | Error Code |
|-------|-----------------|-----------|------------|
| `createSession` | 5 seconds | Terminate | 2212 |
| `Container:init` resolve | 2 seconds | Terminate | 2208 |
| `Container:startCreative` resolve | 2 seconds | Terminate | 2213 |
| Close sequence (after `Container:close`) | 2 seconds | Force terminate | — |
| Tracker firing (`reportInteraction`) | 5 seconds per URI | Mark failed, continue | — |
| Renderer iframe `load` (Markup variant) | 5 seconds | Terminate | 2114 |
| Renderer `:rendered`/`:failed` reply (Markup variant) | 2 seconds | Terminate | 2114 |

On expiry of the `createSession`, `init`, or `startCreative` windows the container MUST terminate with the listed error code. All timeouts have configurable defaults. SSAI/live environments may set the `createSession` timeout to 0. A container configured with `requireSharcInit: false` skips the `createSession` fatal timeout so non-SHARC creatives load to a stable container instance.

<!-- trace: source=api-reference.md §Appendix: Timeout Summary (+ §1 timeouts option, renderer rows from §10) | gate=covered by handshake/lifecycle suites (test:smoke; validator gate-U1/U2 windows) -->

### 1.20 Distribution and artifact identity

> RESERVED — extraction slice N (source: distribution-design.md (current-guidance parts) + adr/0001 (rationale, INFORMATIVE))

---

## Part 2 — Creative Wire Protocol

> **Placement note (editorial):** per the traceability skeleton, §§2.2–2.7 below are L2 rows (Creative API Specification). They are moved here from api-reference.md in this slice so the demoted source has a normative home, and they re-home to `docs/spec/creative-api.md` in the L2 extraction slice. Section numbering matches the skeleton's §B rows.

### 2.1 Scope; wire-format vs SDK separation

> RESERVED — extraction slice N (source: NEW-PROSE (framing) + creative-sources.md §Conventions)

### 2.2 Protocol layers and enforcement bounds

SHARC is a bidirectional, session-scoped message protocol between a **container** (the publisher's secure rendering environment — an iframe or WebView) and a **creative** (the ad markup running inside that container).

The container controls the environment. The creative requests actions. The container decides whether to honor them.

**Platform scope (v1):** Web iframes, iOS WKWebView, Android WebView.

#### Protocol enforcement bounds

The container enforces the following at the protocol layer:

- **Rate limiting:** incoming messages are limited to **50 per second** per session. Excess messages are dropped with a warning (`2205` is the error code for overload).
- **Pending response cap:** no more than **100 in-flight requests** are allowed simultaneously. New requests beyond that cap are rejected immediately.
- **Session ID validation:** `createSession` must supply a valid UUID v4. Malformed session IDs are rejected.
- **URL validation:** `requestNavigation` and `reportInteraction` tracker URIs accept only `https:` and `http:`. All other schemes are rejected or dropped.
- **Feature name validation:** `request[FeatureName]` validates the feature name format before constructing a message type string, preventing message-type injection.
- **Sandboxed iframe:** the container creates the creative iframe with `allow-scripts` only. `allow-same-origin` is intentionally absent — adding it alongside `allow-scripts` would allow the creative to remove its own sandbox entirely.

These bounds are restated and consolidated in the L1 security model (§1.11) when that section is extracted.

#### Message flow summary

```
Container                                           Creative
    │                                                   │
    │  [creates iframe/WebView, loads creative]          │
    │                                                   │
    │◄──────────── SHARC:Creative:createSession ─────────│
    │───────────── resolve (createSession) ─────────────►│
    │                                                   │
    │───────────── SHARC:Container:init ────────────────►│
    │◄──────────── resolve (init) ───────────────────────│
    │                                                   │
    │───────────── SHARC:Container:startCreative ───────►│
    │◄──────────── resolve (startCreative) ──────────────│
    │                                                   │
    │  [makes container visible] ─────────────────────── │
    │───────────── SHARC:Container:stateChange {active} ►│
    │                                                   │
    │◄──────────── [creative runs, sends requests] ──────│
    │                                                   │
    │───────────── SHARC:Container:close ───────────────►│
    │◄──────────── resolve (close) ──────────────────────│
    │  [container terminates the creative] ─────────── │
```

<!-- trace: source=api-reference.md §2 (Protocol Overview incl. Security Guarantees) | gate=test:protocol-router; test:smoke -->

### 2.3 Message data structure

All SHARC messages — primary and response — share a common structure.

#### Primary message

```typescript
interface Message {
  sessionId: string;         // UUID identifying this session
  messageId: number;         // Sender's sequence counter, starting at 0
  timestamp: number;         // Date.now() at send time
  type: string;              // Message type (e.g., "SHARC:Container:init")
  args?: any;                // Message-specific arguments
}
```

- `sessionId` — set by the creative when it generates the session ID in `createSession`. All messages in the session carry the same `sessionId`.
- `messageId` — each party maintains its own independent counter. Container and creative `messageId` values will diverge. First message is `0`.
- `timestamp` — milliseconds since epoch. Should be set as close to the triggering event as possible; do not assume it is exact.

**Example:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 3,
  "timestamp": 1748930400000,
  "type": "SHARC:Creative:requestPlacementChange",
  "args": {
    "changePlacement": {
      "containerDimensions": { "width": 320, "height": 480 },
      "inline": false
    }
  }
}
```

#### resolve message

Sent by the receiver to acknowledge successful processing of a primary message.

```typescript
interface ResolveMessage {
  sessionId: string;
  messageId: number;
  timestamp: number;
  type: "resolve";
  args: {
    messageId: number;  // messageId of the message being resolved
    value?: any;        // Optional response data
  };
}
```

#### reject message

Sent by the receiver when it cannot or will not process the message.

```typescript
interface RejectMessage {
  sessionId: string;
  messageId: number;
  timestamp: number;
  type: "reject";
  args: {
    messageId: number;  // messageId of the message being rejected
    value: {
      errorCode: number;    // See §1.18
      message?: string;     // Optional explanation
    };
  };
}
```

<!-- trace: source=api-reference.md §4 (Message Data Structure) | gate=test:smoke; test:protocol-router -->

### 2.4 Transport and session establishment

#### MessageChannel transport

SHARC uses `MessageChannel` as its primary transport. This creates a private, dedicated port pair between the container and the creative — no broadcasting to `window`, no collision risk from other iframes.

The handshake, stated at the wire level:

1. The container creates a `MessageChannel`, keeps `port1`, and loads the creative (iframe with `sandbox="allow-scripts"`; `allow-same-origin` intentionally omitted — see §2.2).
2. After the creative document's `load` event, the container posts a bootstrap message to the creative window: `{ type: 'SHARC:Container:handshake', version: '1.0' }`, with `targetOrigin: '*'` and `port2` in the transfer list. The wildcard target origin is intentional — the bootstrap carries no sensitive data, only the `MessagePort`.
3. The creative listens for a `message` event whose `data.type` is `'SHARC:Container:handshake'`, adopts `event.ports[0]`, starts it, and sends `createSession` over the port. A handshake message without a port is ignored.
4. All subsequent SHARC messages flow through the dedicated port. The initial `postMessage` is the only broadcast; all subsequent SHARC communication flows through the private channel.

#### Fallback: window.postMessage

If `MessageChannel` is unavailable (effectively zero real-world cases on supported platforms), the parties fall back to raw `postMessage` on `window`. The container must then filter incoming messages by origin (against the trusted creative origin) and by `sessionId` to handle multiple concurrent sessions.

#### Serialization

Both `MessageChannel` and `postMessage` use the browser's **Structured Clone** algorithm automatically. Do **not** call `JSON.stringify` or `JSON.parse`. Pass the message object directly.

#### SHARC:Creative:createSession

Sent when the creative is ready to begin SHARC communication. This is the first message in every session.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:**

```typescript
interface CreateSessionArgs {
  placementType?: "inline" | "interstitial";  // Default: "inline"
  version: string;                             // SHARC version of the creative SDK
}
```

- `placementType` — the creative's self-declared placement type. `"inline"` (default) means the ad is anchored in page content. `"interstitial"` means the ad overlays content. Omitting the field is equivalent to `"inline"`.
- `version` — the SHARC spec version the creative conforms to. Used by the container for version compatibility checks.

The creative generates a unique `sessionId` (UUID) and includes it in this message. All subsequent messages in the session use this same `sessionId`.

**resolve** — Container acknowledges and will proceed to send `Container:init`.

If `createSession` is not received within the timeout window (default **5 seconds**, see §1.19), the container MUST terminate with error `2212`.

**Example createSession message:**

```json
{
  "sessionId": "173378a4-b2e1-11e9-a2a3-2a2ae2dbcce4",
  "messageId": 0,
  "timestamp": 1748930400000,
  "type": "SHARC:Creative:createSession",
  "args": {
    "placementType": "inline"
  }
}
```

> RESERVED (within this section) — late-establishment recovery posture (Legacy §Establishing a New Session harvest; VAST/SSAI prose dropped — video is out of L2 scope) joins in a later slice.

<!-- trace: source=api-reference.md §3 (Transport Layer) + §8 (createSession) | gate=test:smoke; validator gate-U2 (`declared-sharc-no-handshake` 2212) -->

### 2.5 Container → creative messages

Messages sent from the container to the creative use the `SHARC:Container:*` namespace.

#### SHARC:Container:init

Sent after `createSession` is resolved. Provides the creative with all environment data needed to initialize.

**Direction:** Container → Creative
**Requires response:** Yes — `resolve` or `reject`

**Args:**

```typescript
interface ContainerInitArgs {
  environmentData: EnvironmentData;  // See §2.7
  supportedFeatures?: Feature[];     // Extensions this container supports
}
```

**resolve** — Creative acknowledges the initialization data. The container then sends `startCreative`.

**reject** — Creative cannot initialize (wrong version, incompatible dimensions, etc.):

```typescript
interface InitRejectArgs {
  errorCode: number;   // See §1.18
  reason?: string;     // Human-readable explanation
}
```

If the creative does not respond within the timeout window (default **2 seconds**), the container treats it as a fatal error (code `2208`) and terminates.

#### SHARC:Container:startCreative

Sent after `init` is resolved. Signals the creative to make itself visible and begin the ad experience.

**Direction:** Container → Creative
**Requires response:** Yes — `resolve` or `reject`

The creative should respond immediately. The container makes the iframe/WebView visible upon receiving `resolve`.

**resolve** — Creative is ready to display. No additional args required.

**reject** — Creative cannot start (`{ errorCode, reason? }`).

If the creative does not respond within the timeout window (default **2 seconds**), the container terminates with error `2213`.

#### SHARC:Container:stateChange

Sent whenever the container state changes (§1.8). The creative receives this message to update its behavior accordingly.

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface ContainerStateChangeArgs {
  containerState: "ready" | "active" | "passive" | "hidden" | "frozen";
}
```

The container MUST NOT send `stateChange` carrying `loading` or `terminated` — the creative cannot receive messages in those states.

#### SHARC:Container:placementChange

Sent when the container's placement properties change (usually in response to a `requestPlacementChange` from the creative).

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface ContainerPlacementChangeArgs {
  placementUpdate: CurrentPlacement;
  transition?: TransitionHint;       // Animation timing applied (if any)
  closeButtonPosition?: {            // Position of the container's close button
    position: string;                // e.g. "top-right"
    rect: { x: number; y: number; width: number; height: number };
  };
}

interface CurrentPlacement {
  containerDimensions: PlacementDimensions;
  inline: boolean;  // true = anchored in content; false = overlays content
  standardSize?: "default" | "max" | "min";
}

interface PlacementDimensions {
  x: number;       // DIPs
  y: number;       // DIPs
  width: number;   // DIPs
  height: number;  // DIPs
  anchor?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}
```

The `closeButtonPosition` field enables OMID `addFriendlyObstruction` registration — the creative (or OMID bridge) can report the close button's exact position to the verification vendor.

#### SHARC:Container:log

Informational message from the container. Primarily for debugging.

**Direction:** Container → Creative
**Requires response:** No

**Args:** `{ message: string }`

Messages prefixed with `"WARNING:"` indicate that the container has detected a spec deviation or performance issue in the creative's behavior.

#### SHARC:Container:placementConstraintsChange

Sent when placement constraints change mid-session (device rotation, browser resize, publisher policy update). Allows the creative to update its understanding of what the container allows.

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface PlacementConstraintsChangeArgs {
  constraints: {
    maxWidth: number | null;
    maxHeight: number | null;
    allowedIntents: string[];
    requireCloseRegion: boolean;
    allowOffscreen: boolean;
  };
  reason: "rotation" | "viewportResize" | "policyUpdate";
}
```

The container debounces resize/orientation events (200ms) to avoid flooding the creative during drag-resize.

| `reason` | Trigger | Creative should... |
|----------|---------|-------------------|
| `rotation` | Device orientation change | Re-check if current placement still fits |
| `viewportResize` | Browser/app window resize | Re-check if current placement still fits |
| `policyUpdate` | Publisher changed policy mid-session | Re-query constraints, may need to `collapse` |

#### SHARC:Container:placementTransitionEnd

Sent when a container-side placement animation completes (or immediately if animation is skipped). Every placement change request that includes a `transition` field produces exactly one `placementTransitionEnd` event — no hanging states.

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface PlacementTransitionEndArgs {
  finalDimensions: {
    width: number;   // DIPs
    height: number;  // DIPs
  };
}
```

There is no `placementTransitionStart` event — the creative already knows when a transition begins (it is the moment `requestPlacementChange()` resolves). A separate start event would be fragile: if the app backgrounds mid-animation, the creative would receive a start with no corresponding end, creating a hanging state.

#### SHARC:Container:effectiveVisibilityChange

The core effective-visibility channel. Sent when the container's single effective-visibility composer recomputes — the container-side surface every visibility consumer (MRAID, SafeFrame, OMID) reads instead of computing its own. The composer folds the raw visibility axes (in-page IntersectionObserver ratio, parent-page visibility, and the in-app host-exposure input) into one integer percent.

**Direction:** Container → Creative
**Requires response:** No (fire-and-forget; a rejected send is swallowed)

**Args:**

```typescript
interface EffectiveVisibilityChangeArgs {
  effectivePercent: number;              // Composed effective visibility, integer [0, 100]
  reason: string | null;                 // Raw SHARC EV reason token, or null when visible
  visibleRectangle: object | null;       // Visible rect of the creative, or null when not applicable
}
```

`reason` is the raw SHARC effective-visibility token — one of `'offscreen'` / `'backgrounded'` / `'frozen'` / `'notAttached'` — that explains a `0%` (or otherwise non-obvious) `effectivePercent`; it is `null` when the creative is visible. Creative-side listeners MUST receive this token unchanged (wire-honesty); mapping to the OM SDK `adView.reasons` vocabulary (`offscreen` → `clipped`, `notAttached` → `notFound`, `frozen`/`backgrounded` → `backgrounded`) happens only where the value crosses into OMID. Deduped on `(effectivePercent, reason)`; the last value is cached and replayed to late subscribers, and a preloaded creative receives the current value on activation. Not sent before a session exists (no creative listener).

#### SHARC:Container:audioVolumeChange

Notifies the creative of a host-reported audio-state change while the creative is running.

**Direction:** Container → Creative
**Requires response:** No

**Args:**

```typescript
interface AudioVolumeChangeArgs {
  volumePercentage: number;  // Integer, clamped to [0, 100]
  volume: number;            // volumePercentage / 100, in [0, 1]
  isMuted: boolean;          // Tracked independently — muting does NOT zero the volume
}
```

Sent live only in the `active`/`passive` states. In pre-interactive states (`loading`/`ready`/`hidden`) the values are buffered into `EnvironmentData` (`volumePercentage`, `volume`, `isMuted`) and delivered on the next activation; in `frozen`/`terminated` the input is dropped (JS is suspended or the protocol is gone).

#### SHARC:Container:fatalError

Sent when the container encounters an unrecoverable error. The container waits for `resolve` before terminating the creative.

**Direction:** Container → Creative
**Requires response:** `resolve` only (creative acknowledges, then the container terminates the creative)

**Args:** `{ errorCode: number, errorMessage?: string }`

The container terminates the creative after receiving `resolve`, or after a short timeout if `resolve` does not arrive.

#### SHARC:Container:close

Sent when the close sequence begins. Triggered by: user activating the close control, `Creative:requestClose`, or a platform-level close demand.

**Direction:** Container → Creative
**Requires response:** `resolve`

**Args:** None

**resolve** — Creative acknowledges close. The container may allow up to **2 seconds** for the creative to run a close sequence (fire trackers, play animation). The container will terminate the creative regardless after 2 seconds.

The close control (typically a 50×50 DIP button in the top-right corner) is **always** provided by the container. The creative may provide its own supplementary close UI, but the container's close control is mandatory.

<!-- trace: source=api-reference.md §7 (all subsections) + §Appendix: Message Type Reference (`audioVolumeChange` registry row; wire shape from src/sharc-protocol.js sendAudioVolumeChange — no §7 subsection existed in the source) | gate=test:container-state-establish-push; test:creative-state-replay; test:mraid-visibility-channel (wire leg); test:effective-visibility-wire-hop; audio: test:mraid-bridge-correctness-e2; per-message assertions across lifecycle suites -->

### 2.6 Creative → container messages

Messages sent from the creative to the container use the `SHARC:Creative:*` namespace. `createSession` is specified in §2.4 (session establishment).

#### SHARC:Creative:fatalError

Sent when the creative encounters an unrecoverable error. The container terminates the creative immediately.

**Direction:** Creative → Container
**Requires response:** No (container terminates the creative on receipt)

**Args:** `{ errorCode: number, errorMessage?: string }`

#### SHARC:Creative:getContainerState

Requests the current container state. The creative can call this at any time.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetContainerStateResolveValue {
  currentState: "ready" | "active" | "passive" | "hidden" | "frozen";
}
```

#### SHARC:Creative:getPlacementOptions

Requests current container placement information.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetPlacementOptionsResolveValue {
  currentPlacementOptions: {
    containerDimensions: PlacementDimensions;
    inline: boolean;
  };
}
```

The container always resolves, even if it cannot provide all values.

#### SHARC:Creative:log

Sends arbitrary log information to the container.

**Direction:** Creative → Container
**Requires response:** No

**Args:** `{ message: string }`

Messages prefixed with `"WARNING:"` signal that the creative has detected non-standard container behavior.

#### SHARC:Creative:reportInteraction

Delegates interaction tracking to the container. The container fires the provided URIs.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:**

```typescript
interface ReportInteractionArgs {
  trackingUris: string[];  // Array of https/http URIs to fire (max 20)
}
```

**Security:** The container validates all URIs before firing them. Only `https:` and `http:` schemes are permitted. URIs using any other scheme (`javascript:`, `data:`, `file:`, custom OS schemes, etc.) are silently dropped. The array is capped at **20 entries** — excess entries are ignored.

The container MUST:
- Fire all valid URIs in **parallel** (not serial)
- Use HTTP GET
- Follow redirects (up to 5 hops)
- Apply a 5-second timeout per URI
- Not retry on failure
- Resolve when all URIs have been fired or timed out

**resolve value:**

```typescript
interface ReportInteractionResolveValue {
  results: Array<{
    uri: string;
    success: boolean;
    statusCode?: number;
  }>;
}
```

Standard macros in URIs are replaced by the container. Unknown macros are left intact.

#### SHARC:Creative:requestNavigation

Signals that the creative wants to navigate the user to a URL. **The creative must always call this, even on web where the browser handles navigation.** This ensures the container always has a log of navigation events.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:**

```typescript
interface RequestNavigationArgs {
  url: string;                                              // Target URL or deep link
  target: "clickthrough" | "deeplink" | "store" | "custom"; // Navigation type
  customScheme?: string;                                     // Only when target === "custom"
}
```

**Security:** The container MUST validate `url` before acting on it. Only `https:` and `http:` schemes are permitted. Requests with any other scheme (`javascript:`, `data:`, `file:`, etc.) MUST be rejected with error code `2211` (`MESSAGE_SPEC_VIOLATION`), and the URL MUST NOT be opened.

**resolve** — Container handled the navigation (e.g., opened the OS browser on mobile). No further creative action needed.

**reject** — Either the container cannot handle navigation (e.g., web environment where the browser handles it), or the URL failed validation. The creative should inspect the error code:
- `2105` — Container can't handle navigation; creative should open the URL itself. This is a handoff, not an error.
- `2211` — URL failed validation; do not attempt to open it.

The reject does NOT always mean navigation was blocked — `2105` specifically means "creative, you handle it."

Container-side navigation-policy hooks are observation-only in 0.7.x; runtime allow/deny/rewrite policy is future design work (§1.10).

#### SHARC:Creative:requestPlacementChange

Requests that the container change its size or position. Uses an intent-based model where the creative declares what kind of change it wants.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:**

```typescript
interface RequestPlacementChangeArgs {
  intent: "resize" | "expand" | "fullscreen" | "collapse";
  targetDimensions?: {       // Required when intent === 'resize'
    width: number;           // DIPs
    height: number;          // DIPs
  };
  targetPosition?: {         // Optional offset for resize
    x: number;               // DIPs
    y: number;               // DIPs
  };
  closeRegion?: CloseRegion; // Positioning hint for the container's close button
  allowOffscreen?: boolean;  // Whether ad content may extend beyond viewport
  transition?: TransitionHint; // Animation preference (container may ignore)
}

interface CloseRegion {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right"
           | "top-center" | "center-left" | "center-right" | "bottom-center";
  size: number;              // DIPs, minimum 50
}

interface TransitionHint {
  duration: number;          // Milliseconds, capped at 500ms by container
  easing: string;            // CSS keyword: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out"
}
```

**Intent descriptions:**

| Intent | Behavior |
|--------|----------|
| `resize` | Change to specific dimensions. Requires `targetDimensions`. |
| `expand` | Expand to maximum available placement size (`maxExpandSize`). |
| `fullscreen` | Expand to fill the viewport. |
| `collapse` | Return placement to its default/original state (`initialDefaultSize`). Used after any non-default placement (resize, expand, or fullscreen). |

**Close region:** The `closeRegion` field is a **positioning hint**, not a rendering directive. The container always owns and renders the close button (a DOM element outside the sandbox). If the hinted position would place the close button offscreen, the container silently overrides to `top-right` — it does NOT reject the placement change.

**resolve value:**

```typescript
interface RequestPlacementChangeResolveValue {
  placementUpdate: CurrentPlacement;
  transition?: TransitionHint;       // Actual animation applied (if any)
  closeButtonPosition?: {            // Position of the container's close button
    position: string;                // e.g. "top-right"
    rect: { x: number; y: number; width: number; height: number };
  };
}
```

**reject** — The container may reject with:
- `2203` (`FEATURE_NOT_SUPPORTED`) — intent not allowed, dimensions exceed policy limits, or offscreen violation.
- `2211` (`MESSAGE_SPEC_VIOLATION`) — malformed request (e.g., missing required `closeRegion` when policy demands it, unknown intent value, non-string intent).

**Placement policy is container-local — never on the wire.** Publishers configure placement constraints on the container; the creative observes policy only through `getPlacementConstraints` (below), `placementConstraintsChange` events, and rejects. When no placement policy is configured, the validation pipeline is skipped entirely and placement requests are not policy-rejected. Creatives that do not handle rejection will see an unhandled promise rejection.

**Container-owned close button:** On `resize`, `expand`, and `fullscreen` intents, the container renders a 50 DIP close button as a DOM sibling to the iframe (outside the sandbox). On `collapse`, the close button is removed. For resize state, the close button triggers collapse; for expand/fullscreen, it triggers close. The close button is keyboard-focusable with Enter/Space handlers and has `role="button"` and `aria-label="Close ad"`.

**Animation:** When a `transition` hint is provided and the container supports animation (`com.iabtechlab.sharc.placement.animate` feature), the container animates to the target dimensions and fires `SHARC:Container:placementTransitionEnd` when the animation completes (or immediately if animation is skipped). Duration is capped at 500ms; easing is restricted to the five CSS keywords above.

#### SHARC:Creative:requestClose

Requests that the container close the ad. The container is not required to honor this.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:** None

**resolve** — Container will close. The container will send `Container:close`.

**reject** — Container cannot close at this time (e.g., a required display duration has not elapsed). The creative may choose to cease activity and emit a `Creative:log` message, but the container remains open.

#### SHARC:Creative:getPlacementConstraints

Queries the container's placement constraints before requesting a change. Follows the Permissions API query-before-request pattern.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:**

```typescript
interface GetPlacementConstraintsResolveValue {
  maxWidth: number | null;       // null = no limit
  maxHeight: number | null;      // null = no limit
  allowedIntents: string[];      // e.g. ["resize", "expand", "collapse"]
  requireCloseRegion: boolean;   // Whether closeRegion is required on resize
  allowOffscreen: boolean;       // Whether content may extend beyond viewport
}
```

Container-side custom validators are intentionally not exposed in the resolve value — they are opaque container-side logic that creatives should not inspect.

**Feature detection:** the message requires the `com.iabtechlab.sharc.placement.constraints` feature; check `supportedFeatures` from `init` (or `getFeatures`) before calling.

#### SHARC:Creative:getFeatures

Requests the list of extensions/features the container supports. This returns the same data as `supportedFeatures` in `Container:init` — useful for late-binding queries.

**Direction:** Creative → Container
**Requires response:** `resolve`

**Args:** None

**resolve value:** `{ features: Feature[] }`

Features do not change after `init` in v1.

#### SHARC:Creative:request[FeatureName]

Invokes a named extension feature. The message type is `SHARC:Creative:request` + the feature name (capitalized). Example: `SHARC:Creative:requestAudio`.

**Direction:** Creative → Container
**Requires response:** `resolve` or `reject`

**Args:** Defined by the feature specification.

**Security:** Feature names are validated against the required namespace format before the message type is constructed. Valid names must match the pattern `com.[domain].[...].featureName` using only alphanumerics, dots, and hyphens (e.g., `com.iabtechlab.sharc.audio`). Invalid names are rejected sender-side before any message is sent, preventing message-type injection attacks.

**resolve** — Feature executed. Response value defined by the feature.

**reject** — Feature is not supported or could not be executed. Error codes:
- `2203` — Feature unsupported by this container
- `2204` — Feature known but execution failed

<!-- trace: source=api-reference.md §8 (all subsections except createSession, carried in §2.4) | gate=test:placement; test:creative-protocol-placement-type; test:navigation-bridge; close-sequence assertions in lifecycle suites -->

### 2.7 EnvironmentData and dataspec

`EnvironmentData` is sent in `Container:init` and describes the publisher's environment.

```typescript
interface EnvironmentData {
  currentPlacement: ContainerPlacement;  // Current container dimensions
  dataspec: Dataspec;                     // AdCOM or other dataspec identifier
  data: Data;                            // Dataspec data (placement, ad, context)
  containerNavigation?: Navigation;       // Navigation capabilities
  currentState: ContainerState;          // State at init time (always "ready")
  version: string;                       // SHARC version, e.g., "1.0.0"
  isMuted?: boolean;                     // True if device is muted (if known)
  volume?: number;                       // 0.0–1.0 volume, or -1 if unknown
}
```

#### ContainerPlacement

```typescript
interface ContainerPlacement {
  initialDefaultSize: Dimensions;  // Container size when startCreative is called
  minDefaultSize: Dimensions;      // Minimum size in default placement
  maxDefaultSize: Dimensions;      // Maximum size in default placement
  maxExpandSize: Dimensions;       // Maximum size when expanded
  viewportSize: Dimensions;        // Viewport/screen dimensions
}

interface Dimensions {
  width: number;   // Density-independent pixels (DIPs)
  height: number;  // Density-independent pixels (DIPs)
}
```

If `minDefaultSize` equals `initialDefaultSize`, the placement cannot be made smaller. If `maxDefaultSize` equals `initialDefaultSize`, it cannot be made larger.

#### Dataspec

```typescript
interface Dataspec {
  model: string;  // Default: "AdCOM"
  ver: string;    // Default: "1.0"
}
```

#### Data (AdCOM default)

```typescript
interface Data {
  ad: AdcomAd;               // AdCOM Ad object
  placement: AdcomPlacement; // AdCOM Placement object
  context: AdcomContext;     // AdCOM Context (site/app, user, device, regs)
}
```

All `data` fields are optional — a container without AdCOM data omits them. The only truly required `EnvironmentData` fields are `currentPlacement`, `currentState`, and `version`.

#### Navigation

```typescript
interface Navigation {
  navigationPossible: boolean;  // Platform supports container-handled navigation
  navigationAllowed: boolean;   // Container will handle navigation (requires navigationPossible=true)
}
```

On web, the browser handles navigation — `navigationPossible` is typically `false`. The creative must always call `requestNavigation` regardless; the container will reject, which signals the creative to open the URL itself. This ensures the container always has a log of navigation events.

On iOS/Android WebView, `navigationPossible` is typically `true`. The container handles deep links and store URLs.

<!-- trace: source=api-reference.md §6 (EnvironmentData Structure) | gate=test:creative-protocol-placement-type; test:host-placement-integration -->

### 2.8–2.14 Remaining L2 rows

> RESERVED — later extraction slices, landing with the L2 Creative API Specification (skeleton §B): 2.8 state-delivery contract (state-delivery-contract.md §§1–12), 2.9 readiness semantics, 2.10 extension framework, 2.11 lifecycle event payloads, 2.12 OMID from inside the creative, 2.13 creative errors 21xx registry reference, 2.14 informative SDK annex.

---

## Appendix A — Message type reference

### Container → Creative

| Message | Response Required | When Sent |
|---------|------------------|-----------|
| `SHARC:Container:init` | resolve or reject | After createSession resolved |
| `SHARC:Container:startCreative` | resolve or reject | After init resolved |
| `SHARC:Container:stateChange` | None | On any state transition |
| `SHARC:Container:placementChange` | None | After placement changes |
| `SHARC:Container:placementConstraintsChange` | None | When placement constraints change (rotation, resize, policy update) |
| `SHARC:Container:placementTransitionEnd` | None | When placement animation completes or is skipped |
| `SHARC:Container:audioVolumeChange` | None | When audio state changes |
| `SHARC:Container:effectiveVisibilityChange` | None | When the effective-visibility composer recomputes |
| `SHARC:Container:log` | None | Debug/warning messages |
| `SHARC:Container:fatalError` | resolve | On unrecoverable container error |
| `SHARC:Container:close` | resolve | When close sequence begins |

### Creative → Container

| Message | Response Required | When Sent |
|---------|------------------|-----------|
| `SHARC:Creative:createSession` | resolve | As soon as creative is ready |
| `SHARC:Creative:fatalError` | None | On unrecoverable creative error |
| `SHARC:Creative:getContainerState` | resolve | Any time |
| `SHARC:Creative:getPlacementOptions` | resolve | Any time |
| `SHARC:Creative:getPlacementConstraints` | resolve | Any time after init (requires `com.iabtechlab.sharc.placement.constraints` feature) |
| `SHARC:Creative:log` | None | Debug/warning messages |
| `SHARC:Creative:reportInteraction` | resolve | On user interaction |
| `SHARC:Creative:requestNavigation` | resolve or reject | On clickthrough |
| `SHARC:Creative:requestPlacementChange` | resolve or reject | On resize/expand/collapse |
| `SHARC:Creative:requestClose` | resolve or reject | When creative wants to close |
| `SHARC:Creative:getFeatures` | resolve | Any time after init |
| `SHARC:Creative:request[FeatureName]` | resolve or reject | When using an extension |

This appendix is the interim home of the message-type registry; per skeleton §D it is re-homed to (or cited from) `docs/spec/registries.md` in a later slice.

<!-- trace: source=api-reference.md §Appendix: Message Type Reference | gate=registry cross-check (test:spec-structure phase b) -->

## Appendix B — Seam census

> RESERVED — extraction slice N (source: skeleton §F2 seam census, RATIFIED 2026-07-08; seed rows completed during extraction; the census is normative once the spec ships)
