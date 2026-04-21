# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SHARC (Secure HTML Ad Richmedia Container) — IAB Tech Lab reference implementation for a secure container protocol between ad creatives and publisher pages. Think of it as a modern successor to MRAID/SafeFrame for rich media display ads.

## Architecture

- **Container SDK** (`examples/sharc-container.js`) — runs on the publisher page, manages the iframe lifecycle, placement changes, and the MessageChannel transport
- **Creative SDK** (`examples/sharc-creative.js`) — runs inside the ad iframe, provides the creative-facing API
- **Protocol** (`examples/sharc-protocol.js`) — shared message bus used by both sides; handles serialization, timeouts, and the port handshake
- **Bridges** (`examples/bridges/`) — compatibility layers mapping MRAID and SafeFrame APIs to SHARC

Transport: MessageChannel (port pair transferred via one-time postMessage). All subsequent communication through the dedicated port.

State machine: `loading → ready → active ↔ passive ↔ hidden → frozen → terminated` (aligned with Chrome/WebKit Page Lifecycle API).

## Running Locally

```bash
node examples/server.cjs
# Opens test harness at http://localhost:3000/examples/test/
```

## Version Bump Checklist

When cutting a new changelog version, ALL of these locations must be updated to match:

| File | Location |
|------|----------|
| `package.json` | `"version"` field |
| `package-lock.json` | `"version"` field (top-level and `packages[""]`) |
| `examples/sharc-protocol.js` | `SHARC_VERSION` constant (single source of truth) |
| `examples/sharc-protocol.js` | `@version` JSDoc tag |
| `examples/sharc-container.js` | `@version` JSDoc tag |
| `examples/sharc-creative.js` | `@version` JSDoc tag |

`SHARC_VERSION` in `sharc-protocol.js` is the canonical constant — container imports it, and the `SHARC:Container:handshake` bootstrap message references it. The `@version` JSDoc tags are informational only.

The version in `CHANGELOG.md` under `[Unreleased]` becomes the new version number. Run:

```bash
npm version <major|minor|patch>   # bumps package.json + runs scripts/sync-version.js
npm run build                      # rebuild dist with new version
```

The `npm version` lifecycle hook (`scripts/sync-version.js`) automatically propagates the version to `SHARC_VERSION`, `@version` tags, and README badge/CDN URLs. You still need to manually update `CHANGELOG.md` (move `[Unreleased]` to a dated version heading).

## Placement Intent Vocabulary

Intents: `resize`, `expand`, `fullscreen`, `collapse`

- `resize` = action (request specific dimensions, any direction including smaller)
- `expand` = go to `maxExpandSize`
- `fullscreen` = viewport takeover (`position: fixed`)
- `collapse` = return placement to default/original state (used after resize, expand, or fullscreen)
- `expand`/`collapse` is the state pair; `resize` is the action

These align with MRAID, SafeFrame, and SIMID terminology.

## PR and Branch Policy

PRs target `jeffreycarlson/SHARC` (the fork). Never open PRs on the upstream `IABTechLab/SHARC` unless explicitly told to.
