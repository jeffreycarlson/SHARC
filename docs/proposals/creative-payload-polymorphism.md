# Proposal: Creative Payload Polymorphism (Creative Markup — Renderer Protocol)

**Author:** Jeffrey Carlson  
**Date:** 2026-04-27  
**Status:** Revised — incorporating architect, security, and industry review feedback  
**Related:** Issue #41, #23 (cross-origin renderer testing), #24 (SRI — deferred), #25 (canonical renderer — descoped)

---

## Summary

SHARC currently requires a `creativeUrl` — a URL the container loads into an iframe via `src`. This is **Creative URL**. This proposal adds:

- **Creative Markup** — `creativeHtml` + `creativeRendererUrl`: markup posted to a trusted cross-origin renderer page operated by the same entity that operates the container. The renderer writes the HTML into its own document, giving the creative a real origin.

A bare-`srcdoc` variant (markup without a renderer) was considered and rejected. It would give the creative a null origin and silently break measurement SDKs, `localStorage`, credentialed `fetch`, and CORS — exactly the things real-time-bidding-delivered creatives depend on. An advisory warning would not prevent the failure mode for the most common use case (bid markup containing third-party measurement). Pre-1.0, `creativeHtml` always requires `creativeRendererUrl`.

Both variants share the same SHARC bootstrap handshake and state machine. The creative SDK is unaware of which variant is in use.

### Direction of travel

Creative URL and Creative Markup are **both first-class and permanent**. They serve structurally distinct supply paths:

- **Creative URL** suits hosted-asset flows where the creative has a stable cacheable origin — direct-sold publisher inventory, signed-asset CDNs, FLEDGE/Protected Audience render URLs, third-party tag redirects, and creative servers.
- **Creative Markup** suits real-time bidding, where markup is composed at auction time from bid response payloads. The auction latency budget cannot absorb the redundant hop a URL would require, and render-time creative composition (macro substitution, dynamic insertion of trackers and click URLs, dynamic creative optimization) depends on having the markup in hand.

Neither variant is "ideal." Each is the right tool for its supply path. Inline markup is a structural property of how RTB works, not a transitional implementation detail — every demand-side platform would need to host every winning creative at a stable URL accessible to publishers for Creative URL to subsume Creative Markup, and that is not a change the industry is making.

The SHARC vocabulary stays cross-platform: "Creative URL" and "Creative Markup" are SHARC's terms, and they apply identically on web iframes, iOS WKWebView, and Android WebView. SHARC sits above delivery-specific conventions; bridges (MRAID, SafeFrame) handle compatibility with delivery-specific vocabulary.

---

## Problem

### Creative URL forces a URL where operators already have the markup

The canonical real-time bidding path returns ad markup inline. Container operators today must store that markup somewhere to produce a URL, or shim it with `blob:` / data URLs — neither is clean. `creativeHtml` should be a first-class constructor option.

### Bare srcdoc breaks silently

When `srcdoc` is used on a sandboxed iframe without `allow-same-origin`, the creative's origin is `null`. This breaks:
- `localStorage` / `sessionStorage` access
- `fetch` with `credentials: 'include'`
- CORS requests from the creative that expect a real origin
- Any measurement SDK that reads `document.domain` or `location.origin`

Almost every RTB-delivered creative contains third-party measurement (OMID, IAS, DV, Moat) that depends on a real origin. Allowing `creativeHtml` without a renderer would silently fail for the most common use case. Creative Markup — `creativeHtml` + `creativeRendererUrl` — is the only sound way to ship inline markup with predictable behavior.

---

## Renderer Ownership Model

**The container operator owns the renderer URL.** Whoever instantiates `new SHARCContainer(...)` is responsible for hosting and operating the renderer page that `creativeRendererUrl` points to. Container and renderer are part of the same supply chain.

The container operator is, in approximate order of impression volume on the open web:

| Operator | Hosts the renderer at |
|---|---|
| **Ad servers (GAM dominates)** | Ad server's CDN |
| **Header bidding wrappers (Prebid Universal Creative dominates)** | Wrapper's CDN |
| **Publisher O&O ad ops (direct-sold inventory)** | Publisher's CDN |
| **SSP-managed wrappers (OpenWrap, Magnite Demand Manager, etc.)** | SSP's CDN |

This mirrors how MRAID and SafeFrame work in practice — the SDK ships, but the runtime is hosted by ad servers and header bidders. There is no neutral third party magically hosting it. Notably, GAM's SafeFrame at `tpc.googlesyndication.com` is the de facto canonical-hosted runtime for the dominant share of web display impressions. There is no IAB-neutral SafeFrame runtime because GAM's market share made one unnecessary. SHARC follows the same pattern: the IAB ships the spec, operators host the runtime, and dominant operators (likely GAM and Prebid Universal Creative) become the de facto reference deployments.

### Stock implementation + operator tweaks

The SHARC repository ships a reference renderer at `examples/renderer/index.html`. Operators are expected to:

1. Take the reference implementation as the starting point.
2. Host it on their own infrastructure (their origin, their SLA).
3. Patch as needed — bug fixes, CSP tightening, custom measurement hooks, audit logging.

The protocol contract (`SHARC:Renderer:render` / `SHARC:Renderer:rendered`, message shape, timing) is invariant. The implementation is operator-tweakable.

### Renderer URL Stability

The construction-time origin check and post-load origin echo (see Security Model) together require that `creativeRendererUrl` and the renderer's actual served origin match exactly. This makes `creativeRendererUrl` a **stable contract** — operators cannot use 30x redirects to migrate from one renderer URL to another, because redirects defeat the cross-origin sandbox guarantee.

**Supported changes that don't require migration** (origin unchanged):
- DNS / CNAME / IP rotation
- TLS certificate rotation
- CDN backend changes behind the same public hostname
- Path changes — the protocol validates origin, not path

**Changes that require coordinated migration:**
- Hostname changes (subdomain, domain)
- Port changes

**Recommended pattern for renderer evolution without URL changes:** ship versioned paths under a stable origin (e.g. `https://renderer.operator.com/v1/`, `/v2/`). Origin stays stable, new container instances reference the new path, old instances continue using the old path until they're updated. This decouples renderer evolution from coordinated deployment and pairs naturally with the `rendererProtocolVersion` field (see Renderer Protocol Messages below).

**Operator commitment is comparable to existing precedent.** GAM has held `tpc.googlesyndication.com` as a stable SafeFrame runtime origin for over a decade across multiple SafeFrame and rendering-protocol versions. The SHARC origin-stability contract asks operators for the same long-lived commitment they already make for SafeFrame infrastructure today.

### Measurement vendor coordination

Operators deploying renderers should coordinate with measurement vendors (IAS, DV, Moat, OMID verification scripts) to allowlist the renderer origin. Many measurement vendors maintain per-origin allowlists for fraud detection and viewability scoring; a new renderer origin needs to be onboarded the same way any new ad-serving subdomain would be.

### IAB canonical renderer (#25) — descoped from this proposal

A canonical IAB-hosted renderer at `renderer.sharc.iabtechlab.com` is descoped from 0.7.0. The 0.7.0 protocol does **not** assume it exists, default to it, or depend on its operational availability.

A real but small constituency may benefit from a managed endpoint — long-tail publishers without sophisticated ad ops, certification labs, reference deployments for spec validation. The IAB Tech Lab may choose to operate one in the future as a deployment option. The 0.7.0 protocol is designed to make that addition non-breaking — no operator depends on its existence, no fallback logic assumes it.

### Out of scope (with future-work paths noted)

- **Native ad JSON payloads (e.g. OpenRTB Native 1.2)** — out of scope **for 0.7.0**, but two future paths bring native into SHARC without changing the protocol:
  - **HTML native assembly** — an upstream layer (publisher template, ad server, SSP) converts native JSON assets into HTML markup, which is then delivered to SHARC as Creative Markup. This already works today; no protocol change required. Operators choosing this path treat assembly as a pre-SHARC concern.
  - **Native rendering bridge** — analogous to the existing MRAID and SafeFrame bridges in `examples/bridges/`, a future SHARC bridge could accept native JSON, render it via a publisher-supplied template, and present the result through the SHARC Creative API. The bridge layer handles JSON-to-presentation; the SHARC container provides the secure runtime. This is future work, likely 0.8+ or 1.x, depending on demand.

  Either path lets native ads benefit from SHARC's security model without the 0.7.0 protocol taking on native-specific concerns.

- **Mediation chains (waterfall fallbacks)** — mostly mobile in-app. Mediation operates below SHARC; SHARC sees the winning creative markup, not the mediation logic.

- **Creative capability signaling** — how publishers/operators know to use Creative Markup vs Creative URL for a given creative is orthogonal to this proposal. Operators select the variant based on whether they have markup or a URL. Future IAB work (across delivery conventions) may add a SHARC capability signal — see Deferred section.

---

## Constructor Changes

### New Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `creativeHtml` | `string` | Conditional | Raw HTML markup for the creative. Mutually exclusive with `creativeUrl`. Requires `creativeRendererUrl`. |
| `creativeRendererUrl` | `string` | Conditional | HTTPS URL of an operator-hosted renderer page. Required when `creativeHtml` is provided. Must be cross-origin to the publisher page. |
| `onSecurityEvent` | `Function` | No | Callback fired with a structured event payload for security-relevant events (wrapper carve-out, origin mismatch, renderer protocol failure, etc.). Production observability hook — see Security Model § wrapper-cross-origin section for the event schema and reserved `type` values. Console output continues regardless of whether the callback is provided. |

### Validation Rules (enforced synchronously at construction)

Evaluated in order; first violation throws. This ordering surfaces "shape of the call is wrong" errors before "shape is right but URL is bad" errors, which matches how operators mentally debug:

1. Exactly one of `creativeUrl` or `creativeHtml` must be provided. Neither or both → `TypeError`.
2. `creativeHtml` requires `creativeRendererUrl`. Missing → `TypeError`.
3. `creativeRendererUrl` is only valid alongside `creativeHtml`. Pairing it with `creativeUrl` → `TypeError`.
4. `creativeRendererUrl` must parse via `new URL(...)` without throwing → `Error`.
5. `creativeRendererUrl` must use exactly the `https:` scheme. `http:`, `javascript:`, `data:`, `blob:`, `file:`, `about:`, and any other scheme → `Error`.
6. `creativeRendererUrl` must not contain userinfo. Non-empty `username` or `password` → `Error`.
7. `creativeRendererUrl` must be cross-origin (strict `URL.origin` equality) to both `window.location` and `window.top.location` when accessible. Same-origin → `Error`. When `window.top.location` access throws (cross-origin top frame), the wrapper context inherits the cross-origin guarantee and `window.location` comparison is sufficient.
8. `creativeHtml` size must not exceed 256 KiB at construction → `Error`. Larger payloads almost always indicate a bug; RTB markup norms are well below this.

`TypeError` is used for argument-shape violations (rules 1–3); `Error` is used for value violations (rules 4–8). This lets consumers catch shape errors specifically with `instanceof TypeError`.

### Updated `creativeUrl` instance property

`creativeUrl` remains on the instance for Creative URL. For Creative Markup, `creativeUrl` is `null`. The new `creativeSource` metadata property (see below) indicates the active variant.

---

## Load Path Matrix

| | Creative URL | Creative Markup |
|---|--------|--------|
| Constructor input | `creativeUrl` | `creativeHtml` + `creativeRendererUrl` |
| Iframe `src` / `srcdoc` | `src = creativeUrl` | `src = creativeRendererUrl` (with fragment nonce — see below) |
| Renderer protocol | None | `SHARC:Renderer:render` / `SHARC:Renderer:rendered` / `SHARC:Renderer:failed` |
| Creative origin | Creative server's origin | Renderer's origin (validated post-load) |
| Iframe sandbox | No `allow-same-origin` | `allow-same-origin` (safe — renderer is cross-origin) |
| Iframe `csp` attribute | Not set | `object-src 'none'; base-uri 'none'` baseline |
| Iframe `referrerpolicy` | Default | `no-referrer` |
| Injection support | Yes (via `useMarkupInjection` fetch path) | Yes (before posting to renderer) |
| `creativeSource` | `'url'` | `'html'` |
| `creativeRendered` | `false` | `true` |

---

## Creative Markup — `creativeHtml` + `creativeRendererUrl` (Renderer Protocol)

### Iframe sandbox

Creative Markup grants `allow-same-origin` on the renderer iframe. This is normally dangerous — and is intentionally absent today on Creative URL (`SEC-001` in `sharc-container.js`) — but is **safe in Creative Markup's specific configuration** because of how the browser assigns origins.

**The mechanism that makes it safe:**

| Iframe load | `allow-same-origin` absent | `allow-same-origin` present |
|---|---|---|
| `srcdoc` (no source URL) | Opaque origin (null) | **Inherits the publisher's origin** — sandbox escape: creative can read publisher cookies, modify publisher DOM, and remove the sandbox attribute itself. |
| `src=<same-origin URL>` | Opaque origin (null) | **Becomes the publisher's origin** — same escape as srcdoc. |
| `src=<javascript:>` | Opaque origin (null) | **Inherits the embedder's origin** — sandbox escape. |
| `src=<data:>` | Opaque origin (null) | Browser-dependent; treated as opaque in modern browsers but historically inconsistent. |
| `src=<blob:>` | Opaque origin (null) | **Inherits the origin of the page that created the blob**, which on a publisher page is the publisher's origin — sandbox escape. |
| `src=<cross-origin URL>` | Opaque origin (null) | **Becomes the URL's origin** (e.g. `renderer.publisher.com`). Cross-origin to the publisher. |

The browser only collapses to the publisher's origin when there is no other origin to assign — `srcdoc`, `about:blank`, same-origin URLs, `javascript:`, `data:`, and `blob:` URIs.

**Why Creative Markup's validation rules together create the safe configuration:**

- Rule 4 (parseable URL) → eliminates malformed inputs that bypass scheme checks
- Rule 5 (`https:` only) → eliminates `javascript:`, `data:`, `blob:`, `file:`, `about:`, and other origin-collapsing schemes
- Rule 6 (no userinfo) → eliminates phishing/log-poisoning vectors
- Rule 7 (cross-origin) → eliminates the same-origin URL escape, checked against both `window.location` and `window.top.location`

Remove any of these and `allow-same-origin` becomes unsafe. All are enforced synchronously at construction. There is no path where Creative Markup grants `allow-same-origin` to an iframe that could be same-origin to the publisher — at construction time. The post-load origin echo (see below) closes the redirect bypass.

Without `allow-same-origin`, the creative running in the renderer would have a null origin, defeating the entire point of Creative Markup (giving the creative a real origin so measurement SDKs work).

**Full sandbox:** `allow-scripts allow-same-origin allow-forms allow-popups`

### Iframe-level CSP and referrer policy

The container sets the following on the renderer iframe element:

| Attribute | Value | Purpose |
|---|---|---|
| `csp` | `object-src 'none'; base-uri 'none'` (baseline) | Defense-in-depth against `<base href>` redirection and plugin-content (`<object>`/`<embed>`) injection — both real attack vectors against arbitrary creative HTML. |
| `referrerpolicy` | `no-referrer` | Prevents the renderer's network requests from leaking the publisher page URL. |

`form-action <renderer-origin>` was considered for the baseline CSP but is **not enabled by default** because it would break legitimate lead-gen creatives, newsletter signup units, and other ads that POST forms to third-party endpoints. Operators who don't run lead-gen inventory may add it as an opt-in hardening; the proposal documents it but does not enforce it.

### Load sequence

```
1. Container generates a CSPRNG nonce and appends it to creativeRendererUrl as URL fragment:
   nonce = crypto.randomUUID()  // CSPRNG required — Math.random()-based UUID is unsafe
   srcUrl = creativeRendererUrl + '#sharcNonce=' + nonce
   (Fragments are not sent to servers and are opaque to other origins.)
2. Create iframe, set src = srcUrl with sandbox + csp + referrerpolicy
3. Wait for iframe 'load' event
   — Timeout: 5 seconds. On expiry: terminate with RENDERER_TIMEOUT.
   — Iframe-load 'error' events and never-resolving loads are caught by the same timeout.
4. Run injection on creativeHtml (if extensions registered)
5. container → renderer: postMessage(
     {
       type: 'SHARC:Renderer:render',
       creativeHtml,
       placementSessionId,
       sharcNonce,              // must match nonce in URL fragment
       sharcVersion,            // SHARC SDK version (semver)
       rendererProtocolVersion, // renderer protocol version (independent of sharcVersion)
       containerOrigin          // SHARC container's window.location.origin — for renderer-side validation
     },
     rendererOrigin)
6. Await renderer → container, one of:
   - { type: 'SHARC:Renderer:rendered', placementSessionId, rendererOrigin }
       — rendererOrigin must equal expected origin (defeats 30x redirect attack)
   - { type: 'SHARC:Renderer:failed', placementSessionId, reason }
       — fast-fail path; container terminates with RENDERER_FAILED
   — Timeout: 2 seconds. On expiry: terminate with RENDERER_TIMEOUT.
7. On receipt of valid 'rendered': proceed with standard SHARC bootstrap (200ms delay, initChannel)
```

The `rendererOrigin` for step 5 is derived from `creativeRendererUrl` at construction time (sans fragment). Total worst-case wall clock for Creative Markup load: 5s (iframe load) + 2s (rendered reply) + 200ms (bootstrap delay) + 5s (createSession) + 2s (init) = **~14.2s upper bound**. Happy path (cached renderer, fast network) is sub-second. Operators should expect Creative Markup to add ~100–500ms over Creative URL on warm caches.

### Renderer protocol messages

**Container → renderer** (via `iframe.contentWindow.postMessage`, `targetOrigin = rendererOrigin`):

```javascript
{
  type: 'SHARC:Renderer:render',
  creativeHtml: string,            // injected creative HTML (matches constructor option name)
  placementSessionId: string,      // for correlation; renderer echoes it back
  sharcNonce: string,              // CSPRNG UUID v4; must match URL fragment
  sharcVersion: string,            // e.g. "0.7.0" — for SHARC-version compatibility
  rendererProtocolVersion: string, // e.g. "1" — for renderer protocol compatibility
  containerOrigin: string          // SHARC container's window.location.origin — for renderer-side validation
}
```

**Renderer → container, success** (via `window.parent.postMessage`, `targetOrigin = containerOrigin`):

```javascript
{
  type: 'SHARC:Renderer:rendered',
  placementSessionId: string,
  rendererOrigin: string           // renderer's window.location.origin — container validates against expected
}
```

**Renderer → container, failure** (via `window.parent.postMessage`, `targetOrigin = containerOrigin`):

```javascript
{
  type: 'SHARC:Renderer:failed',
  placementSessionId: string,
  reason: string                   // 'unsupported_sharc_version' | 'unsupported_renderer_protocol' |
                                   // 'nonce_mismatch' | 'container_origin_mismatch' | 'render_failed' | ...
}
```

### Renderer implementation contract

The renderer page is responsible for the following protocol-level contract items. Operators forking the reference renderer must preserve these:

1. **Reading the nonce from URL fragment** at startup: `const nonce = new URLSearchParams(location.hash.slice(1)).get('sharcNonce')`. Reserve `sharcNonce` as a SHARC-protocol parameter; operator-tweaked renderers using fragment routing for other purposes must namespace their own params.
2. **Listening for `SHARC:Renderer:render` on `window`.**
3. **Validating the incoming message:**
   - `event.data.sharcNonce === nonce` (defeats neighbor-frame forgery)
   - `event.data.placementSessionId` is a non-empty string
   - `event.origin === event.data.containerOrigin` (defeats container-spoofing)
   - `event.source === window.parent` (defeats sibling-frame forgery)
   - `sharcVersion` and `rendererProtocolVersion` are versions the renderer supports
4. **On any validation failure**, send `SHARC:Renderer:failed` with the appropriate `reason`. Do not render.
5. **Clearing origin storage** before rendering, to prevent cross-impression amplification. This is a protocol contract item; operator-forked renderers MUST implement one of the following storage-isolation strategies:

   **Strategy A — `Clear-Site-Data` HTTP header (recommended baseline).** Serve the renderer page with `Clear-Site-Data: "storage"` on each response. This is the spec-blessed mechanism (W3C Clear-Site-Data) and clears localStorage, sessionStorage, IndexedDB, Cache API, and the cookie store from the server side, without JS limitations.

   **Browser support reality:** Chromium and Firefox support the `"storage"` directive fully. **Safari shipped Clear-Site-Data only in 16.4 (March 2023) and its directive coverage lags** — Safari supports `"cookies"` but the `"storage"` directive (which covers localStorage, IndexedDB, etc.) has incomplete coverage across Safari versions still in active use on iOS. Operators with significant Safari traffic should pair Strategy A with Strategy B (JS-side fallback) rather than relying on Clear-Site-Data alone.

   **Strategy B — JS-side clearing (fallback for older browsers; required when Strategy A coverage is incomplete).** Clear what JS can reach: `localStorage.clear()`, `sessionStorage.clear()`, `indexedDB.databases()` enumeration + `indexedDB.deleteDatabase()` for each, `caches.keys()` + `caches.delete()` for each, and best-effort `document.cookie` clearing for non-HttpOnly cookies.

   **Strategy B limitations — operators must understand:**
   - **HttpOnly cookies cannot be cleared from JS.** If the renderer origin sets HttpOnly cookies (e.g. for measurement vendor session correlation), Strategy B alone leaves residual state.
   - **Cookies with non-default path/domain variants require explicit enumeration.** `document.cookie` only exposes cookies in scope for the current document; cookies set with subpaths or subdomains may not be visible to clear.
   - **`indexedDB.databases()` was added to Safari in iOS 14 (Sep 2020).** Older Safari versions still in use cannot enumerate IndexedDB; on those browsers Strategy B cannot clear unknown databases. Operators must either accept the gap, hard-code expected database names, or rely on Strategy A's server-side clearing where available.
   - **No equivalent to `Clear-Site-Data` for client-state APIs.** Storage Access API state, Permissions API state, IndexedDB transaction queues, and Service Worker registrations cannot be reliably reset from JS without a page reload.

   Strategy B is best-effort; it is not a replacement for Strategy A when Strategy A is supported.

   **Strategy C — ephemeral or per-tenant renderer origins (strongest isolation).** For operators with strict cross-advertiser isolation requirements (e.g. high-value direct-sold inventory, regulated verticals, Safari-heavy traffic), provision a fresh renderer origin per session, per tenant, or per advertiser. Per-origin storage is naturally isolated by the browser; no clearing required. Operational cost is higher (DNS, certs, CDN config per tenant), but the isolation guarantee is structural rather than behavioral and works identically across all browsers.

   **Recommendation:** the reference renderer ships with Strategy A configured (`Clear-Site-Data` header on the served HTML page) plus Strategy B as a JS-side fallback. Operators serving significant Safari traffic, or operators with cross-advertiser isolation requirements that storage clearing cannot satisfy reliably, should adopt Strategy C.
6. **Writing the received HTML into the document** — recommended technique: `document.open() / document.write(creativeHtml) / document.close()`. This replaces the renderer document while keeping `iframe.contentWindow` intact, so the subsequent SHARC port handshake reaches the creative SDK running in the renderer's window.
7. **Sending `SHARC:Renderer:rendered` to `window.parent`** after `DOMContentLoaded` fires on the written document, including the renderer's actual `window.location.origin` as the `rendererOrigin` field for container-side redirect detection.
8. **Serving the renderer page with HTTP response CSP headers** matching the iframe `csp` baseline:
   ```
   Content-Security-Policy: object-src 'none'; base-uri 'none'
   ```
   This is the **portable enforcement layer** — the iframe `csp` attribute is Chromium-only (Firefox and Safari do not honor it). Without HTTP response CSP, Firefox and Safari sessions are unprotected from `<base href>` injection and plugin-content vectors. Operators forking the renderer MUST configure their hosting infrastructure (CDN, edge worker, origin response headers) to emit this CSP. Omitting it means the security model only works in Chromium — not a supported deployment for the SHARC security guarantee.

The reference renderer ships in `examples/renderer/`. Operators are expected to fork it.

**Timing guidance:** The `DOMContentLoaded` listener must be registered on `window` *before* calling `document.open()`. After `document.open()`, the existing script context is replaced and listeners registered later are gone. The reason `rendered` must wait for `DOMContentLoaded`: it ensures the creative SDK (loaded as a `<script>` inside the creative HTML) has registered its own `message` listener before the container sends the bootstrap port handshake. Sending `rendered` too early creates a race.

**CSP guidance — what the renderer's HTTP CSP must permit, in addition to the contract baseline above:** Operators must ensure the response CSP permits `document.write` of arbitrary HTML — specifically avoid `require-trusted-types-for 'script'` in strict mode without an exception for the renderer, and ensure `script-src` permits inline and remote scripts found in real RTB markup. The contract baseline (`object-src 'none'; base-uri 'none'`) does not interfere with these requirements; both can coexist in the same response header.

**`document.write` forward compatibility:** Browser vendors have been incrementally restricting `document.write` (deprecation in same-origin third-party contexts, Trusted Types enforcement). The renderer protocol intentionally constrains *behavior* (write the creative HTML into the document, preserve `contentWindow`) rather than *technique*. If browsers further restrict `document.write` for cross-origin iframes, operators may switch the implementation to `DOMParser.parseFromString(creativeHtml, 'text/html')` + `document.replaceChildren(parsed.documentElement)` — preserving script execution semantics requires re-creating `<script>` elements, but the wire protocol does not change.

**Operational constraints — operators MUST also:**
- Run minimum logic in the renderer page itself. Any first-party scripts loaded into the renderer (analytics, RUM, error reporting) execute alongside adversarial creative HTML in the same origin and should be treated as exposed to creative manipulation.
- Not log `location.href` or `location.hash` from the renderer page (the nonce is sensitive — sending it to a server log or third-party analytics endpoint defeats the fragment-nonce defense).

### Container-side message validation

The container **silently ignores** `SHARC:Renderer:rendered` and `SHARC:Renderer:failed` messages that fail any of these envelope checks (any frame on the page can postMessage; mismatches are noise, not errors):
- `event.source === iframe.contentWindow`
- `event.origin === rendererOrigin` (the construction-time-derived origin)
- `event.data.placementSessionId === this.placementSessionId`

Once envelope checks pass, the message is accepted and the container validates payload shape. **Payload-shape failures terminate** with `RENDERER_PROTOCOL_ERROR`:
- `rendered` reply missing `rendererOrigin` field, or `rendererOrigin` is not a string → terminate
- `failed` reply missing `reason` field → terminate
- Any required field has wrong type → terminate

For `rendered` specifically, the container additionally verifies:
- `event.data.rendererOrigin === rendererOrigin` (construction-time expected origin)

If `event.data.rendererOrigin` does not match (because the renderer was redirected to a different origin), the container terminates with `RENDERER_ORIGIN_MISMATCH` and emits a `console.error`:

```
[SHARCContainer] Renderer origin mismatch — refusing to load.
  Expected origin: https://renderer.operator.com (from creativeRendererUrl)
  Actual origin:   https://cdn.example.com (after redirect)
Redirects on creativeRendererUrl are not permitted — they can collapse the
cross-origin sandbox guarantee. Configure creativeRendererUrl to the
post-redirect canonical URL.
See: docs/architecture-design.md#renderer-protocol
```

### `close()` mid-render cleanup

If `container.close()` is called between iframe `load` and receipt of `rendered`/`failed`, the container:
- Cancels the rendered/failed reply timeout
- Removes the renderer message listener
- Removes the iframe from the DOM (terminating the renderer's script execution)
- Restores the placement element to its pre-load state (per the placement-stamping cleanup contract)

Late `rendered` or `failed` messages arriving after close are ignored — the message listener has been removed, and even if a stray listener remained, `placementSessionId` no longer matches (close clears the session).

### State machine impact

Creative Markup introduces no new states. The renderer protocol is a sub-phase of `loading`, before MessageChannel handshake. The `loading → ready` transition still corresponds to `Container:init` resolving over MessageChannel, exactly as in Creative URL. From the state machine's perspective, Creative Markup looks identical to a slow-to-load Creative URL. The set of *terminate-from-loading* edges grows by one (`RENDERER_TIMEOUT` / `RENDERER_FAILED` / `RENDERER_ORIGIN_MISMATCH`); the state graph itself is unchanged.

---

## Injection Across Variants

`useMarkupInjection` semantics per variant:

| Variant | Injection behavior |
|------|--------------------|
| Creative URL (`creativeUrl`) | Unchanged — fetch URL, pipe through injectors, load via `srcdoc`. Falls back to direct `src` on fetch failure. |
| Creative Markup (`creativeHtml` + `creativeRendererUrl`) | No fetch. Pipe `creativeHtml` through injectors synchronously. Injected HTML is what gets posted to the renderer in step 5. `useMarkupInjection` flag is irrelevant — injection always runs if injectors are registered. |

For Creative Markup, injection runs regardless of `useMarkupInjection`. The flag only controls whether Creative URL performs a fetch.

---

## Metadata and Observability

### New instance properties

| Property | Type | Description |
|----------|------|-------------|
| `creativeSource` | `'url' \| 'html'` | `'url'` for Creative URL, `'html'` for Creative Markup. |
| `creativeInjected` | `boolean` | `true` if injection ran and at least one injector returned a non-empty modified string. |
| `creativeRendered` | `boolean` | `true` if Creative Markup renderer protocol was used. |

### DOM stamping additions

Add to the **creative iframe** stamping (alongside existing `class="sharc-creative"` and `data-sharc-placement-session-id`):

| Attribute | Value | Notes |
|-----------|-------|-------|
| `data-sharc-creative-source` | `'url'` \| `'html'` | Reflects `creativeSource`. Always present. |
| `data-sharc-creative-rendered` | `'true'` \| `'false'` | Always present, matching `data-sharc-creative-injected` precedent from the placement-stamping proposal. Enables symmetric devtools queries (e.g. `[data-sharc-creative-rendered="false"]` selects Creative URL instances explicitly). |

`data-sharc-creative-injected` (always present `'true'`/`'false'`) is set by the placement-stamping work and remains unchanged by this proposal.

### Log tagging

All `[SHARCContainer]` console output already prefixes the `placementSessionId`. No additional tagging change required for this proposal — that is covered by issue #42.

---

## Security Model

The core SHARC security guarantee — **the creative cannot reach the publisher's origin** — holds across both variants. Creative URL achieves this by withholding `allow-same-origin`. Creative Markup achieves it by granting `allow-same-origin` only when **all** of the following hold:

- Construction-time guards prove the iframe will be configured with a cross-origin HTTPS URL with no userinfo (validation rules 4–7).
- Post-load origin echo proves the iframe actually loaded at the expected origin (defeats 30x redirect attacks).
- Renderer-side message validation rejects forged render requests from neighbor frames (URL fragment nonce + parent-origin check).
- Iframe-level CSP closes plugin-content and `<base href>` injection vectors.

This is a stricter trust model than today's MRAID/SafeFrame deployment, where the SDK runtime runs in the publisher's own page context. Compromised SHARC renderer affects only the renderer's origin; the publisher remains isolated. Compromised MRAID SDK or SafeFrame host runtime exposes the publisher's origin directly.

| Concern | Creative URL | Creative Markup |
|---------|--------|--------|
| Creative origin isolation | Cross-origin src | Renderer origin (cross-origin to publisher) |
| `allow-same-origin` | Absent | Present (safe — renderer is cross-origin, redirect-validated) |
| Creative can access publisher DOM | No | No |
| Creative can access renderer's storage | N/A | Yes — this is the point |
| Publisher can read creative content | No | No |
| `creativeRendererUrl` must be HTTPS | N/A | Enforced at construction |
| `creativeRendererUrl` must be cross-origin | N/A | Enforced at construction (vs. `window.location` and `window.top.location`) |
| Plugin content (`<object>`, `<embed>`) | N/A | Blocked by iframe `csp` (`object-src 'none'`) |
| `<base href>` injection | N/A | Blocked by iframe `csp` (`base-uri 'none'`) |
| Form-based exfiltration | Not blocked by default | Not blocked by default; opt-in `form-action` available |
| Referrer leak to renderer network | N/A | Blocked (`referrerpolicy="no-referrer"`) |
| 30x redirect to same-origin | N/A | Detected and terminated (post-load origin echo) |
| Neighbor-frame forgery | N/A | Defeated (URL fragment nonce + parent-origin check) |

### Threat: malicious renderer

The renderer is operator-controlled and part of the same supply chain as the container. If the renderer origin is compromised, the creative runs in that compromised origin. This is equivalent to the operator's own supply chain risk, not a new SHARC-introduced attack surface — and it is strictly less severe than the equivalent MRAID/SafeFrame failure mode, where a compromised SDK host runtime exposes the publisher's origin directly.

The protocol's job is to provide *isolation between creative and publisher*, not isolation between operator and operator's own renderer. Container operators that fork the reference renderer accept responsibility for its security posture — same as forking and operating the container itself.

### Threat: untrusted creative HTML

Operators stitching markup from many DSPs cannot reliably "verify" bid sources beyond TLS and contract. Creative Markup gives the markup a real origin (the renderer's), which may increase capability versus null-origin srcdoc (e.g., localStorage access). The iframe-level CSP baseline (`object-src 'none'; base-uri 'none'`) provides defense-in-depth against the highest-impact injection patterns in adversarial markup, even when the markup is hostile.

### Threat: cross-impression amplification via shared renderer storage

Creative Markup gives creatives served by the same renderer access to shared origin storage — localStorage, sessionStorage, IndexedDB, Cache API, and non-HttpOnly cookies. An attacker briefly controlling a creative could plant persistent payloads visible to future creatives via the same renderer.

The renderer implementation contract requires one of three isolation strategies (A: `Clear-Site-Data` HTTP header, B: JS-side clearing, C: ephemeral/per-tenant origins) — see the Renderer Implementation Contract section for details. **Strategy A is the recommended baseline** because server-side `Clear-Site-Data: "storage"` covers all storage types reliably, including HttpOnly cookies that JS cannot reach. **Strategy C provides the strongest guarantee** for operators with strict cross-advertiser isolation requirements, because per-origin browser separation is structural rather than behavioral.

**Limitations of JS-side clearing (Strategy B alone):** HttpOnly cookies cannot be cleared from JS — if the renderer origin sets HttpOnly cookies (e.g. for measurement vendor session correlation), Strategy B alone leaves residual state. Operators using Strategy B should ensure the renderer origin does not set HttpOnly cookies, or pair Strategy B with Strategy A.

**Tension with measurement vendors:** measurement SDKs (OMID, IAS, DV, Moat) historically used persistent storage in the creative iframe for frequency caps, viewability accumulators, and fingerprint material. SHARC's per-render storage clearing breaks any pattern that depends on cross-impression state in the renderer's origin. Modern measurement architectures avoid this by using first-party verification endpoints (server-side state keyed by impression ID) rather than creative-iframe storage — that pattern is unaffected by SHARC's storage clearing. Measurement vendors that still rely on iframe storage should migrate to first-party verification, or operators serving such inventory should adopt Strategy C (per-tenant origins) to give the measurement vendor a stable storage scope per advertiser.

### Threat: SHARC container in a wrapper iframe cross-origin to publisher top

When SHARC runs inside a wrapper iframe at origin X, with the publisher top frame at origin Y where X ≠ Y, validation rule 7 cannot read `window.top.location` (cross-origin throws). The carve-out skips the top-frame check and validates only against `window.location` (the wrapper's origin X).

The browser still enforces the wrapper-iframe boundary: a renderer iframe inside the SHARC container cannot directly access the publisher's DOM regardless of its origin. **However**, if `creativeRendererUrl` happens to share origin with the publisher top (Y), the renderer's origin storage and cookies become accessible to the creative — origin-keyed storage (localStorage, IndexedDB, cookies, BroadcastChannel) does not respect the frame-tree barrier the way DOM access does.

**Unsupported deployment configuration:** SHARC running inside a wrapper iframe cross-origin to the publisher top, with a `creativeRendererUrl` that may share origin with any publisher top the wrapper is embedded into, is an **unsupported deployment**. The wrapper-context fallback in validation rule 7 cannot detect this case. Operators in this configuration MUST guarantee `creativeRendererUrl` is not same-origin with any publisher top their wrapper is embedded into. If they cannot make that guarantee, they MUST NOT deploy SHARC in this configuration.

**Runtime detection — two-channel signal:** The container detects the wrapper-cross-origin-to-top condition at construction by attempting `window.top.location.origin` access inside a try/catch. When access throws (cross-origin top frame), the container emits the carve-out signal on **both a developer channel (`console.warn`) and a structured-event channel (`onSecurityEvent` callback)**. Production observability platforms hook the structured channel; developers see the console message in dev/staging.

**Developer channel — `console.warn` (one-time per container instance):**

```
[SHARCContainer] Validation rule 7 carve-out applied — cross-origin top
frame detected; cannot verify creativeRendererUrl is cross-origin to the
publisher's top-level page. This is an unsupported deployment unless the
operator has independently guaranteed creativeRendererUrl is not
same-origin with any publisher top this wrapper is embedded into.
See: docs/architecture-design.md#wrapper-cross-origin-deployment
```

**Structured-event channel — `onSecurityEvent` constructor callback:**

```javascript
new SHARCContainer({
  // ...other options...
  onSecurityEvent: (event) => {
    // pipe to observability stack (Datadog, Sentry, custom)
    monitoring.recordEvent(event);
  }
});
```

The callback receives a structured payload:

```javascript
{
  type: 'wrapper_top_frame_inaccessible',  // event type identifier
  severity: 'warning',                      // 'warning' | 'error'
  timestamp: 1714291200000,                 // Date.now()
  placementSessionId: 'a1b2c3d4-...',       // for correlation
  message: 'Validation rule 7 carve-out applied — cross-origin top frame detected',
  details: {
    wrapperOrigin: 'https://wrapper.example.com',         // window.location.origin
    creativeRendererUrl: 'https://renderer.example.com/'  // configured renderer URL
    // publisher top origin intentionally omitted — we cannot read it
  }
}
```

The `onSecurityEvent` callback is non-terminating; the container does not block construction (the carve-out is sometimes legitimate, e.g. SHARC running in a known-good wrapper context the operator controls). Operators that treat the event as a hard error in their own observability layer can fail-closed in their own logic; the protocol does not impose that decision.

**Event types reserved for `onSecurityEvent`:**

| `type` | Severity | When fired | Terminating? |
|---|---|---|---|
| `wrapper_top_frame_inaccessible` | `warning` | Construction; `window.top.location` throws | No |
| `renderer_origin_mismatch` | `error` | Post-load origin echo doesn't match construction-time origin | Yes — fires before terminate |
| `renderer_protocol_error` | `error` | Renderer sends malformed reply or wrong-version message | Yes — fires before terminate |
| `renderer_failed` | `error` | Renderer sends explicit `SHARC:Renderer:failed` reply | Yes — fires before terminate |

For terminating events, `onSecurityEvent` fires **before** `onError` so observability tooling sees the structured security context before the generic error callback runs. Operators that only want terminating events can filter on `severity: 'error'`; operators that want full security telemetry hook both severities.

The callback is optional — operators that don't pass it get console-only signaling, identical to the prior behavior.

Practically, the unsupported-deployment constraint is satisfied by:
- Choosing a renderer origin that is clearly distinct from any publisher (e.g. `renderer.<wrapper-tech-vendor>.com`, not a generic CDN that other entities also use)
- Not running SHARC inside cross-origin wrappers if the wrapper is rented to many small publishers and the renderer URL is shared across all of them

The 0.7.0 protocol cannot enforce this from inside the wrapper context; the responsibility sits with the operator deploying the wrapper.

### CSP enforcement: HTTP response is the portable layer; iframe `csp` is defense-in-depth

The iframe-level `csp` attribute (CSP Embedded Enforcement / CSPEE) is **Chromium-only enforcement**. Firefox and Safari currently do not honor it. Relying on iframe `csp` alone leaves Firefox and Safari sessions unprotected from the threats the CSP baseline addresses (`<base href>` injection, plugin content via `<object>`/`<embed>`, etc.).

**The HTTP-response CSP served by the renderer is the portable enforcement layer.** The renderer implementation contract requires the renderer page's HTTP response to include CSP headers matching the iframe `csp` baseline:

```
Content-Security-Policy: object-src 'none'; base-uri 'none'
```

This is enforced by all major browsers (Chromium, Firefox, Safari, mobile WebKit) consistently. Operators forking the reference renderer MUST configure their hosting infrastructure (CDN, edge worker, origin response headers) to emit this CSP on the renderer page response.

**Iframe `csp` is layered on top as defense-in-depth where supported.** When both layers are present (HTTP response CSP + iframe `csp`), the effective policy is the intersection — both must permit a resource for it to load. Chromium enforces both; Firefox and Safari enforce only the HTTP response CSP. The HTTP layer is what makes the security model portable; the iframe layer is a Chromium-specific belt on the suspenders.

Operators that omit the HTTP response CSP get a security model that only works in Chromium. That is **not** a supported deployment for the SHARC security guarantee.

### Threat: click-jacking / tap-jacking

Not new to Creative Markup, but the increased capability via `allow-same-origin` makes timing attacks easier (the creative can read its own renderer's state). Mitigation is publisher-side (iframe positioning, transparency) and outside SHARC's protocol scope. Documented for completeness.

---

## Timeouts

| Event | Timeout | On expiry |
|-------|---------|-----------|
| Iframe `load` event (Creative Markup) | 5 seconds | Terminate with `RENDERER_TIMEOUT` |
| `SHARC:Renderer:rendered` reply | 2 seconds | Terminate with `RENDERER_TIMEOUT` |
| `createSession` (both variants) | 5 seconds (unchanged) | Terminate with `2212` |
| `Container:init` resolve | 2 seconds (unchanged) | Terminate with `2208` |
| `Container:startCreative` resolve | 2 seconds (unchanged) | Terminate with `2213` |

The renderer's `rendered` reply is tightened from the originally-proposed 5s to 2s. A `document.write` of inline HTML completes in milliseconds on any non-pathological renderer; 5s was an order of magnitude too generous. The 5s budget is preserved for the iframe `load` event, which depends on network conditions.

---

## Error Codes

New codes added to the SHARC error code table (additive, pre-1.0 — not breaking):

| Code | Constant | Meaning |
|------|---------|---------|
| `2114` | `RENDERER_TIMEOUT` | Iframe load or `rendered` reply did not arrive within budget |
| `2115` | `RENDERER_FAILED` | Renderer sent explicit `SHARC:Renderer:failed` reply |
| `2116` | `RENDERER_ORIGIN_MISMATCH` | Post-load origin echo does not match construction-time origin (redirect detected) |
| `2117` | `RENDERER_PROTOCOL_ERROR` | Malformed renderer message, missing nonce, version mismatch, parent-origin mismatch |

Code numbers tentative — final assignment during implementation, fitting the existing `21xx` container-error range.

---

## Deferred

### SRI Integrity Verification (#24)

Issue #24 proposes SRI-style hash verification for `creativeRendererUrl`. This is explicitly deferred to a future minor version. The constructor option name is reserved: `creativeRendererIntegrity` (mirrors the HTML `integrity` attribute convention). Browser APIs do not currently support SRI on iframe `src`; the deferred work needs to specify what `creativeRendererIntegrity` actually does (likely a post-load probe message exchanging known asset hashes). No implementation in 0.7.0.

### Creative capability signaling

How publishers/operators know to use Creative Markup vs Creative URL for a given creative is not addressed in this proposal — the operator selects the variant based on whether they have markup or a URL, which is orthogonal to creative API capability. Future IAB Tech Lab work, in coordination with delivery-convention working groups (OpenRTB / AdCOM, Prebid, etc.), may add a SHARC capability signal to bid responses or ad server tags. Until then, MRAID/SafeFrame compatibility bridges (existing in `examples/bridges/`) handle the API-shape question separately from the load-variant question.

### Native ad support (rendering bridge or HTML native assembly)

Native ad JSON payloads (e.g. OpenRTB Native 1.2) are out of scope for 0.7.0 but explicitly noted as future work. Two paths bring native into SHARC without changing the 0.7.0 protocol:

1. **HTML native assembly** — upstream layer converts native JSON to HTML, delivered to SHARC as Creative Markup. Works today.
2. **Native rendering bridge** — analogous to the existing MRAID/SafeFrame bridges, accepts native JSON and renders via a publisher-supplied template through the SHARC Creative API. Likely 0.8+ or 1.x scope, demand-driven.

The Renderer Ownership Model and Creative Markup variant accommodate both paths without protocol changes. Native is a future-work track, not a permanent exclusion.

---

## Open Questions

| # | Question | Resolution |
|---|----------|------------|
| OQ-1 | Should `creativeHtml` be exposed as an instance property? | **No.** It can be large (full ad markup). `creativeSource` is sufficient for diagnostics. |
| OQ-2 | Should Creative URL's `useMarkupInjection` path be deprecated now that Creative Markup exists? | **Not yet.** Different semantics (fetched, falls back to src). Keep for 0.7.0; revisit before 1.0. |
| OQ-3 | Does the renderer protocol need a version field? | **Yes — both `sharcVersion` and `rendererProtocolVersion`.** SHARC version covers SDK compatibility; renderer protocol version evolves independently. Renderer rejects unsupported versions via `SHARC:Renderer:failed` with `reason: 'unsupported_*'`. |
| OQ-4 | Should the container accept `creativeRendererUrl` with a path that includes the creative as a query param? | **Out of scope.** The renderer receives HTML via postMessage, not via URL. How the renderer is parameterized is the operator's concern. |
| OQ-5 | What is the renderer timeout error code? | **Add `RENDERER_TIMEOUT`, `RENDERER_FAILED`, `RENDERER_ORIGIN_MISMATCH`, `RENDERER_PROTOCOL_ERROR` in 0.7.0.** Pre-1.0, additive error codes are not breaking; deferring would create production-debug debt. |
| OQ-6 | Should `form-action` be in the iframe CSP baseline? | **No.** Would break legitimate lead-gen creatives, newsletter signup units. Document as opt-in operator hardening for inventory that doesn't include forms. |
| OQ-7 | Should the dev-origin guard treat `file://` as dev? | **No, deny by default.** Test harnesses should run on a local HTTP server (the existing dev workflow already does this). File-origin support adds attack surface without meaningful test workflow benefit. |
| OQ-8 | Should the container scan `creativeHtml` for known-malicious patterns? | **No.** Markup scanning is unreliable (obfuscation, runtime fetch). The iframe-level CSP provides content-independent defense; that's the right layer. |

---

## Acceptance Criteria

### Constructor validation

- [ ] `creativeUrl` alone loads via iframe `src` (Creative URL, unchanged)
- [ ] `creativeHtml` + `creativeRendererUrl` uses renderer protocol (Creative Markup)
- [ ] `creativeHtml` without `creativeRendererUrl` throws `TypeError`
- [ ] `creativeRendererUrl` without `creativeHtml` throws `TypeError`
- [ ] `creativeUrl` + `creativeRendererUrl` throws `TypeError`
- [ ] `creativeUrl` + `creativeHtml` throws `TypeError`
- [ ] Neither `creativeUrl` nor `creativeHtml` throws `TypeError`
- [ ] Unparseable `creativeRendererUrl` throws `Error`
- [ ] `http://` `creativeRendererUrl` throws `Error`
- [ ] `javascript:` / `data:` / `blob:` / `file:` / `about:` `creativeRendererUrl` throws `Error`
- [ ] `creativeRendererUrl` with userinfo throws `Error`
- [ ] Same-origin `creativeRendererUrl` throws `Error` (vs both `window.location` and `window.top.location`)
- [ ] `creativeHtml` exceeding 256 KiB throws `Error`
- [ ] Validation rule ordering surfaces shape errors before value errors

### Iframe configuration

- [ ] Creative Markup renderer iframe gets `allow-same-origin` in sandbox
- [ ] Creative URL does NOT get `allow-same-origin` in sandbox
- [ ] Creative Markup iframe sets `csp="object-src 'none'; base-uri 'none'"`
- [ ] Creative Markup iframe sets `referrerpolicy="no-referrer"`

### Renderer protocol

- [ ] URL fragment nonce is appended to `creativeRendererUrl` and matches the `sharcNonce` field in the `render` message
- [ ] Renderer-side parent-origin validation rejects forged messages from sibling frames
- [ ] Container validates `event.source`, `event.origin`, and `placementSessionId` on all renderer replies
- [ ] Post-load origin echo: container verifies `event.data.rendererOrigin === rendererOrigin`; mismatch terminates with `RENDERER_ORIGIN_MISMATCH` and emits `console.error` with both origins
- [ ] Renderer-side container-origin validation: renderer rejects render messages where `event.origin !== event.data.containerOrigin`
- [ ] Reference renderer ships with `Clear-Site-Data: "storage"` HTTP header (Strategy A) plus JS-side clearing (Strategy B) as a fallback
- [ ] Renderer implementation contract documents Strategy C (ephemeral / per-tenant origins) for operators with strong cross-advertiser isolation requirements
- [ ] Renderer implementation contract acknowledges Safari Clear-Site-Data coverage gap (16.4+ and incomplete `"storage"` directive coverage); recommends Strategy A + B pairing for Safari traffic
- [ ] Renderer implementation contract acknowledges JS-side clearing limitations (HttpOnly cookies not reachable; `indexedDB.databases()` requires iOS 14+; non-default cookie path/domain variants not enumerable)
- [ ] Renderer page MUST be served with HTTP response CSP `object-src 'none'; base-uri 'none'` (portable enforcement layer); iframe `csp` attribute is Chromium-only defense-in-depth
- [ ] Container emits one-time `console.warn` at construction when validation rule 7 carve-out applies (cross-origin top frame detected)
- [ ] Container fires `onSecurityEvent` callback (when registered) with structured payload for `wrapper_top_frame_inaccessible`, `renderer_origin_mismatch`, `renderer_protocol_error`, and `renderer_failed` events
- [ ] For terminating security events, `onSecurityEvent` fires before `onError` so observability tooling sees the security context before the generic error callback
- [ ] `onSecurityEvent` is optional — omitting it falls back to console-only signaling without breaking
- [ ] Nonce generation uses `crypto.randomUUID()` (CSPRNG) — implementation does not use `Math.random()`-based UUID
- [ ] `RENDERER_PROTOCOL_ERROR` (2117) terminates only on payload-shape failure (missing required fields, wrong types) after envelope validation passes
- [ ] Render message field name `creativeHtml` matches constructor option name (not generic `html`)
- [ ] `SHARC:Renderer:failed` reply terminates container with `RENDERER_FAILED` and reason
- [ ] Iframe load timeout (5s) terminates with `RENDERER_TIMEOUT`
- [ ] `rendered` reply timeout (2s) terminates with `RENDERER_TIMEOUT`
- [ ] `close()` mid-render cleanly removes iframe and listeners; late replies are ignored

### Metadata and observability

- [ ] Injection runs for Creative Markup if injectors are registered (regardless of `useMarkupInjection`)
- [ ] `creativeSource`, `creativeInjected`, `creativeRendered` are correct across both variants
- [ ] DOM stamps `data-sharc-creative-source` and `data-sharc-creative-rendered` (always-present `'true'`/`'false'`) are applied and cleaned up on close
- [ ] `placementSessionId` correlation prevents cross-instance message confusion

### Reference implementation

- [ ] Reference renderer ships in `examples/renderer/index.html` with inline comments and operator-fork guidance
- [ ] Reference renderer implements all message validation (nonce, parent origin, source, version checks)
- [ ] Reference renderer implements storage clearing on each render
- [ ] Cross-origin renderer testing works in dev harness (issue #23, superseded by #55)

### Types and tests

- [ ] TypeScript types updated: `creativeUrl` becomes optional; `creativeHtml`, `creativeRendererUrl` added; renderer message types exported
- [ ] Test coverage: all constructor validation errors, both load variants, injection across variants
- [ ] Test coverage: redirect detection (mock 30x redirect, verify origin mismatch + terminate)
- [ ] Test coverage: neighbor-frame forgery (sibling frame attempts to send `render` with stolen `placementSessionId`, verify renderer rejects)
- [ ] Test coverage: `close()` mid-render at every renderer protocol step
