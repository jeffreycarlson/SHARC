# SHARC (Secure HTML Ad Richmedia Container)

![Package status](https://img.shields.io/badge/package-v0.7.2%20(pre--publish)-informational)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/jeffreycarlson/SHARC/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffreycarlson/SHARC/actions/workflows/ci.yml)

Secure HTML Ad Richmedia Container (SHARC) — IAB Tech Lab protocol reference implementation.

> 📋 This repository is the current SHARC reference implementation and working specification set.
> It is in active pre-1.0 development at package version `0.7.2` and is not yet published to npm.
> Start with the curated docs index at [docs/README.md](docs/README.md) and the current state summary at [docs/current-status.md](docs/current-status.md).

## Overview

SHARC is a secure container API for managed communication between a publisher-controlled container (iframe or WebView) and a served ad creative.

**Goal:** _Write one ad; serve it across supported SHARC environments._

The current v1 reference implementation targets web iframes, iOS WKWebView, and Android WebView. Future scope such as CTV is discussed in design material, but is not part of the current supported implementation surface.

## Transition vs. Steady State

In the steady state, SHARC creatives handshake directly with the container via `createSession`. The container observes the full SHARC lifecycle, installs bridges, and audits navigation through the protocol.

In the transition state, operators have inventory that does not yet speak SHARC: legacy plain HTML, MRAID, and SafeFrame adm from mixed supply. SHARC 0.7.2 ships the current legacy-adm path through `SHARCContainer`: set `requireSharcInit: false` to keep non-SHARC creatives from fatal-erroring on the missing `createSession` handshake, and set `creativeSdkUrl` on Markup-variant loads to auto-inject the SHARC creative-side SDK so legacy adm becomes SHARC-compatible at load time.

See the [operator cookbook](docs/operator-cookbook.md) for concrete integration recipes.

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

## Container Constructor Options

Selected options most relevant to operators are listed here. The full API surface, including sandbox, renderer-protocol, and callback options, is documented in [docs/api-reference.md](docs/api-reference.md).

### Creative Source

Exactly one creative source is required.

| Option | Type | Default | Purpose |
|---|---|---|---|
| `creativeUrl` | string | `undefined` | URL of a SHARC-aware creative HTML page. |
| `creativeHtml` | string | `undefined` | Inline Markup-variant creative HTML, commonly OpenRTB `bid.adm`. Requires `creativeRendererUrl`. |
| `creativeRendererUrl` | string | `undefined` | HTTPS URL of an operator-hosted renderer page. Required when `creativeHtml` is set. |

### Transition-State Options

| Option | Type | Default | Purpose |
|---|---|---|---|
| `requireSharcInit` | boolean | `true` | When `false`, skips the `createSession` fatal-timeout so non-SHARC creatives load to a stable container instance. Useful for mixed inventory, validator tooling, and generic HTML banners. |
| `creativeSdkUrl` | string | `undefined` | URL of the operator-hosted `sharc-creative.js` bundle. When set on a Markup-variant container, the container auto-injects a `<script src="...">` tag into the creative HTML at load time, lifting legacy adm into SHARC without per-creative changes. |
| `creativeSdkSkipIfPresent` | boolean | `true` | Idempotency guard for `creativeSdkUrl`; when `true`, markup already containing a real `<script src="...sharc-creative.js">` tag is left alone. |
| `creativeSdkScriptAttrs` | object | `{}` | Additional `<script>` attributes for the auto-injected tag, for example `{ integrity: 'sha384-...' }` or `{ nonce: 'abc' }`. Default `{}` emits a bare parser-blocking synchronous tag, the only attribute set that prevents the inline-`mraid.*` race condition. |

### Bridge Detection

| Option | Type | Default | Purpose |
|---|---|---|---|
| `bridges` | `string[]` | auto-detected | Explicit override for compatibility bridges. Reserved identifiers are `'mraid'` and `'safeframe'`. Pass `[]` to suppress all bridge loading. |
| `creativeMeta` | object | `undefined` | Forward-compatible metadata bag. `creativeMeta.apis` accepts AdCOM `APIFramework` integer codes from bid metadata and drives bridge selection plus `container.apiFramework`. |

### Observability Accessors

Frozen instance properties are available for callbacks, dashboards, and validator tooling.

| Accessor | Type | Description |
|---|---|---|
| `container.apiFramework` | `number \| null` | AdCOM `APIFramework` integer code for the declared container runtime, resolved at construction through the three-layer picker. `null` means no recognized runtime declaration. Added in 0.7.2. |
| `container.hasSharcSession` | boolean | `true` once the SHARC `createSession` handshake has been accepted; `false` until then. Added in 0.7.2. |
| `container.bridges` | `ReadonlyArray<string>` | Compatibility bridges selected for this load. Empty when none are selected or when bridge loading is suppressed. Added in 0.7.1. |
| `container.placementSessionId` | string | UUID v4 generated at construction for placement correlation, DOM stamping, and diagnostics. |

## Distribution and URL Guidance

SHARC is packaged as one npm package with versioned subpath exports:

- Container: `@iabtechlab/sharc/sharc-container`
- Creative: `@iabtechlab/sharc/sharc-creative`
- Protocol: `@iabtechlab/sharc/sharc-protocol`
- Navigation bridge: `@iabtechlab/sharc/sharc-navigation-bridge`
- Bridges: `@iabtechlab/sharc/sharc-mraid-bridge`, `@iabtechlab/sharc/sharc-safeframe-bridge`, `@iabtechlab/sharc/sharc-omid-bridge`

All public entry points build into `dist/` as ESM (`.mjs`) plus browser/IIFE bundles (`.js`).

After the package is published, public CDN URL patterns should mirror the current `dist/` filenames:

- Container: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.2/dist/sharc-container.js`
- Creative: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.2/dist/sharc-creative.js`
- Protocol: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.2/dist/sharc-protocol.js`

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
- **[Operator cookbook](docs/operator-cookbook.md)** — recipes for legacy adm lift, mixed-inventory containers, and SDK-injection composition
- **[Creative cookbook](docs/creative-cookbook.md)** — creative-side SHARC authoring patterns

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
