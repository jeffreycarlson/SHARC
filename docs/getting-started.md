# SHARC Getting Started

**Audience:** container implementers and creative developers evaluating the current SHARC reference implementation.

## Before You Start

SHARC is currently in active pre-1.0 development:

- Current package version in this repo: `0.6.0`
- npm package: **not yet published**
- Current supported implementation scope: **web iframe**, **iOS WKWebView**, **Android WebView**

Today, the practical way to evaluate SHARC is to build from this repository and use the generated `dist/` artifacts or the local browser harness.

## Package Entry Points

The repository builds one package with subpath exports:

- `@iabtechlab/sharc/sharc-container`
- `@iabtechlab/sharc/sharc-creative`
- `@iabtechlab/sharc/sharc-protocol`
- `@iabtechlab/sharc/sharc-mraid-bridge`
- `@iabtechlab/sharc/sharc-safeframe-bridge`
- `@iabtechlab/sharc/sharc-omid-bridge`

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
- `http://localhost:8765/examples/omid-integration-test.html` — OMID bridge integration page

Use `?build=dist` on the core harness to validate the built artifacts.

## TypeScript Support

As of `0.6.0`, every public subpath ships a generated `.d.ts` declaration alongside its `.mjs` bundle. TypeScript consumers get IntelliSense and compile-time argument validation on `new SHARCContainer({...})`, every bridge constructor, and the creative API surface — no `@types/sharc` needed.

## Container Usage

### ESM / bundler

```js
import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';

const container = new SHARCContainer({
  creativeUrl: 'https://ads.example.com/creative.html',
  placementElement: document.getElementById('ad-slot'),
  environmentData: {
    currentPlacement: {
      width: 320,
      height: 50,
      inline: true,
    },
  },
  autoStart: false,
});

container.load();
// Later, after the creative resolves init:
container.start();
```

### Browser bundle

```html
<script src="./dist/sharc-protocol.js"></script>
<script src="./dist/sharc-container.js"></script>
<script>
  const container = new window.SHARC.Container({
    creativeUrl: '/creative.html',
    placementElement: document.getElementById('ad-slot'),
    environmentData: {
      currentPlacement: { width: 320, height: 50, inline: true }
    }
  });

  container.load();
</script>
```

## Creative Usage

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

## Security Model at a Glance

The reference web container uses a sandboxed iframe with:

```html
<iframe sandbox="allow-scripts allow-forms allow-popups"></iframe>
```

Notably:

- `allow-same-origin` is intentionally **not** used
- SHARC uses a transferred `MessageChannel` port after bootstrap
- Creatives should route navigation and tracker firing through the SHARC API rather than bypassing the container

## Platform Integration

SHARC runs on iOS WKWebView and Android WebView in addition to web iframes. Native integration wiring guides are in progress pending working Swift and Kotlin sample implementations — see issues #51 (iOS) and #52 (Android). The state machine mapping for both platforms is documented in [docs/architecture-design.md](./architecture-design.md#5-container-state-machine).

## Recommended Next Reading

- [docs/current-status.md](./current-status.md) — project maturity and scope
- [docs/api-reference.md](./api-reference.md) — authoritative public API and protocol details
- [docs/creative-cookbook.md](./creative-cookbook.md) — practical creative implementation patterns
- [docs/architecture-overview.md](./architecture-overview.md) — maintainer orientation
- [docs/design/mraid-bridge-design.md](./design/mraid-bridge-design.md)
- [docs/design/safeframe-bridge-design.md](./design/safeframe-bridge-design.md)
