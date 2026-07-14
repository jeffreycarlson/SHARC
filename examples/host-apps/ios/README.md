# SHARC G6 iOS Harness

This directory contains the G6 iOS harness for issues #432, #435, and #436. It is a
thin WKWebView host app, not a native SHARC container. The app loads a local
HTTP host page, runs the public G5 URL-mode fixtures plus the G6 phase-2
in-app rows plus one public G6 MRAID Markup renderer-topology row with the
same JavaScript container bundles from `dist/`, and
prints one NDJSON report row per fixture via
`window.webkit.messageHandlers.sharcHarness.postMessage(row)`.

The native side performs no verdict interpretation. It serializes the row it
receives from JavaScript and exits after the terminal summary message. The Node
runner compares those rows against the committed web baseline using
`compareReportVerdicts`.

## Local Gate

From the repository root:

```sh
npm run build
node scripts/run-ios-walking-skeleton.js
```

The default public runner:

1. starts two local `server.cjs` instances, matching the G5 two-origin pattern
   (`18865` host / `18867` creative), with renderer origins reserved at
   `18866` and `18868`;
2. builds `SHARCG6Harness.xcodeproj` for an available iOS Simulator;
3. installs and launches `com.iabtechlab.SHARCG6Harness` with
   `xcrun simctl launch --console`;
4. captures NDJSON rows from stdout;
5. compares them with
   `examples/host-apps/ios/baselines/g5-public-fixtures.web.jsonl`.

The gate passes only when row-count parity holds and `regressionClean` is true.
That means the in-app verdicts are identical to the committed web baseline.
The runner also asserts the phase-2 rows directly: URL-mode 7/7 must stay
identical, the host-lifecycle round-trip must pass, the port-exfiltration
navigation row must fail closed as `navigation-policy`, and expand/collapse
must pass. The committed MRAID Markup row proves the host page can construct a
markup-variant container with `creativeHtml` plus a third-origin
`creativeRendererUrl`, and that the renderer-provided MRAID bridge can bring a
raw `mraid.js` creative through the in-app WKWebView path.

## MRAID Corpus Sample

Issue #436 adds an operator-only private corpus gate. Real MRAID creatives are
not committed, so the sample input, matching web baseline, iOS report, and
comparison output stay under `tools/creative-validator/private/`.

First materialize the private sample from a normalized corpus and a broad web
report that covers enough candidate rows:

```sh
node scripts/run-ios-walking-skeleton.js \
  --prepare-mraid-sample-only \
  --mraid-corpus tools/creative-validator/private/normalized/openrtb-parsing-20260529-api7-cases.jsonl \
  --mraid-web-report tools/creative-validator/private/reports/openrtb-parsing-20260529-post-213-report.jsonl \
  --mraid-sample-size 50
```

Then run a current web-validator baseline for the exact selected sample:

```sh
node tools/creative-validator/src/cli.js run \
  tools/creative-validator/private/g6-ios-mraid-corpus-sample/sample.jsonl \
  --out tools/creative-validator/private/g6-ios-mraid-corpus-sample/current-web-report.jsonl
```

Finally run the in-app comparison against that current web baseline:

```sh
npm run build
node scripts/run-ios-walking-skeleton.js \
  --mraid-corpus tools/creative-validator/private/normalized/openrtb-parsing-20260529-api7-cases.jsonl \
  --mraid-web-report tools/creative-validator/private/g6-ios-mraid-corpus-sample/current-web-report.jsonl \
  --mraid-sample-size 50
```

In MRAID corpus mode the runner:

1. filters executable Creative Markup rows with an MRAID declaration, sniffed
   MRAID signal, or MRAID AdCOM API metadata;
2. selects a deterministic stratified sample across
   `bidder | admKind | MRAID signal` buckets;
3. writes the selected private sample to
   `tools/creative-validator/private/g6-ios-mraid-corpus-sample/sample.jsonl`;
4. extracts matching rows from the supplied web-validator report into
   `tools/creative-validator/private/g6-ios-mraid-corpus-sample/web-baseline.jsonl`;
5. runs only that sample through WKWebView using `hostContext: 'app'` and the
   markup renderer path;
6. compares every iOS verdict against the matching web-validator verdict with
   `compareReportVerdicts`.

The corpus gate fails closed unless row-count parity holds,
`regressionClean === true`, and `verdictChanges === 0`. Any divergence must be
triaged in the sanitized report before treating the run as clean.

## Phase 2 Coverage

Issue #435 extends the walking skeleton into the in-app seam coverage tier:

- Containers are constructed with `hostContext: 'app'`, selecting
  `AppLifecycleAdapter`.
- The native app maps iOS app notifications to host inputs: inactive →
  `setHostLifecycle('passive')`, background → `setHostLifecycle('hidden')`,
  `setHostExposure(0)`, then `setHostLifecycle('frozen')`, foreground →
  `setHostLifecycle('passive')`, and active → `setHostLifecycle('active')`
  plus `setHostExposure(100)`.
- The lifecycle row drives a Simulator background → foreground round-trip and
  requires the container to reach FROZEN and then re-assert ACTIVE.
- The named #432 port-exfiltration-across-navigation gap is now closed: the
  fixture captures the bootstrap port, navigates, and the expected verdict is
  the 2118 `navigation-policy` fail-closed path with no stolen-port delivery.
- The expand/collapse row exercises `requestPlacementChange` /
  `onPlacementChange` with `hostOwnsClamping: true`.

## Evidence Tier

This is the ratified G6 walking-skeleton tier from
`docs/design/0.8.0-g6-omid-in-app-design.md` Decision 6:

- Simulator runs are the automated gate.
- Real-device runs are manual spot checks.
- XCUITest is intentionally not used; verdict rows are already the test output.
- The app uses an ATS localhost exception only, so the fixture servers can run
  over local HTTP.

## Deferred Work

The iOS harness still does not cover full-corpus in-app reruns, OMID native
mode, real-device automation, or Android. Those remain separate contracts.

## Files

- `SHARCG6Harness.xcodeproj/` — minimal iOS app project.
- `SHARCG6Harness/` — SwiftUI WKWebView app and ATS plist.
- `harness/index.html` — in-page G5 fixture runner.
- `harness/fixtures/` — G6 phase-2 synthetic URL creatives and the public MRAID
  Markup renderer-topology fixture.
- `baselines/g5-public-fixtures.web.jsonl` — committed web baseline report for
  the same public fixtures, phase-2 rows, and public MRAID Markup row.
- `analysis/g6-mraid-corpus-sample.md` — sanitized corpus-sample run note,
  updated by private operator runs without exposing creative markup or URLs.
