# SHARC Creative Validator Hardening Harness

**Status:** Planned
**Target:** Private hardening harness first; public validator later if the workflow proves stable.
**Issue:** Future operator validation tooling and compatibility hardening.

## 1. Goal

SHARC's long-term compatibility goal is to run any valid creative thrown at it:
regular HTML, MRAID, SafeFrame, SHARC-native creatives, and creatives that need
coordinated OMID measurement. The hardening harness exists to make that promise
testable against real bid-derived creative payloads.

The first version is intentionally private and experimental. It should run a
repo-local private corpus of cleaned OpenRTB export rows, identify where
creatives fail under SHARC, and provide enough structured evidence to decide
whether the failure belongs to the creative, the renderer deployment, a bridge
adapter, OMID setup, or SHARC itself.

The harness is a discovery tool, not a certification suite. Its job is to find
edge cases, group them, and feed focused SHARC issues and regression fixtures.

## 2. Non-Goals

- Do not rebase or merge the old `spike/sharc-creative-validator` branch
  wholesale. It is source material only.
- Do not commit private real bid responses, raw `adm`, tracking URLs, advertiser
  domains, device/user identifiers, or generated private reports.
- Do not build a polished public npm package in the first iteration.
- Do not make console noise fatal by default. Real creatives are noisy; console
  diagnostics become fatal only when tied to container failure.
- Do not treat VAST/XML or native JSON payloads as executable v0 scope. They
  should be classified and skipped until the harness has a deliberate runner for
  those formats.
- Do not run Creative URL mode in v0. The initial private corpus is `adm`-driven,
  so the first runner is Creative Markup only.
- Do not auto-file GitHub issues from harness output. Triage is manual until the
  signal is reliable.

## 3. Starting Inputs

The initial private corpus lives under `tools/creative-validator/private/` and is
ignored by git. The current cleaned export shape is:

```json
[
  {
    "id": "auction-row-id",
    "auction": [
      {
        "bidder": "bidder-name",
        "mtype": "banner",
        "bid_request": {},
        "bid_response": {}
      }
    ]
  }
]
```

Snapshot taken 2026-05-24 against a private corpus of 4 cleaned files. These
counts are illustrative planning data, not normative targets.

The cleaned files inspected during planning had this profile:

| Field | Observed |
|---|---:|
| cleaned files | 4 |
| rows | 297 |
| auction entries / bids | 437 |
| `adm` payloads | 437 |
| `curl` payloads | 0 |
| banner entries | 184 |
| video entries | 104 |
| native entries | 149 |
| HTML/banner-like `adm` | 148 |
| HTML with MRAID markers | 26 |
| VAST/XML `adm` | 104 |
| native JSON-like `adm` | 149 |
| other / needs classification | 10 |

API declarations were primarily on the matched impression, not the bid:

| Path | Observed |
|---|---:|
| `imp.banner.api` | 284 |
| `imp.video.api` | 96 |
| `imp.native.api` | 149 |
| `bid.api` | 14 |
| `bid.apis` | 0 |

This means v0 should optimize for the cleaned export shape and preserve API
provenance, instead of pretending the first corpus is a generic manifest format.

## 4. Repository Shape

The harness lives under:

```text
tools/creative-validator/
  private/              # gitignored corpus, reports, traces, screenshots
  fixtures/
    reductions/         # committed synthetic reductions only
  src/
```

`tools/creative-validator/private/` should contain:

- private cleaned corpus files
- optional local config
- generated reports under `private/reports/`
- traces/screenshots when enabled

Only synthetic, minimized reductions belong in git.

The feature work should use generic feature naming rather than agent-specific
branch names. Planned implementation branches and PRs should use the
`feat/creative-validator-*` family. The first implementation branch should be:

```text
feat/creative-validator-normalizer
```

That branch should establish the private corpus scaffolding, normalizer, and
classifier foundation described in Phase 1.

Initial CLI shape should stay small:

```text
creative-validator normalize <corpus-glob> --out tools/creative-validator/private/normalized/
creative-validator run <normalized-jsonl> --out tools/creative-validator/private/reports/
```

The command name can change before public packaging. The important v0 contract
is the split between normalization and execution.

## 5. Architecture

### 5.1 Normalizer

The normalizer reads the cleaned corpus and emits canonical test cases. It
should preserve enough provenance for triage while producing current
`SHARCContainer` inputs.

Canonical shape:

```json
{
  "source": {
    "rowIndex": 0,
    "auctionId": "auction-row-id",
    "auctionIndex": 0,
    "bidder": "bidder-name",
    "mtype": "banner"
  },
  "ids": {
    "responseId": "response-id",
    "bidId": "bid-id",
    "impId": "imp-id",
    "crid": "creative-id"
  },
  "creative": {
    "mode": "adm-html",
    "admKind": "html-mraid",
    "html": "<<PRIVATE_CORPUS_ADM_OR_SYNTHETIC_REDUCTION>>",
    "url": null,
    "width": 320,
    "height": 50,
    "placementType": "inline"
  },
  "bidSignals": {
    "apis": {
      "raw": [3, 5, 7],
      "sanitized": [3, 5, 7],
      "sources": [
        { "path": "imp.banner.api", "values": [3, 5, 7] }
      ]
    },
    "mtype": "banner",
    "adomain": ["example.invalid"],
    "cat": ["IAB0"],
    "battr": [],
    "placement": {},
    "measurement": {}
  },
  "expectations": {
    "declared": ["mraid", "omid"],
    "sniffed": ["mraid"],
    "execute": true,
    "skipReason": null
  },
  "sharcOptions": {
    "creativeMeta": {
      "apis": [3, 5, 7]
    },
    "requireSharcInit": false,
    "placementType": "inline"
  }
}
```

`creative.admKind` is a closed v0 enum:

```text
html | html-mraid | html-safeframe | vast-xml | native-json | unknown
```

Important corrections from the parked spike:

- `creativeMeta.apis` must be the sanitized integer array expected by current
  `SHARCContainer`, not the old `{ raw, sanitized }` object.
- API provenance belongs under `bidSignals.apis`.
- API extraction must consider `bid.api`, `bid.apis`, `imp.banner.api`,
  `imp.video.api`, and `imp.native.api`.
- API extraction should be media-aware. If the corpus item is `mtype: "banner"`,
  `imp.banner.api` is the primary impression source; video/native sources are
  still useful provenance but should not blindly force banner expectations.
- VAST/XML and native JSON should be classified via `admKind` and skipped in v0.

### 5.2 Classifier

The classifier predicts what SHARC should provide from both bid declarations and
creative-byte sniffing.

Signals:

- API declarations from bid and impression paths.
- HTML markers such as `mraid.js`, `window.mraid`, `$sf.ext`, and SafeFrame
  references.
- Payload kind via the `admKind` enum.
- OMID API code `7` as a measurement signal.

The report must preserve both declared and sniffed expectations. Mismatches are
diagnostic signals, not immediate failures.

### 5.3 Runner

The v0 runner executes banner/HTML-ish `adm` through the real SHARC markup path:

- Use local built renderer by default.
- Use `creativeHtml + creativeRendererUrl`.
- Attach to SHARC's `HtmlAdapter` path
  (`src/lifecycle-adapters/html-adapter.js`) for non-handshake creative
  lifecycle observation.
- Use current `SHARCContainer` support for `requireSharcInit: false` instead of
  bypassing SHARC for non-SHARC creatives.
- Use existing `puppeteer-core` and a local Chrome executable.
- Allow real network activity so the harness can surface real CORS, resource,
  and creative behavior.

Initial timeout defaults:

- render timeout: 10 seconds
- post-load settle window: 2 seconds

These defaults are intentionally conservative for a first private corpus pass:
they are long enough to cover slow third-party creative resources without
turning every bad creative into a multi-minute run.

These defaults should become CLI-configurable once the first runner lands.

For v0, terminal runner signals should be derived from `HtmlAdapter`-driven
container state plus SHARC security events. The runner should record whether
the case reaches `ACTIVE`, `PASSIVE`, `HIDDEN`, `FROZEN`, or `TERMINATED`, but
should only treat state as fatal when paired with timeout, termination, or a
fatal security event.

### 5.4 Bridge Probes

Bridge expectations come from both declaration and sniffing. The harness should
probe enough of each bridge to identify adapter gaps without becoming a full
MRAID/SafeFrame compliance suite.

MRAID examples:

- `window.mraid` exists when expected.
- state can be read without throwing.
- navigation calls route through SHARC observation surfaces.
- close/expand/resize probes are added as repeated failures justify them.

SafeFrame examples:

- `$sf.ext` exists when expected.
- `register`, `redirect`, and expansion-style calls are probed when a SafeFrame
  case appears in the corpus or a synthetic reduction is created.

### 5.5 OMID Probe

OMID API code `7` is a bid signal, not a renderer bridge. Operators ultimately
choose whether to enable OMID support at bid-request or ad-request time.

For the private harness, code `7` should exercise the ability to run the
container's OMID signal path when validator OMID support is enabled. Missing
sidecar data, missing local OMID defaults, or disabled validator OMID support
should produce diagnostics, not make an otherwise valid creative fail.

### 5.6 Diagnostics Capture

Each run should capture:

- `onSecurityEvent` payloads from `SHARCContainer`
- `HtmlAdapter`-driven lifecycle state and terminal/failure reasons where
  exposed
- concrete SHARC security event literals:
  - `renderer_protocol_error`
  - `renderer_failed`
  - `bridge_load_failed`
  - `feature_load_failed`
  - `unauthorized_navigation`
  - `wrapper_top_frame_inaccessible`
  - `renderer_origin_mismatch`
- `renderer_protocol_error.details.subtype` values:
  - `malformed_payload`
  - `timeout`
  - `post_failed`
  - `integrity_failed`
- browser console errors and warnings
- page errors
- failed network requests
- CORS- and CSP-like browser error messages when observable

Raw SHARC event names, reasons, and error codes should be preserved in the
report alongside the higher-level diagnosis bucket.

### 5.7 Reporter

Result granularity is one row per bid/test case with nested probe results. The
report should support both human triage and machine filtering.

Initial diagnosis buckets:

- `unsupported-input` — normalized case is valid, but not executable by the v0
  runner, such as VAST/XML or native JSON.
- `creative-broken` — page/runtime errors appear before SHARC can establish the
  expected execution path, or the same failure is observed outside SHARC.
- `sharc-runner-error` — the harness, container construction, or adapter wiring
  throws independently of the creative.
- `renderer-timeout` — `renderer_protocol_error` with
  `details.subtype: "timeout"` or no terminal signal within the render timeout.
- `renderer-integrity` — `renderer_protocol_error` with
  `details.subtype: "integrity_failed"` or related renderer-integrity preflight
  failure.
- `renderer-origin` — `renderer_origin_mismatch` or equivalent origin validation
  failure.
- `renderer-protocol` — `renderer_protocol_error` with `malformed_payload` or
  `post_failed`, excluding timeout and integrity subtypes that have dedicated
  buckets.
- `bridge-missing` — declared or sniffed MRAID/SafeFrame expectation is not
  present after SHARC bridge resolution.
- `bridge-api-error` — bridge object exists but required probe calls throw or
  produce invalid results.
- `navigation-policy` — `unauthorized_navigation` or observed click/navigation
  escape outside SHARC's navigation observation path.
- `network-cors` — failed external resource request, CORS-like browser error,
  or CSP-like browser error that affects creative execution.
- `measurement-omid` — OMID API 7 signal path cannot be exercised because of
  sidecar/config/feature load diagnostics.
- `inconclusive` — the run lacks enough terminal evidence to assign a more
  specific bucket.

These buckets are expected to evolve as real failures are observed.

Initial report output should prefer JSONL for corpus-scale runs, with one line
per bid/test case and nested probe results. JSON arrays or per-case files can
be added later if a consumer needs them.

## 6. Pass Criteria

For v0 HTML `adm`, "runs well" means:

- the document executes in the DOM through SHARC
- no fatal renderer/container timeout
- no fatal SHARC security event
- no fatal bridge setup failure for required compatibility surfaces
- navigation attempts are observed through SHARC surfaces rather than escaping
  container policy

Console errors, external resource failures, and CORS failures are diagnostic by
default. They become fatal only when tied to the creative failing to execute or
to a SHARC compatibility promise.

## 7. Privacy And Reduction Policy

Private corpus and generated output stay under ignored paths. Public committed
fixtures must be synthetic reductions.

Never commit:

- real raw `adm`
- real advertiser domains
- tracking URLs
- bid IDs
- auction IDs
- user/device identifiers
- IP addresses or IFA-like identifiers
- generated private reports, traces, or screenshots

Promotion workflow:

1. Run private corpus.
2. Identify repeated failures or a single failure that exposes a real SHARC gap.
3. Hand-write a minimal synthetic OpenRTB row and minimal creative HTML that
   reproduces only the relevant behavior.
4. Place it under
   `tools/creative-validator/fixtures/reductions/NNN-<bucket>-<short-slug>/`.
5. Add it as a regression fixture once the SHARC fix lands.

Reduction rule: if deleting a line still reproduces the behavior, delete the
line.

## 8. Phased PR Plan

### Phase 1 — Normalizer and Classifier

Suggested branch: `feat/creative-validator-normalizer`.

- Add `tools/creative-validator/` scaffolding.
- Add `.gitignore` coverage for `tools/creative-validator/private/`.
- Support cleaned corpus files.
- Emit canonical test-case JSON.
- Extract `adm`, `curl`, dimensions, placement, mtype, bidder, bid IDs, API
  declarations with provenance, and basic OMID signal presence.
- Classify executable v0 cases versus skipped VAST/native/unknown cases.
- Add a synthetic minimal `cleaned-corpus.fixture.json` under
  `tools/creative-validator/fixtures/reductions/`, consumed by Phase 1
  normalizer tests.

### Phase 2 — SHARC Markup Runner

- Run executable banner/HTML-ish `adm` through local SHARC renderer.
- Use `puppeteer-core` and local Chrome.
- Capture lifecycle, `onSecurityEvent`, console, page errors, failed requests,
  navigation callbacks, and timeout reasons.
- Write reports under `tools/creative-validator/private/reports/`.

### Phase 3 — Bridge Probes

- Add MRAID presence and basic API probes.
- Add SafeFrame probes when corpus or reductions justify them.
- Compare declared versus sniffed bridge expectations.

### Phase 4 — OMID Signal Path

- Add validator-local OMID defaults/stubs.
- Exercise API `7` signal path when enabled.
- Record missing sidecar/config as diagnostics.

### Phase 5 — Network And CORS Diagnostics

- Group failed requests by resource type and origin.
- Surface CORS/CSP/resource failures as report facets.
- Add direct header checks for renderer/SDK/OMID resources when useful.
- Treat the first implementation as iterative: Phase 2/3/4 triage should decide
  which network failures deserve first-class buckets before this phase hardens
  the final report shape.

### Phase 6 — Triage And Regression Workflow

- Run the private corpus extensively.
- Group failures by bidder, mtype, API declaration, adm classification, and
  diagnosis bucket.
- Promote repeated or SHARC-owned failures into synthetic reductions.
- File focused issues manually from triaged findings.

## 9. Parked Spike Reuse

The local `spike/sharc-creative-validator` branch contains useful source
material:

- bid selection and cleaned-row processing
- `adm` base64 and wrapper unwrapping
- API sanitization
- placement/dimension extraction
- early renderer orchestration and reporting ideas

It also contains stale or out-of-scope material:

- old source/version changes from a pre-0.7.6 branch
- old `requireSharcInit` assumptions that bypassed SHARC instead of using the
  current `requireSharcInit: false` container path
- `.claude/` files
- `_site/` output
- a broad creative/container matrix that should be rebuilt in phases

Reuse should happen by selective copying and rewriting on fresh branches from
current `main`, not by rebasing the spike.
