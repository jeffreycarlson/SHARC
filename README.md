# SHARC (Secure HTML Ad Richmedia Container)

![Package status](https://img.shields.io/badge/package-v0.7.1%20(pre--publish)-informational)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/InteractiveAdvertisingBureau/SHARC/actions/workflows/ci.yml/badge.svg)](https://github.com/InteractiveAdvertisingBureau/SHARC/actions/workflows/ci.yml)

Secure HTML Ad Richmedia Container (SHARC) — IAB Tech Lab protocol reference implementation.

> 📋 This repository is the current SHARC reference implementation and working specification set.
> It is in active pre-1.0 development at package version `0.7.1` and is not yet published to npm.
> Start with the curated docs index at [docs/README.md](docs/README.md) and the current state summary at [docs/current-status.md](docs/current-status.md).

## Overview

SHARC is a secure container API for managed communication between a publisher-controlled container (iframe or WebView) and a served ad creative.

**Goal:** _Write one ad; serve it across supported SHARC environments._

The current v1 reference implementation targets web iframes, iOS WKWebView, and Android WebView. Future scope such as CTV is discussed in design material, but is not part of the current supported implementation surface.

## Try It

The SHARC project hosts a reference deployment of the Creative Markup renderer for evaluation and integration testing:

- **Hosted reference renderer:** [`https://jeffreycarlson.github.io/SHARC/renderer/`](https://jeffreycarlson.github.io/SHARC/renderer/) — test/dev only; the SDK refuses to load this URL from production origins via the `KNOWN_TEST_RENDERERS` production-block guard.

A local Creative Markup demo at [`examples/demos/creative-markup/`](./examples/demos/creative-markup/) drives a 300×250 placement against the hosted renderer and prints every container-side event (security events, errors, navigation requests, state changes, port handshake) to a live log:

```bash
git clone https://github.com/jeffreycarlson/SHARC.git
cd SHARC
npm install
npm run build
node server.cjs
# open http://localhost:8765/examples/demos/creative-markup/index.html
```

The demo runs locally rather than on Pages because Pages would put the demo and renderer on the same origin, collapsing the cross-origin requirement (validation rule 7 — see [Renderer Ownership Model](./docs/proposals/creative-sources.md)). Operators evaluating SHARC for production must fork [`examples/renderer/index.html`](./examples/renderer/index.html) and self-host on operator-controlled infrastructure.

## Quick Start

### Current state

- **Today:** build from this repository and use the `dist/` artifacts locally.
- **After first npm publish:** install `@iabtechlab/sharc` and use the same subpath entry points shown below.

### ESM / bundler usage

```bash
npm install @iabtechlab/sharc
```

```js
import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';
import { SHARC } from '@iabtechlab/sharc/sharc-creative';
```

All public entry points ship generated `.d.ts` declarations, so TypeScript consumers get full IntelliSense and argument-shape checking on every subpath import — no separate `@types` package required.

### Browser bundle usage

```html
<script src="./dist/sharc-protocol.js"></script>
<script src="./dist/sharc-container.js"></script>
<script src="./dist/sharc-creative.js"></script>
```

Browser globals:

- `window.SHARC.Container` — container constructor
- `window.SHARC` — creative API surface (`onReady`, `onStart`, `requestNavigation`, etc.)

## Distribution and URL Guidance

SHARC is packaged as one npm package with versioned subpath exports:

- Container: `@iabtechlab/sharc/sharc-container`
- Creative: `@iabtechlab/sharc/sharc-creative`
- Protocol: `@iabtechlab/sharc/sharc-protocol`
- Bridges: `@iabtechlab/sharc/sharc-mraid-bridge`, `@iabtechlab/sharc/sharc-safeframe-bridge`, `@iabtechlab/sharc/sharc-omid-bridge`

All public entry points build into `dist/` as ESM (`.mjs`) plus browser/IIFE bundles (`.js`).

After the package is published, public CDN URL patterns should mirror the current `dist/` filenames:

- Container: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.1/dist/sharc-container.js`
- Creative: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.1/dist/sharc-creative.js`
- Protocol: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.1/dist/sharc-protocol.js`

Versioning guidance:

- **Production:** pin exact semver, for example `@1.2.3`
- **Dev/staging:** floating minor or major aliases are acceptable, for example `@1.2` or `@1`
- **Do not rely on `latest`** for production integrations or long-lived test environments

Bridge public CDN URL policy is intentionally deferred for now. Treat bridge bundles as package artifacts used by SHARC, not as separately documented public CDN entry points yet.

## Documentation

Start with the curated index, then dive into specifics:

- **[Docs index](docs/README.md)** — curated guide to authoritative, maintainer, and archive material
- **[Current status](docs/current-status.md)** — what's stable, what's pre-publish, current package version
- **[API reference](docs/api-reference.md)** — detailed protocol and public API reference

The [docs index](docs/README.md) lists everything else (architecture overview, bridge designs, change log, reviews, proposals).

## Repository Structure

```
SHARC/
├── src/               # Reference implementation source
├── dist/              # Built modules (ESM + browser/IIFE)
├── docs/              # Specification, design, review, and research material
├── test/browser/      # Browser test harness and reference creatives
├── test/node/         # Node-based regression tests (npm run test:*)
├── test/types/        # Type-consumer verification
├── examples/          # Wrappers, bridge demos, and compliance vectors
├── CHANGELOG.md       # Version history
├── SECURITY.md        # Security reporting and support policy
└── README.md          # This file
```

## Examples and Test Harness

The repository includes a local browser test harness for development:

```bash
npm run dev
# or: node server.cjs
```

Main entry points:

- `http://localhost:8765/test/browser/index.html` — core SHARC harness
- `http://localhost:8765/test/browser/mraid-test.html` — MRAID bridge harness
- `http://localhost:8765/test/browser/safeframe-test.html` — SafeFrame bridge harness
- `http://localhost:8765/examples/demos/omid-integration/index.html` — OMID bridge integration page

Use `?build=dist` on the core harness to exercise built artifacts:

```http
http://localhost:8765/test/browser/index.html?build=dist
```

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) and the [Architecture Overview](docs/architecture-overview.md) before submitting changes.

## Security

For security concerns, please see our [Security Policy](SECURITY.md).

## License

SHARC is licensed under the [Apache License 2.0](LICENSE).

## Contact

For questions or to get involved, email [support@iabtechlab.com](mailto:support@iabtechlab.com).

---

**IAB Tech Lab** | [iabtechlab.com](https://www.iabtechlab.com/)