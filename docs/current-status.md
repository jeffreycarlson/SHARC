# SHARC Current Status

## Summary

SHARC is an IAB Tech Lab reference implementation in active **pre-1.0** development.

- Repository package version: `0.5.3`
- npm publication status: **not yet published**
- Current implementation scope: **web iframe**, **iOS WKWebView**, **Android WebView**
- Current repo posture: suitable for technical evaluation and standards review; not yet presented here as a broadly adopted production release line

## What Is Stable Enough to Read as Current

The following are the most reliable descriptions of the present implementation:

- [api-reference.md](./api-reference.md)
- [architecture-design.md](./architecture-design.md)
- bridge design docs under [`docs/design/`](./design)
- the current source and generated `dist/` artifacts
- [CHANGELOG.md](../CHANGELOG.md) — what shipped in `0.5.3` and earlier

As of `0.5.3`, every public package subpath ships generated TypeScript declaration files (`.d.ts`) alongside its `.mjs` bundle. TypeScript consumers get full IntelliSense and compile-time argument validation when importing any subpath.

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
