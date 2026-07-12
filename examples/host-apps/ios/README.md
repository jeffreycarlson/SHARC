# SHARC G6 iOS Walking-Skeleton Harness

This directory contains the G6 iOS walking skeleton for issue #432. It is a thin
WKWebView host app, not a native SHARC container. The app loads a local HTTP
host page, runs the public G5 URL-mode fixtures with the same JavaScript
container bundles from `dist/`, and prints one NDJSON report row per fixture via
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

The runner:

1. starts two local `server.cjs` instances, matching the G5 two-origin pattern
   (`18865` host / `18867` creative);
2. builds `SHARCG6Harness.xcodeproj` for an available iOS Simulator;
3. installs and launches `com.iabtechlab.SHARCG6Harness` with
   `xcrun simctl launch --console`;
4. captures NDJSON rows from stdout;
5. compares them with
   `examples/host-apps/ios/baselines/g5-public-fixtures.web.jsonl`.

The gate passes only when row-count parity holds and `regressionClean` is true.
That means the in-app verdicts are identical to the committed web baseline.

## Evidence Tier

This is the ratified G6 walking-skeleton tier from
`docs/design/0.8.0-g6-omid-in-app-design.md` Decision 6:

- Simulator runs are the automated gate.
- Real-device runs are manual spot checks.
- XCUITest is intentionally not used; verdict rows are already the test output.
- The app uses an ATS localhost exception only, so the fixture servers can run
  over local HTTP.

## Explicit Gap

The port-exfiltration-across-navigation must-test is out of scope for this
walking skeleton. It needs the later app adapter / host lifecycle seam. This
harness names that gap rather than silently treating it as covered.

## Files

- `SHARCG6Harness.xcodeproj/` — minimal iOS app project.
- `SHARCG6Harness/` — SwiftUI WKWebView app and ATS plist.
- `harness/index.html` — in-page G5 fixture runner.
- `baselines/g5-public-fixtures.web.jsonl` — committed web baseline report for
  the same public fixtures.
