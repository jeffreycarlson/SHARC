# SHARC Current Status

## Summary

SHARC is an IAB Tech Lab reference implementation in active **pre-1.0** development.

- Repository package version: `0.6.0`
- npm publication status: **not yet published**
- Current implementation scope: **web iframe**, **iOS WKWebView**, **Android WebView**
- Current repo posture: suitable for technical evaluation and standards review; not yet presented here as a broadly adopted production release line

## What Is Stable Enough to Read as Current

The following are the most reliable descriptions of the present implementation:

- [api-reference.md](./api-reference.md)
- [architecture-design.md](./architecture-design.md)
- bridge design docs under [`docs/design/`](./design)
- the current source and generated `dist/` artifacts
- [CHANGELOG.md](../CHANGELOG.md) — what shipped in `0.6.0` and earlier

As of `0.6.0`, every public package subpath ships generated TypeScript declaration files (`.d.ts`) alongside its `.mjs` bundle. TypeScript consumers get full IntelliSense and compile-time argument validation when importing any subpath.

## What Shipped in 0.6.0

### Breaking changes

- **`placementId` / `placementName` are now `string|null`** — passing an empty string `''` normalizes to `null`. Code that compared these fields against `''` must be updated to check for `null`.
- **`sessionId` is now `null` before the `createSession` handshake completes** — previously unspecified; now explicit. Code that accessed `sessionId` synchronously at construction time should guard for `null`.
- **`containerEl` constructor option removed** — the option was renamed to `placementElement` in this release. Passing `containerEl` throws synchronously. Update all instantiation sites.
- **Close button `aria-label` changed** — updated from `"Close advertisement"` to `"Close ad"` to align with display conventions.

### New observability surface

**Placement identity fields** — `SHARCContainer` now accepts `placementId` and `placementName` as optional constructor options. Both normalize empty strings to `null` and are readable as instance properties after construction.

**`placementSessionId` instance property** — a UUID v4 generated at construction time, unique per `SHARCContainer` instance. Never `null`. Used for DOM stamping and diagnostics.

**DOM stamping** — on `load()`, `SHARCContainer` stamps `data-sharc-*` attributes onto the placement element (including `class="sharc-placement"`, `data-sharc-placement-session-id`, `data-sharc-state`, `data-sharc-intent`, `data-sharc-version`, and optionally `data-sharc-placement-id` / `data-sharc-placement-name`) and `class="sharc-creative"` / `data-sharc-placement-session-id` onto the creative iframe. All stamped attributes are removed on `close()`, restoring the element byte-for-byte.

**Isolation guard** — `SHARCContainer` throws synchronously at construction if `placementElement` already carries `class="sharc-placement"`, indicating it is already owned by another instance. The error message includes the existing `data-sharc-placement-session-id`. Call `close()` on the existing instance to release the element.

**`placementType` in `createSession`** — creatives now declare their placement type (`"inline"` | `"interstitial"`) in the `createSession` wire message. Omitting the field defaults to `"inline"`. See the [wire protocol reference](./api-reference.md).

## What to Treat Carefully

This repository also includes proposals, research notes, and review snapshots that were kept for context. They are helpful, but they are not all normative or current.

Use extra caution with:

- dated review documents
- proposal drafts
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

## Security Model Snapshot

For the web reference implementation, the container uses a sandboxed iframe with `allow-scripts allow-forms allow-popups` and intentionally excludes `allow-same-origin`.

SHARC communication uses a transferred `MessageChannel` port after bootstrap. Navigation and tracker execution are expected to be mediated by the container.

## External Readiness Notes

For external and standards-facing review, the clearest framing today is:

1. SHARC is real, implemented, and testable.
2. The implementation is still pre-release and should be described that way.
3. The authoritative documents are concentrated in a small subset of this repo.
4. Historical review and research material is preserved for transparency, not because every file reflects current policy.
