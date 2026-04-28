# Proposal: Creative Payload Polymorphism (Forms 2 and 3)

**Author:** Jeffrey Carlson  
**Date:** 2026-04-27  
**Status:** Draft — pending architect review  
**Related:** Issue #41, #23 (cross-origin renderer testing), #24 (SRI — deferred), #25 (canonical renderer)

---

## Summary

SHARC currently requires a `creativeUrl` — a URL the container loads into an iframe via `src`. This is Form 1. This proposal adds two additional creative payload forms:

- **Form 2** — `creativeHtml`: raw HTML markup loaded directly via `srcdoc`. No URL required. Fits Prebid `bid.ad`, server-rendered tag responses, and header-bidding payloads that carry the markup inline.
- **Form 3** — `creativeHtml` + `creativeRendererUrl`: markup posted to a trusted cross-origin renderer page, which renders it in a real origin context. Eliminates the opaque-origin limitations of bare `srcdoc`.

All three forms share the same SHARC bootstrap handshake and state machine. The creative SDK is unaware of which form is in use.

---

## Problem

### Form 1 forces a URL where publishers already have the markup

The canonical real-time bidding path returns ad markup inline (`bid.ad` in OpenRTB, companion `AdParameters` in VAST). Publishers today must store that markup somewhere to produce a URL, or shim it with `blob:` / data URLs — neither is clean. `creativeHtml` should be a first-class constructor option.

### Bare srcdoc gives creatives an opaque origin

When `srcdoc` is used on a sandboxed iframe without `allow-same-origin`, the creative's origin is `null`. This breaks:
- `localStorage` / `sessionStorage` access
- `fetch` with `credentials: 'include'`
- CORS requests from the creative that expect a real origin
- Any measurement SDK that reads `document.domain` or `location.origin`

Form 3 solves this by loading a cross-origin renderer page via `src`, then posting the creative HTML to it. The renderer writes the HTML into its own document. The creative runs in the renderer's origin — a real HTTPS origin — with `allow-same-origin` safe to grant because the renderer is cross-origin to the publisher.

---

## Constructor Changes

### New Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `creativeHtml` | `string` | Conditional | Raw HTML markup for the creative. Mutually exclusive with `creativeUrl`. |
| `creativeRendererUrl` | `string` | No | HTTPS URL of a trusted renderer page. Requires `creativeHtml`. Must be cross-origin to the publisher page. |

### Validation Rules (enforced synchronously at construction)

1. Exactly one of `creativeUrl` or `creativeHtml` must be provided. Neither or both → throw.
2. `creativeRendererUrl` requires `creativeHtml`. `creativeRendererUrl` + `creativeUrl` → throw.
3. `creativeRendererUrl` must be HTTPS. HTTP or other schemes → throw.
4. `creativeRendererUrl` must be cross-origin to `window.location`. Same-origin → throw.

All four throw `Error` synchronously with a descriptive message. Pre-1.0 — no deprecation path.

### Updated `creativeUrl` instance property

`creativeUrl` remains on the instance for Form 1. For Forms 2 and 3, `creativeUrl` is `null`. The new `creativeSource` metadata property (see below) indicates the active form.

---

## Load Path Matrix

| | Form 1 | Form 2 | Form 3 |
|---|--------|--------|--------|
| Constructor input | `creativeUrl` | `creativeHtml` | `creativeHtml` + `creativeRendererUrl` |
| Iframe `src` / `srcdoc` | `src = creativeUrl` | `srcdoc = html` | `src = creativeRendererUrl` |
| Renderer protocol | None | None | `SHARC:Renderer:render` / `SHARC:Renderer:rendered` |
| Creative origin | Creative server's origin | `null` (opaque) | Renderer's origin |
| Iframe sandbox | No `allow-same-origin` | No `allow-same-origin` | `allow-same-origin` (safe — renderer is cross-origin) |
| Injection support | Yes (via `useMarkupInjection` fetch path) | Yes (inline — no fetch) | Yes (before posting to renderer) |
| `creativeSource` | `'url'` | `'html'` | `'html'` |
| `creativeRendered` | `false` | `false` | `true` |

---

## Form 2 — `creativeHtml` via `srcdoc`

### Load behavior

1. Container creates iframe with existing sandbox (`allow-scripts allow-forms allow-popups` — no `allow-same-origin`).
2. If extensions with `injectIntoMarkup` are registered, they run on `creativeHtml` in registration order.
3. `iframe.srcdoc = html` (possibly injected).
4. On iframe `load`, proceed with standard SHARC bootstrap (200ms delay, `initChannel`).

No fetch step. No CORS dependency. Injection is synchronous (markup is already in memory).

### Opaque-origin warning

If `creativeHtml` is provided without `creativeRendererUrl`, and the HTML contains a `<script` tag (heuristic), log a one-time `console.warn`:

```
[SHARCContainer] creativeHtml loaded via srcdoc — creative origin is null (opaque).
Scripts that require a real origin (localStorage, credentialed fetch, origin-checking
measurement SDKs) will not work. Use creativeRendererUrl to give the creative a real
origin, or ensure the creative is designed for opaque-origin sandboxed environments.
```

This is advisory only. The load proceeds.

---

## Form 3 — `creativeHtml` + `creativeRendererUrl` (Renderer Protocol)

### Iframe sandbox

Form 3 uses `allow-same-origin` on the renderer iframe because:
- The renderer is cross-origin to the publisher (validated at construction).
- `allow-scripts` + `allow-same-origin` on a cross-origin iframe is safe — it grants the renderer its own origin, not the publisher's.
- Without `allow-same-origin`, the creative running in the renderer would have a null origin, defeating the purpose of Form 3.

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

A reference renderer implementation ships with this feature (see Acceptance Criteria). The recommended technique for writing the HTML is `document.open() / document.write(html) / document.close()` — this replaces the renderer document while keeping `iframe.contentWindow` intact, so the subsequent SHARC port handshake reaches the creative SDK running in the renderer's window.

Timing guidance for the reference renderer: send `SHARC:Renderer:rendered` after `DOMContentLoaded` fires on the written document, not before. The `DOMContentLoaded` listener should be registered on `window` before calling `document.open()`.

### `placementSessionId` correlation

The container ignores `SHARC:Renderer:rendered` messages with a mismatched `placementSessionId`. This is the only validation required — full origin validation is enforced by the cross-origin construction guard.

---

## Injection Across Forms

`useMarkupInjection` semantics per form:

| Form | Injection behavior |
|------|--------------------|
| Form 1 (`creativeUrl`) | Unchanged — fetch URL, pipe through injectors, load via `srcdoc`. Falls back to direct `src` on fetch failure. |
| Form 2 (`creativeHtml`) | No fetch. Pipe `creativeHtml` through injectors synchronously. Load via `srcdoc`. `useMarkupInjection` flag is irrelevant — injection always runs if injectors are registered. |
| Form 3 (`creativeHtml` + `creativeRendererUrl`) | Same as Form 2 — synchronous injection. Injected HTML is what gets posted to the renderer in step 4. |

For Forms 2 and 3, injection runs regardless of `useMarkupInjection`. The flag only controls whether Form 1 performs a fetch.

---

## Metadata and Observability

### New instance properties

| Property | Type | Description |
|----------|------|-------------|
| `creativeSource` | `'url' \| 'html'` | `'url'` for Form 1, `'html'` for Forms 2 and 3. |
| `creativeInjected` | `boolean` | `true` if injection ran and at least one injector returned a non-empty modified string. |
| `creativeRendered` | `boolean` | `true` if Form 3 renderer protocol was used. |

### DOM stamping additions

Add to the **creative iframe** stamping (alongside existing `class="sharc-creative"` and `data-sharc-placement-session-id`):

| Attribute | Value | Notes |
|-----------|-------|-------|
| `data-sharc-creative-source` | `'url'` \| `'html'` | Reflects `creativeSource`. |
| `data-sharc-creative-rendered` | `'true'` | Only present when Form 3. Absent otherwise. |

`data-sharc-creative-injected` is intentionally omitted from DOM stamping — injection is an implementation detail the publisher page doesn't need to key off. It's available on the instance for logging and diagnostics.

### Log tagging

All `[SHARCContainer]` console output already prefixes the `placementSessionId`. No additional tagging change required for this proposal — that is covered by issue #42.

---

## Security Model

| Concern | Form 1 | Form 2 | Form 3 |
|---------|--------|--------|--------|
| Creative origin isolation | Cross-origin src | Opaque (null) | Renderer origin (cross-origin to publisher) |
| `allow-same-origin` | Absent | Absent | Present (safe — renderer is cross-origin) |
| Creative can access publisher DOM | No | No | No |
| Creative can access renderer's storage | N/A | N/A | Yes — this is the point |
| Publisher can read creative content | No | No | No |
| `creativeRendererUrl` must be HTTPS | N/A | N/A | Enforced at construction |
| `creativeRendererUrl` must be cross-origin | N/A | N/A | Enforced at construction |

### Threat: malicious renderer

The renderer is a trusted publisher-controlled (or IAB canonical) page. SHARC does not authenticate the renderer beyond URL validation. If the renderer origin is compromised, the creative runs in that compromised origin. This is equivalent to the publisher's own supply chain risk, not a new SHARC-introduced attack surface.

### Threat: creative HTML from untrusted source

If the publisher passes untrusted third-party markup as `creativeHtml`, the sandboxed iframe contains it regardless of form. Form 3 gives it a real origin, which may increase capability (e.g., localStorage access). Publishers should only use `creativeHtml` with markup from verified bid sources. Advisory warning (see Form 2 opaque-origin warning) covers the in-between case.

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
| OQ-4 | Should the container accept a `creativeRendererUrl` with a path that includes the creative as a query param? | Out of scope — the renderer receives HTML via postMessage, not via URL. How the renderer is parameterized is the publisher's concern. |
| OQ-5 | What is the renderer timeout error code? | Use `UNSPECIFIED_CONTAINER (2200)` for 0.7.0. File a follow-up to add `RENDERER_TIMEOUT` to the error code table before 1.0. |

---

## Acceptance Criteria

- [ ] `creativeHtml` without `creativeRendererUrl` loads via `srcdoc` (Form 2)
- [ ] `creativeHtml` + `creativeRendererUrl` uses renderer protocol (Form 3)
- [ ] `creativeUrl` + `creativeRendererUrl` throws at construction
- [ ] Neither `creativeUrl` nor `creativeHtml` throws at construction
- [ ] Both `creativeUrl` and `creativeHtml` throws at construction
- [ ] Non-HTTPS `creativeRendererUrl` throws at construction
- [ ] Same-origin `creativeRendererUrl` throws at construction
- [ ] Form 3 renderer iframe gets `allow-same-origin` in sandbox
- [ ] Forms 1 and 2 do NOT get `allow-same-origin` in sandbox
- [ ] `creativeHtml` with script tag and no `creativeRendererUrl` logs advisory warning (once only)
- [ ] Injection runs for Forms 2 and 3 if injectors are registered (regardless of `useMarkupInjection`)
- [ ] `creativeSource`, `creativeInjected`, `creativeRendered` are correct across all three forms
- [ ] DOM stamps `data-sharc-creative-source` and `data-sharc-creative-rendered` are applied and cleaned up on close
- [ ] Renderer timeout (5s) terminates the container with UNSPECIFIED_CONTAINER
- [ ] Reference renderer example ships in `examples/` with inline comments
- [ ] Cross-origin renderer testing works in dev harness (issue #23)
- [ ] TypeScript types updated: `creativeUrl` becomes optional; `creativeHtml` and `creativeRendererUrl` added
- [ ] Test coverage: all constructor validation errors, all three load forms, injection across forms
