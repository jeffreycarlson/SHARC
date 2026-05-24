# SHARC Operator Cookbook

**Audience:** Ad-tech engineers integrating `SHARCContainer` in DSPs, SSPs,
ad servers, publisher SDKs, and validator tooling.

This cookbook focuses on operator-side integration patterns introduced in
0.7.2 and 0.7.3. Creative-side authoring patterns live in
[creative-cookbook.md](./creative-cookbook.md), and the full API surface is in
[api-reference.md](./api-reference.md).

---

## Table of Contents

1. [Lift Legacy OpenRTB adm into SHARC](#1-lift-legacy-openrtb-adm-into-sharc)
2. [Render Non-SHARC Creatives in a SHARC Container](#2-render-non-sharc-creatives-in-a-sharc-container)
3. [Combine SDK Injection with Operator Extensions](#3-combine-sdk-injection-with-operator-extensions)
4. [Migration from the PR #103 Preview Injector](#4-migration-from-the-pr-103-preview-injector)
5. [Wire Container-Owned OMID Measurement](#5-wire-container-owned-omid-measurement)

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

Creative URL variant (0.7.4+): `creativeSdkUrl` is supported on the URL
variant when the operator also passes `useMarkupInjection: true`. With that
flag the container fetches the creative URL, runs the built-in SDK injector
first (mirroring the Markup-variant ordering — operator extensions see the
markup with the SDK already present), and loads the result via
`iframe.srcdoc`. Without `useMarkupInjection: true` the URL variant continues
to load via `iframe.src` and `creativeSdkUrl` is a no-op (so operators
sharing constructor config across Markup and URL bid variants don't see
iframe-loading semantics flip from `src` to `srcdoc` under them). Fetch
failures (CORS, 404, transport) emit a `console.warn` and fall through to
the un-injected `iframe.src` load — no SHARCSecurityEvent fires, and the
`com.iabtechlab.sharc.creative-injector` feature is NOT advertised (no
capability lie). See [issue #106](https://github.com/jeffreycarlson/SHARC/issues/106)
and [0.7.4 design § 2.1](./design/0.7.4-omid-hardening.md).

Known limit: the built-in SDK injector uses lightweight scanning rather than a
full HTML tokenizer. It handles comment-contained `<head>` tokens, legacy SGML
doctype internal subsets, and literal `>` characters inside quoted `<head>`
attributes, but the `creativeSdkSkipIfPresent` idempotency guard still uses a
targeted regex and can behave imperfectly with entity-encoded or pathological
script markup.

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

## 5. Wire Container-Owned OMID Measurement

Use this pattern when the operator needs IAB Open Measurement (OMID) viewability
and impression measurement on a mix of MRAID, SafeFrame, and SHARC-native
creatives without modifying any of them. The container loads OM SDK on the
publisher page and drives the `AdSession` lifecycle from container state
transitions. Creatives do nothing.

```javascript
// Operator wires OMID measurement once at the container layer. The same
// container handles MRAID, SafeFrame, and SHARC-native creatives uniformly;
// none of them need an OMID integration.

import { SHARCContainer }   from '@iabtechlab/sharc/sharc-container';
import { OmidCompatBridge } from '@iabtechlab/sharc/sharc-omid-bridge';

const omidBridge = new OmidCompatBridge({
  omSdkServiceScriptUrl: 'https://cdn.operator.example/omid/omweb-v1.js',
  omSdkSessionClientUrl: 'https://cdn.operator.example/omid/omid-session-client-v1.js',
  partnerName:    'OperatorName',
  partnerVersion: '1.0.0',
  creativeType:   'video',                  // 'video' | 'audio' | 'display'
  impressionType: 'definedByJavaScript',
  mediaType:      'video',
  verificationScripts: [
    {
      resourceUrl:            'https://verification.vendor.example/script.js',
      vendorKey:              'vendor-id',
      verificationParameters: 'opaque-vendor-string',
    },
  ],
});

const container = new SHARCContainer({
  creativeHtml:        bid.adm,
  creativeRendererUrl: 'https://renderer.operator.example/r/',
  placementElement:    document.getElementById('ad-slot'),
  extensions:          [omidBridge],
});

container.load();
```

OMID is intentionally an extension, not a bridge. `bridges` is scoped to
renderer-loaded creative API compatibility (`'mraid'`, `'safeframe'`); OMID is
measurement, not API translation. Passing `bridges: ['omid']` is rejected at
construction, and AdCOM `APIFramework` code `7` never adds a renderer bridge.
Install `OmidCompatBridge` explicitly with `extensions`, or use
`omidAutoInstall` with `creativeMeta.measurement.omid.verificationScripts` when
bid metadata carries OMID verification resources.

`omSdkServiceScriptUrl`, `omSdkSessionClientUrl`, and every
`verificationScripts[].resourceUrl` are validated at construction — HTTPS
required, userinfo rejected — and verification scripts are deduplicated by URL.
Misconfiguration throws synchronously from the `OmidCompatBridge` constructor
(`must use HTTPS`, `must not include userinfo`), so operators find wiring bugs
at boot, not at first render.

### Lifecycle

The container drives the OM SDK session from its own state machine. No
creative-side calls are involved.

| Container event              | OM SDK action                                    |
|------------------------------|--------------------------------------------------|
| `container.load()`           | `_ensureSdkLoaded()` injects OM SDK scripts on the publisher page (skipped if already present) |
| `ready`                      | `AdSession.start()` (waits for SDK load to resolve first) |
| First `active`               | `AdEvents.loaded(VastProperties)` + `impressionOccurred()` (single-fire) |
| `active ↔ passive`           | `AdEvents.stateChange('VISIBLE' \| 'NON_VISIBLE')` |
| `active → hidden \| frozen`  | `AdEvents.stateChange('NON_VISIBLE')`            |
| Placement intent change      | `MediaEvents.playerStateChange(mode)` (video/audio only) |
| `close`, `destroy`, `error`, `terminated` | `AdSession.finish()` (idempotent) |

Full state-mapping table and ordering constraints live in
[`docs/design/0.7.3-omid-wiring.md`](design/0.7.3-omid-wiring.md) §4 and §8.

### Friendly obstructions

The container's auto-rendered dismiss button registers itself as a friendly
obstruction on the active OM SDK session. No operator code is required. If the
publisher overlays additional UI on top of the ad slot (close affordances,
debug chrome, opt-out badges), register those explicitly:

```javascript
omidBridge.registerFriendlyObstruction(
  document.getElementById('publisher-close'),
  'closeAd',
  'Publisher-rendered close affordance'
);
```

`purpose` follows OM SDK's `FriendlyObstructionPurpose` enum (default
`'closeAd'`); pass any string the OM SDK spec defines. The bridge stores the
element synchronously, attempts registration immediately, and re-registers
automatically when `AdSession.start()` runs if the session wasn't ready yet.

When both OM SDK URLs are configured, `OmidCompatBridge.getFeatureName()`
returns `'com.iabtechlab.sharc.omid'` and the container adds it to
`supportedFeatures` in `SHARC:Container:init`. If either URL is omitted, the
bridge is inert: no scripts load, no feature is declared, no session starts.
SHARC-aware creatives check the feature flag and skip any creative-side OMID
shim:

```javascript
SHARC.onReady(() => {
  if (SHARC.hasFeature('com.iabtechlab.sharc.omid')) {
    // Container is measuring; skip the creative's own OM SDK init.
  }
});
```

When the OM SDK Service Script or Session Client fails to load (404, network
failure, fetch error), the container logs a `[SHARC OMID Bridge]` warning and
continues the SHARC lifecycle. The ad still renders; only measurement is lost.
The bridge does not currently signal this to operator code — the feature stays
advertised in `supportedFeatures` even when the SDK failed to load. Clearer
signaling is tracked in [issue #125](https://github.com/jeffreycarlson/SHARC/issues/125).
If measurement is required (not best-effort), confirm OM SDK loads by checking
the Network tab for 200 responses on both OM SDK URLs, watching the console for
`[SHARC OMID Bridge]` warnings, and running the
[`examples/demos/omid-integration/`](../examples/demos/omid-integration/) demo
against your CDN.

`OmidCompatBridge` is fully container-owned in both Markup and URL variants —
OM SDK loads on the publisher page regardless of how the creative is delivered.
The related `creativeSdkUrl` SHARC-SDK auto-injection (see recipe 1) reached
URL-variant parity in 0.7.4 ([issue #106](https://github.com/jeffreycarlson/SHARC/issues/106));
the URL-variant injector activates when the operator opts in via
`useMarkupInjection: true`.

See also: [README OMID section](../README.md#open-measurement-omid),
[design spec](design/0.7.3-omid-wiring.md),
[working demo](../examples/demos/omid-integration/).
