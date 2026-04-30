# Proposal: Creative Payload Polymorphism (Creative Markup — Renderer Protocol)

**Author:** Jeffrey Carlson  
**Date:** 2026-04-27  
**Status:** Revised — incorporating architect, security, industry, technical writer, and product management review feedback  
**Related:** Issue #41, #23 (cross-origin renderer testing — superseded by #55), #24 (SRI — deferred), #25 (canonical renderer — descoped), #55 (GitHub Pages hosting + Creative Markup demo)

---

## At a glance

**What this proposal adds:** A second creative payload variant (`creativeHtml` + `creativeRendererUrl`, called Creative Markup) alongside the existing URL-based variant (`creativeUrl`, now called Creative URL). Creative Markup posts inline HTML markup to a trusted cross-origin renderer page operated by the same entity that operates the SHARC container.

**Why:** Real-time bidding delivers ad markup inline (`bid.adm`). Forcing operators to manufacture URLs from inline markup is unnecessary. Bare `srcdoc` would silently break measurement SDKs, `localStorage`, and CORS for the most common RTB use case — a cross-origin renderer page solves this by giving the creative a real origin.

**Surface area added:**
- Constructor options: `creativeHtml`, `creativeRendererUrl`, `onSecurityEvent`, `allowPopups`, `allowTopNavigationByUserActivation`, `allowStorageAccessByUserActivation`, `allowModals`, `allowDownloads`, `wrapperPolicy`
- Instance properties: `creativeSource`, `creativeInjected`, `creativeRendered`
- DOM stamps: `data-sharc-creative-source`, `data-sharc-creative-rendered`
- Error codes: `2114` `RENDERER_TIMEOUT`, `2115` `RENDERER_FAILED`, `2116` `RENDERER_ORIGIN_MISMATCH`, `2117` `RENDERER_PROTOCOL_ERROR`, `2118` `RENDERER_UNAUTHORIZED_NAVIGATION`
- Message types: `SHARC:Renderer:render`, `SHARC:Renderer:rendered`, `SHARC:Renderer:failed`
- Security event types: `wrapper_top_frame_inaccessible`, `renderer_origin_mismatch`, `renderer_protocol_error`, `renderer_failed`, `unauthorized_navigation`

**Backward compatibility:** Pre-1.0 — additive. Creative URL behavior is unchanged. Operators on 0.6.x running Creative URL only can upgrade to 0.7.0 without code changes.

**Key decisions:**
1. Both Creative URL and Creative Markup are first-class and permanent — they serve structurally distinct supply paths
2. Container operators host their own renderer; SHARC repo is canonical source, runtime is distributed
3. SHARC vocabulary stays cross-platform (no OpenRTB-specific anchoring)
4. Inspired by Prebid Universal Creative; not attempting to disrupt it
5. Primary mission is MRAID + SafeFrame replacement; PUC compatibility bridge is deferred future work

---

## Conventions

The keywords MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) **when, and only when, they appear in all capitals**. Lower-case "must" / "should" / "may" are non-normative prose.

In tables and code blocks, **bold values mark the dangerous or required case**. Plain values mark the safe or default case.

---

## Glossary

Anchors the SHARC-specific vocabulary used throughout this proposal. WG reviewers reading this for the first time should skim this section first.

| Term | Definition |
|---|---|
| **Container operator** | The entity that instantiates `SHARCContainer` on the page. May or may not be the publisher. Examples: ad servers (GAM), header bidding wrappers (Prebid Universal Creative), SSP-managed wrappers (OpenWrap, Magnite Demand Manager), publisher O&O ad ops. |
| **Container origin** | `window.location.origin` of the page where the SHARC container is instantiated. Distinct from "publisher origin" when SHARC runs inside a wrapper iframe cross-origin to the publisher top. |
| **Creative URL** | Load variant where the creative is fetched by URL via the `creativeUrl` constructor option. Iframe `src` is set to the URL; existing pre-0.7.0 behavior, unchanged. |
| **Creative Markup** | Load variant introduced in 0.7.0. Operator provides HTML markup via `creativeHtml` and an operator-hosted renderer URL via `creativeRendererUrl`. Container loads the renderer page and posts the markup to it via the renderer protocol. |
| **Embedder** | Whichever frame embeds the SHARC iframe — could be the publisher's top frame, or a wrapper iframe one or more levels deep. |
| **Renderer page** | The operator-hosted HTTPS page served at `creativeRendererUrl`. Receives `creativeHtml` via postMessage and writes it into its own document. |
| **Renderer iframe** | The iframe element in the container's DOM that loads the renderer page. |
| **Renderer protocol** | The `SHARC:Renderer:render` / `:rendered` / `:failed` postMessage exchange between container and renderer page. |
| **`rendererProtocolVersion`** | Version of the renderer protocol; independent of the SHARC SDK semver. SDK patch releases do NOT bump this; protocol-breaking changes do. |
| **Operator** | Shorthand for "container operator." |

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

**Canonical source, distributed runtime.** The SHARC repository at `github.com/IABTechLab/SHARC` is the single source of truth for the spec, SDK, and reference implementations. The runtime — containers, renderers, bridges — is hosted by operators in distributed infrastructure. Same pattern as HTTP, OpenRTB, MRAID, SafeFrame: the spec evolves in one place where the ecosystem can review and contribute; execution happens at the edge where each operator owns SLA, security posture, and deployment cadence.

**The container operator owns the renderer URL.** Whoever instantiates `new SHARCContainer(...)` is responsible for hosting and operating the renderer page that `creativeRendererUrl` points to. Container and renderer share the same supply chain.

| Operator | Hosts the renderer at |
|---|---|
| Ad servers (GAM dominates) | Ad server's CDN |
| Header bidding wrappers (Prebid Universal Creative dominates) | Wrapper's CDN |
| Publisher O&O ad ops (direct-sold inventory) | Publisher's CDN |
| SSP-managed wrappers (OpenWrap, Magnite Demand Manager, etc.) | SSP's CDN |

This mirrors how MRAID and SafeFrame work in practice. GAM's SafeFrame at `tpc.googlesyndication.com` is the de facto canonical-hosted runtime for the dominant share of web display impressions; SHARC follows the same pattern.

**Relationship to Prebid Universal Creative.** Inspired by PUC, not attempting to disrupt it. SHARC's primary mission is MRAID + SafeFrame replacement; PUC compatibility bridge is tracked as future work. See DD-11 for the differentiation rationale and § Future Work § PUC compatibility bridge for the planned path.

**Compatibility bridges as first-class deliverables** (`examples/bridges/`):

| Bridge | What it does |
|---|---|
| `sharc-mraid-bridge` | Exposes MRAID 3.0 API to creatives; translates `mraid.expand()`, `mraid.resize()`, `mraid.close()`, `mraid.open()`, and all other MRAID-spec'd patterns into SHARC messages. **Owns all MRAID navigation.** |
| `sharc-safeframe-bridge` | Exposes `$sf.ext.expand()`, `$sf.ext.collapse()`, `$sf.ext.geom()`, and all other SafeFrame-spec'd patterns; maps to SHARC `requestPlacementChange` and `requestNavigation`. **Owns all SafeFrame navigation.** |
| `sharc-omid-bridge` | OMID measurement integration |
| `sharc-navigation-bridge` | Intercepts **non-IAB-spec'd web-native navigation patterns**: `window.open`, `location.href`/`assign`/`replace`, `<a>` clicks, `<form>` submits, `<meta http-equiv="refresh">`. Routes through `SHARC.requestNavigation()`. Fills the gap for creatives that use standard web patterns rather than MRAID or SafeFrame APIs. (IAB-spec'd navigation stays in the MRAID and SafeFrame bridges; this bridge does not duplicate that surface.) |

A creative authored against MRAID 3.0 or SafeFrame runs inside a SHARC container without modification. This is what makes SHARC a true MRAID/SafeFrame *successor* rather than an additional rendering option.

### Stock implementation + operator tweaks

The SHARC repository ships a reference renderer at `examples/renderer/index.html`. Operators fork it, host on their own infrastructure, and patch as needed. The protocol contract is invariant; the implementation is operator-tweakable.

**Stay close to canonical.** Operators SHOULD file issues and PRs back to the SHARC repository for any non-operator-specific improvement. Forks that drift accumulate maintenance burden and weaken the reference implementation's security posture (which depends on being the most-reviewed implementation in the wild). Operator-specific changes belong in a thin layer over recent canonical, not in a long-lived divergent branch.

| Belongs upstream (file an issue/PR) | Belongs in operator's private fork |
|---|---|
| Bug fixes in the renderer protocol logic | Operator branding (logo, page title) |
| Security hardening (CSP refinements, header tightening) | Internal audit logging endpoints |
| Browser compatibility patches | Operator-specific monitoring integration |
| Performance improvements | Customer support hooks |
| Observability improvements (event types, payloads) | Operator-internal feature flags |
| Documentation improvements | Operator-specific deployment scripting |

**Three patterns minimize operator merge cost** as canonical evolves:

1. **Extension points over inline edits.** The reference renderer exposes named hooks (`onBeforeRender`, `onAfterRender`, `customSecurityLog`, `beforeStorageClear`). Operators register handlers without modifying canonical code.
2. **Configuration over code.** Operator-specific values (branding, endpoints, feature flags, custom CSP additions) live in `RENDERER_CONFIG`. Canonical code reads from config; operators update config, not code.
3. **`rendererProtocolVersion` is the upgrade trigger — not the SHARC SDK version.** SDK patch releases (0.7.0 → 0.7.1) do NOT bump the protocol; operators only update their renderer when the protocol actually changes (typically minor releases). Dramatically reduces re-merge cadence.

Canonical maintainers commit to evolving the hook surface and config schema in additive, backward-compatible ways across protocol-stable releases. Operator tweaks built on the documented surface should not break across `rendererProtocolVersion`-stable SHARC releases.

### Container and renderer must upgrade together

The renderer protocol version is part of the SHARC SDK's contract. **When `rendererProtocolVersion` changes, operators MUST upgrade the renderer in coordination with the SDK upgrade**, or impressions fail with `SHARC:Renderer:failed { reason: 'unsupported_*' }`. Mismatches are loud (immediate failures via `onSecurityEvent`), not silent — operators see them immediately in monitoring, not as slowly degrading impression rates weeks after a deploy.

**Zero-downtime deployment pattern** (standard server-deploys-before-clients):

1. **Stage:** test SDK + renderer upgrade together in staging
2. **Renderer first:** deploy new renderer with backward compatibility (accepts old AND new protocol versions during transition)
3. **Container second:** roll out SDK upgrade — old containers keep working via backward-compat path
4. **Drop old support last:** once monitoring confirms all containers migrated, drop old protocol from renderer

The versioned-paths recommendation below makes this pattern easy: an operator running both `/0.7.0/` and `/0.8.0/` in parallel can roll out gradually without coordinated cutover.

### Renderer URL Stability

The construction-time origin check and post-load origin echo (see Security Model) require `creativeRendererUrl` and the renderer's actual served origin to match exactly. **`creativeRendererUrl` is a stable contract** — operators cannot use 30x redirects to migrate from one renderer URL to another.

| Supported (origin unchanged) | Requires coordinated migration |
|---|---|
| DNS / CNAME / IP rotation | Hostname changes (subdomain, domain) |
| TLS certificate rotation | Port changes |
| CDN backend changes (same hostname) | |
| Path changes | |

**URL convention** — ship SHARC-versioned paths under a stable origin, mirroring the SDK distribution model (`cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.6.2/...`):

```
https://renderer.operator.com/0.7.0/   ← renderer forked from SHARC 0.7.0
https://renderer.operator.com/0.8.0/   ← renderer forked from SHARC 0.8.0 (parallel)
```

The version segment names the SHARC SDK release the renderer was forked from. Patch releases reuse the URL — the protocol-version handshake enforces actual compatibility, not the URL path. The path convention is a naming guide, not a security boundary.

Operator commitment is comparable to existing precedent: GAM has held `tpc.googlesyndication.com` as a stable SafeFrame runtime origin for over a decade.

### Measurement vendor coordination

Operators deploying renderers SHOULD coordinate with measurement vendors (IAS, DV, Moat, OMID) to allowlist the renderer origin. Many vendors maintain per-origin allowlists for fraud detection and viewability scoring; new renderer origins need onboarding the same way any new ad-serving subdomain would.

---

## Constructor Changes

### New Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `creativeHtml` | `string` | Conditional | Raw HTML markup for the creative. Mutually exclusive with `creativeUrl`. Requires `creativeRendererUrl`. |
| `creativeRendererUrl` | `string` | Conditional | HTTPS URL of an operator-hosted renderer page. Required when `creativeHtml` is provided. Must be cross-origin to the publisher page. |
| `onSecurityEvent` | `Function` | No | Callback fired with a structured event payload for security-relevant events (wrapper carve-out, origin mismatch, renderer protocol failure, etc.). Production observability hook — see Security Model § wrapper-cross-origin section for the event schema and reserved `type` values. Console output continues regardless of whether the callback is provided. |
| `allowPopups` | `boolean` | No | Default `true`. When `true`, the iframe sandbox includes both `allow-popups` AND `allow-popups-to-escape-sandbox` (popups inherit a clean browser context for landing pages). When `false`, both tokens are omitted; creative `window.open()` calls fail at the browser level. `SHARC.requestNavigation()` continues to work as the operator-controlled click-through path regardless of this flag. The `allow-popups-to-escape-sandbox` token is bound to `allowPopups`, not exposed as a separate option — see DD-21. Use case for `false`: publishers with strict UX policies (kid-directed sites, financial services, healthcare, premium brand placements) where popups are not appropriate. See DD-17. |
| `allowTopNavigationByUserActivation` | `boolean` | No | Default `true`. When `true`, the iframe sandbox includes the `allow-top-navigation-by-user-activation` token, permitting creative `<a target="_top">` clicks and other user-gesture-initiated top-frame navigation. When `false`, the token is omitted and the browser blocks all top-frame navigation regardless of user activation. The unsafe `allow-top-navigation` token (auto-redirect without user gesture) is **not** exposed via this option — only the user-activation variant. Default matches IAB SafeFrame parity, which is the dominant production baseline. `SHARC.requestNavigation()` and the navigation bridge continue to operate regardless of this flag. See DD-20. |
| `allowStorageAccessByUserActivation` | `boolean` | No | Default `true`. When `true`, the iframe sandbox includes the `allow-storage-access-by-user-activation` token, permitting creatives to invoke the Storage Access API (`document.requestStorageAccess()`) on user gesture for cross-site cookie/storage access. When `false`, the token is omitted and SAA calls fail. Default `true` reflects that Safari and Firefox block third-party cookies — measurement and identity vendors operating across those browsers depend on SAA as the user-gesture-gated cross-site storage path. Chrome continues to support third-party cookies (Google retired the cookie deprecation plan in October 2025), so SAA is less load-bearing there but remains operative. See DD-22. |
| `allowModals` | `boolean` | No | Default **`false`**. When `true`, the iframe sandbox includes the `allow-modals` token, permitting creatives to invoke `window.alert()`, `window.confirm()`, `window.prompt()`, `window.print()`, and receive `beforeunload` events. When `false` (default), the token is omitted and these calls silently fail. Default-false because the legitimate use cases (age gates on regulated inventory, subscription confirmations) are narrower than the abuse surface (dialog-spam blocking user session, dark-pattern `beforeunload` prompts), and publishers absorb the UX cost of bad creatives. Operators serving inventory that legitimately needs modals (alcohol/gambling age gates, B2B confirmation flows) can opt in via `true`. See DD-23. |
| `allowDownloads` | `boolean` | No | Default **`false`**. When `true`, the iframe sandbox includes the `allow-downloads` token, permitting creatives to trigger downloads via `<a download>` and `Content-Disposition: attachment` responses. When `false` (default), the token is omitted and download attempts are blocked at the browser level. Default-false because the legitimate use cases (ad-served PDFs / white papers, calendar invites `.ics`, vCards `.vcf`, coupon downloads) are narrower than the abuse surface (drive-by downloads, social-engineering download prompts), and most legitimate flows route the asset through click-through to a landing page rather than direct iframe download. Operators serving inventory that legitimately needs in-iframe downloads (B2B lead-gen, event-promotion `.ics`) can opt in via `true`. See DD-25. |
| `wrapperPolicy` | `'warn' \| 'block'` | No | Default `'warn'`. Controls container behavior when the wrapper-cross-origin-to-top condition is detected at construction (validation rule 7 carve-out applies — see Security Model § wrapper-cross-origin). `'warn'` (default) emits `console.warn` + `onSecurityEvent` and proceeds; matches the original behavior and most production deployments (SHARC inside header-bidding wrappers). `'block'` terminates synchronously at construction with a thrown `Error`; recommended for security-strict deployments (regulated verticals, audit-required inventory) where the operator cannot independently verify the renderer URL won't collide with publisher origins. See DD-19. |

### Validation Rules (enforced synchronously at construction)

Evaluated in order; first violation throws. This ordering surfaces "shape of the call is wrong" errors before "shape is right but URL is bad" errors, which matches how operators mentally debug:

1. Exactly one of `creativeUrl` or `creativeHtml` must be provided. Neither or both → `TypeError`.
2. `creativeHtml` requires `creativeRendererUrl`. Missing → `TypeError`.
3. `creativeRendererUrl` is only valid alongside `creativeHtml`. Pairing it with `creativeUrl` → `TypeError`.
4. `creativeRendererUrl` must parse via `new URL(...)` without throwing → `Error`.
5. `creativeRendererUrl` must use exactly the `https:` scheme. `http:`, `javascript:`, `data:`, `blob:`, `file:`, `about:`, and any other scheme → `Error`.
6. `creativeRendererUrl` must not contain userinfo. Non-empty `username` or `password` → `Error`.
7. `creativeRendererUrl` must be cross-origin (strict `URL.origin` equality) to both `window.location` and `window.top.location` when accessible. Same-origin → `Error`. When `window.top.location` access throws (cross-origin top frame), the wrapper context inherits the cross-origin guarantee and `window.location` comparison is sufficient.
8. `creativeHtml` size must not exceed 256 KiB **at construction (pre-injection)** → `Error`. Larger payloads almost always indicate a bug; RTB markup norms are well below this. The cap applies to the operator-supplied markup before extension `injectIntoMarkup` hooks run; post-injection markup size is **unbounded** by the protocol (extensions can legitimately add OMID host script, measurement tags, etc., that grow the markup). Operators that need a post-injection cap should enforce it in their extension layer.

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
| `src=<data:>` | Opaque origin (null) | Opaque origin in all current browsers (Chromium, Firefox, WebKit). The historical inconsistency was resolved before 2020. |
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

**Full sandbox (default):** `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-storage-access-by-user-activation`

`allow-modals` and `allow-downloads` are configurable but **default off** — see DD-23 and DD-25 for the asymmetric default rationale.

Token presence is governed by constructor options (all default `true`):

| Token | Constructor option | Always present | Notes |
|---|---|---|---|
| `allow-scripts` | — | ✅ | Required for SHARC bootstrap |
| `allow-same-origin` | — | ✅ (Markup only) | Required for renderer-origin storage; safety derived from validation rules 4-7 |
| `allow-forms` | — | ✅ | Required for lead-gen, signup, search creatives |
| `allow-popups` | `allowPopups` | Conditional | See DD-12, DD-17 |
| `allow-popups-to-escape-sandbox` | `allowPopups` (bound) | Conditional | Bound to `allowPopups`; not a separate option. See DD-21 |
| `allow-top-navigation-by-user-activation` | `allowTopNavigationByUserActivation` | Conditional | See DD-20 |
| `allow-storage-access-by-user-activation` | `allowStorageAccessByUserActivation` | Conditional | See DD-22 |
| `allow-modals` | `allowModals` | Conditional (default **off**) | See DD-23 |
| `allow-downloads` | `allowDownloads` | Conditional (default **off**) | See DD-25 |

Operators can independently strip any conditional token to harden the sandbox. The unsafe `allow-top-navigation` token (top-nav without user gesture) is **never** present — only the user-activation variant is exposed. The defaults match the IAB SafeFrame industry baseline, which is the dominant production deployment for ad iframes; strict-mode opt-out is available per-token via the constructor.

### Iframe-level CSP, Permissions Policy, and referrer policy

The container sets the following on the renderer iframe element:

| Attribute | Value | Purpose |
|---|---|---|
| `csp` | `object-src 'none'; base-uri 'none'` (baseline) | Defense-in-depth against `<base href>` redirection and plugin-content (`<object>`/`<embed>`) injection — both real attack vectors against arbitrary creative HTML. Chromium-only; HTTP-response CSP on the renderer is the portable enforcement layer (see Renderer Implementation Contract). |
| `allow` (Permissions Policy) | `geolocation 'none'; camera 'none'; microphone 'none'; payment 'none'; usb 'none'; serial 'none'; clipboard-write 'none'; screen-wake-lock 'none'; accelerometer 'none'; gyroscope 'none'; magnetometer 'none'; web-share 'none'; idle-detection 'none'; xr-spatial-tracking 'none'; identity-credentials-get 'none'` | Default-deny across sensors, hardware-access APIs, payments, identity-federation (FedCM), and UX-intrusive features. Adversarial creative HTML cannot escalate to user-permission prompts. **Ad-tech-relevant Permissions Policy features are deliberately NOT in the deny list** — `private-state-token-issuance` and `private-state-token-redemption` (Private State Tokens, actively used for anti-fraud signals as of October 2025) remain operative; the policy features for retired Privacy Sandbox APIs (`browsing-topics`, `attribution-reporting`, `shared-storage`) are also not denied because permit-by-default is forward-compatible with whatever the W3C PATCG attribution work produces. See DD-24. Stronger than `sandbox` for the denied features — `sandbox` doesn't cover most of them. |
| `referrerpolicy` | `no-referrer` | Prevents the renderer's network requests from leaking the publisher page URL. |

**Note on `fullscreen`**: SHARC's fullscreen placement intent uses `position: fixed` viewport takeover, not the `Element.requestFullscreen()` API, so `fullscreen` can stay denied in Permissions Policy without breaking SHARC's fullscreen feature.

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

**Fragment-nonce confidentiality limitations.** The fragment-nonce defense rests on the URL fragment being readable only by code running in the renderer's origin. Three vectors break this assumption — none are SHARC-introduced, but operators must understand them:

1. **Service Workers registered on the renderer origin** see every iframe load including the URL fragment via `FetchEvent.request.url`. If a malicious or compromised SW is registered on the renderer origin, the fragment-nonce defense is defeated. **Operators MUST NOT register Service Workers on the renderer origin** (see Renderer Implementation Contract operational constraints).
2. **Browser extensions with `webRequest` host permission** can read iframe URLs including fragments. Manifest V3 narrowed the API surface but did not remove fragment access. This is a known limitation of fragment-based secrets across the entire web (OAuth2 implicit flow had the same property), not unique to SHARC. The threat model for SHARC, like every other in-page protocol, assumes a non-adversarial user agent.
3. **The Navigation API** (`navigation.entries()`) exposes the fragment to same-origin code on the renderer — which is what we want, since the renderer needs to read it. But it also exposes it to any subsequent navigation on the renderer origin while the entry list still contains the renderer URL. Renderer pages MUST NOT perform top-level navigations that would persist alongside the renderer entry.

### Renderer protocol messages

**Container → renderer** (via `iframe.contentWindow.postMessage`, `targetOrigin = rendererOrigin`):

```javascript
{
  type: 'SHARC:Renderer:render',
  creativeHtml: string,            // injected creative HTML (matches constructor option name)
  placementSessionId: string,      // for correlation; renderer echoes it back
  sharcNonce: string,              // CSPRNG UUID v4; must match URL fragment
  sharcVersion: string,            // SHARC SDK version (semver), e.g. "0.7.0"
  rendererProtocolVersion: string, // Renderer protocol version, INITIAL VALUE: "1" for 0.7.0. Bumps independently of SHARC SDK semver — see § Container and renderer must upgrade together.
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
                                   // 'nonce_mismatch' | 'container_origin_mismatch' | 'render_failed' |
                                   // 'service_worker_detected' | ...
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

   **Embedded WebView caveat:** in iOS WKWebView and Android WebView contexts, the host app can intercept the renderer's HTTP responses via `WKURLSchemeHandler` (iOS) or `WebViewClient.shouldInterceptRequest` (Android) and strip or replace headers — including `Clear-Site-Data`. Operators serving inventory through embedded WebViews should validate the header is honored end-to-end in the host environment, not just on the open web.

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
- **Not register Service Workers on the renderer origin.** A Service Worker on the renderer origin sees every iframe load including the URL fragment (via `FetchEvent.request.url`) and can substitute the renderer HTML transparently. This defeats the fragment-nonce defense entirely. If the operator's deployment platform registers SWs by default (some PaaS tooling does), explicitly disable SW registration for the renderer hostname.

  **Reference renderer runtime check:** the reference renderer SHALL detect Service Worker control at startup via `navigator.serviceWorker.controller` (and check `navigator.serviceWorker.getRegistrations()` for registered-but-not-yet-controlling SWs). If a Service Worker is detected on the renderer origin, the renderer sends `SHARC:Renderer:failed` with `reason: 'service_worker_detected'` and does NOT proceed with rendering. This prevents the silent-defeat attack where an unexpected SW (from a prior unrelated deployment, sloppy operator analytics, or compromised CDN config) is controlling the origin without the operator's knowledge. Operator forks SHOULD preserve this check.
- **Not set restrictive `X-Frame-Options` or CSP `frame-ancestors`** on the renderer response. The renderer is designed to be embedded as an iframe by arbitrary publisher origins; setting `X-Frame-Options: DENY/SAMEORIGIN` or `frame-ancestors 'self'` will break SHARC. Security-conscious operators following typical hardening guides will be tempted; document this in deployment runbooks.
- **Set `Cross-Origin-Resource-Policy: same-origin`** on the renderer HTTP response. CORP doesn't block iframe embedding (that's `frame-ancestors`/`X-Frame-Options`'s job), but it does block adversaries from loading the renderer page as an `<img>` / `<script>` / other subresource type to read its bytes. One-line config change, real protective value.
- Run minimum logic in the renderer page itself. Any first-party scripts loaded into the renderer (analytics, RUM, error reporting) execute alongside adversarial creative HTML in the same origin and should be treated as exposed to creative manipulation.
- Not log `location.href` or `location.hash` from the renderer page (the nonce is sensitive — sending it to a server log or third-party analytics endpoint defeats the fragment-nonce defense).

**Click-through routing (renderer imports `sharc-navigation-bridge`):**

All creative-initiated web-native navigation is intercepted and routed through `SHARC.requestNavigation()` for operator URL review and policy enforcement. The renderer page imports `sharc-navigation-bridge` (a first-class bridge in `examples/bridges/`, sibling to MRAID/SafeFrame/OMID bridges) and installs it before `document.write(creativeHtml)` so its interceptors apply to all creative code.

The navigation bridge intercepts non-IAB-spec'd navigation patterns:

- **`window.open()`** — adds `noopener,noreferrer` features unconditionally; routes URL through `SHARC.requestNavigation()`. Suppressed entirely by the browser when `allowPopups: false` removes `allow-popups` from the sandbox.
- **`window.location.href` setter / `location.assign()` / `location.replace()`** — intercepts in-frame navigation; routes through `SHARC.requestNavigation()`.
- **Anchor click delegate** — single document-level listener handles both `<a target="_blank">` (popup) and `<a>` without target (in-frame nav). Adds `rel="noopener noreferrer"` defensively; routes URL through `SHARC.requestNavigation()`.
- **Form submit delegate** — intercepts `<form>` submissions; routes through `SHARC.requestNavigation()`. The `form-action` CSP opt-in (DD-6) provides browser-level enforcement when enabled.
- **Strip `<meta http-equiv="refresh">`** from `creativeHtml` before `document.write` — meta refresh would redirect the iframe outside any JS interception path. (Renderer-side only; the SDK in Creative URL cannot strip post-load — falls back to container load-event backstop.)

**The bridge is best-effort.** Adversarial creative HTML can re-override `window.open`, redefine `location` getters, or use other patterns to bypass it. The container-side load-event monitoring (see Security Model § Click-through enforcement) is the defense-in-depth backstop that catches anything the bridge misses.

**IAB-spec'd navigation stays in its own bridge** — operators that need MRAID navigation handling load `sharc-mraid-bridge`; SafeFrame deployments load `sharc-safeframe-bridge`. The navigation bridge does not duplicate that surface.

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
See: https://github.com/IABTechLab/SHARC/blob/main/docs/api-reference.md#renderer-protocol
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

## WebView Compatibility

SHARC's platform scope is **web iframe + iOS WKWebView + Android WebView** per `docs/product-scope.md`. Creative Markup is designed to work across all three; this section documents the feature-support reality across SHARC's lowest-supported WebView versions.

### Feature support matrix

| Feature | Web (modern) | iOS WKWebView | Android WebView | Notes |
|---|---|---|---|---|
| `crypto.randomUUID()` | All | iOS Safari 15.4+ (WKWebView 15.4+) | WebView 92+ (Aug 2021) | CSPRNG nonce generation. **Required.** |
| Sandbox `allow-same-origin` semantics | All | All | All | Standard HTML behavior; stable. |
| Iframe `csp=` attribute (CSPEE) | Chromium only | **No** (WebKit) | Yes (Chromium-based WebView 81+) | iOS WKWebView does NOT honor it. HTTP-response CSP is the portable enforcement layer. |
| Iframe `allow=` Permissions Policy | All evergreen | iOS 16.4+ (limited features) | WebView 88+ (full) | Older iOS versions ignore unknown directives; safe to set, but not enforced pre-16.4. |
| `referrerpolicy="no-referrer"` | All | All | All | Stable across all targets. |
| `Cross-Origin-Resource-Policy` header | All evergreen | iOS 12+ | WebView 73+ | Stable. |
| `Clear-Site-Data: "storage"` | Chromium, Firefox | iOS 16.4+ (`cookies` only; `storage` partial) | WebView 88+ (full) | **Strategy A coverage gap on iOS.** Pair with Strategy B (JS-side clearing) for Safari/iOS traffic. |
| `indexedDB.databases()` | All evergreen | iOS 14+ | WebView 71+ | Strategy B fallback uses this for IDB enumeration. iOS 13 and older cannot enumerate. |
| `document.write(html)` in cross-origin iframe | All | All | All | Cross-origin iframes are not subject to the document.write interventions Chromium added for slow same-origin third-party scripts. Stable. |
| Trusted Types | Chromium, Firefox 133+, Safari 18+ | iOS 18+ | WebView 83+ | Operators MUST NOT enable `require-trusted-types-for 'script'` on the renderer's response CSP — would block `document.write`. |
| `MessageChannel` / `postMessage` `transfer` | All | All | All | Stable across all targets; SHARC's transport layer. |
| Fragment opacity to other origins | All | All | All | Stable. |

### Embedded WebView caveats

In iOS WKWebView and Android WebView contexts, the **host app can intercept HTTP responses** via `WKURLSchemeHandler` (iOS) or `WebViewClient.shouldInterceptRequest` (Android) and strip or replace headers. This affects:

- `Clear-Site-Data` enforcement (Strategy A may not work end-to-end if the host strips the header)
- `Cross-Origin-Resource-Policy` (host can override)
- HTTP response CSP (host can override, weakening the security model)

Operators serving inventory through embedded WebViews SHOULD validate header pass-through end-to-end in the host environment, not just on the open web. If header interception is observed, operators MUST adopt Strategy C (per-tenant origins) to compensate.

### What does NOT work uniformly

- **`Clear-Site-Data: "storage"` directive on iOS** — partial coverage in Safari 16.4+; older iOS versions don't support it. Strategy B is required.
- **Iframe `csp=` attribute on WebKit / iOS WKWebView** — not enforced. HTTP-response CSP is the enforcement layer for iOS.
- **Permissions Policy on iOS < 16.4** — directives are ignored silently.
- **IndexedDB enumeration on iOS < 14** — Strategy B cannot enumerate unknown databases on those versions.

### Lowest supported WebView versions

| Platform | Lowest supported | Reasoning |
|---|---|---|
| iOS WKWebView | **iOS 15.4** | `crypto.randomUUID()` availability — required for nonce generation |
| Android WebView | **WebView 92** | `crypto.randomUUID()` availability |

Operators serving inventory below these versions SHOULD detect and gracefully fall back to Creative URL where possible. Creative Markup is not supported on iOS 14 / WebView pre-92.

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

**`BroadcastChannel` is not cleared by either Strategy A or Strategy B.** `BroadcastChannel` is origin-scoped: two creatives in different impressions but the same renderer origin can communicate via `BroadcastChannel` regardless of storage clearing. `Clear-Site-Data: "storage"` does not terminate active channels or in-flight messages, and JS-side `localStorage.clear()` is irrelevant to `BroadcastChannel` state. **Only Strategy C (per-tenant origins) fully isolates `BroadcastChannel`** because per-origin browser separation is structural. Operators with strict cross-advertiser isolation requirements should adopt Strategy C or document this gap to their measurement and brand-safety stakeholders.

**Tension with measurement vendors:** measurement SDKs (OMID, IAS, DV, Moat) historically used persistent storage in the creative iframe for frequency caps, viewability accumulators, and fingerprint material. SHARC's per-render storage clearing breaks any pattern that depends on cross-impression state in the renderer's origin. Modern measurement architectures avoid this by using first-party verification endpoints (server-side state keyed by impression ID) rather than creative-iframe storage — that pattern is unaffected by SHARC's storage clearing. Measurement vendors that still rely on iframe storage should migrate to first-party verification, or operators serving such inventory should adopt Strategy C (per-tenant origins) to give the measurement vendor a stable storage scope per advertiser.

### Threat: SHARC container in a wrapper iframe cross-origin to publisher top

When SHARC runs inside a wrapper iframe at origin X, with the publisher top frame at origin Y where X ≠ Y, validation rule 7 cannot read `window.top.location` (cross-origin throws). The carve-out skips the top-frame check and validates only against `window.location` (the wrapper's origin X).

The browser still enforces the wrapper-iframe boundary: a renderer iframe inside the SHARC container cannot directly access the publisher's DOM regardless of its origin. **However**, if `creativeRendererUrl` happens to share origin with the publisher top (Y), the renderer's origin storage and cookies become accessible to the creative — origin-keyed storage (localStorage, IndexedDB, cookies, BroadcastChannel) does not respect the frame-tree barrier the way DOM access does.

**Blast radius if the collision occurs:**
- Creative gains read/write access to publisher-origin localStorage, sessionStorage, IndexedDB
- Creative gains read access to non-HttpOnly publisher-origin cookies
- Creative can establish `BroadcastChannel` connections to other publisher-origin frames
- Creative still **cannot** directly access publisher DOM (frame-tree barrier holds)
- Creative still cannot programmatically navigate publisher top (the unsafe `allow-top-navigation` token is never present in the sandbox); user-gesture-initiated top-nav via `<a target="_top">` is governed by `allowTopNavigationByUserActivation` (default `true`, see DD-20)
- The frame-tree barrier prevents the creative from reading `window.top.document` even when origin matches

The collision requires a specific operator misconfiguration (renderer URL chosen in a way that overlaps publisher origins). It does not happen by accident on competently-configured deployments. But it is unverifiable from inside the wrapper context, and the risk surface is non-trivial.

**Unsupported deployment configuration:** SHARC running inside a wrapper iframe cross-origin to the publisher top, with a `creativeRendererUrl` that may share origin with any publisher top the wrapper is embedded into, is an **unsupported deployment**. The wrapper-context fallback in validation rule 7 cannot detect this case. Operators in this configuration MUST guarantee `creativeRendererUrl` is not same-origin with any publisher top their wrapper is embedded into. If they cannot make that guarantee, they MUST NOT deploy SHARC in this configuration.

**Runtime detection — configurable behavior:** The container detects the wrapper-cross-origin-to-top condition at construction by attempting `window.top.location.origin` access inside a try/catch. When access throws (cross-origin top frame), the container's response is governed by the `wrapperPolicy` constructor option (default `'warn'`):

- **`wrapperPolicy: 'warn'`** (default) — emits `console.warn` + `onSecurityEvent` and proceeds with construction. Matches the original 0.7.0 behavior and most production deployments (SHARC inside header-bidding wrappers, where the wrapper-cross-origin-to-top topology is the common case). Operator accepts the out-of-band-promise responsibility documented above.
- **`wrapperPolicy: 'block'`** — emits `console.error` + `onSecurityEvent` and **throws synchronously** at construction. Recommended for security-strict deployments (regulated verticals, audit-required inventory) where the operator cannot independently verify the renderer URL won't collide with publisher origins. Fails closed.

In both modes, the container emits the carve-out signal on **both a developer channel (`console.warn` / `console.error`) and a structured-event channel (`onSecurityEvent` callback)**. Production observability platforms hook the structured channel; developers see the console message in dev/staging.

**Developer channel — `console.warn` (one-time per container instance):**

```
[SHARCContainer] Validation rule 7 carve-out applied — cross-origin top
frame detected; cannot verify creativeRendererUrl is cross-origin to the
publisher's top-level page. This is an unsupported deployment unless the
operator has independently guaranteed creativeRendererUrl is not
same-origin with any publisher top this wrapper is embedded into.
See: https://github.com/IABTechLab/SHARC/blob/main/docs/api-reference.md#wrapper-cross-origin-deployment
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
  severity: 'warning',                      // 'warning' (wrapperPolicy='warn') | 'error' (wrapperPolicy='block')
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
| `unauthorized_navigation` | `error` | Iframe navigated outside the SHARC protocol path (load-event monitoring detected an unexpected re-navigation) | Yes — fires before terminate |

For terminating events, `onSecurityEvent` fires **before** `onError` so observability tooling sees the structured security context before the generic error callback runs. Operators that only want terminating events can filter on `severity: 'error'`; operators that want full security telemetry hook both severities.

The callback is optional — operators that don't pass it get console-only signaling, identical to the prior behavior.

**`onSecurityEvent` error-handling contract:**

- **The callback is invoked synchronously** during the security event. Container does not `await` async callbacks; it fires-and-continues.
- **If the callback throws,** the container catches the exception, logs it via `console.error` (without exposing the original event payload to the catch path), and continues with its planned action (terminate-or-warn). A throwing callback never prevents container actions; it never propagates to the caller of `new SHARCContainer(...)`.
- **Slow callbacks** (synchronous CPU work in the handler) block the container's main-thread work for the duration. Operators SHOULD perform heavy work asynchronously (e.g. `queueMicrotask` or `setTimeout`) inside the handler if their observability stack requires it.
- **Callback ordering for terminating events:** `onSecurityEvent` fires first, then container terminates, then `onError` fires. This ordering is guaranteed; observability tooling that depends on it can rely on the sequence.
- **Idempotency:** the same security event will not fire twice for the same root cause within a single container instance. The wrapper-cross-origin warning fires once per construction. Other event types fire once per occurrence (terminating events fire on the first detection; the container is already shutting down on subsequent detections).

Practically, the unsupported-deployment constraint is satisfied by:
- Choosing a renderer origin that is clearly distinct from any publisher (e.g. `renderer.<wrapper-tech-vendor>.com`, not a generic CDN that other entities also use)
- Not running SHARC inside cross-origin wrappers if the wrapper is rented to many small publishers and the renderer URL is shared across all of them

The 0.7.0 protocol cannot enforce this from inside the wrapper context; the responsibility sits with the operator deploying the wrapper.

### CSP enforcement: HTTP response is the portable layer; iframe `csp` is defense-in-depth

The iframe-level `csp` attribute (CSP Embedded Enforcement / CSPEE) is **Chromium-only and unlikely to become portable**. Firefox marked their tracking work WONTFIX-leaning; Safari has never implemented it; standards work has effectively stalled. Relying on iframe `csp` alone leaves Firefox and Safari sessions unprotected from the threats the CSP baseline addresses (`<base href>` injection, plugin content via `<object>`/`<embed>`, etc.). The HTTP-response CSP layer is the durable answer, not a transitional one.

**The HTTP-response CSP served by the renderer is the portable enforcement layer.** The renderer implementation contract requires the renderer page's HTTP response to include CSP headers matching the iframe `csp` baseline:

```
Content-Security-Policy: object-src 'none'; base-uri 'none'
```

This is enforced by all major browsers (Chromium, Firefox, Safari, mobile WebKit) consistently. Operators forking the reference renderer MUST configure their hosting infrastructure (CDN, edge worker, origin response headers) to emit this CSP on the renderer page response.

**Iframe `csp` is layered on top as defense-in-depth where supported.** When both layers are present (HTTP response CSP + iframe `csp`), the effective policy is the intersection — both must permit a resource for it to load. Chromium enforces both; Firefox and Safari enforce only the HTTP response CSP. The HTTP layer is what makes the security model portable; the iframe layer is a Chromium-specific belt on the suspenders.

Operators that omit the HTTP response CSP get a security model that only works in Chromium. That is **not** a supported deployment for the SHARC security guarantee.

### Threat: click-jacking / tap-jacking

Not new to Creative Markup, but the increased capability via `allow-same-origin` makes timing attacks easier (the creative can read its own renderer's state). The `allow-top-navigation-by-user-activation` user-gesture requirement (DD-20) is **not** a complete click-jacking defense — UI redress against a transparent overlay positioned over the renderer iframe still produces a real activation token, and standard browser activation-consumption rules propagate that token to top-nav. Treating the user-activation requirement as the floor against pure programmatic redirects is correct; treating it as a click-jacking mitigation is not. Defense-in-depth here is publisher-side: iframe positioning, transparency policy, and overlay-detection — outside SHARC's protocol scope. Documented for completeness.

### Sandbox: top-frame navigation — user-activation default, configurable

The unsafe `allow-top-navigation` token (top-nav with **no** user gesture, the click-jacking-friendly variant) is **never** present in the renderer iframe sandbox. There is no constructor option to enable it. Auto-redirect / programmatic top-nav from creative HTML is not supported.

The safer `allow-top-navigation-by-user-activation` token (top-nav requires a real user gesture) is **present by default** and configurable via `allowTopNavigationByUserActivation: boolean`. The default matches IAB SafeFrame parity — the dominant production baseline that operators upgrading from SafeFrame implicitly assume. Strict deployments (regulated verticals, audit-required inventory) can opt out via `allowTopNavigationByUserActivation: false`, which strips the token and blocks all top-frame navigation regardless of user gesture.

Click-throughs continue to flow through `SHARC.requestNavigation()` and the navigation bridge regardless of this flag. The flag only governs whether real user-clicked `<a target="_top">` anchors are permitted to navigate the top frame as a fallback when SHARC's audit path is bypassed by the creative.

See DD-20 for the rationale on the default and the deliberate omission of an `'always'` mode that would expose the unsafe token.

### Out of scope: browser extensions

The SHARC security model assumes a non-adversarial user agent. Browser extensions with broad host permissions (`<all_urls>` or equivalent) can read postMessage traffic, inject content scripts, forge messages between frames, and bypass any in-page security boundary. This applies equally to SHARC, MRAID, SafeFrame, PUC, OMID, and every other in-page protocol. Defense at this layer is browser-extension-policy and user-trust, not a SHARC concern. The fragment-nonce, origin-echo, and message-validation defenses target adversaries operating *within* the page's normal frame model — sibling frames, neighbor iframes, malicious creatives — not adversaries with browser-extension-level capabilities.

### Privacy Sandbox compatibility (Fenced Frames)

The SHARC Creative Markup variant **does not run as a fenced frame, but does run inside one** when the publisher uses Privacy Sandbox's Protected Audience (formerly FLEDGE). A fenced frame is a stricter iframe primitive that cannot use `postMessage` to its embedder, cannot use URL fragments for communication, and cannot access `localStorage` — all of which SHARC depends on. The two layers compose without conflict by nesting:

```
Publisher page
  └── Fenced frame (Protected Audience auction winner)
        └── SHARC Container (running inside the fenced frame)
              └── SHARC Renderer iframe (regular cross-origin iframe inside the fenced frame)
                    └── Creative HTML
```

The fenced-frame boundary isolates the SHARC stack from the publisher (Privacy Sandbox's privacy guarantee). The SHARC renderer-iframe boundary isolates the creative from the SHARC container (SHARC's security guarantee). Fenced frames *contain* regular iframes inside them; the fenced-frame restrictions apply at the fenced-frame boundary, not all the way down. SHARC does not need to adopt fenced frames as the renderer primitive.

### Side channels: SharedArrayBuffer not exposed

The renderer protocol does not require cross-origin isolation; `SharedArrayBuffer` is unavailable to both renderer and creative (its use requires COOP+COEP, which SHARC does not adopt — see Design Decisions DD-13). No Spectre-class side channel is exposed by the protocol.

### Click-through enforcement

SHARC consolidates click-throughs through `SHARC.requestNavigation()` so the operator can review URLs against allowlists, fire trackers consistently, and enforce policy uniformly. Multiple bridges and a universal backstop route creative-initiated navigation to that single audit point.

**Bridge ownership by spec:**

| Spec / pattern | Bridge that handles it |
|---|---|
| MRAID-spec'd navigation (`mraid.open()`, etc.) | `sharc-mraid-bridge` |
| SafeFrame-spec'd navigation | `sharc-safeframe-bridge` |
| Web-native, non-IAB-spec'd navigation (`window.open`, `location.*`, anchor clicks, form submits, meta refresh) | `sharc-navigation-bridge` (new in 0.7.0) |
| SHARC-native (creative calls `SHARC.requestNavigation()` directly) | No bridge needed — direct call |

Each bridge owns its spec; no overlap or duplication. Operators load the bridges that match their inventory mix.

**Bridge load points across variants:**

| Variant | Where bridges load | Coverage |
|---|---|---|
| Creative Markup | Renderer page imports bridges before `document.write(creativeHtml)`. Operator-controlled load point; install precedes any creative code. | Comprehensive |
| Creative URL | SHARC Creative SDK auto-loads bridges at SDK init. Creative author places SHARC `<script>` in their HTML — placement is implicit-required because nothing SHARC works before SDK loads. | Comprehensive when authoring follows the recommended pattern (load SHARC SDK before any other creative scripts). |

The variant difference is *who controls the bridge load point* — operator-controlled renderer page vs. creative-author-controlled SDK script tag — not whether comprehensive coverage is achievable. Both variants converge on full coverage when used correctly. The container load-event backstop (below) catches deviations regardless.

**Routing matrix:**

| Creative pattern | Bridge / handler |
|---|---|
| `SHARC.requestNavigation(url)` | Direct — no bridge needed |
| `mraid.open(url)` and other MRAID navigation | `sharc-mraid-bridge` → `SHARC.requestNavigation()` |
| SafeFrame navigation patterns | `sharc-safeframe-bridge` → `SHARC.requestNavigation()` |
| `<a href>` with `target="_blank"` (popup) | `sharc-navigation-bridge` anchor delegate → `SHARC.requestNavigation()` |
| `<a href>` without target (in-frame nav) | `sharc-navigation-bridge` anchor delegate → `SHARC.requestNavigation()` |
| `window.open(url)` | `sharc-navigation-bridge` `window.open` interceptor → `SHARC.requestNavigation()` |
| `window.location.href = url` (and `.assign()` / `.replace()`) | `sharc-navigation-bridge` location interceptor → `SHARC.requestNavigation()` |
| `<form action>` (with or without `target="_blank"`) | `sharc-navigation-bridge` form delegate → `SHARC.requestNavigation()` |
| `<meta http-equiv="refresh">` | Renderer (Markup) strips before `document.write`; SDK (URL) cannot strip post-load — relies on container backstop |
| Anything that bypasses bridge interception | Container load-event monitoring (universal backstop) |

**`<a target="_top">` / `target="_parent"` is governed by `allowTopNavigationByUserActivation` (default `true`).** With the default, real user-clicked top-targeted anchors fall through to top-frame navigation as a fallback when SHARC's audit path is bypassed by the creative — the lowest-risk navigation in the threat model (user-initiated, requires gesture, IAB SafeFrame parity). Operators can opt out via `allowTopNavigationByUserActivation: false` to block top-nav entirely. The unsafe `allow-top-navigation` token (programmatic top-nav with no user gesture) is never present regardless of this flag. See DD-20.

**Container-side unauthorized-navigation detection (universal backstop):**

The bridges are best-effort. Adversarial creative HTML can re-override `window.open`, redefine `location` getters, or call `Object.defineProperty` on the patched accessors. The container provides a backstop that does not depend on JS-level enforcement and works identically for both variants.

The container counts iframe `load` events:
- **Expected sequence (Creative URL):** creative document loads from `creativeUrl`. One load event expected.
- **Expected sequence (Creative Markup):** renderer page loads → creative document loads (after `document.write` triggers the second load).
- **Any subsequent `load` event** beyond the expected sequence means the iframe navigated to a different URL outside the SHARC protocol path.
- **Container response:** terminate the session with `RENDERER_UNAUTHORIZED_NAVIGATION (2118)`; fire `onSecurityEvent` with type `unauthorized_navigation`.

This is browser-observable and cannot be bypassed by JS-level overrides — the load event fires regardless of what the creative HTML did. It does not *prevent* the navigation (browser already started it), but it ensures:
1. The operator's monitoring sees the unauthorized navigation immediately
2. The SHARC session terminates cleanly rather than continuing in a broken state
3. The user gesture that triggered the navigation is recorded as a SHARC event for fraud / abuse detection

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
| `2118` | `RENDERER_UNAUTHORIZED_NAVIGATION` | Iframe navigated outside the SHARC protocol path (in-frame `location.href`, anchor click, form submit, meta refresh that bypassed the renderer shim). Detected via load-event monitoring. |

Code numbers tentative — final assignment during implementation, fitting the existing `21xx` container-error range.

---

## Migration & Adoption

For container operators evaluating SHARC adoption — SSP product managers, ad-server architects, header-bidding-wrapper maintainers, publisher O&O ad ops.

**When to adopt:**

| If you... | Recommended path |
|---|---|
| Serve mobile in-app inventory via MRAID 3.0 | Adopt SHARC + MRAID bridge — existing creatives run unchanged |
| Serve web display via SafeFrame | Adopt SHARC + SafeFrame bridge — same story |
| Serve direct-sold inventory with hosted URLs | Adopt SHARC with Creative URL — no infrastructure change beyond the SDK |
| Serve header-bidding inventory via PUC | Stay on PUC; future PUC bridge offers convergence on demand |

**Rollout:** typical SSP green-light to first impression is **4–12 weeks** depending on existing SafeFrame/MRAID overlap. Spike (1–2 sprints) → staging integration (2–4 sprints) → production pilot (4–8 weeks) → full rollout.

**Infrastructure requirements:** see Acceptance Criteria § Documentation & Governance for the full list (renderer hosting, HTTP CSP, CORP header, storage-clearing strategy, monitoring integration, measurement vendor coordination). The renderer is a static HTML file with no per-request server-side logic — cacheable indefinitely, marginal CDN bandwidth cost, no origin compute.

**Adoption is strategic, not urgent.** SHARC does not deprecate SafeFrame in 0.7.0. The decision factors: cross-platform unification (SafeFrame is web-only), operator-controlled infrastructure (vs. GAM-hosted SafeFrame), and where future IAB WG investment is going. Widespread adoption maps to 1.0 and beyond; 0.7.0 is the foundation release.

**Reference deployments** are expected to land post-1.0 from dominant operators (GAM, Prebid Universal Creative, major SSPs). Until then, the GitHub Pages-hosted reference renderer (issue #55) is the canonical place to point production-shaped tests for integration validation.

---

## Future Work

Items considered during 0.7.0 development that are not in scope for this release. Each has a clear status, target version, tracking issue, and reasoning.

| Item | Status | Target | Tracking | Reasoning |
|---|---|---|---|---|
| SRI integrity verification (`creativeRendererIntegrity`) | Deferred | 1.0+ | #24 | Browser APIs do not support SRI on iframe `src` today; the work needs to specify a post-load probe protocol exchanging known asset hashes. Constructor option name is reserved. |
| Native ad support (rendering bridge or HTML native assembly) | Out of scope for 0.7.0; future work | 0.8+ or 1.x | (file an issue) | Two paths accommodate native without changing the 0.7.0 protocol — see below. Demand-driven. |
| Creative capability signaling | Out of scope; cross-WG dependency | TBD | (file an issue) | How operators know to use Creative Markup vs Creative URL is orthogonal to this proposal. Future IAB Tech Lab work in coordination with OpenRTB / AdCOM / Prebid may add a SHARC capability signal. |
| PUC compatibility bridge | Out of scope; Prebid.org coordination required | 0.8+ or 1.x | (file an issue) | See below. |
| IAB-managed canonical renderer at `renderer.sharc.iabtechlab.com` | Descoped from 0.7.0 | TBD or never | #25 | Long-tail publishers and certification labs may benefit; IAB Tech Lab may operate one as a deployment option in the future. The 0.7.0 protocol is designed to make the addition non-breaking. |
| Mediation chains (waterfall fallbacks) | Out of scope (architectural) | N/A | — | Mostly mobile in-app. Mediation operates below SHARC; SHARC sees the winning creative markup. |

### Status definitions

- **Out of scope** — not in 0.7.0, no commitment to ship in any version
- **Deferred** — not in 0.7.0, planned for a later release with a target
- **Descoped** — was considered for 0.7.0, removed during review

### Native ad support — two paths

Native ad JSON payloads (e.g. OpenRTB Native 1.2) come into SHARC without changing the 0.7.0 protocol via:

1. **HTML native assembly** — upstream layer (publisher template, ad server, SSP) converts native JSON to HTML, delivered to SHARC as Creative Markup. Works today; no protocol change required.
2. **Native rendering bridge** — analogous to existing MRAID/SafeFrame bridges, accepts native JSON and renders via a publisher-supplied template through the SHARC Creative API. Future work, demand-driven.

### PUC compatibility bridge

A SHARC **PUC compatibility bridge** — `examples/bridges/sharc-puc-bridge.js`, sibling to the existing MRAID, SafeFrame, and OMID bridges — would expose PUC's interface to creatives authored against PUC, translating PUC calls into SHARC messages. This lets PUC-authored creatives run inside a SHARC container without re-authoring. The bridge fits SHARC's existing pattern: legacy interface → bridge → SHARC protocol.

**Why deferred from 0.7.0:**
1. PUC's interface is informal and Prebid.org-versioned (no formal IAB spec). A stable bridge requires Prebid.org coordination on an interface contract, or version-pinning against a specific PUC release.
2. PUC evolves with Prebid.js releases, not IAB cadence. Maintaining the bridge means accepting upstream churn from a non-IAB project.
3. Most PUC features survive Creative Markup directly — plain HTML with scripts and CSS. The bridge becomes necessary only for PUC-specific macros, click helpers, native templating, and viewability hooks.

**Tone:** "we make PUC creatives work in SHARC containers," not "we replace Prebid." Collaborative coordination with Prebid.org, same pattern as IAB-Prebid coordination on OpenRTB extensions.

**Trajectory:** same as MRAID and SafeFrame — bridge exists for legacy compatibility, new creatives target SHARC's Creative API directly. Lands once SHARC protocol stabilizes and Prebid.org coordination is in motion.

---

## Design Decisions

The following questions were raised during proposal development and review, and are recorded here as a decision log. Each has a concrete resolution embedded in the spec; this table captures the *why* for future maintainers and WG reviewers who want to understand what alternatives were considered.

| # | Question | Decision |
|---|----------|----------|
| DD-1 | Should `creativeHtml` be exposed as an instance property? | **No.** It can be large (full ad markup). `creativeSource` is sufficient for diagnostics. |
| DD-2 | Should Creative URL's `useMarkupInjection` path be deprecated now that Creative Markup exists? | **Not yet.** Different semantics (fetched, falls back to src). Keep for 0.7.0; revisit before 1.0. |
| DD-3 | Does the renderer protocol need a version field? | **Yes — both `sharcVersion` and `rendererProtocolVersion`.** SHARC version covers SDK compatibility; renderer protocol version evolves independently. Renderer rejects unsupported versions via `SHARC:Renderer:failed` with `reason: 'unsupported_*'`. |
| DD-4 | Should the container accept `creativeRendererUrl` with a path that includes the creative as a query param? | **Out of scope.** The renderer receives HTML via postMessage, not via URL. How the renderer is parameterized is the operator's concern. |
| DD-5 | What is the renderer timeout error code? | **Add `RENDERER_TIMEOUT`, `RENDERER_FAILED`, `RENDERER_ORIGIN_MISMATCH`, `RENDERER_PROTOCOL_ERROR` in 0.7.0.** Pre-1.0, additive error codes are not breaking; deferring would create production-debug debt. |
| DD-6 | Should `form-action` be in the iframe CSP baseline? | **No.** Would break legitimate lead-gen creatives, newsletter signup units. Document as opt-in operator hardening for inventory that doesn't include forms. |
| DD-7 | Should the dev-origin guard treat `file://` as dev? | **No, deny by default.** Test harnesses should run on a local HTTP server (the existing dev workflow already does this). File-origin support adds attack surface without meaningful test workflow benefit. |
| DD-8 | Should the container scan `creativeHtml` for known-malicious patterns? | **No.** Markup scanning is unreliable (obfuscation, runtime fetch). The iframe-level CSP provides content-independent defense; that's the right layer. |
| DD-9 | Should the renderer URL convention use abstract version paths (`/v1/`, `/v2/`) or SHARC SDK semver (`/0.7.0/`)? | **SHARC SDK semver.** Aligns with the rest of the SHARC distribution model (npm, jsDelivr, CHANGELOG anchors, GitHub release tags). Removes the mental-translation step between SDK version and renderer URL. The path is a naming convention; the protocol-version handshake enforces actual compatibility. |
| DD-10 | Should the renderer be hosted on a shared public CDN (jsDelivr, unpkg) like the SDK files? | **No.** Shared CDN origin would mean all SHARC operator renderers share `cdn.jsdelivr.net`, defeating the per-operator origin separation that makes `allow-same-origin` safe. Operators must serve from their own origin (CDN-backed is fine). The SDK files can use shared CDNs because they execute in the publisher's origin, not their own. |
| DD-11 | What is SHARC's positioning relative to Prebid Universal Creative? | **Inspired by PUC, not attempting to disrupt it.** SHARC's primary mission is MRAID and SafeFrame replacement. Optional PUC compatibility bridge is tracked future work (see Deferred); convergence by demand, not displacement by mandate. |
| DD-12 | Should `allow-popups` be removed from the renderer iframe sandbox to prevent reverse-tabnabbing via creative-opened popups? | **No.** Click-throughs via `window.open(url, '_blank')` are a core creative behavior; removing `allow-popups` would break the majority of real creatives. Reverse-tabnabbing mitigation depends on creative authors using `rel="noopener"` or operators applying click-through interception in the renderer. Documented as a known residual risk. Popups create real problems but the cost of removing them exceeds the cost of accepting them as residual risk. |
| DD-13 | Should the renderer page set Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy / be cross-origin-isolated? | **No.** COOP `same-origin` would prevent publisher embedding (the opposite of what we need). COEP `require-corp` would require every creative-loaded subresource to opt in via CORP/CORS — most real RTB markup loads dozens of third-party resources from origins that have not opted in, so enabling COEP would break the majority of real creatives. Cross-origin isolation enables `SharedArrayBuffer`, which SHARC has no use for. |
| DD-14 | Should the renderer adopt Document Policy (`Document-Policy` header / `policy=` iframe attribute)? | **No.** Chromium-only experiment, deprecated path in favor of Permissions Policy for most practical use cases. Permissions Policy on the iframe (DD-12 area) covers the restrictions SHARC needs. |
| DD-15 | Should the renderer enforce Trusted Types (`require-trusted-types-for 'script'`) on its own response CSP? | **No.** Trusted Types enforcement would block `document.write(creativeHtml)` — the renderer's job IS to write arbitrary HTML. This directive is incompatible with the renderer's core function. Operators must verify their effective response CSP does not include this directive (some hardening tooling adds it by default). Trusted Types is appropriate for publisher-side scripts, not the renderer. |
| DD-16 | Should `onSecurityEvent` route through the W3C Reporting API instead of a custom callback? | **Hybrid: keep the custom callback, add CSP `report-to` recommendation.** Reporting API events are emitted by the browser, not by JS — there is no API to *emit* a Report from page code, only to observe browser-emitted reports. The custom callback gives operators stronger ordering guarantees (fires before `onError` for terminating events) than Reporting API can provide. Operators can additionally configure CSP `report-to` and `report-uri` on the renderer page to capture browser-emitted CSP violations alongside SHARC's structured events. The two channels serve different purposes. |
| DD-17 | Should publishers be able to disable popups entirely, separate from DD-12's "keep `allow-popups` by default"? | **Yes — `allowPopups: false` constructor option.** Removes `allow-popups` from the iframe sandbox; browser-enforced (unbypassable). Default remains `true` to preserve click-through behavior for the majority of inventory. Publishers with strict UX policies (kid-directed sites, financial services, healthcare, premium brands) can opt out cleanly. `SHARC.requestNavigation()` continues to work in both modes as the operator-controlled click-through path. |
| DD-18 | How should SHARC handle creative click-throughs that bypass `SHARC.requestNavigation()` — anchor tags, `window.location.href`, form submits, meta refresh? | **Bridge architecture + universal backstop.** Web-native (non-IAB-spec'd) navigation patterns are handled by a dedicated `sharc-navigation-bridge` (sibling to the existing MRAID, SafeFrame, OMID bridges in `examples/bridges/`). The bridge intercepts `window.open`, `location.href`/`assign`/`replace`, anchor click delegation, form submit delegation, and meta-refresh stripping — all routed through `SHARC.requestNavigation()`. **IAB-spec'd navigation stays in its own bridge:** MRAID navigation in `sharc-mraid-bridge`, SafeFrame navigation in `sharc-safeframe-bridge`. No overlap or duplication. **Bridge load points across variants:** Creative Markup imports the bridge in the renderer page before `document.write(creativeHtml)` (operator-controlled load point); Creative URL auto-loads the bridge via the SHARC Creative SDK at SDK init (creative-author-controlled SDK script placement, but SHARC SDK is required for either variant to function). Coverage is comprehensive in both variants when SHARC is correctly loaded. **Universal backstop:** the container counts iframe load events; any unexpected re-navigation terminates the session with `RENDERER_UNAUTHORIZED_NAVIGATION (2118)` and fires `onSecurityEvent` type `unauthorized_navigation`. JS-bypass-resistant. The earlier framing that "Creative Markup is more secure for click-through audit" was overstated — both variants converge on comprehensive coverage when used correctly. |
**Sandbox / policy configuration philosophy** (governs DD-19 through DD-25): SHARC exposes browser-level capability tokens (sandbox tokens, Permissions Policy features) via constructor options when an operator might legitimately want them either on or off. The pattern is **single boolean, never a tristate**, and **no constructor option ever exposes a token whose unsafe sibling has no legitimate use case** (e.g., `allow-top-navigation` without user activation, programmatic / no-gesture variants of capability tokens). Defaults split on a single test: **is the capability load-bearing for click-through or measurement?** If yes (creatives implicitly depend on it for the inventory to function), default permissive — operators upgrading from SafeFrame inventory get parity, security-strict deployments opt in to strict via `false`. If no (capability is UX-disruption surface where the cost-bearer is the publisher and the capability-grantee is the operator), default strict — operators with the use case opt in via `true`. This applies asymmetrically by design: `allowPopups` / `allowTopNavigationByUserActivation` / `allowStorageAccessByUserActivation` are click-through-or-measurement load-bearing → default `true`; `allowModals` / `allowDownloads` are UX-disruption surface → default `false`. The pattern emerged across DD-17, DD-19, DD-20, DD-23, and DD-25 and is named here so future maintainers asked "should `allowAutoplay` ship?" or "should we expose the next browser sandbox token?" have an explicit test rather than re-deriving it from prior DDs.

| DD-19 | What is the container's behavior when validation rule 7 carve-out applies (cross-origin top frame inaccessible)? | **Configurable via `wrapperPolicy` constructor option, default `'warn'`.** `'warn'` (default) emits `console.warn` + `onSecurityEvent` type `wrapper_top_frame_inaccessible` and proceeds with construction — matches the original 0.7.0 behavior and fits the common production topology (SHARC inside header-bidding wrappers, where the wrapper-cross-origin-to-top deployment is the common case). `'block'` emits `console.error` + the same structured event and **throws synchronously** at construction, recommended for security-strict deployments (regulated verticals, audit-required inventory) where the operator cannot independently verify the renderer URL won't collide with publisher origins. The default was kept as `'warn'` rather than `'block'` because flipping the default would break the dominant production deployment pattern (Prebid wrapper, SSP wrappers) without clear ecosystem benefit; security-strict operators have an explicit opt-in path via `'block'`. Blast-radius analysis is documented in Security Model § wrapper-cross-origin so operators can make informed configuration choices. |
| DD-20 | Should the renderer iframe permit top-frame navigation, and if so, in what form? | **`allow-top-navigation-by-user-activation` is on by default; configurable via `allowTopNavigationByUserActivation: boolean`. The unsafe `allow-top-navigation` token is never exposed.** The decision space had three options: (1) always allow user-activation top-nav, (2) always block, (3) configurable. Initial proposal locked option 2 (block) for strictest security posture. Industry-standard floor is `allow-top-navigation-by-user-activation` — IAB SafeFrame ships it by default; PUC's unsandboxed iframes implicitly allow full top-nav. Option 2 left SHARC stricter than SafeFrame, breaking standard `<a target="_top">` click-throughs out of the box and creating measurable adoption friction for operators upgrading from SafeFrame inventory. Option 3 (configurable, default permissive) achieves SafeFrame parity for adoption while preserving the strict opt-in for regulated verticals — same pattern as `allowPopups` (DD-17) and `wrapperPolicy` (DD-19), which both established the "permissive default + explicit opt-in to strict" precedent. The unsafe `allow-top-navigation` token is **deliberately not exposed** at any configuration level — auto-redirect / programmatic top-nav has no legitimate use case the proposal aims to support, and offering it as an escape hatch would be a permanent footgun. The boolean (`true`/`false`) rather than tristate (`'by-user-activation'`/`'block'`/`'always'`) reflects that the third state has no value to ship. The navigation bridge intercepts every iframe-internal navigation path (window.open, location, anchors, forms, meta-refresh) regardless of this flag — this option only governs whether real user-clicked `<a target="_top">` anchors can fall through to top-nav when SHARC's audit path is bypassed; that user-initiated path is the lowest-risk navigation in the threat model. |
| DD-21 | Should `allow-popups-to-escape-sandbox` be exposed as its own constructor option, or bound to `allowPopups`? | **Bound to `allowPopups`; not a separate option.** Without `allow-popups-to-escape-sandbox`, popups opened from the renderer iframe inherit SHARC's full sandbox token set — landing pages would degrade (no first-party cookies, no autoplay, restricted storage). SafeFrame includes this token by default for exactly this reason ([Chromium sample](https://googlechrome.github.io/samples/allow-popups-to-escape-sandbox/), [Mozilla bug 1190641](https://bugzilla.mozilla.org/show_bug.cgi?id=1190641) — both explicitly position the token as needed for ad iframes). The threat that omitting the token would mitigate (reverse-tabnabbing via `window.opener`) is **mitigated by best effort** through the navigation bridge's `noopener,noreferrer` injection on intercepted popup paths (AC: nav bridge intercepts `window.open()`); residual risk consistent with DD-12's accepted-popup-risk framing remains (creative can re-override `window.open` post-bridge-install, anchor click delegate is stompable, form `target="_blank"` submits and other paths the bridge does not fully cover). The proposal accepts this residual risk for the same reason DD-12 keeps `allow-popups`: the cost of removing the capability exceeds the cost of accepting bounded residual risk. The two tokens are functionally coupled: `allow-popups-to-escape-sandbox` is meaningless without `allow-popups` (no popups to escape). There is no coherent third state ("popups allowed but inheriting sandbox") with a production use case — sandboxed landing pages break, reverse-tabnab is already partly mitigated by the bridge, and binding both tokens to a single switch matches what every shipping browser does today. **Footnote on durability:** the binding holds *given current browser behavior* where `allow-popups-to-escape-sandbox` is meaningless without `allow-popups`. If a future browser ships a token that interacts with one but not the other, this DD needs revisiting. Low probability — these two have been paired across browsers for ~6 years — but not a permanent invariant. Single-switch principle wins: `allowPopups` controls both tokens together. Adding a separate toggle would be configuration surface area without product value. |
| DD-22 | Should the renderer iframe permit the Storage Access API (`document.requestStorageAccess()`)? | **Yes — `allow-storage-access-by-user-activation` on by default; configurable via `allowStorageAccessByUserActivation: boolean`.** Safari blocks third-party cookies entirely; Firefox blocks them by default with Total Cookie Protection; Chrome continues to support third-party cookies after Google retired the deprecation plan in October 2025. Measurement and identity vendors operating across all three browsers depend on the Storage Access API as the user-gesture-gated cross-site storage path on Safari/Firefox. Default-denying SAA would break those vendors on roughly half the desktop browser market and most of the iOS market. The token requires user activation (no silent storage-access escalation), and the access prompt is browser-mediated. Configurable per the standard pattern: default permissive for the cross-browser measurement surface, opt-out via `false` for strict deployments where the operator does not want any cross-site storage path available to creatives. |
| DD-23 | Should the renderer iframe permit `window.alert/confirm/prompt/print` and `beforeunload` by default? | **No — `allow-modals` is configurable via `allowModals: boolean`, default `false`.** Per the configuration philosophy preamble above, the test for default-permissive vs. default-strict is: **is the capability load-bearing for click-through or measurement?** `allow-popups`, `allow-top-navigation-by-user-activation`, and `allow-storage-access-by-user-activation` are — creatives implicitly depend on them for click-through and measurement to function, so default true is the right call. `allow-modals` is not — modals are a UX-disruption capability with narrower legitimate use cases (age gates on regulated inventory like alcohol/gambling, B2B subscription confirmations) and broader abuse surface (dialog-spam blocking the user session before browser throttling kicks in, dark-pattern `beforeunload` "are you sure you want to leave?" prompts). Publishers absorb the UX cost of bad creatives, not advertisers, so the cost-bearer and the capability-grantee diverge. Operators serving inventory that legitimately needs modals can opt in via `true`; the option is preserved for the use case but the default reflects "modals are an opt-in operator control, not a baseline capability." Pre-1.0, the default can flip to `true` later if real-world signal shows the use case is broader than expected; flipping `true` → `false` would break operators that came to depend on the default. |
| DD-24 | Should the renderer's Permissions Policy default-deny Privacy Sandbox APIs? | **No.** The original framing conflated two distinct cases that need to be separated. **(a) Active ad-tech surface — Private State Tokens (`private-state-token-issuance`, `private-state-token-redemption`).** PSTokens shipped, has SSP/DSP adoption for anti-fraud and abuse signaling, and survived Google's October 2025 Privacy Sandbox cleanup. Default-denying it would break legitimate active use. **Permit by default.** **(b) Retired Privacy Sandbox APIs — Topics (`browsing-topics`), Attribution Reporting (`attribution-reporting`), Shared Storage (`shared-storage`).** Google retired these in October 2025 citing low adoption and regulatory friction; attribution work moved to the W3C Private Advertising Technology Community Group (PATCG). The Permissions Policy *features* may persist in browsers for some transition period, governing APIs that nobody is calling. Default-denying them would buy SHARC nothing — there are no callers — but maintaining a deny list creates ongoing busywork as PATCG produces new attribution APIs under new feature names. **Don't deny by default**, for forward-compatibility. The original proposal's DD-24 claimed these APIs were "the IAB-aligned post-cookie measurement and auction paths" — that framing was wrong as of October 2025 and is updated here. Conflating "Privacy Sandbox APIs" with "sensitive APIs requiring user permission" was always a category error regardless: sensor/hardware/payment APIs prompt the user; ad-tech APIs do not. The Permissions Policy continues to default-deny everything that prompts the user (geolocation, camera, microphone, payment, usb, serial, clipboard, sensors, idle-detection, xr-spatial-tracking, web-share, screen-wake-lock) and federated identity (`identity-credentials-get` / FedCM, which is not ad-tech relevant). Operators that want stricter policy than this baseline can deny additional features at the renderer's HTTP `Permissions-Policy` response header layer — that intersects with the iframe `allow=` attribute, so the response header can be stricter than the iframe ceiling. **Re-evaluate this DD when W3C PATCG produces a Working Draft for its successor attribution work** — at that point, if the new APIs include a user-prompt surface, they need to move into the deny list per the same category test the rest of the policy uses. |
| DD-25 | Should the renderer iframe permit creative-initiated downloads (`<a download>`, `Content-Disposition: attachment`) by default? | **No — `allow-downloads` is configurable via `allowDownloads: boolean`, default `false`.** Asymmetric default vs. other configurable tokens, parallel to DD-23's reasoning. Legitimate use cases exist (ad-served PDFs, calendar invites `.ics`, vCards `.vcf`, coupon downloads, B2B lead-gen assets) but most legitimate flows route the asset through click-through to a landing page rather than direct iframe download — the publisher controls the click-through layer, the advertiser controls the landing page, and the user gets the file from a context they recognize. Direct iframe download bypasses that recognition and creates a broader abuse surface (drive-by downloads, social-engineering download prompts where the file appears to come from the publisher's site). Modern browsers require user gesture for most download flows and Safe Browsing scans downloads, but the trust break — "this site downloaded a file" — is a sharper UX cost than other ad capabilities. Operators serving inventory that legitimately needs in-iframe downloads (B2B catalogs, event-promotion `.ics`, healthcare/finance whitepaper distribution) can opt in via `true`; the option is preserved for the use case but the default reflects "downloads are an opt-in operator control, not a baseline capability." |

---

## Risks & Mitigations

Risks consolidated from prose sections for accountability. Mitigation details live in the linked sections.

| # | Risk | L × I | Mitigation |
|---|---|---|---|
| R-1 | Safari `Clear-Site-Data "storage"` gap leaves residual storage | H × H | Strategy A + B pairing for Safari traffic; Strategy C for strict isolation |
| R-2 | Embedded WebView host app strips CSP / CORP / Clear-Site-Data headers | M × H | Operators validate header pass-through end-to-end; fall back to Strategy C |
| R-3 | Browsers further restrict `document.write` for cross-origin iframes | M × H | Forward-compat fallback (`DOMParser` + `replaceChildren`); wire protocol unchanged |
| R-4 | Operator forks drift from canonical | H × M | Extension points + config + protocol-version-pinning; canonical commits to backward-compat extension surfaces |
| R-5 | Wrapper-cross-origin-to-top renderer URL collides with publisher origin | L × H | Documented as unsupported deployment; runtime `console.warn` + `onSecurityEvent` |
| R-6 | Service Worker on renderer origin defeats fragment-nonce | L × H | Operators MUST NOT register SWs on renderer origin (renderer implementation contract) |
| R-7 | Performance regression > 500ms vs. Creative URL on cold cache | M × M | Performance baseline AC with regression budget |
| R-8 | Measurement vendor allowlist coordination delays adoption | M × H | Pre-launch coordination with IAS/DV/Moat/OMID |
| R-9 | `rendererProtocolVersion` skew causes impression failures | M × H | Zero-downtime deployment pattern; alert on `RENDERER_PROTOCOL_ERROR` > 0.1% |
| R-10 | Privacy Sandbox evolves and tightens fenced-frame restrictions | M × H | Composition pattern (SHARC inside fenced frame) accommodates current restrictions; monitored upstream dependency |
| R-11 | WG pushback on key positions (PUC, allow-popups, no SRI in 0.7.0) | L–M × M | Positioning explicit in Design Decisions; FAQ pre-empts common objections |
| R-12 | No dominant-operator reference deployment post-launch | M × M | GitHub Pages hosting (#55) covers testing tier; outreach to GAM / PUC / major SSPs |

---

## Success Metrics

Aspirational targets giving the WG, sponsors, and SHARC team a shared definition of "this worked." Not commitments.

| Horizon | Metric | Target |
|---|---|---|
| 90 days | Distinct operators running 0.7.0 in production | ≥ 3 |
| 90 days | GitHub Pages reference renderer uptime | ≥ 99% |
| 90 days | `RENDERER_PROTOCOL_ERROR` rate (operator-shared) | < 0.1% of impressions |
| 90 days | Creative Markup P95 load time regression vs. Creative URL | ≤ +500ms |
| 90 days | Security incidents attributable to Creative Markup | 0 |
| 90 days | Upstream contributions to `examples/renderer/` | ≥ 1 |
| 12 months | Renderer hosted by ≥ 1 dominant operator (GAM / PUC / major SSP) | Yes |
| 12 months | Creative Markup share of SHARC impressions (opt-in reporting) | ≥ 30% |
| 12 months | Median operator-fork drift vs. canonical | < 200 LOC |
| 12 months | WebView platform deployments (iOS WKWebView + Android) | ≥ 1 each |

**Failure-mode triggers for a 6-month learning post-mortem:** operators preferring SafeFrame or PUC for new inventory; reference renderer stale (no commits in 90 days); WG engagement dormant; multiple operator forks diverging > 500 LOC from canonical.

---

## Acceptance Criteria

ACs are split into two categories:

- **Behavioral ACs** — testable through executable tests or browser-observable behavior. These are the engineering deliverables.
- **Documentation & Governance ACs** — verified by doc-presence checks or maintainer commitments. These are the governance deliverables.

This split lets each track its own owner: behavioral ACs map to test plans; documentation ACs map to docs review.

### Track Mapping

Which 0.7.0 implementation track owns delivery of each AC:

| Track | Issue | Owns |
|---|---|---|
| **Core protocol** | #41 | Constructor validation, renderer protocol, iframe configuration, message validation, `close()` cleanup, error codes, types |
| **Log tagging / structured events** | #42 | `onSecurityEvent` integration, structured event payload schema, event-type registry |
| **ES6 class syntax for bridges** | #33 | Independent of this proposal; tracked separately |
| **GitHub Pages + reference renderer + Creative Markup demo** | #55 | Reference renderer hosting, cross-origin testing harness, Creative Markup demo page |

**Critical dependency:** AC for cross-origin renderer testing depends on #55 going green. 0.7.0 cannot ship until #55 ships.

---

### Behavioral ACs

#### Constructor validation

- [ ] **#41** `creativeUrl` alone loads via iframe `src` (Creative URL, unchanged)
- [ ] **#41** `creativeHtml` + `creativeRendererUrl` uses renderer protocol (Creative Markup)
- [ ] **#41** `creativeHtml` without `creativeRendererUrl` throws `TypeError`
- [ ] **#41** `creativeRendererUrl` without `creativeHtml` throws `TypeError`
- [ ] **#41** `creativeUrl` + `creativeRendererUrl` throws `TypeError`
- [ ] **#41** `creativeUrl` + `creativeHtml` throws `TypeError`
- [ ] **#41** Neither `creativeUrl` nor `creativeHtml` throws `TypeError`
- [ ] **#41** Unparseable `creativeRendererUrl` throws `Error`
- [ ] **#41** `http://` `creativeRendererUrl` throws `Error`
- [ ] **#41** `javascript:` `creativeRendererUrl` throws `Error`
- [ ] **#41** `data:` `creativeRendererUrl` throws `Error`
- [ ] **#41** `blob:` `creativeRendererUrl` throws `Error`
- [ ] **#41** `file:` `creativeRendererUrl` throws `Error`
- [ ] **#41** `about:` `creativeRendererUrl` throws `Error`
- [ ] **#41** `creativeRendererUrl` with userinfo (`username` or `password` non-empty) throws `Error`
- [ ] **#41** Same-origin `creativeRendererUrl` (vs `window.location`) throws `Error`
- [ ] **#41** Same-origin `creativeRendererUrl` (vs `window.top.location` when accessible) throws `Error`
- [ ] **#41** `creativeHtml` exceeding 256 KiB throws `Error`
- [ ] **#41** Validation rule ordering surfaces shape errors (`TypeError`) before value errors (`Error`)

#### Iframe configuration

- [ ] **#41** Creative Markup renderer iframe gets `allow-same-origin` in sandbox
- [ ] **#41** Creative URL does NOT get `allow-same-origin` in sandbox
- [ ] **#41** Creative Markup iframe sets `csp="object-src 'none'; base-uri 'none'"`
- [ ] **#41** Creative Markup iframe sets `allow=` Permissions Policy matching the documented `SHARC_RENDERER_PERMISSIONS_POLICY` constant (default-deny across geolocation, camera, microphone, payment, usb, serial, clipboard-write, screen-wake-lock, sensors, web-share, idle-detection, xr-spatial-tracking, and identity-credentials-get)
- [ ] **#41** Permissions Policy does NOT deny `private-state-token-issuance` or `private-state-token-redemption` (Private State Tokens — actively used for anti-fraud as of October 2025), and does NOT deny the policy features for retired Privacy Sandbox APIs (`browsing-topics`, `attribution-reporting`, `shared-storage`) — permit-by-default keeps SHARC forward-compatible with W3C PATCG work without re-litigating per-API additions and removals (see DD-24)
- [ ] **#41** Creative Markup iframe sets `referrerpolicy="no-referrer"`
- [ ] **#41** Sandbox NEVER contains the unsafe `allow-top-navigation` token (no constructor option exposes it; auto-redirect / programmatic top-nav is unsupported by design)
- [ ] **#41** `allowPopups: true` (default) → sandbox includes BOTH `allow-popups` AND `allow-popups-to-escape-sandbox`
- [ ] **#41** `allowPopups: false` → sandbox includes NEITHER `allow-popups` NOR `allow-popups-to-escape-sandbox`; browser blocks creative `window.open()` calls
- [ ] **#41** `allow-popups-to-escape-sandbox` is NOT exposed as a separate constructor option; its presence is bound to `allowPopups` (DD-21)
- [ ] **#41** `SHARC.requestNavigation()` works regardless of `allowPopups` value
- [ ] **#41** `allowTopNavigationByUserActivation: true` (default) → sandbox includes `allow-top-navigation-by-user-activation`
- [ ] **#41** `allowTopNavigationByUserActivation: false` → sandbox does NOT include `allow-top-navigation-by-user-activation`; browser blocks creative `<a target="_top">` clicks even on user gesture
- [ ] **#41** `SHARC.requestNavigation()` and the navigation bridge work regardless of `allowTopNavigationByUserActivation` value
- [ ] **#41** `allowStorageAccessByUserActivation: true` (default) → sandbox includes `allow-storage-access-by-user-activation`
- [ ] **#41** `allowStorageAccessByUserActivation: false` → sandbox does NOT include the token; creative `document.requestStorageAccess()` calls fail
- [ ] **#41** `allowModals: false` (default) → sandbox does NOT include `allow-modals`; creative `alert/confirm/prompt/print/beforeunload` calls silently fail
- [ ] **#41** `allowModals: true` → sandbox includes `allow-modals`
- [ ] **#41** `allowDownloads: false` (default) → sandbox does NOT include `allow-downloads`; creative `<a download>` clicks and download-triggering responses are blocked by the browser
- [ ] **#41** `allowDownloads: true` → sandbox includes `allow-downloads`

#### Click-through routing (`sharc-navigation-bridge` + container detection)

- [ ] **#41** `sharc-navigation-bridge` ships in `examples/bridges/` as a first-class bridge module (sibling to `sharc-mraid-bridge`, `sharc-safeframe-bridge`, `sharc-omid-bridge`)
- [ ] **#41** Navigation bridge intercepts `window.open()`: injects `noopener,noreferrer`; routes URL through `SHARC.requestNavigation()`
- [ ] **#41** Navigation bridge intercepts `window.location.href` setter, `location.assign()`, `location.replace()`; routes through `SHARC.requestNavigation()`
- [ ] **#41** Navigation bridge: anchor click delegate (single document-level listener) routes both `target="_blank"` and no-target anchors through `SHARC.requestNavigation()`; defensively adds `rel="noopener noreferrer"`
- [ ] **#41** Navigation bridge: `<form>` submit delegate routes through `SHARC.requestNavigation()`
- [ ] **#41** Navigation bridge (renderer-side, Creative Markup only): strips `<meta http-equiv="refresh">` from `creativeHtml` before `document.write`
- [ ] **#41** Reference renderer (Creative Markup) imports `sharc-navigation-bridge` and installs it before `document.write(creativeHtml)` — operator-controlled load point
- [ ] **#41** SHARC Creative SDK auto-loads `sharc-navigation-bridge` at SDK init (Creative URL coverage)
- [ ] **#41** Container counts iframe `load` events; expected sequence is variant-specific: Creative URL = 1 load (creative doc), Creative Markup = 2 loads (renderer page + creative doc after `document.write`)
- [ ] **#41** Any iframe `load` event beyond the expected sequence terminates the session with `RENDERER_UNAUTHORIZED_NAVIGATION (2118)`
- [ ] **#42** `onSecurityEvent` fires with type `unauthorized_navigation` (severity: error) before container terminates
- [ ] **#41** MRAID bridge owns all MRAID-spec'd navigation (`mraid.open(url)`, etc.) and translates to `SHARC.requestNavigation()` (existing behavior; verified unchanged — no overlap with `sharc-navigation-bridge`)
- [ ] **#41** SafeFrame bridge owns all SafeFrame-spec'd navigation and translates to `SHARC.requestNavigation()` (existing behavior; no overlap with `sharc-navigation-bridge`)

#### Renderer protocol

- [ ] **#41** URL fragment nonce is appended to `creativeRendererUrl` (form: `#sharcNonce=<uuid>`)
- [ ] **#41** Nonce generation uses `crypto.randomUUID()` (CSPRNG) — implementation does not use `Math.random()`-based UUID
- [ ] **#41** `render` message includes `creativeHtml`, `placementSessionId`, `sharcNonce`, `sharcVersion`, `rendererProtocolVersion`, `containerOrigin` fields
- [ ] **#41** Container validates `event.source === iframe.contentWindow` on renderer replies (silent-ignore on mismatch)
- [ ] **#41** Container validates `event.origin === rendererOrigin` on renderer replies (silent-ignore on mismatch)
- [ ] **#41** Container validates `event.data.placementSessionId === this.placementSessionId` on renderer replies (silent-ignore on mismatch)
- [ ] **#41** Container terminates with `RENDERER_PROTOCOL_ERROR` when `rendered` reply is missing required fields or has wrong field types
- [ ] **#41** Container terminates with `RENDERER_PROTOCOL_ERROR` when `failed` reply is missing `reason` field
- [ ] **#41** Post-load origin echo: container verifies `event.data.rendererOrigin === rendererOrigin` on `rendered`; mismatch terminates with `RENDERER_ORIGIN_MISMATCH` and emits `console.error` with both origins
- [ ] **#41** `SHARC:Renderer:failed` reply terminates container with `RENDERER_FAILED` and includes the renderer-supplied `reason` in the failure context
- [ ] **#41** Iframe `load`-event timeout (5s) terminates with `RENDERER_TIMEOUT`
- [ ] **#41** `rendered` reply timeout (2s) terminates with `RENDERER_TIMEOUT`
- [ ] **#41** `close()` mid-render: rendered/failed reply timeout is cancelled
- [ ] **#41** `close()` mid-render: renderer message listener is removed
- [ ] **#41** `close()` mid-render: iframe element is removed from DOM
- [ ] **#41** `close()` mid-render: placement element is restored to pre-load state
- [ ] **#41** `close()` mid-render: late `rendered`/`failed` replies are ignored

#### Wrapper-cross-origin runtime detection

- [ ] **#41** Container emits one-time `console.warn` at construction when `wrapperPolicy: 'warn'` (default) and `window.top.location` access throws
- [ ] **#41** Container emits `console.error` and **throws synchronously** at construction when `wrapperPolicy: 'block'` and `window.top.location` access throws
- [ ] **#42** Container fires `onSecurityEvent` callback in BOTH `'warn'` and `'block'` modes with payload `{ type: 'wrapper_top_frame_inaccessible', severity: 'warning' | 'error', timestamp, placementSessionId, message, details: { wrapperOrigin, creativeRendererUrl } }`
- [ ] **#41** `wrapperPolicy: 'warn'` is the default (matches original 0.7.0 behavior); `'block'` is opt-in

#### Security event payload conformance

- [ ] **#42** `onSecurityEvent` payload for `wrapper_top_frame_inaccessible` conforms to documented schema
- [ ] **#42** `onSecurityEvent` payload for `renderer_origin_mismatch` conforms to documented schema (severity: 'error')
- [ ] **#42** `onSecurityEvent` payload for `renderer_protocol_error` conforms to documented schema (severity: 'error')
- [ ] **#42** `onSecurityEvent` payload for `renderer_failed` conforms to documented schema (severity: 'error')
- [ ] **#42** For terminating security events, `onSecurityEvent` fires before `onError`
- [ ] **#42** `onSecurityEvent` is optional — omitting it falls back to console-only signaling without breaking
- [ ] **#42** No `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy` headers are emitted by the reference renderer (cross-origin isolation is explicitly NOT enabled — see DD-13)

#### Metadata and observability

- [ ] **#41** Injection runs for Creative Markup if injectors are registered (regardless of `useMarkupInjection`)
- [ ] **#41** `creativeSource` is `'url'` for Creative URL, `'html'` for Creative Markup
- [ ] **#41** `creativeInjected` reflects whether injection ran and modified the markup
- [ ] **#41** `creativeRendered` is `false` for Creative URL, `true` for Creative Markup
- [ ] **#41** DOM stamp `data-sharc-creative-source` is always present (`'url'` or `'html'`) and cleaned up on close
- [ ] **#41** DOM stamp `data-sharc-creative-rendered` is always present (`'true'` or `'false'`) and cleaned up on close
- [ ] **#41** `placementSessionId` correlation prevents cross-instance message confusion when multiple SHARC containers are on the same page

#### Performance

- [ ] **#41** Test harness measures Creative Markup load time vs. Creative URL load time on a representative-sized payload (50 KiB markup); regression > 600ms (P95) fails the AC

#### Types and tests

- [ ] **#41** TypeScript types updated: `creativeUrl` becomes optional; `creativeHtml`, `creativeRendererUrl`, `onSecurityEvent` added; renderer message types exported
- [ ] **#41** Test coverage: all constructor validation errors
- [ ] **#41** Test coverage: both load variants happy-path
- [ ] **#41** Test coverage: injection across variants
- [ ] **#41** Test coverage: redirect detection (mock 30x redirect, verify `RENDERER_ORIGIN_MISMATCH` terminate)
- [ ] **#41** Test coverage: neighbor-frame forgery (sibling frame attempts `render` with stolen `placementSessionId`; verify renderer rejects)
- [ ] **#41** Test coverage: `close()` mid-render at every renderer protocol step

---

### Documentation & Governance ACs

#### Reference renderer

- [ ] **#41** Reference renderer ships in `examples/renderer/index.html` with inline comments
- [ ] **#41** Reference renderer supports the current `rendererProtocolVersion` and rejects unsupported versions via `SHARC:Renderer:failed { reason: 'unsupported_renderer_protocol' }`
- [ ] **#41** Reference renderer exposes named extension points (hooks like `onBeforeRender`, `onAfterRender`, `customSecurityLog`, `beforeStorageClear`)
- [ ] **#41** Reference renderer exposes a documented `RENDERER_CONFIG` object for operator-specific values
- [ ] **#41** Reference renderer's hook surface and config schema are documented in inline comments
- [ ] **#41** Reference renderer ships with `Clear-Site-Data: "storage"` HTTP header (Strategy A) plus JS-side clearing (Strategy B) as a fallback
- [ ] **#41** Reference renderer implements message validation (nonce, container-origin, source, version checks)
- [ ] **#41** Reference renderer implements storage clearing on each render
- [ ] **#41** Reference renderer is served with HTTP response CSP `object-src 'none'; base-uri 'none'`
- [ ] **#41** Reference renderer is served with `Cross-Origin-Resource-Policy: same-origin` HTTP response header
- [ ] **#41** Reference renderer does NOT set restrictive `X-Frame-Options` or CSP `frame-ancestors`
- [ ] **#41** Reference renderer's effective response CSP does NOT include `require-trusted-types-for 'script'` (would block `document.write`)
- [ ] **#41** Reference renderer detects Service Worker control at startup via `navigator.serviceWorker.controller` and `navigator.serviceWorker.getRegistrations()`; sends `SHARC:Renderer:failed` with `reason: 'service_worker_detected'` and aborts rendering if a SW is present on the renderer origin
- [ ] **#41** Reference renderer ships with a working proof-of-concept of the `DOMParser` + `replaceChildren` fallback (alternative to `document.write`); not the default code path but tested and verified to preserve script execution semantics. Insurance against future browser restrictions on `document.write` for cross-origin iframes.
- [ ] **#41** Reference renderer detects `document.write` failure or restriction at runtime (try/catch around the call; or feature-detect `document.write` availability) and gracefully falls back to the `DOMParser` path. Test coverage: simulate a `document.write` failure and verify the fallback completes the render and the SHARC bootstrap succeeds.

#### `onSecurityEvent` error-handling contract

- [ ] **#42** Callback is invoked synchronously; container does not `await` async callbacks
- [ ] **#42** If the callback throws, the container catches the exception, logs via `console.error`, and continues with its planned action (terminate-or-warn)
- [ ] **#42** A throwing callback never propagates to the caller of `new SHARCContainer(...)`
- [ ] **#42** `onSecurityEvent` does not fire twice for the same root cause within a single container instance (idempotency)

#### Documentation

- [ ] **#41** Renderer implementation contract documents Strategy C (ephemeral / per-tenant origins)
- [ ] **#41** Renderer implementation contract documents Safari Clear-Site-Data coverage gap and Strategy A + B pairing recommendation
- [ ] **#41** Renderer implementation contract documents JS-side clearing limitations (HttpOnly, indexedDB.databases, path/domain cookie variants)
- [ ] **#41** Renderer implementation contract explicitly documents `BroadcastChannel` cross-impression leakage gap — Strategy A and Strategy B do NOT clear `BroadcastChannel` state; only Strategy C (per-tenant origins) provides structural isolation. Operators with strict cross-advertiser isolation requirements need to know this is a real limitation, not a theoretical one.
- [ ] **#41** Renderer implementation contract prohibits Service Worker registration on renderer origin
- [ ] **#41** Renderer documentation includes embedded WebView caveat for `Clear-Site-Data` (host-app interception possible)
- [ ] **#41** Renderer documentation includes the zero-downtime version-sync deployment pattern (renderer-first, container-second, drop-old-support-last)
- [ ] **#41** Renderer documentation prohibits logging `location.href` or `location.hash` (nonce sensitivity)

#### Governance

- [ ] **N/A** Canonical maintainers commit to evolving the renderer hook surface and config schema in additive, backward-compatible ways across `rendererProtocolVersion`-stable SHARC releases (documented in CONTRIBUTING.md or equivalent)
- [ ] **#55** Cross-origin renderer testing works in dev harness (issue #23, superseded by #55)
- [ ] **#55** Reference renderer hosted at `<owner>.github.io/<repo>/renderer/` for testing (placeholder; resolves to whichever repo deploys — fork or upstream)

---

## Release Readiness Checklist

0.7.0 ships when:

- [ ] All Behavioral and Documentation/Governance ACs above pass
- [ ] **Hard dependency:** issue #55 (GitHub Pages + reference renderer + Creative Markup demo) shipped
- [ ] Performance baseline captured (Creative Markup vs. Creative URL P95) and within +500ms regression budget
- [ ] Version bump complete per `CLAUDE.md` checklist (`SHARC_VERSION`, `@version` tags, `package.json`, `package-lock.json`, README badge / CDN URLs); git tag `v0.7.0` published
- [ ] `CHANGELOG.md`, `docs/api-reference.md`, `docs/architecture-design.md` (renderer protocol anchors), `docs/creative-cookbook.md`, `docs/getting-started.md`, `docs/current-status.md` updated for 0.7.0

**Best-effort items** (alongside or shortly after GA, not hard blockers): measurement vendor coordination, WG sync on key positions, Prebid.org coordination conversation, supplementary materials (1-page executive summary, WG deck, blog post, security one-pager).

---

## FAQ

Anticipated questions for IAB Safe Ad Container WG members and operator product managers reviewing this proposal. Each links to the section that answers in full.

**Q: Why not just allow `creativeHtml` via bare `srcdoc`?**
A: It collapses the creative origin to `null`, silently breaking measurement SDKs (OMID, IAS, DV, Moat), `localStorage`, credentialed `fetch`, and CORS. Almost every RTB-delivered creative depends on at least one of these. See §Problem § Bare srcdoc breaks silently.

**Q: How is SHARC different from Prebid Universal Creative?**
A: Two axes: governance (IAB-standardized vs. Prebid.org-maintained) and scope (SHARC ships compatibility bridges for MRAID/SafeFrame; PUC is rendering-only). SHARC is inspired by PUC, not attempting to disrupt it. See Renderer Ownership Model § PUC differentiation and DD-11.

**Q: Will SHARC replace PUC?**
A: No. SHARC primary mission is MRAID + SafeFrame replacement. PUC compatibility bridge is tracked future work in Future Work § PUC compatibility bridge — but only if operators ask for it. Convergence by demand, not displacement by mandate.

**Q: Does this require COOP/COEP / cross-origin isolation?**
A: No. COOP `same-origin` would prevent publisher embedding; COEP `require-corp` would break most real RTB creatives that load non-CORP-opted-in third-party resources. See DD-13.

**Q: Why is `allow-popups` retained in the sandbox?**
A: Click-throughs via `window.open(url, "_blank")` are a core creative behavior; removing `allow-popups` by default would break the majority of real creatives. Publishers with strict UX policies can opt out via `allowPopups: false` (DD-17). The reference renderer hardens the popup path via the renderer shim regardless. See DD-12 and DD-17.

**Q: How does SHARC handle clicks that bypass `SHARC.requestNavigation()` — anchor tags, `window.location.href`, form submits?**
A: A dedicated `sharc-navigation-bridge` (sibling to MRAID/SafeFrame/OMID bridges) intercepts non-IAB-spec'd web-native navigation patterns and routes them through `SHARC.requestNavigation()`. The bridge handles `window.open`, `location.*`, anchor clicks, form submits, and meta refresh. IAB-spec'd navigation (MRAID `mraid.open()`, SafeFrame patterns) stays in its respective bridge. Container load-event monitoring is the universal JS-bypass-resistant backstop for both variants — any unexpected iframe re-navigation terminates the session with `RENDERER_UNAUTHORIZED_NAVIGATION`. See DD-18 and Security Model § Click-through enforcement.

**Q: Are Creative URL and Creative Markup equally secure for click-through audit?**
A: Yes, when used correctly. Both variants load the same `sharc-navigation-bridge` — Creative Markup via the renderer page, Creative URL via the SHARC Creative SDK at init. The variant difference is *who controls the bridge load point* (operator-controlled renderer vs. creative-author-controlled SDK script tag), not whether comprehensive coverage is achievable. SHARC SDK is required for either variant to function, so the recommended-loading-pattern requirement is implicit anyway. Container load-event monitoring is the universal backstop. See DD-18.

**Q: What is the deployment cost for a typical operator?**
A: Fork `examples/renderer/`, host it on the operator's CDN with appropriate HTTP CSP and CORP headers, point `creativeRendererUrl` at the hosted URL. Operational effort comparable to standing up a SafeFrame deployment. See Migration & Adoption.

**Q: How does the renderer URL stay in sync with the SHARC SDK version?**
A: Convention: renderer URL path uses the SHARC SDK version (`/0.7.0/`, `/0.8.0/`). Patch releases reuse the URL because `rendererProtocolVersion` does not bump on patches. Minor releases that bump the protocol require a coordinated renderer + container deploy. See Renderer URL Stability and § Container and renderer must upgrade together.

**Q: Why no Subresource Integrity (SRI) on the renderer URL in 0.7.0?**
A: Browser APIs do not currently support SRI on iframe `src`. The deferred work needs to specify what `creativeRendererIntegrity` actually does (likely a post-load probe message exchanging known asset hashes). Reserved for future minor version. See Future Work § SRI.

**Q: Does the renderer work in iOS WKWebView and Android WebView?**
A: Yes, with caveats around feature support (Permissions Policy, `csp=` attribute, `Clear-Site-Data`). See § WebView Compatibility.

**Q: What stops an operator from using `cdn.jsdelivr.net` to host the renderer like the SDK files?**
A: Origin sharing. The SDK files run in the publisher's origin (no security implication of shared CDN). The renderer must run in its own origin, distinct from every other operator. jsDelivr origin sharing would mean all SHARC operator renderers share `cdn.jsdelivr.net` — defeats the per-operator origin separation that makes `allow-same-origin` safe. See DD-10.

