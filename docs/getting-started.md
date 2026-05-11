# SHARC Getting Started

**Audience:** container implementers and creative developers evaluating the current SHARC reference implementation.

## Before You Start

SHARC is currently in active pre-1.0 development:

- Current package version in this repo: `0.7.0`
- npm package: **not yet published**
- Current supported implementation scope: **web iframe**, **iOS WKWebView**, **Android WebView**

Today, the practical way to evaluate SHARC is to build from this repository and use the generated `dist/` artifacts or the local browser harness.

## What's New in 0.7.0

0.7.0 ships the **Creative Markup variant** — a second creative-payload path alongside Creative URL. Operators that have markup in hand (RTB pipelines, header bidding wrappers, Prebid Universal Creative scenarios) can pass `creativeHtml` + `creativeRendererUrl` instead of `creativeUrl`. The container posts the markup to an operator-hosted renderer page that writes it into its own document, giving the creative a real cross-origin origin (so measurement SDKs work) without forcing operators to pre-host every markup blob as a URL.

For the architecture, see [architecture-design.md §14](./architecture-design.md#14-renderer-protocol--creative-markup-variant). For the wire-level reference, see [api-reference.md §10](./api-reference.md#10-renderer-protocol). For practical recipes, see [creative-cookbook.md §8–10](./creative-cookbook.md#8-creative-markup-variant-070).

This release also adds:

- Structured `onSecurityEvent` callback (discriminated union over five reserved event types)
- SDK-auto-installed `sharc-navigation-bridge` (auto-installs at SDK init for Creative URL; renderer installs for Creative Markup) — operators get unified click-through audit across both variants
- Load-event navigation backstop (`RENDERER_UNAUTHORIZED_NAVIGATION` 2118) for both variants
- Six new error codes (2114–2119) for renderer protocol failures
- A reference renderer at `examples/renderer/index.html` (hosted at `https://jeffreycarlson.github.io/SHARC/renderer/` for SDK evaluation only)
- A local Creative Markup demo at `examples/demos/creative-markup/index.html`

The full changelog is in [CHANGELOG.md](../CHANGELOG.md).

## Package Entry Points

The repository builds one package with subpath exports:

- `@iabtechlab/sharc/sharc-container`
- `@iabtechlab/sharc/sharc-creative`
- `@iabtechlab/sharc/sharc-protocol`
- `@iabtechlab/sharc/sharc-mraid-bridge`
- `@iabtechlab/sharc/sharc-safeframe-bridge`
- `@iabtechlab/sharc/sharc-omid-bridge`
- `@iabtechlab/sharc/sharc-navigation-bridge` (new in 0.7.0; also re-exported from `sharc-creative`)

When the package is published, those are the supported import paths.

## Local Evaluation Flow

```bash
npm install
npm run build
npm run dev
```

Then open:

- `http://localhost:8765/test/browser/index.html` — core SHARC harness
- `http://localhost:8765/test/browser/mraid-test.html` — MRAID bridge harness
- `http://localhost:8765/test/browser/safeframe-test.html` — SafeFrame bridge harness
- `http://localhost:8765/examples/demos/omid-integration/index.html` — OMID bridge integration page
- `http://localhost:8765/examples/demos/creative-markup/index.html` — Creative Markup demo (new in 0.7.0)
- `http://localhost:8765/test/browser/test-creative-sources.html` — manual-load harness for the renderer-protocol scenarios (happy path, `:failed`, origin mismatch via 302, Service Worker detected, load-event backstop)

Use `?build=dist` on the core harness to validate the built artifacts.

The 0.7.0 dev server listens on **two ports**: 8765 (publisher pages) and 8766 (renderer pages). Browsers treat the two ports as distinct origins, satisfying validation rule 7's cross-origin requirement for local Creative Markup testing.

## TypeScript Support

As of `0.6.0`, every public package subpath ships a generated `.d.ts` declaration alongside its `.mjs` bundle. TypeScript consumers get IntelliSense and compile-time argument validation on `new SHARCContainer({...})`, every bridge constructor, and the creative API surface — no `@types/sharc` needed.

0.7.0 expands the typedef surface: `creativeUrl` is now optional, `creativeHtml` / `creativeRendererUrl` / `onSecurityEvent` are added, and `SHARCSecurityEvent` is a discriminated union — five reserved variants in 0.7.0 (`wrapper_top_frame_inaccessible`, `renderer_origin_mismatch`, `renderer_protocol_error`, `renderer_failed`, `unauthorized_navigation`), extended to six in 0.7.1 with `bridge_load_failed` (bridge-module import failure, error code 2115 same as `renderer_failed` but distinct event.type for operator observability). 0.7.1 also adds `bridges` and `creativeMeta` constructor options for compatibility-bridge loading on the Markup variant, plus a `container.bridges` instance accessor. Consumers should narrow via `switch (event.type)` rather than treating `details` as `any`.

## Container Constructor — 0.7.0 Options

The most-used `SHARCContainer` constructor options. See [api-reference.md §1](./api-reference.md#1-sharccontainer-javascript-api) for the full surface.

| Option | Type | Required | When you use it |
|---|---|---|---|
| `placementElement` | `HTMLElement` | Yes | The DOM element the container inserts the iframe into |
| `creativeUrl` | `string` | Conditional (one of the two creative-payload pairs) | Creative URL variant — the URL the iframe loads via `src` |
| `creativeHtml` | `string` | Conditional | Creative Markup variant — raw HTML markup, capped at 256 KiB pre-injection |
| `creativeRendererUrl` | `string` | Conditional (required when `creativeHtml` is provided) | HTTPS URL of an operator-hosted renderer page; must be cross-origin to publisher; no userinfo |
| `placementId` | `string \| null` | No | Publisher-supplied placement identifier; round-trips to `container.placementId` |
| `placementName` | `string \| null` | No | Human-readable placement name |
| `environmentData` | `Object` | No | Sent in `Container:init` — `currentPlacement`, `dataspec`, `containerNavigation`, `isMuted`, `volume`, `publisherContext` |
| `extensions` | `Object[]` | No | Extension plugin instances (e.g. `OmidCompatBridge`, `MRAIDCompatBridge`) |
| `onStateChange` | `Function` | No | Called with `(newState, previousState)` on transitions |
| `onClose` | `Function` | No | Fires when the container has fully closed |
| `onError` | `Function` | No | Fires with `(errorCode, errorMessage)` on fatal errors |
| `onNavigation` | `Function` | No | Fires when the creative requests navigation. Observation-only hook for click telemetry; return value is ignored (see issue #75) |
| `onSecurityEvent` | `(event) => void` | No | Production observability hook; discriminated-union payload over five reserved variants. Added in 0.7.0 |
| `wrapperPolicy` | `'warn' \| 'block'` | No | Validation-rule-7 wrapper-cross-origin carve-out policy. `'warn'` (default) emits warning + `onSecurityEvent` and proceeds; `'block'` throws synchronously. Added in 0.7.0 |
| `allowPopups` | `boolean` | No | Default `true`. When `false`, removes `allow-popups` and `allow-popups-to-escape-sandbox` from the Markup renderer iframe sandbox. Added in 0.7.0 |
| `allowTopNavigationByUserActivation` | `boolean` | No | Default `true`. The unsafe `allow-top-navigation` (no-gesture) variant is never exposed. Added in 0.7.0 |
| `allowStorageAccessByUserActivation` | `boolean` | No | Default `true`. Added in 0.7.0 |
| `allowModals` | `boolean` | No | Default **`false`** (asymmetric — operators opt in for age gates, etc.). Added in 0.7.0 |
| `allowDownloads` | `boolean` | No | Default **`false`** (asymmetric). Added in 0.7.0 |
| `placementPolicy` | `Object` | No | Constrains creative-driven placement requests (`resize` / `expand` / `collapse` / `fullscreen`); when omitted, placement requests bypass policy validation |
| `closeButtonStyles` | `Object` | No | CSS overrides for the auto-rendered close button |
| `useMarkupInjection` | `boolean` | No | Creative URL only. Default `false`. Markup variant ALWAYS runs registered injectors |
| `autoStart` | `boolean` | No | If `true` (default), calls `startCreative` automatically after `init` resolves |
| `visible` | `boolean` | No | Initial iframe visibility. Set to `false` to preload silently. Default `false` |
| `timeouts` | `Object` | No | Override default timeouts. Markup variant adds `rendererLoad` (5000 ms) and `rendererReply` (2000 ms) |

After construction, the following instance properties are readable:

| Property | Type | Notes |
|---|---|---|
| `placementSessionId` | `string` | UUID v4, never null, unique per instance — used in DOM stamps and console-log prefixes |
| `sessionId` | `string \| null` | Set during the `createSession` handshake; `null` before |
| `creativeUrl` | `string \| null` | `null` for Creative Markup variant |
| `creativeRendererUrl` | `string \| null` | `null` for Creative URL variant. Added in 0.7.0 |
| `creativeSource` | `'url' \| 'html'` | Variant discriminator. Added in 0.7.0 |
| `creativeRendered` | `boolean` | `true` once renderer's `:rendered` arrives. `false` for Creative URL. Added in 0.7.0 |
| `creativeInjected` | `boolean` | `true` once any extension `injectIntoMarkup` ran AND modified markup |

## Creative URL Hello-World

```html
<script type="module">
  import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';

  const container = new SHARCContainer({
    creativeUrl: 'https://ads.example.com/creative.html',
    placementElement: document.getElementById('ad-slot'),
    placementId: 'inline-300x250',
    environmentData: {
      currentPlacement: { width: 300, height: 250, inline: true },
    },
  });

  container.load();
</script>
```

The container opens an iframe pointing at `creativeUrl`, runs the standard SHARC `MessageChannel` handshake, and the creative's `SHARC.onReady` / `SHARC.onStart` callbacks fire when ready.

## Creative Markup Hello-World

```html
<script type="module">
  import '/dist/sharc-protocol.mjs';
  import { SHARCContainer } from '/dist/sharc-container.mjs';

  const CREATIVE_HTML = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>',
    '<div id="ad" style="background:#0a4d92;color:#fff;padding:1em">Hello SHARC</div>',
    '</body></html>',
  ].join('');

  const container = new SHARCContainer({
    creativeHtml: CREATIVE_HTML,
    creativeRendererUrl: 'https://renderer.your-operator.com/0.7.0/',
    placementElement: document.getElementById('ad-slot'),
    placementId: 'inline-300x250',

    onSecurityEvent: (event) => {
      console.warn('[security]', event.type, event);
    },
    onError: (code, message) => {
      console.error('[error]', code, message);
    },
  });

  container.load();
</script>
```

Ten validation rules run synchronously in the constructor before any I/O happens:

| Rule | Enforces | Throw type |
|---|---|---|
| 1 | Exactly one of `creativeUrl` or `creativeHtml` | `TypeError` |
| 2 | `creativeHtml` requires `creativeRendererUrl` | `TypeError` |
| 3 | `creativeRendererUrl` is forbidden alongside `creativeUrl` | `TypeError` |
| 4 | `creativeRendererUrl` parses via `new URL(...)` | `Error` |
| 5 | `creativeRendererUrl` uses exactly the `https:` scheme | `Error` |
| 6 | `creativeRendererUrl` contains no userinfo | `Error` |
| 7 | `creativeRendererUrl` is cross-origin to `window.location` and (when accessible) `window.top.location` | `Error` |
| 8 | `creativeHtml` ≤ 256 KiB UTF-8 bytes pre-injection | `Error` |
| 9 (0.7.1+) | `bridges` is `null` / `undefined` or an array of recognized identifier strings (`'mraid'`, `'safeframe'` in 0.7.1) | `TypeError` (shape) / `Error` (unknown identifier) |
| 10 (0.7.1+) | `creativeMeta` is `null` / `undefined` or a plain object; `creativeMeta.apis`, when present, is an array of finite numbers (AdCOM `APIFramework` codes) | `TypeError` |

Then the `KNOWN_TEST_RENDERERS` production-block guard fires if `creativeRendererUrl` matches a SHARC reference renderer URL AND the page origin doesn't match a recognized dev origin. Recognized dev-origin patterns (anchored regexes; suffix-style spoofing such as `notlocalhost.example` does NOT match):

- `localhost` / `127.0.0.1` / `*.localhost` / `*.test` / `*.local` / `[::1]` / `0.0.0.0` (any port; `http(s)`)

Operators use the SDK-reference URL (`https://jeffreycarlson.github.io/SHARC/renderer/`) for evaluation from a dev origin. Production deployments must fork `examples/renderer/index.html` and host on operator-controlled infrastructure. See [creative-cookbook.md §9](./creative-cookbook.md#9-operator-side-renderer-setup) for the full setup recipe.

## Trying Creative Markup Locally

The repository ships a working demo at `examples/demos/creative-markup/index.html`:

```bash
npm install
npm run build
node server.cjs
```

Then open `http://localhost:8765/examples/demos/creative-markup/index.html`. The demo constructs a `SHARCContainer` against the hosted reference renderer with a ~1.5 KiB inline HTML banner payload (visible click target, `window.open()` handler intercepted by the auto-installed navigation bridge, and a `creative-loaded` postMessage probe). A live message log on the right shows every container-side observable event (security events, errors, navigation requests, state changes, port handshake) as the protocol unfolds.

The demo runs ONLY via `node server.cjs` — `localhost:8765` is cross-origin to `jeffreycarlson.github.io`, so validation rule 7 passes. If you served the demo from the same origin as the renderer (e.g. both on Pages), construction would throw on rule 7.

## Creative SDK Usage

### ESM / bundler

```js
import { SHARC } from '@iabtechlab/sharc/sharc-creative';

SHARC.onReady(async (env, features) => {
  console.log('Container env:', env);
  console.log('Supported features:', features);
});

SHARC.onStart(() => {
  document.getElementById('ad-root').style.display = 'block';
});
```

### Browser bundle

```html
<script src="./dist/sharc-protocol.js"></script>
<script src="./dist/sharc-creative.js"></script>
<script>
  SHARC.onReady(async (env) => {
    console.log('Ready with placement:', env.currentPlacement);
  });
  SHARC.onStart(() => {
    document.getElementById('ad-root').style.display = 'block';
  });
</script>
```

Common creative APIs:

- `SHARC.onReady(callback)`
- `SHARC.onStart(callback)`
- `SHARC.on(event, callback)`
- `SHARC.requestNavigation({ url, target })`
- `SHARC.requestPlacementChange({ intent, targetDimensions })`
- `SHARC.requestClose()`
- `SHARC.reportInteraction([...uris])`
- `SHARC.fatalError(code, message)`

The Creative API surface is identical across both variants — once the iframe is ready, any creative that loads `sharc-creative.js` sees the same `SHARC.*` interface (`SHARC.onReady`, `SHARC.requestNavigation`, lifecycle hooks, etc.). For Creative URL, the creative loads the SDK like any other resource. For Creative Markup, the creative must include the SDK script tag inside its `creativeHtml` payload — the renderer auto-installs only the navigation bridge (which transparently intercepts `window.open`); it does NOT pre-load `sharc-creative.js`. See [creative-cookbook.md § 8.3](./creative-cookbook.md#83-sdk-loading-pattern-for-markup-creatives) for the SDK-loading pattern.

For MRAID and SafeFrame creatives, the container auto-detects which compatibility bridges to load and tells the renderer to dynamically `import()` them BEFORE `document.write(creativeHtml)` — see [creative-cookbook.md § 8.5](./creative-cookbook.md#85-mraid-and-safeframe-creatives-071) for the bridge-loading pattern and the new `bridges` / `creativeMeta` constructor options (added 0.7.1).

## Security Model at a Glance

The reference web container uses a sandboxed iframe. Sandbox tokens differ per variant:

**Creative URL** (default — third-party iframe loaded directly via `src`):
```html
<iframe sandbox="allow-scripts allow-forms allow-popups"></iframe>
```

`allow-same-origin` is intentionally **not** present — the creative URL's own origin is the trust boundary, and combining `allow-scripts` + `allow-same-origin` on a same-origin iframe would let the document remove the sandbox attribute entirely. `allow-popups-to-escape-sandbox` is also omitted by default for Creative URL.

**Creative Markup** (default — strict superset of the URL set, introduced in 0.7.0 for the rendered iframe at the operator-controlled renderer origin):
```html
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups
                 allow-popups-to-escape-sandbox
                 allow-top-navigation-by-user-activation
                 allow-storage-access-by-user-activation"></iframe>
```

The Markup variant requires a richer capability set because the renderer iframe loads operator-hosted infrastructure (not third-party creative origin) and exposes the rendered creative to measurement SDKs that need same-origin storage and CORS. `allow-same-origin` is safe here because validation rules 4–7 (HTTPS-only, no userinfo, parseable URL, cross-origin to publisher) eliminate every URL shape that would cause the browser to collapse the iframe origin onto the publisher's. Without these rules, `allow-same-origin` would be a sandbox escape — see [proposal § Iframe sandbox](./proposals/creative-sources.md) for the full mechanism table.

`allow-modals` and `allow-downloads` are configurable but **default off** — operators opt in for age-gate creatives or in-iframe downloads.

The renderer iframe also gets:
- `csp` attribute: `object-src 'none'; base-uri 'none'` (Chromium-only — operator must also configure HTTP-response CSP on the renderer page for portable enforcement)
- `referrerpolicy = "no-referrer"`
- A long Permissions-Policy denylist (camera, microphone, geolocation, etc.)

SHARC uses a transferred `MessageChannel` port after bootstrap. Navigation and tracker execution are mediated by the container.

## Platform Integration

SHARC runs on iOS WKWebView and Android WebView in addition to web iframes. Native integration wiring guides are in progress pending working Swift and Kotlin sample implementations — see issues #51 (iOS) and #52 (Android). The state machine mapping for both platforms is documented in [docs/architecture-design.md](./architecture-design.md#5-container-state-machine).

## Recommended Next Reading

- [docs/current-status.md](./current-status.md) — project maturity and 0.7.0 status snapshot
- [docs/api-reference.md](./api-reference.md) — authoritative public API and protocol details
- [docs/api-reference.md §10](./api-reference.md#10-renderer-protocol) — renderer protocol wire-level reference
- [docs/architecture-design.md §14](./architecture-design.md#14-renderer-protocol--creative-markup-variant) — renderer protocol architecture
- [docs/creative-cookbook.md](./creative-cookbook.md) — practical creative implementation patterns (URL and Markup)
- [docs/proposals/creative-sources.md](./proposals/creative-sources.md) — Creative Sources design rationale and threat model
- [docs/design/mraid-bridge-design.md](./design/mraid-bridge-design.md)
- [docs/design/safeframe-bridge-design.md](./design/safeframe-bridge-design.md)
