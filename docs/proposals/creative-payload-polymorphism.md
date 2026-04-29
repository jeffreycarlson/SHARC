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
- Constructor options: `creativeHtml`, `creativeRendererUrl`, `onSecurityEvent`
- Instance properties: `creativeSource`, `creativeInjected`, `creativeRendered`
- DOM stamps: `data-sharc-creative-source`, `data-sharc-creative-rendered`
- Error codes: `2114` `RENDERER_TIMEOUT`, `2115` `RENDERER_FAILED`, `2116` `RENDERER_ORIGIN_MISMATCH`, `2117` `RENDERER_PROTOCOL_ERROR`
- Message types: `SHARC:Renderer:render`, `SHARC:Renderer:rendered`, `SHARC:Renderer:failed`
- Security event types: `wrapper_top_frame_inaccessible`, `renderer_origin_mismatch`, `renderer_protocol_error`, `renderer_failed`

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

**Canonical source, distributed runtime.** The SHARC repository at `github.com/IABTechLab/SHARC` is the single source of truth for the spec, SDK, and reference implementations. The runtime — containers, renderers, bridges — is hosted by operators in distributed infrastructure. One canonical specification; many independent deployments. This pattern matches HTTP, OpenRTB, and MRAID — and for the same reasons: the spec evolves in one place where the whole ecosystem can review and contribute, while execution happens at the edge where each operator owns their SLA, security posture, and deployment cadence.

The implications run through everything in this section: operators stay close to canonical and contribute improvements back upstream (so the canonical stays the strongest implementation), but they own the runtime where their contractual obligations actually live (so the IAB doesn't take on operational responsibility for everyone's ad delivery).

**The container operator owns the renderer URL.** Whoever instantiates `new SHARCContainer(...)` is responsible for hosting and operating the renderer page that `creativeRendererUrl` points to. Container and renderer are part of the same supply chain.

The container operator is, in approximate order of impression volume on the open web:

| Operator | Hosts the renderer at |
|---|---|
| **Ad servers (GAM dominates)** | Ad server's CDN |
| **Header bidding wrappers (Prebid Universal Creative dominates)** | Wrapper's CDN |
| **Publisher O&O ad ops (direct-sold inventory)** | Publisher's CDN |
| **SSP-managed wrappers (OpenWrap, Magnite Demand Manager, etc.)** | SSP's CDN |

This mirrors how MRAID and SafeFrame work in practice — the SDK ships, but the runtime is hosted by ad servers and header bidders. There is no neutral third party magically hosting it. Notably, GAM's SafeFrame at `tpc.googlesyndication.com` is the de facto canonical-hosted runtime for the dominant share of web display impressions. There is no IAB-neutral SafeFrame runtime because GAM's market share made one unnecessary. SHARC follows the same pattern: the IAB ships the spec, operators host the runtime, and dominant operators (likely GAM and Prebid Universal Creative) become the de facto reference deployments.

**Prebid Universal Creative is the closest live precedent for the renderer pattern. SHARC is inspired by PUC, not attempting to disrupt it.** PUC is hosted by Xandr (formerly AppNexus) at `acdn.adnxs.com/puc/` (or operator forks) and renders inline ad markup from header bidding wins — same architectural shape as SHARC's Creative Markup variant. It works at internet scale; the operator-hosted-renderer model is not theoretical.

SHARC differs from PUC on two axes that matter to operators and to WG reviewers:

**1. Governance — IAB-standardized vs. Prebid.org-maintained.** PUC operates under Prebid.org's governance, which works for the Prebid ecosystem but leaves the rendering layer outside the IAB standards process. No formal compatibility commitment across PUC versions, no neutral governance for breaking changes, no IAB-ratified security review. SHARC takes the same architectural pattern and brings it inside IAB Tech Lab's Safe Ad Container WG: spec evolution under neutral standards governance, formal compatibility guarantees, the same audit posture as MRAID and SafeFrame.

**2. Scope — rendering layer only vs. unified container with compatibility bridges.** PUC is a rendering layer. It puts markup on the page. It does not expose a MRAID API to the creative, does not expose a SafeFrame API, does not provide a unified container interface for cross-platform delivery. When a PUC-rendered creative happens to gain MRAID or SafeFrame APIs, those APIs come from whatever wraps PUC (GAM SafeFrame embedding it, mobile SDK providing MRAID externally) — not from PUC itself. Migrating an existing MRAID or SafeFrame creative to PUC requires re-authoring the creative against PUC's interface.

SHARC ships with compatibility bridges as first-class deliverables (`examples/bridges/`):

| Bridge | What it does |
|---|---|
| `sharc-mraid-bridge` | Exposes the MRAID 3.0 API surface to the creative; translates `mraid.expand()`, `mraid.resize()`, `mraid.close()`, `mraid.open()`, etc. into SHARC messages |
| `sharc-safeframe-bridge` | Exposes `$sf.ext.expand()`, `$sf.ext.collapse()`, `$sf.ext.geom()`; maps to SHARC `requestPlacementChange` |
| `sharc-omid-bridge` | OMID measurement integration |

A creative authored against MRAID 3.0 runs inside a SHARC container without modification — the MRAID bridge handles the translation. Same for SafeFrame. This is what makes SHARC a true MRAID/SafeFrame *successor* rather than another rendering option to add to the stack. Operators don't have to choose between "support MRAID inventory" and "support inline RTB markup" — SHARC handles both, in one container.

**SHARC's primary mission is MRAID and SafeFrame replacement** — providing an IAB-standardized cross-platform secure container for the inventory those specs serve today (mobile in-app, web display direct-sold, ad-server-served inventory). PUC and the header-bidding rendering path it serves are a separate concern; SHARC is not positioned to replace PUC or displace Prebid.

In practice, many creatives currently rendered by PUC — plain HTML with scripts and CSS, no PUC-specific helpers — already work through SHARC's Creative Markup variant today, no bridge required. PUC-specific authoring patterns (macro substitution, native templating, click helpers, viewability hooks) would need a future PUC compatibility bridge if operators ask for it. See the PUC compatibility bridge entry in the Deferred section for the planned path.

**Inspired by PUC, not attempting to disrupt it. Opportunities to converge over time where it makes sense.** SHARC operates primarily on non-Prebid inventory channels in 0.7.0 — the safe-ad-container replacement story for MRAID and SafeFrame stands on its own. Optional PUC bridge support can land later when operators serving header-bidding inventory through SHARC ask for it. This leaves Prebid's ecosystem intact, gives operators a non-confrontational migration path, and avoids picking a fight SHARC doesn't need to win.

### Stock implementation + operator tweaks

The SHARC repository ships a reference renderer at `examples/renderer/index.html`. Operators are expected to:

1. Take the reference implementation as the starting point.
2. Host it on their own infrastructure (their origin, their SLA).
3. Patch as needed — bug fixes, CSP tightening, custom measurement hooks, audit logging.

The protocol contract (`SHARC:Renderer:render` / `SHARC:Renderer:rendered`, message shape, timing) is invariant. The implementation is operator-tweakable.

**Stay close to canonical — file improvements back upstream.** Operators are strongly encouraged to file issues and pull requests back to the SHARC repository for any fix or improvement that isn't operator-specific (bug fixes, security hardening, browser-compatibility patches, performance improvements, broader CSP refinements, observability hooks). Forks that drift far from the canonical reference become a maintenance burden — each version upgrade becomes a re-merge of accumulated private patches against a moving upstream, and improvements one operator discovers don't propagate to peers.

The ecosystem health argument is concrete: SHARC's security guarantees rest on the reference implementation being the most-reviewed, most-battle-tested implementation in the wild. Every private patch that stays private weakens this — the reference renderer ages while operators carry undocumented changes, and the next reviewer auditing SHARC has to audit each operator's fork separately. Conversely, fixes upstreamed back to the canonical reference compound: every operator that pulls from `main` benefits from every other operator's contributions.

Operator-specific changes that legitimately don't belong upstream (operator branding, internal audit logging, integration with operator-specific monitoring) should be kept as a thin layer over a recent canonical version — not buried in a fork that has drifted three versions back. The goal is a small operator delta against current canonical, not a divergent long-lived branch.

| Belongs upstream (file an issue/PR) | Belongs in operator's private fork |
|---|---|
| Bug fixes in the renderer protocol logic | Operator branding (logo, page title) |
| Security hardening (CSP refinements, header tightening) | Internal audit logging endpoints |
| Browser compatibility patches | Operator-specific monitoring integration |
| Performance improvements (load time, message handling) | Customer support hooks |
| Observability improvements (event types, structured payloads) | Operator-internal feature flags |
| Documentation, comments, or contract clarifications | Operator-specific deployment scripting |

### Container and renderer must upgrade together

The renderer protocol version is part of the SHARC SDK's contract — every SHARC SDK version expects a specific `rendererProtocolVersion` (or set of supported versions) on the other side of the postMessage handshake. **When an operator upgrades their SHARC SDK, the renderer they host MUST be upgraded in the same release window**, or impressions will fail with `SHARC:Renderer:failed { reason: 'unsupported_*' }`.

This is enforceable infrastructure, not just guidance:
- The container's `SHARC:Renderer:render` message includes `sharcVersion` and `rendererProtocolVersion` (see Renderer Protocol Messages).
- The renderer rejects with `SHARC:Renderer:failed` if either is unsupported.
- Mismatches are loud, not silent — operators see the failure immediately in monitoring via `onSecurityEvent`, not as slowly degrading impression rates weeks after a deploy.

**Recommended deployment pattern (zero-downtime version sync):**

1. **Stage:** test SDK upgrade and renderer upgrade together in staging before any production deployment.
2. **Renderer first:** deploy the new renderer version with backward compatibility — i.e. the new renderer accepts both the old and new protocol versions during the transition window.
3. **Container second:** roll out the SHARC SDK upgrade in containers. Old containers continue working with the renderer's backward-compatible code path; new containers start using the new protocol version.
4. **Drop old support last:** once monitoring confirms all containers are on the new SDK, drop the old protocol version from the renderer.

This is the standard server-deploys-before-clients pattern from API versioning anywhere else: the server side (renderer) ships forward-compatibility before clients (containers) start using new features. SHARC's renderer protocol uses this pattern directly.

The versioned-paths recommendation in the next subsection (Renderer URL Stability) is the operational tool that makes this pattern easy: an operator running both `https://renderer.operator.com/0.7.0/` and `/0.8.0/` in parallel during a transition can roll out container SDK upgrades gradually without coordinated cutover.

### Managing operator tweaks across upstream changes

The "stay close to canonical" principle creates an operational question: how do operators maintain their tweaks against an evolving canonical without redoing the work on every release? Three architectural patterns reduce the merge surface so operators can ship private changes and still pull canonical updates routinely.

**1. Extension points over inline edits.** The reference renderer exposes named hooks (e.g. `onBeforeRender`, `onAfterRender`, `customSecurityLog`, `beforeStorageClear`) that operators register handlers against without modifying canonical code. Operators whose tweaks fit cleanly into hooks have near-zero merge conflict surface; upstream changes don't touch their hook implementations. Inline edits should be a last resort, reserved for tweaks the canonical genuinely cannot anticipate.

**2. Configuration over code.** Operator-specific values (branding strings, audit endpoints, feature flags, monitoring endpoints, custom CSP additions) live in a `RENDERER_CONFIG` object or external config file the operator owns. Canonical code reads from configuration; operators update configuration, not code. Same merge-conflict-minimization argument as hooks.

**3. The renderer protocol version is the upgrade trigger — not the SHARC SDK version.** `rendererProtocolVersion` is independent of the SHARC SDK version. A SHARC SDK patch release (0.7.0 → 0.7.1) does NOT bump the renderer protocol version, so operators do NOT need to update their renderer for every SDK release — only when the protocol actually changes (typically minor releases: 0.7.x → 0.8.0). This dramatically reduces re-merge cadence: the operator updates the renderer once per protocol-breaking SHARC release, not once per SHARC release.

**Operator upgrade workflow:**

1. Watch the SHARC repo for releases. Each release notes whether `rendererProtocolVersion` changed.
2. **If unchanged:** do nothing on the renderer. Continue running the operator's existing renderer build against the new SDK; the protocol handshake will succeed because both ends still target the same protocol version.
3. **If changed:** pull canonical changes into a working branch, reapply operator delta (or update hook/config registrations as needed), test against operator's staging, deploy renderer + SDK together per the zero-downtime pattern above.

This combination — **extension points + configuration + protocol-version-pinning** — lets operators maintain tweaks indefinitely without falling behind canonical. The discipline asks operators to architect their tweaks to live cleanly *outside* the canonical code, not to avoid tweaks entirely. Operators that follow this pattern can typically merge canonical updates as a fast-forward rebase; operators that inline-edit canonical code will pay merge cost on every protocol-version bump.

**Architectural commitment from canonical:** the reference renderer in `examples/renderer/` ships with the hook surface and configuration object documented in its inline comments. As the renderer evolves, the canonical maintainers are responsible for evolving these extension surfaces in additive, backward-compatible ways. Operator tweaks built on the documented hook/config surface should never break across `rendererProtocolVersion`-stable SHARC releases.

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

**Recommended pattern for renderer evolution without URL changes:** ship SHARC-versioned paths under a stable origin, mirroring the way the SDK is distributed via npm/jsDelivr (`https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.6.2/dist/sharc-container.js`). The renderer URL convention is:

```
https://renderer.operator.com/<sharc-version>/
```

Examples:
- `https://renderer.operator.com/0.7.0/` — renderer forked from SHARC SDK 0.7.0
- `https://renderer.operator.com/0.8.0/` — renderer forked from SHARC SDK 0.8.0 (alongside the still-running 0.7.0)

The version segment names the SHARC SDK version the renderer was forked from. Origin stays stable; new container instances reference the new path; old instances continue using the old path until they're updated. This decouples renderer evolution from coordinated deployment and pairs naturally with the `rendererProtocolVersion` field — the protocol-version handshake is what actually enforces compatibility, not the URL path. The path convention is a human-friendly naming guide, not a security boundary.

**Why SHARC version, not abstract `/v1/`, `/v2/`:** the rest of the SHARC distribution model (npm package versions, jsDelivr URLs, CDN paths, CHANGELOG anchors, GitHub release tags) all use semantic version numbers. Renderer URLs using the same versions removes the mental-translation step operators would otherwise have to do between "SHARC SDK 0.7.x ↔ renderer protocol v1." If you're running SHARC 0.7.x in your container, you point at `/0.7.0/` (or whichever 0.7.x release you forked from); if you upgrade to 0.8.x, you fork again and point at `/0.8.0/`.

**Patch releases reuse the URL.** SHARC SDK 0.7.0 → 0.7.1 (patch — bug fix, no protocol change) does NOT require a new renderer URL. The operator's container can continue pointing at `https://renderer.operator.com/0.7.0/`; the protocol handshake succeeds because the protocol version is unchanged. Operators who *want* to redeploy the renderer with the patch fix can do so under the same URL — same protocol, same naming, just freshened content.

**Minor releases that don't change the protocol** (rare but possible) similarly reuse the URL. The convention is: bump the renderer URL when `rendererProtocolVersion` bumps, not on every SHARC SDK release. The version segment names the *SHARC SDK release the renderer was forked from*, which is typically — but not strictly — the release that introduced the current protocol version.

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

**Full sandbox:** `allow-scripts allow-same-origin allow-forms allow-popups`

### Iframe-level CSP, Permissions Policy, and referrer policy

The container sets the following on the renderer iframe element:

| Attribute | Value | Purpose |
|---|---|---|
| `csp` | `object-src 'none'; base-uri 'none'` (baseline) | Defense-in-depth against `<base href>` redirection and plugin-content (`<object>`/`<embed>`) injection — both real attack vectors against arbitrary creative HTML. Chromium-only; HTTP-response CSP on the renderer is the portable enforcement layer (see Renderer Implementation Contract). |
| `allow` (Permissions Policy) | `geolocation 'none'; camera 'none'; microphone 'none'; payment 'none'; usb 'none'; serial 'none'; clipboard-write 'none'; screen-wake-lock 'none'; accelerometer 'none'; gyroscope 'none'; magnetometer 'none'; web-share 'none'; idle-detection 'none'; xr-spatial-tracking 'none'; browsing-topics 'none'; attribution-reporting 'none'; identity-credentials-get 'none'; private-state-token-issuance 'none'; private-state-token-redemption 'none'` | Default-deny across sensitive browser features (sensors, hardware, payments, identity, Privacy Sandbox APIs). Adversarial creative HTML cannot escalate to user-permission prompts or invoke Privacy Sandbox APIs it has no business calling. Stronger than `sandbox` for these features — `sandbox` doesn't cover most of them. |
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
- **Not set restrictive `X-Frame-Options` or CSP `frame-ancestors`** on the renderer response. The renderer is designed to be embedded as an iframe by arbitrary publisher origins; setting `X-Frame-Options: DENY/SAMEORIGIN` or `frame-ancestors 'self'` will break SHARC. Security-conscious operators following typical hardening guides will be tempted; document this in deployment runbooks.
- **Set `Cross-Origin-Resource-Policy: same-origin`** on the renderer HTTP response. CORP doesn't block iframe embedding (that's `frame-ancestors`/`X-Frame-Options`'s job), but it does block adversaries from loading the renderer page as an `<img>` / `<script>` / other subresource type to read its bytes. One-line config change, real protective value.
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

**Unsupported deployment configuration:** SHARC running inside a wrapper iframe cross-origin to the publisher top, with a `creativeRendererUrl` that may share origin with any publisher top the wrapper is embedded into, is an **unsupported deployment**. The wrapper-context fallback in validation rule 7 cannot detect this case. Operators in this configuration MUST guarantee `creativeRendererUrl` is not same-origin with any publisher top their wrapper is embedded into. If they cannot make that guarantee, they MUST NOT deploy SHARC in this configuration.

**Runtime detection — two-channel signal:** The container detects the wrapper-cross-origin-to-top condition at construction by attempting `window.top.location.origin` access inside a try/catch. When access throws (cross-origin top frame), the container emits the carve-out signal on **both a developer channel (`console.warn`) and a structured-event channel (`onSecurityEvent` callback)**. Production observability platforms hook the structured channel; developers see the console message in dev/staging.

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

The iframe-level `csp` attribute (CSP Embedded Enforcement / CSPEE) is **Chromium-only and unlikely to become portable**. Firefox marked their tracking work WONTFIX-leaning; Safari has never implemented it; standards work has effectively stalled. Relying on iframe `csp` alone leaves Firefox and Safari sessions unprotected from the threats the CSP baseline addresses (`<base href>` injection, plugin content via `<object>`/`<embed>`, etc.). The HTTP-response CSP layer is the durable answer, not a transitional one.

**The HTTP-response CSP served by the renderer is the portable enforcement layer.** The renderer implementation contract requires the renderer page's HTTP response to include CSP headers matching the iframe `csp` baseline:

```
Content-Security-Policy: object-src 'none'; base-uri 'none'
```

This is enforced by all major browsers (Chromium, Firefox, Safari, mobile WebKit) consistently. Operators forking the reference renderer MUST configure their hosting infrastructure (CDN, edge worker, origin response headers) to emit this CSP on the renderer page response.

**Iframe `csp` is layered on top as defense-in-depth where supported.** When both layers are present (HTTP response CSP + iframe `csp`), the effective policy is the intersection — both must permit a resource for it to load. Chromium enforces both; Firefox and Safari enforce only the HTTP response CSP. The HTTP layer is what makes the security model portable; the iframe layer is a Chromium-specific belt on the suspenders.

Operators that omit the HTTP response CSP get a security model that only works in Chromium. That is **not** a supported deployment for the SHARC security guarantee.

### Threat: click-jacking / tap-jacking

Not new to Creative Markup, but the increased capability via `allow-same-origin` makes timing attacks easier (the creative can read its own renderer's state). Mitigation is publisher-side (iframe positioning, transparency) and outside SHARC's protocol scope. Documented for completeness.

### Sandbox: top-frame navigation explicitly disallowed

`allow-top-navigation` and `allow-top-navigation-by-user-activation` are **intentionally absent** from the renderer iframe sandbox. Creative HTML running in the renderer cannot navigate the publisher's top frame, regardless of user activation. Click-throughs go through the standard `window.open(url, '_blank')` path under `allow-popups`, not via top-frame replacement.

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

## Migration & Adoption

This section is for **container operators evaluating SHARC adoption** — SSP product managers, ad-server architects, header-bidding-wrapper maintainers, publisher O&O ad ops teams.

### When to adopt SHARC vs. stay on existing infrastructure

| If you... | Recommended path |
|---|---|
| Serve mobile in-app inventory via MRAID 3.0 today | **Adopt SHARC + MRAID bridge.** Existing creatives run unchanged via the bridge; new creatives target SHARC directly. Cross-platform unification is the win. |
| Serve web display via SafeFrame today | **Adopt SHARC + SafeFrame bridge.** Same story — existing SafeFrame creatives run via the bridge. |
| Serve direct-sold inventory with hosted creative URLs | **Adopt SHARC with Creative URL.** No infrastructure change; same URL-based delivery as today, just inside the SHARC container. Easy entry point. |
| Serve header-bidding inventory rendered by PUC today | **Stay on PUC for now.** SHARC is not positioned to displace PUC. Future PUC compatibility bridge (deferred) will offer convergence when operators ask for it. |
| Build creative-server tools (DCO, dynamic insertion) | **No change required.** SHARC accepts the same HTML markup PUC and SafeFrame accept; macro substitution and dynamic creative composition work identically. |

### Sample rollout timeline (typical SSP)

| Phase | Duration | Activities |
|---|---|---|
| **Spike** | 1–2 sprints | Fork `examples/renderer/`, host in staging, point a test container at it, validate end-to-end |
| **Staging integration** | 2–4 sprints | Wire up CDN config (CSP/CORP headers), hook `onSecurityEvent` into observability, run cross-origin tests, coordinate with measurement vendors on origin allowlist |
| **Production pilot** | 4–8 weeks | Start with one publisher / one inventory tier; monitor `RENDERER_PROTOCOL_ERROR` rate, performance budget, measurement vendor reports |
| **Full rollout** | Variable | Depends on container distribution mechanism (SDK update cadence, CDN propagation, inventory contracts) |

Total green-light to first impression: **4–12 weeks** for a typical SSP, depending on existing SafeFrame/MRAID infrastructure overlap.

### Infrastructure checklist

| Item | Required? | Notes |
|---|---|---|
| Renderer hosting (origin + CDN) | Required | Operator-owned origin; CDN-backed serving infrastructure (Cloudflare, Fastly, CloudFront, Akamai). Cannot be shared CDN like jsDelivr — see DD-10. |
| HTTP CSP headers (`object-src 'none'; base-uri 'none'`) | Required | Portable enforcement layer; iframe `csp=` is Chromium-only. |
| `Cross-Origin-Resource-Policy: same-origin` header | Required | Prevents adversaries loading renderer as `<img>`/`<script>` subresource. |
| Restrictive `X-Frame-Options` / `frame-ancestors` | MUST NOT | Renderer must remain embeddable from arbitrary publisher origins. |
| `Clear-Site-Data: "storage"` header (Strategy A) | Recommended | Clears storage on each render; pair with Strategy B for Safari traffic. |
| Storage-clearing fallback (Strategy B) | Required if Strategy A coverage incomplete | JS-side clearing for browsers that don't fully support `Clear-Site-Data: "storage"`. |
| Per-tenant origin provisioning (Strategy C) | Optional | For strict cross-advertiser isolation requirements (high-value direct-sold, regulated verticals, Safari-heavy traffic). |
| Monitoring integration for `onSecurityEvent` | Recommended | Pipe structured events to SIEM / observability stack (Datadog, Sentry, custom). |
| `RENDERER_PROTOCOL_ERROR` rate alerting | Recommended | Threshold suggestion: alert if > 0.1% of impressions over 10-minute window. |
| Measurement vendor (IAS/DV/Moat/OMID) origin allowlisting | Required | Coordinate with measurement vendors before launch to avoid fraud-detection false positives. |
| Performance baseline measurement | Recommended | Capture Creative Markup load time vs. Creative URL on representative inventory before declaring rollout complete. |

### Operational characteristics

The renderer page is a static HTML file with no per-request server-side logic. Operational implications:

- **Cacheable indefinitely** at the CDN edge (use `Cache-Control: public, max-age=31536000, immutable` on versioned paths)
- **Marginal CDN bandwidth cost** — typical reference renderer is < 5 KiB; edge cache hit rate ≈ 99% at scale
- **No origin compute required** — TLS termination + static serving only
- **No per-impression server cost** for the renderer infrastructure itself (operator's existing observability and SIEM costs apply normally)

### Cost-of-staying-on-SafeFrame

For ad servers and SSPs currently relying on GAM's `tpc.googlesyndication.com` SafeFrame:

- **You can keep using SafeFrame.** SHARC does not deprecate SafeFrame in 0.7.0.
- **SafeFrame is not cross-platform.** It works on web display only; mobile in-app needs MRAID. SHARC unifies both under one container API.
- **SafeFrame is GAM-hosted.** Your security and SLA posture depends on GAM. If your contractual obligations require operator-controlled infrastructure (regulated verticals, security-conscious enterprise publishers), SHARC gives you that.
- **The IAB SafeFrame spec is mature but not evolving.** SHARC is where new IAB Tech Lab WG investment is going.

The decision to adopt SHARC is a strategic one for most operators today, not an urgent one. 0.7.0 is the foundation release; widespread adoption maps to 1.0 and beyond.

### Reference deployments to learn from

The dominant operator reference deployments are expected to land post-1.0:

- **GAM** — likely first major operator deployment given existing SafeFrame infrastructure
- **Prebid Universal Creative** — likely to add SHARC compatibility once the protocol stabilizes
- **Major SSPs** — PubMatic OpenWrap, Magnite Demand Manager, Index Exchange Wrapper

Until those land, the canonical reference is the SHARC repo's `examples/renderer/` plus the GitHub Pages-hosted reference renderer (issue #55) for development and integration testing. WG members and operators can point production-shaped tests at the GitHub Pages renderer to validate their integration before standing up their own infrastructure.

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

### PUC compatibility bridge (future work)

Prebid Universal Creative is the closest live precedent for SHARC's Creative Markup pattern (see Renderer Ownership Model). A SHARC **PUC compatibility bridge** — `examples/bridges/sharc-puc-bridge.js`, sibling to the existing MRAID, SafeFrame, and OMID bridges — would expose PUC's interface to a creative authored against PUC, translating PUC calls into SHARC messages. This lets the millions of header-bidding creatives currently authored against PUC's interface run inside a SHARC container without re-authoring.

The bridge fits SHARC's existing pattern: legacy interface → bridge → SHARC protocol. Same shape as `sharc-mraid-bridge` and `sharc-safeframe-bridge`. The implementation work is incremental.

**Why it's deferred from 0.7.0:**

1. **PUC's interface is informal and Prebid.org-versioned.** Unlike MRAID and SafeFrame which have formal IAB specs, PUC's contract is "what the code does." A stable bridge requires either coordination with Prebid.org maintainers on a formal interface contract, or version-pinning the bridge against a specific PUC release.
2. **PUC evolves with Prebid.js releases**, not on an IAB cadence. Maintaining a PUC bridge means accepting upstream churn from a non-IAB project.
3. **Most PUC features survive Creative Markup directly.** Plain HTML markup with `<script>` and CSS — which is the bulk of PUC inventory — runs in Creative Markup without a bridge. The bridge becomes necessary specifically for PUC's macro substitution, click-tracking helpers, native templating, and viewability hooks.

**Long-term trajectory:** the same as MRAID and SafeFrame — bridge exists for legacy compatibility, new creatives target the standardized interface (SHARC's Creative API directly) rather than the bridged interface. Operators serving header-bidding inventory get a transition path; creative authors gradually migrate to SHARC-native authoring.

**Coordination:** building this bridge well requires conversation with Prebid.org. Same pattern as IAB Tech Lab's coordination with Prebid on OpenRTB extensions — collaborative, not adversarial. SHARC's PUC bridge is "we make PUC creatives work in SHARC containers," not "we replace Prebid."

The Creative Markup variant in 0.7.0 establishes the foundation. The PUC bridge can land in 0.8+ or 1.x once the SHARC protocol is stable and Prebid.org coordination is in motion.

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

---

## Risks & Mitigations

Top risks for 0.7.0 implementation and rollout, with severity, likelihood, and mitigation status. The risks are documented in the relevant prose sections; this table consolidates them for accountability.

| # | Risk | Likelihood | Impact | Mitigation | Section |
|---|---|---|---|---|---|
| R-1 | Safari `Clear-Site-Data "storage"` coverage gap leaves residual storage state across impressions | High | High | Operators using Strategy A on Safari traffic MUST pair with Strategy B (JS-side clearing) or adopt Strategy C (per-tenant origins). Acknowledged in Renderer Implementation Contract. | §Renderer implementation contract |
| R-2 | Embedded WebView host app intercepts `Clear-Site-Data` / CSP / CORP headers | Medium | High | Operators serving inventory through embedded WebViews MUST validate header pass-through end-to-end; fall back to Strategy C if interception is observed. | §WebView Compatibility |
| R-3 | Browser deprecates `document.write` for cross-origin iframes | Medium | High | Forward-compat fallback documented: `DOMParser.parseFromString` + `replaceChildren` with script re-creation. Wire protocol unchanged. Quarterly review of browser-vendor signals recommended. | §Renderer implementation contract |
| R-4 | Operator forks drift from canonical, accumulating un-upstreamed patches | High | Medium | Extension points + configuration + protocol-version-pinning architecture (see §Managing operator tweaks). Discipline is operator responsibility; canonical maintainers commit to backward-compatible extension surfaces. | §Managing operator tweaks |
| R-5 | Wrapper-cross-origin-to-top deployments where renderer URL collides with publisher origin | Low | High | Documented as unsupported deployment configuration; runtime detection emits `console.warn` + `onSecurityEvent`. Cannot enforce from inside wrapper. Operator-only mitigation. | §Threat: SHARC container in a wrapper iframe |
| R-6 | Service Worker registered on renderer origin defeats fragment-nonce defense | Low | High | Documented prohibition in renderer implementation contract operational constraints. Operators MUST NOT register SWs on renderer origin. | §Renderer implementation contract |
| R-7 | Performance regression > 500ms vs. Creative URL on cold cache | Medium | Medium | Performance baseline AC; ongoing budget tracking. Reference renderer should be optimized for sub-second cold-cache load. | §Acceptance Criteria — performance |
| R-8 | Measurement vendor allowlist coordination delays adoption | Medium | High | Operators coordinate with IAS/DV/Moat/OMID before launch; pre-WG sync recommended. | §Migration & Adoption |
| R-9 | `rendererProtocolVersion` skew during operator deploy windows causes impression failures | Medium | High | Zero-downtime deployment pattern documented (renderer-first, container-second). Monitoring guidance: alert if `RENDERER_PROTOCOL_ERROR` > 0.1% over 10-min window. | §Container and renderer must upgrade together |
| R-10 | Privacy Sandbox / Protected Audience evolves; fenced-frame restrictions tighten | Medium | High | Out of SHARC's control. Documented as monitored upstream dependency. Composition pattern (SHARC inside fenced frame, not as fenced frame) accommodates current restrictions. | §Privacy Sandbox compatibility |
| R-11 | WG pushback on key positions (PUC framing, governance, allow-popups, no SRI in 0.7.0) | Low–Medium | Medium | Positioning explicit in Design Decisions; one-page FAQ for WG meetings recommended. | §FAQ, §Design Decisions |
| R-12 | No operator volunteers to host canonical reference renderer beyond IAB GitHub Pages testing tier | Medium | Medium | GitHub Pages hosting (#55) covers testing/dev; production adoption depends on dominant operators (GAM, PUC, major SSPs) becoming de facto reference deployments. Outreach plan needed. | §Migration & Adoption |

---

## Success Metrics

How we'll know 0.7.0 succeeded post-launch. These are aspirational targets, not commitments — they exist to give the WG, executive sponsors, and the SHARC team a shared definition of "this worked."

### 90-day post-launch metrics (post 0.7.0 GA)

| Metric | Target | Source |
|---|---|---|
| Distinct operators running 0.7.0 in production | ≥ 3 | Public commits, npm download segmentation, operator self-reporting |
| Cross-origin renderer testing harness uptime (GitHub Pages-hosted reference) | ≥ 99% over 90 days | Issue #55 deployment monitoring |
| `RENDERER_PROTOCOL_ERROR` rate in shared operator monitoring (opt-in) | < 0.1% of impressions | Operator-shared dashboards |
| Creative Markup load time P95 vs. Creative URL P95 on representative inventory | ≤ +500ms regression | Test harness benchmark |
| Reported security incidents attributable to Creative Markup | 0 | CVE feed, GitHub Security Advisories |
| Upstream contributions to `examples/renderer/` from operator forks | ≥ 1 | GitHub PR activity |
| Measurement vendor (OMID/IAS/DV/Moat) origin onboarding documented | ≥ 1 vendor | Public coordination, operator reports |

### 12-month post-launch metrics

| Metric | Target | Source |
|---|---|---|
| Renderer hosted by ≥ 1 dominant operator (GAM, Prebid Universal Creative, or major SSP) | Yes | Public infrastructure |
| WG-ratified compatibility commitment for 0.7.0 → 0.8.0 protocol transition | Yes | IAB Tech Lab Safe Ad Container WG |
| Creative Markup share of total SHARC impressions | ≥ 30% | Operator-shared reporting (opt-in) |
| Operator forks tracked vs. canonical (median drift in LOC) | < 200 LOC | Public fork analysis |
| WebView platform deployments (iOS WKWebView + Android WebView in production) | ≥ 1 each | Operator reports |

### Failure modes worth tracking

If any of the following are true at the 6-month mark, 0.7.0 has not landed cleanly and a learning post-mortem should publish:

- Operators are preferring SafeFrame or PUC for new inventory rather than SHARC
- Reference renderer in `examples/renderer/` has gone stale (no commits in 90 days)
- WG engagement on Safe Ad Container WG is dormant
- Multiple operators are running 0.7.0 forks that diverge significantly from canonical (> 500 LOC delta median)

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
- [ ] **#41** Creative Markup iframe sets `allow=` Permissions Policy matching the documented `SHARC_RENDERER_PERMISSIONS_POLICY` constant (default-deny across geolocation, camera, microphone, payment, usb, serial, clipboard-write, screen-wake-lock, sensors, web-share, idle-detection, xr-spatial-tracking, and Privacy Sandbox APIs)
- [ ] **#41** Creative Markup iframe sets `referrerpolicy="no-referrer"`
- [ ] **#41** Sandbox does NOT contain `allow-top-navigation` or `allow-top-navigation-by-user-activation` (creative cannot navigate publisher top frame)

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

- [ ] **#41** Container emits one-time `console.warn` at construction when `window.top.location` access throws (cross-origin top frame detected, validation rule 7 carve-out applied)
- [ ] **#42** Container fires `onSecurityEvent` callback (when registered) with payload `{ type: 'wrapper_top_frame_inaccessible', severity: 'warning', timestamp, placementSessionId, message, details: { wrapperOrigin, creativeRendererUrl } }`

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

#### Documentation

- [ ] **#41** Renderer implementation contract documents Strategy C (ephemeral / per-tenant origins)
- [ ] **#41** Renderer implementation contract documents Safari Clear-Site-Data coverage gap and Strategy A + B pairing recommendation
- [ ] **#41** Renderer implementation contract documents JS-side clearing limitations (HttpOnly, indexedDB.databases, path/domain cookie variants)
- [ ] **#41** Renderer implementation contract prohibits Service Worker registration on renderer origin
- [ ] **#41** Renderer documentation includes embedded WebView caveat for `Clear-Site-Data` (host-app interception possible)
- [ ] **#41** Renderer documentation includes the zero-downtime version-sync deployment pattern (renderer-first, container-second, drop-old-support-last)
- [ ] **#41** Renderer documentation prohibits logging `location.href` or `location.hash` (nonce sensitivity)

#### Governance

- [ ] **N/A** Canonical maintainers commit to evolving the renderer hook surface and config schema in additive, backward-compatible ways across `rendererProtocolVersion`-stable SHARC releases (documented in CONTRIBUTING.md or equivalent)
- [ ] **#55** Cross-origin renderer testing works in dev harness (issue #23, superseded by #55)
- [ ] **#55** Reference renderer hosted at `iabtechlab.github.io/SHARC/renderer/` for testing

---

## Release Readiness Checklist

0.7.0 is ready to ship when ALL of the following are green:

### Code & tests

- [ ] All Behavioral ACs above are passing
- [ ] All Documentation & Governance ACs above are verified
- [ ] `npm run build` produces clean `dist/` artifacts pinned to 0.7.0
- [ ] `npm run build:types` regenerates TypeScript declarations cleanly
- [ ] CI green on `main` (no test failures, no linter errors)
- [ ] Browser harness test passes: end-to-end Creative Markup load against the GitHub Pages-hosted reference renderer

### Infrastructure

- [ ] Issue #55 (GitHub Pages + reference renderer + Creative Markup demo) shipped — this is a hard prerequisite
- [ ] Reference renderer accessible at `iabtechlab.github.io/SHARC/renderer/` (or finalized URL)
- [ ] Creative Markup demo accessible at `iabtechlab.github.io/SHARC/demos/creative-markup/`
- [ ] Test harness can run cross-origin renderer tests

### Documentation

- [ ] CHANGELOG.md updated with 0.7.0 entry covering all changes in this proposal
- [ ] CHANGELOG.md notes any pre-1.0 breaking changes (per project convention — clean break, no aliases)
- [ ] Migration guide for 0.6.x → 0.7.0 published (likely combined with CHANGELOG)
- [ ] `docs/api-reference.md` updated with new constructor options, instance properties, message types, error codes
- [ ] `docs/architecture-design.md` updated with renderer protocol section (anchors `#renderer-protocol` and `#wrapper-cross-origin-deployment` referenced from console.error output)
- [ ] `docs/creative-cookbook.md` updated with Creative Markup pattern example
- [ ] `docs/getting-started.md` updated with Creative Markup mention
- [ ] `docs/current-status.md` reflects 0.7.0 release

### Versioning

- [ ] `package.json` and `package-lock.json` bumped to 0.7.0
- [ ] `SHARC_VERSION` constant in `sharc-protocol.js` set to `'0.7.0'`
- [ ] All `@version` JSDoc tags propagated to 0.7.0 via `scripts/sync-version.js`
- [ ] README badge and CDN URL examples updated to 0.7.0
- [ ] Git tag `v0.7.0` pushed; GitHub release notes published

### Performance

- [ ] Performance baseline captured: Creative Markup load time vs. Creative URL on representative inventory
- [ ] Performance budget published for 0.8.0 (P95 regression budget)

### Coordination (best-effort, not blocking)

- [ ] At least one measurement vendor (OMID, IAS, DV, Moat) coordinated on origin allowlisting
- [ ] WG sync scheduled or completed on key positions (PUC framing, `allow-popups` retention, governance)
- [ ] Prebid.org coordination conversation initiated (for the future PUC bridge track)

### Communication

- [ ] 1-page executive summary drafted (separate artifact, not in proposal)
- [ ] WG presentation deck drafted
- [ ] Blog post drafted announcing 0.7.0
- [ ] Security summary one-pager drafted for operator procurement teams

The "Coordination" and "Communication" items are best-effort and can land alongside or shortly after the 0.7.0 GA — they are not hard blockers for the engineering ship.

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
A: Click-throughs via `window.open(url, "_blank")` are a core creative behavior; removing `allow-popups` would break the majority of real creatives. Reverse-tabnabbing mitigation depends on creative authors using `rel="noopener"`. Documented as known residual risk. See DD-12.

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

