# SHARC Operator Cookbook

**Audience:** Ad-tech engineers integrating `SHARCContainer` in DSPs, SSPs,
ad servers, publisher SDKs, and validator tooling.

This cookbook focuses on operator-side integration patterns introduced in
0.7.2. Creative-side authoring patterns live in
[creative-cookbook.md](./creative-cookbook.md), and the full API surface is in
[api-reference.md](./api-reference.md).

---

## Table of Contents

1. [Lift Legacy OpenRTB adm into SHARC](#1-lift-legacy-openrtb-adm-into-sharc)
2. [Render Non-SHARC Creatives in a SHARC Container](#2-render-non-sharc-creatives-in-a-sharc-container)
3. [Combine SDK Injection with Operator Extensions](#3-combine-sdk-injection-with-operator-extensions)
4. [Migration from the PR #103 Preview Injector](#4-migration-from-the-pr-103-preview-injector)

---

## 1. Lift Legacy OpenRTB adm into SHARC

Use `creativeSdkUrl` when the operator receives plain HTML, MRAID, or
SafeFrame adm from a third-party DSP and wants to lift it into SHARC at load
time.

```javascript
// Operator receives bid.adm from a third-party DSP. The adm is plain
// HTML / MRAID / SafeFrame, not necessarily SHARC-aware. The operator hosts
// sharc-creative.js and lets the container inject it at render time.

import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';

const container = new SHARCContainer({
  creativeHtml: bid.adm,
  creativeRendererUrl: 'https://renderer.operator.example/r/',
  placementElement: document.getElementById('ad-slot'),
  creativeSdkUrl: 'https://cdn.operator.example/sharc-creative.js',
  bridges: ['mraid'], // or let the container detect from bid metadata / adm
});

container.load();
```

The container injects a real parser-visible script tag into the Markup variant
before the renderer writes the creative. Injection uses a four-position anchor
contract: after `<head>`, otherwise after `<html>`, otherwise after
`<!DOCTYPE>`, otherwise prepended to the markup. The script is never inserted
before the doctype, which avoids forcing standards-mode markup into quirks
mode.

`creativeSdkSkipIfPresent` defaults to `true`. When the markup already includes
a real `<script src="...sharc-creative.js">` tag, the container leaves it
unchanged. Set it to `false` only for deliberate forced-injection cases, such
as versioned-SDK coexistence tests or controlled debug overlays.

The default `creativeSdkScriptAttrs: {}` emits a bare synchronous script tag.
That parser-blocking default is intentional for legacy MRAID: inline creative
code can call `mraid.*` immediately after the SDK and bridge load, so adding
`async`, `defer`, or a module type can reintroduce an inline-call race.

When `creativeSdkUrl` is active, the container advertises
`com.iabtechlab.sharc.creative-injector` in `supportedFeatures`. SHARC-aware
creatives can read the feature list and skip their own SDK-load shim.

Creative URL variant note: `creativeSdkUrl` is Markup-variant-only in 0.7.2.
Setting it on a Creative URL container does not inject the SDK and does not
advertise the feature flag. URL-variant parity is tracked in
[issue #106](https://github.com/jeffreycarlson/SHARC/issues/106).

Known limit: if your inventory contains malformed HTML with embedded quotes,
entity-encoded URLs, or pathologically long repeated `<script` tokens, the
built-in `skipIfPresent` detector can behave imperfectly. The catalog is in
[issue #104](https://github.com/jeffreycarlson/SHARC/issues/104).

## 2. Render Non-SHARC Creatives in a SHARC Container

Use `requireSharcInit: false` for mixed inventory pipelines and validators
that need the container's lifecycle, observability, and security boundaries
even when the creative never handshakes.

```javascript
// Operator wants container lifecycle and observability for a creative that
// does not speak SHARC. The missing handshake should not be fatal.

const container = new SHARCContainer({
  creativeHtml: legacyHtmlBanner,
  creativeRendererUrl: 'https://renderer.operator.example/r/',
  placementElement: document.getElementById('ad-slot'),
  requireSharcInit: false,
});

container.load();

// No handshake will arrive for plain HTML:
// container.hasSharcSession === false
// container.apiFramework === null when no recognized runtime is declared
```

`container.apiFramework` is declaration-driven and available immediately after
construction. It reflects the runtime declaration resolved from explicit
options, `creativeMeta.apis`, or adm scanning. `container.hasSharcSession` is
outcome-driven and should be read from `onStateChange`, `onError`, or after an
operator-owned lifecycle observation window.

```javascript
const declaredFramework = container.apiFramework;

const containerWithCallbacks = new SHARCContainer({
  creativeHtml: legacyHtmlBanner,
  creativeRendererUrl: rendererUrl,
  placementElement: slot,
  requireSharcInit: false,
  onStateChange(state) {
    if (state === 'active') {
      reportInventoryShape({
        declaredFramework,
        hasSharcSession: containerWithCallbacks.hasSharcSession,
      });
    }
  },
});
```

If a creative declared as non-SHARC still completes a SHARC handshake while
`requireSharcInit: false` is set, the container accepts the handshake but logs
a confused-deputy warning. Treat that as a declaration mismatch signal: the
creative behavior and bid metadata disagree.

Do not use `requireSharcInit: false` for pipelines where every creative is
expected to be SHARC-aware. Leave the default `true` so a missing handshake
remains a loud integration error.

## 3. Combine SDK Injection with Operator Extensions

Use this pattern when the operator needs the built-in SHARC SDK injection plus
custom markup transforms such as analytics tags, CSP nonce stamping, or
operator diagnostics.

```javascript
// Operator uses creativeSdkUrl for SDK injection and a custom extension for
// analytics injection.

const container = new SHARCContainer({
  creativeHtml: bid.adm,
  creativeRendererUrl: rendererUrl,
  placementElement: slot,
  creativeSdkUrl: 'https://cdn.operator.example/sharc-creative.js',
  extensions: [
    new OperatorAnalyticsExtension({ pixelUrl: analyticsPixelUrl }),
  ],
});
```

Execution order is fixed: built-in SDK injection runs first, then operator
extensions run in registration order. Extensions see markup with the SDK
already present.

Idempotency responsibility is split by owner. The built-in
`creativeSdkSkipIfPresent` guard prevents the container from injecting its own
SDK tag twice. Operator extensions that also inject `sharc-creative.js` are
responsible for their own deduplication. The recommended pattern is for the
extension to read `supportedFeatures` and skip SDK injection when
`com.iabtechlab.sharc.creative-injector` is present. This cookbook note closes
[issue #108](https://github.com/jeffreycarlson/SHARC/issues/108).

The common mistake is wiring both `creativeSdkUrl` and a custom
`SHARCCreativeInjector`-style extension. That creates two SDK loads and two
`SHARCCreativeProtocol` instances racing in the same iframe.

## 4. Migration from the PR #103 Preview Injector

The standalone `SHARCCreativeInjector` extension from the closed PR
[#103](https://github.com/jeffreycarlson/SHARC/pull/103) was never released.
The 0.7.2 API folds that capability into `SHARCContainer`.

Before:

```javascript
import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';
import { SHARCCreativeInjector } from '@iabtechlab/sharc/sharc-creative-injector';

const container = new SHARCContainer({
  // ...
  extensions: [
    new SHARCCreativeInjector({
      creativeSdkUrl: 'https://cdn.operator.example/sharc-creative.js',
      skipIfPresent: true,
      scriptAttrs: { async: true },
    }),
  ],
});
```

After:

```javascript
import { SHARCContainer } from '@iabtechlab/sharc/sharc-container';

const container = new SHARCContainer({
  // ...
  creativeSdkUrl: 'https://cdn.operator.example/sharc-creative.js',
  creativeSdkSkipIfPresent: true,
  creativeSdkScriptAttrs: { async: true },
});
```

Remove any import from `@iabtechlab/sharc/sharc-creative-injector`; that subpath
does not exist in 0.7.2. If the preview extension also carried unrelated
operator behavior, keep that behavior in a separate extension and make it
idempotent against `com.iabtechlab.sharc.creative-injector`.
