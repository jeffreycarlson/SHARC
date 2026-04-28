# Proposal: Creative Payload Polymorphism (Form 2 — Renderer Protocol)

**Author:** Jeffrey Carlson  
**Date:** 2026-04-27  
**Status:** Draft — pending architect review  
**Related:** Issue #41, #23 (cross-origin renderer testing), #24 (SRI — deferred), #25 (canonical renderer — descoped)

---

## Summary

SHARC currently requires a `creativeUrl` — a URL the container loads into an iframe via `src`. This is **Form 1**. This proposal adds:

- **Form 2** — `creativeHtml` + `creativeRendererUrl`: markup posted to a trusted cross-origin renderer page operated by the same entity that operates the container. The renderer writes the HTML into its own document, giving the creative a real origin.

A bare-`srcdoc` form (markup without a renderer) was considered and rejected. It would give the creative a null origin and silently break measurement SDKs, `localStorage`, credentialed `fetch`, and CORS — exactly the things RTB-delivered creatives depend on. An advisory warning would not prevent the failure mode for the most common use case (bid markup containing third-party measurement). Pre-1.0, `creativeHtml` always requires `creativeRendererUrl`.

Both forms share the same SHARC bootstrap handshake and state machine. The creative SDK is unaware of which form is in use.

---

## Problem

### Form 1 forces a URL where operators already have the markup

The canonical real-time bidding path returns ad markup inline (`bid.ad` in OpenRTB, companion `AdParameters` in VAST). Container operators today must store that markup somewhere to produce a URL, or shim it with `blob:` / data URLs — neither is clean. `creativeHtml` should be a first-class constructor option.

### Bare srcdoc is a foot-gun

When `srcdoc` is used on a sandboxed iframe without `allow-same-origin`, the creative's origin is `null`. This breaks:
- `localStorage` / `sessionStorage` access
- `fetch` with `credentials: 'include'`
- CORS requests from the creative that expect a real origin
- Any measurement SDK that reads `document.domain` or `location.origin`

Almost every RTB-delivered creative contains third-party measurement (OMID, IAS, DV, Moat) that depends on a real origin. Allowing `creativeHtml` without a renderer would silently fail for the most common use case. Form 2 — `creativeHtml` + `creativeRendererUrl` — is the only sound way to ship inline markup with predictable behavior.

---

## Renderer Ownership Model

**The container operator owns the renderer URL.** Whoever instantiates `new SHARCContainer(...)` is responsible for hosting and operating the renderer page that `creativeRendererUrl` points to. Container and renderer are part of the same supply chain.

The container operator may be:

| Operator | Hosts the renderer at |
|---|---|
| Publisher O&O | Publisher's CDN |
| SSP-provided container (PubMatic, Magnite, Index, etc.) | SSP's CDN |
| Ad server (GAM-style) | Ad server's CDN |
| Header bidding wrapper (Prebid + tech partner) | Wrapper's CDN |

This mirrors how MRAID and SafeFrame work in practice — the SDK ships, but the runtime is hosted by SSPs, ad servers, and header bidders. There is no neutral third party magically hosting it.

### Stock implementation + operator tweaks

The SHARC repository ships a reference renderer at `examples/renderer/index.html`. Operators are expected to:

1. Take the reference implementation as the starting point.
2. Host it on their own infrastructure (their origin, their SLA).
3. Patch as needed — bug fixes, CSP tightening, custom measurement hooks, audit logging.

The protocol contract (`SHARC:Renderer:render` / `SHARC:Renderer:rendered`, message shape, timing) is invariant. The implementation is operator-tweakable.

### IAB canonical renderer (#25) — descoped from this proposal

A canonical IAB-hosted renderer at `renderer.sharc.iabtechlab.com` may exist as one option for operators that prefer a managed dependency. The 0.7.0 protocol does **not** assume it exists, default to it, or depend on its operational availability. Operators that choose to use it do so explicitly via `creativeRendererUrl`.

---

## Constructor Changes

### New Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `creativeHtml` | `string` | Conditional | Raw HTML markup for the creative. Mutually exclusive with `creativeUrl`. Requires `creativeRendererUrl`. |
| `creativeRendererUrl` | `string` | Conditional | HTTPS URL of an operator-hosted renderer page. Required when `creativeHtml` is provided. Must be cross-origin to the publisher page. |

### Validation Rules (enforced synchronously at construction)

1. Exactly one of `creativeUrl` or `creativeHtml` must be provided. Neither or both → throw.
2. `creativeHtml` requires `creativeRendererUrl`. Missing → throw.
3. `creativeRendererUrl` requires `creativeHtml`. `creativeRendererUrl` + `creativeUrl` → throw.
4. `creativeRendererUrl` must be HTTPS. HTTP or other schemes → throw.
5. `creativeRendererUrl` must be cross-origin to `window.location`. Same-origin → throw.

All five throw `Error` synchronously with descriptive messages. Pre-1.0 — no deprecation path.

### Updated `creativeUrl` instance property

`creativeUrl` remains on the instance for Form 1. For Form 2, `creativeUrl` is `null`. The new `creativeSource` metadata property (see below) indicates the active form.

---

## Load Path Matrix

| | Form 1 | Form 2 |
|---|--------|--------|
| Constructor input | `creativeUrl` | `creativeHtml` + `creativeRendererUrl` |
| Iframe `src` / `srcdoc` | `src = creativeUrl` | `src = creativeRendererUrl` |
| Renderer protocol | None | `SHARC:Renderer:render` / `SHARC:Renderer:rendered` |
| Creative origin | Creative server's origin | Renderer's origin |
| Iframe sandbox | No `allow-same-origin` | `allow-same-origin` (safe — renderer is cross-origin) |
| Injection support | Yes (via `useMarkupInjection` fetch path) | Yes (before posting to renderer) |
| `creativeSource` | `'url'` | `'html'` |
| `creativeRendered` | `false` | `true` |

---

## Form 2 — `creativeHtml` + `creativeRendererUrl` (Renderer Protocol)

### Iframe sandbox

Form 2 uses `allow-same-origin` on the renderer iframe because:
- The renderer is cross-origin to the publisher (validated at construction).
- `allow-scripts` + `allow-same-origin` on a cross-origin iframe is safe — it grants the renderer its own origin, not the publisher's.
- Without `allow-same-origin`, the creative running in the renderer would have a null origin, defeating the purpose of Form 2.

Full sandbox: `allow-scripts allow-same-origin allow-forms allow-popups`

### Load sequence

```
1. Create iframe, set src = creativeRendererUrl
2. Wait for iframe 'load' event
3. Run injection on creativeHtml (if extensions registered)
4. container → renderer: postMessage({ type: 'SHARC:Renderer:render', html, placementSessionId }, rendererOrigin)
5. Await renderer → container: postMessage({ type: 'SHARC:Renderer:rendered', placementSessionId })
   — Timeout: 5 seconds. On expiry: terminate with UNSPECIFIED_CONTAINER error.
6. On receipt of 'rendered': proceed with standard SHARC bootstrap (200ms delay, initChannel)
```

The `rendererOrigin` for step 4 is derived from `creativeRendererUrl` at construction time.

### Renderer protocol messages

**Container → renderer** (via `iframe.contentWindow.postMessage`):

```javascript
{
  type: 'SHARC:Renderer:render',
  html: string,            // injected creative HTML
  placementSessionId: string  // for correlation; renderer echoes it back
}
```

**Renderer → container** (via `window.parent.postMessage`):

```javascript
{
  type: 'SHARC:Renderer:rendered',
  placementSessionId: string  // must match; mismatches are ignored
}
```

### Renderer implementation contract

The renderer page is responsible for:
1. Listening for `SHARC:Renderer:render` on `window`.
2. Validating `placementSessionId` (echo-back only — no need to verify against a list).
3. Writing the received HTML into the document.
4. Sending `SHARC:Renderer:rendered` to `window.parent` after the creative HTML has loaded.

The reference renderer ships in `examples/renderer/`. Operators are expected to fork it. The recommended technique for writing the HTML is `document.open() / document.write(html) / document.close()` — this replaces the renderer document while keeping `iframe.contentWindow` intact, so the subsequent SHARC port handshake reaches the creative SDK running in the renderer's window.

Timing guidance for the reference renderer: send `SHARC:Renderer:rendered` after `DOMContentLoaded` fires on the written document, not before. The `DOMContentLoaded` listener should be registered on `window` before calling `document.open()`.

### `placementSessionId` correlation

The container ignores `SHARC:Renderer:rendered` messages with a mismatched `placementSessionId`. This is the only validation required — full origin validation is enforced by the cross-origin construction guard.

---

## Injection Across Forms

`useMarkupInjection` semantics per form:

| Form | Injection behavior |
|------|--------------------|
| Form 1 (`creativeUrl`) | Unchanged — fetch URL, pipe through injectors, load via `srcdoc`. Falls back to direct `src` on fetch failure. |
| Form 2 (`creativeHtml` + `creativeRendererUrl`) | No fetch. Pipe `creativeHtml` through injectors synchronously. Injected HTML is what gets posted to the renderer in step 4. `useMarkupInjection` flag is irrelevant — injection always runs if injectors are registered. |

For Form 2, injection runs regardless of `useMarkupInjection`. The flag only controls whether Form 1 performs a fetch.

---

## Metadata and Observability

### New instance properties

| Property | Type | Description |
|----------|------|-------------|
| `creativeSource` | `'url' \| 'html'` | `'url'` for Form 1, `'html'` for Form 2. |
| `creativeInjected` | `boolean` | `true` if injection ran and at least one injector returned a non-empty modified string. |
| `creativeRendered` | `boolean` | `true` if Form 2 renderer protocol was used. |

### DOM stamping additions

Add to the **creative iframe** stamping (alongside existing `class="sharc-creative"` and `data-sharc-placement-session-id`):

| Attribute | Value | Notes |
|-----------|-------|-------|
| `data-sharc-creative-source` | `'url'` \| `'html'` | Reflects `creativeSource`. |
| `data-sharc-creative-rendered` | `'true'` | Only present when Form 2. Absent otherwise. |

`data-sharc-creative-injected` is intentionally omitted from DOM stamping — injection is an implementation detail the publisher page doesn't need to key off. It's available on the instance for logging and diagnostics.

### Log tagging

All `[SHARCContainer]` console output already prefixes the `placementSessionId`. No additional tagging change required for this proposal — that is covered by issue #42.

---

## Security Model

| Concern | Form 1 | Form 2 |
|---------|--------|--------|
| Creative origin isolation | Cross-origin src | Renderer origin (cross-origin to publisher) |
| `allow-same-origin` | Absent | Present (safe — renderer is cross-origin) |
| Creative can access publisher DOM | No | No |
| Creative can access renderer's storage | N/A | Yes — this is the point |
| Publisher can read creative content | No | No |
| `creativeRendererUrl` must be HTTPS | N/A | Enforced at construction |
| `creativeRendererUrl` must be cross-origin | N/A | Enforced at construction |

### Threat: malicious renderer

The renderer is operator-controlled and part of the same supply chain as the container. If the renderer origin is compromised, the creative runs in that compromised origin. This is equivalent to the operator's own supply chain risk, not a new SHARC-introduced attack surface.

The protocol's job is to provide *isolation between creative and publisher*, not isolation between operator and operator's own renderer. Container operators that fork the reference renderer accept responsibility for its security posture — same as forking and operating the container itself.

### Threat: untrusted creative HTML

If the operator passes untrusted third-party markup as `creativeHtml`, the sandboxed iframe contains it regardless. Form 2 gives the markup a real origin (the renderer's), which may increase capability (e.g., localStorage access). Operators should only use `creativeHtml` with markup from verified bid sources.

---

## Timeouts

| Event | Timeout | On expiry |
|-------|---------|-----------|
| `SHARC:Renderer:rendered` | 5 seconds | Terminate with UNSPECIFIED_CONTAINER |
| `createSession` (all forms) | 5 seconds (unchanged) | Terminate with 2212 |
| `Container:init` resolve | 2 seconds (unchanged) | Terminate with 2208 |
| `Container:startCreative` resolve | 2 seconds (unchanged) | Terminate with 2213 |

---

## Deferred: SRI Integrity Verification (#24)

Issue #24 proposes SRI-style hash verification for `creativeRendererUrl`. This is explicitly deferred to a future minor version. The constructor option name is reserved: `creativeRendererIntegrity` (mirrors the HTML `integrity` attribute convention). No implementation in 0.7.0.

---

## Open Questions

| # | Question | Recommendation |
|---|----------|---------------|
| OQ-1 | Should `creativeHtml` be exposed as an instance property? | No. It can be large (full ad markup). `creativeSource` is sufficient for diagnostics. |
| OQ-2 | Should Form 1's `useMarkupInjection` path be deprecated now that Form 2 exists? | Not yet. Form 1 injection has different semantics (fetched, falls back to src). Keep for 0.7.0; revisit before 1.0. |
| OQ-3 | Does the renderer protocol need a version field? | Yes — add `sharcVersion` to the `render` message so the renderer can reject incompatible versions early. |
| OQ-4 | Should the container accept a `creativeRendererUrl` with a path that includes the creative as a query param? | Out of scope — the renderer receives HTML via postMessage, not via URL. How the renderer is parameterized is the operator's concern. |
| OQ-5 | What is the renderer timeout error code? | Use `UNSPECIFIED_CONTAINER (2200)` for 0.7.0. File a follow-up to add `RENDERER_TIMEOUT` to the error code table before 1.0. |

---

## Acceptance Criteria

- [ ] `creativeUrl` alone loads via iframe `src` (Form 1, unchanged)
- [ ] `creativeHtml` + `creativeRendererUrl` uses renderer protocol (Form 2)
- [ ] `creativeHtml` without `creativeRendererUrl` throws at construction
- [ ] `creativeRendererUrl` without `creativeHtml` throws at construction
- [ ] `creativeUrl` + `creativeRendererUrl` throws at construction
- [ ] `creativeUrl` + `creativeHtml` throws at construction
- [ ] Neither `creativeUrl` nor `creativeHtml` throws at construction
- [ ] Non-HTTPS `creativeRendererUrl` throws at construction
- [ ] Same-origin `creativeRendererUrl` throws at construction
- [ ] Form 2 renderer iframe gets `allow-same-origin` in sandbox
- [ ] Form 1 does NOT get `allow-same-origin` in sandbox
- [ ] Injection runs for Form 2 if injectors are registered (regardless of `useMarkupInjection`)
- [ ] `creativeSource`, `creativeInjected`, `creativeRendered` are correct across both forms
- [ ] DOM stamps `data-sharc-creative-source` and `data-sharc-creative-rendered` are applied and cleaned up on close
- [ ] Renderer timeout (5s) terminates the container with UNSPECIFIED_CONTAINER
- [ ] Reference renderer ships in `examples/renderer/index.html` with inline comments and operator-fork guidance
- [ ] Cross-origin renderer testing works in dev harness (issue #23)
- [ ] TypeScript types updated: `creativeUrl` becomes optional; `creativeHtml` and `creativeRendererUrl` added
- [ ] Test coverage: all constructor validation errors, both load forms, injection across forms
