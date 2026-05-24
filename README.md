# SHARC (Secure HTML Ad Richmedia Container)

![Package status](https://img.shields.io/badge/package-v0.7.5%20(pre--publish)-informational)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/jeffreycarlson/SHARC/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffreycarlson/SHARC/actions/workflows/ci.yml)

Secure HTML Ad Richmedia Container (SHARC) — IAB Tech Lab protocol reference implementation.

> 📋 This repository is the current SHARC reference implementation and working specification set.
> It is in active pre-1.0 development at package version `0.7.5` and is not yet published to npm.
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
| `creativeRendererIntegrity` | string | `undefined` | Optional SRI-style SHA-384 digest (`sha384-<base64>`) for the Markup renderer page. When set, the container verifies `creativeRendererUrl` bytes before loading the iframe and refuses to send `SHARC:Renderer:render` on mismatch. Best-effort only because iframes do not support native `integrity=`; cross-origin renderer hosts must allow the verification fetch with CORS. |

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
| `bridges` | `string[]` | auto-detected | Explicit override for compatibility bridges. Reserved identifiers are `'mraid'` and `'safeframe'`. Pass `[]` to suppress all bridge loading. OMID is **not** a bridge — see [Open Measurement (OMID)](#open-measurement-omid). |
| `creativeMeta` | object | `undefined` | Forward-compatible metadata bag. `creativeMeta.apis` accepts AdCOM `APIFramework` integer codes from bid metadata and drives bridge selection plus `container.apiFramework` on Markup variant. AdCOM code `7` (OMID 1.0) is a measurement declaration and never produces a bridge entry; when paired with `omidAutoInstall` and `creativeMeta.measurement.omid.verificationScripts`, it can auto-install [`OmidCompatBridge`](#open-measurement-omid). |
| `omidAutoInstall` | object | `undefined` | Operator-owned OMID auto-install defaults. Supplies trusted OM SDK URLs and partner defaults when bid metadata declares `creativeMeta.apis: [7]` plus an OMID measurement sidecar. |
| `extensions` | `Object[]` | `[]` | Container-side extension plugin instances. Used to install [`OmidCompatBridge`](#open-measurement-omid) and operator-authored extensions. Extensions are invoked through container lifecycle hooks and may contribute entries to `supportedFeatures`. |

### Observability Accessors

Frozen instance properties are available for callbacks, dashboards, and validator tooling.

| Accessor | Type | Description |
|---|---|---|
| `container.apiFramework` | `number \| null` | AdCOM `APIFramework` integer code for the declared container runtime, resolved at construction through the three-layer picker. `null` means no recognized runtime declaration. Added in 0.7.2. |
| `container.hasSharcSession` | boolean | `true` once the SHARC `createSession` handshake has been accepted; `false` until then. Added in 0.7.2. |
| `container.bridges` | `ReadonlyArray<string>` | Compatibility bridges selected for this load. Empty when none are selected or when bridge loading is suppressed. Added in 0.7.1. |
| `container.placementSessionId` | string | UUID v4 generated at construction for placement correlation, DOM stamping, and diagnostics. |

## Open Measurement (OMID)

SHARC ships container-owned OMID measurement through the `OmidCompatBridge` extension (introduced in 0.7.3; load-failure signaling added in 0.7.4). The publisher page loads the OM SDK scripts, the container owns the full `AdSession` lifecycle, and OM SDK events fire automatically from SHARC container state transitions. Creatives do nothing — MRAID, SafeFrame, and SHARC-native creatives all receive OMID measurement transparently.

OMID is intentionally **not** a SHARC bridge. The `bridges` vocabulary stays scoped to renderer-loaded creative API compatibility (`'mraid'`, `'safeframe'`). OMID is measurement, not API translation, so it uses the `extensions` slot on `SHARCContainer` instead. The container rejects `bridges: ['omid']`, and AdCOM `APIFramework` code `7` never adds `'omid'` to the renderer bridge list.

### Operator integration

```javascript
import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';
import { OmidCompatBridge } from '@iabtechlab/sharc/sharc-omid-bridge';

const omidBridge = new OmidCompatBridge({
  omSdkServiceScriptUrl: 'https://your-cdn.example/omweb-v1.js',
  omSdkSessionClientUrl: 'https://your-cdn.example/omid-session-client-v1.js',
  partnerName: 'YourPartner',
  partnerVersion: '1.0.0',
  creativeType: 'video',          // 'video' | 'audio' | 'display'
  impressionType: 'definedByJavaScript',
  mediaType: 'video',             // 'video' | 'audio' | 'display'
  verificationScripts: [
    { resourceUrl: 'https://verify.ias.com/omsdk/verification.js', vendorKey: 'ias' },
  ],
});

const container = new SHARCContainer({
  creativeHtml: bid.adm,
  creativeRendererUrl: 'https://your-cdn.example/renderer.html',
  placementElement: document.getElementById('ad-slot'),
  extensions: [omidBridge],
});
container.load();
```

Both `omSdkServiceScriptUrl` and `omSdkSessionClientUrl` are required for the bridge to advertise `com.iabtechlab.sharc.omid` in `supportedFeatures`. When either URL is omitted, the bridge is inert and the feature is not declared.

### Bid-signaled auto-install

For bid pipelines that normalize OMID verification metadata into `creativeMeta`, the container can append `OmidCompatBridge` automatically. The operator still owns the trusted OM SDK URLs through `omidAutoInstall`; the bid sidecar supplies verification resources and optional OMID session metadata.

```javascript
const container = new SHARCContainer({
  creativeHtml: bid.adm,
  creativeRendererUrl: 'https://your-cdn.example/renderer.html',
  placementElement: document.getElementById('ad-slot'),
  creativeMeta: {
    apis: [7],
    measurement: {
      omid: {
        verificationScripts: bid.ext?.omidVerificationScripts ?? [],
        impressionType: 'beginToRender',
        mediaType: 'display',
        creativeType: 'display',
      },
    },
  },
  omidAutoInstall: {
    omSdkServiceScriptUrl: 'https://your-cdn.example/omweb-v1.js',
    omSdkSessionClientUrl: 'https://your-cdn.example/omid-session-client-v1.js',
    partnerName: 'YourPartner',
    partnerVersion: '1.0.0',
  },
});
```

Missing or invalid OMID sidecar data emits a warning and continues without installing OMID measurement. This path works for both Creative Markup and Creative URL variants, but it does not change URL-variant `container.apiFramework` and does not load renderer bridges.

### What's shipped

**Core (0.7.3):**

- **Automatic OM SDK loading.** Container loads the Service Script and Session Client on the publisher page from the two configured URLs (skipped if already present). Strict HTTPS validation on both URLs at construction; userinfo and non-HTTPS rejected.
- **Automatic session lifecycle.** Session starts when the container reaches `READY`, fires `loaded()` and the impression once on the first viewable moment, tracks viewability across `ACTIVE ↔ PASSIVE / HIDDEN / FROZEN`, and finishes on `close`, `destroy`, `error`, or `TERMINATED`.
- **Video/audio extras.** `MediaEvents.playerStateChange` fires on placement intent changes for video/audio sessions; display sessions get `AdEvents` only.
- **Verification scripts and friendly obstruction.** Verification scripts are HTTPS-validated and deduplicated at construction; the container's auto-rendered close button is registered as a friendly obstruction.

**Hardening (0.7.4):**

- **Structured SDK load-failure signaling.** OM SDK script-load failures now fire the new `feature_load_failed` `SHARCSecurityEvent` variant with `details: { featureName, reason, scriptUrl }` (non-terminating; container keeps running, failed extension goes inert). Reason is a classified token: `'timeout'`, `'network'`, or `'evaluation_throw'`. The `_loadingUrl` tracker on the bridge reports the specific URL that failed (service vs. session client), not just whichever was configured first.
- **Termination-mid-load contract pinned.** Test coverage (H1–H5) for the bfcache / destroy-mid-load edge case: when termination fires while the OM SDK load promise is pending, no session is created, no late callbacks fire, and no `feature_load_failed` is emitted (the failure here is normal teardown, not script-load failure).

### Verifying integration

Confirm the wiring without instrumenting the creative:

- **Network tab:** both OM SDK URLs return 200; verification scripts (if any) return 200.
- **Console:** look for `[SHARC OMID Bridge]` log lines. Successful flow has no warnings; misconfiguration throws at container construction.
- **Live event log:** open the [`examples/demos/omid-integration/`](examples/demos/omid-integration/) demo — the publisher page prints every SHARC protocol message and container lifecycle callback in real time; OM SDK activity is in the console.
- **OM SDK validation script:** load IAB's `omid-validation-verification-script-v1.js` as a verification script in dev. It logs protocol compliance to the console. Distributed via the [Open-Measurement-JSClients](https://github.com/InteractiveAdvertisingBureau/Open-Measurement-JSClients) repo (no canonical public CDN — operators self-host alongside the OM SDK service script).

### Tracked follow-ups

- **Fuller docs** — full `OmidCompatBridge` API surface in [`docs/api-reference.md`](docs/api-reference.md) is tracked in [#136](https://github.com/jeffreycarlson/SHARC/issues/136); a "Wire Container-Owned OMID" recipe in [`docs/operator-cookbook.md`](docs/operator-cookbook.md) is tracked in [#135](https://github.com/jeffreycarlson/SHARC/issues/135). Until those land, the bridge constructor JSDoc in [`src/sharc-omid-bridge.js`](src/sharc-omid-bridge.js) and the design spec below are authoritative.

> **Resolved in 0.7.4:** URL-variant `creativeSdkUrl` auto-injection ([#106](https://github.com/jeffreycarlson/SHARC/issues/106), explicit opt-in via `useMarkupInjection: true`) and structured OM SDK load-failure signaling via the new `feature_load_failed` `SHARCSecurityEvent` variant ([#125](https://github.com/jeffreycarlson/SHARC/issues/125)). See the [0.7.4 CHANGELOG section](CHANGELOG.md#074---2026-05-24).

### References

- **Design specs:** [`docs/design/0.7.3-omid-wiring.md`](docs/design/0.7.3-omid-wiring.md) — original architecture, state-mapping table, validation rules, and decision log; [`docs/design/0.7.4-omid-hardening.md`](docs/design/0.7.4-omid-hardening.md) — 0.7.4 hardening additions (#121 audit, #123 error contract, #124 dedup warn, #125 feature_load_failed, #126 termination-mid-load).
- **Working demo:** [`examples/demos/omid-integration/`](examples/demos/omid-integration/) — publisher page + test creative with a live event log.
- **Implementation PRs:** [#122](https://github.com/jeffreycarlson/SHARC/pull/122) (0.7.3 container-owned wiring), [#138](https://github.com/jeffreycarlson/SHARC/pull/138) (LOW hardening sweep), and [#171](https://github.com/jeffreycarlson/SHARC/pull/171) (0.7.4 `feature_load_failed` variant).

## Distribution and URL Guidance

SHARC is packaged as one npm package with versioned subpath exports:

- Container: `@iabtechlab/sharc/sharc-container`
- Creative: `@iabtechlab/sharc/sharc-creative`
- Protocol: `@iabtechlab/sharc/sharc-protocol`
- Navigation bridge: `@iabtechlab/sharc/sharc-navigation-bridge`
- Bridges: `@iabtechlab/sharc/sharc-mraid-bridge`, `@iabtechlab/sharc/sharc-safeframe-bridge`, `@iabtechlab/sharc/sharc-omid-bridge`

All public entry points build into `dist/` as ESM (`.mjs`) plus browser/IIFE bundles (`.js`).

After the package is published, public CDN URL patterns should mirror the current `dist/` filenames:

- Container: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.5/dist/sharc-container.js`
- Creative: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.5/dist/sharc-creative.js`
- Protocol: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.7.5/dist/sharc-protocol.js`

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
