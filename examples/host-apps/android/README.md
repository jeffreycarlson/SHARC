# SHARC G6 Android WebView Harness

This directory contains the G6 Android WebView harness for issue #437. It is a
thin native Android host app, not a native SHARC container. The app loads a
local HTTP host page, runs the public G5 URL-mode fixtures plus the G6 phase-2
in-app rows with the same JavaScript container bundles from `dist/`, and prints
one NDJSON report row per fixture through a JavaScript interface.

The native side performs no verdict interpretation. It serializes each row to
logcat with the `SHARC_G6` tag, and `scripts/run-android-webview-harness.js`
collects those rows, writes the report, compares against the committed web
baseline, and asserts the Android phase-2 rows directly.

## Running

From the repository root:

```sh
npm run build
npm run test:g6-android-webview
```

The runner requires Android command-line tools on `PATH`:

- `adb`
- `gradle` or `GRADLE=/path/to/gradle`

It selects the first connected emulator/device unless `--device <serial>` is
provided. The gate is intended for an Android emulator; real devices are manual
evidence only because host loopback and lifecycle automation vary by device.

Useful options:

```sh
node scripts/run-android-webview-harness.js --device emulator-5554
node scripts/run-android-webview-harness.js --skip-build --apk examples/host-apps/android/app/build/outputs/apk/debug/app-debug.apk
node scripts/run-android-webview-harness.js --timeout-ms 120000
```

The emulator reaches the host servers through `10.0.2.2`, so the runner serves
the repository on local ports `18865` and `18867` and loads:

```text
http://10.0.2.2:18865/examples/host-apps/android/harness/index.html
```

## Phase 2 Coverage

Issue #437 ports the proven iOS phase-2 stack to Android WebView:

- Containers are constructed with `hostContext: 'app'`, selecting
  `AppLifecycleAdapter`.
- The native app maps Android lifecycle callbacks to host inputs:
  process/activity start -> `setHostLifecycle('passive')`, resume ->
  `setHostLifecycle('active')` plus `setHostExposure(100)`, pause ->
  `setHostLifecycle('passive')`, and process/activity stop ->
  `setHostLifecycle('hidden')`, `setHostExposure(0)`, then
  `setHostLifecycle('frozen')`.
- Focus is deliberately ignored; resumed-but-unfocused multi-window scenarios
  remain ACTIVE per the G6 U2 ruling.
- Android WebView is Blink, so page freeze/resume can also exist. The runtime's
  per-axis freeze latches and host-rise recompute remain under test by the
  lifecycle row, which requires FROZEN and then ACTIVE after foreground.
- The port-exfiltration-across-navigation fixture must fail closed as
  `navigation-policy` with no stolen-port delivery.
- The expand/collapse row exercises `requestPlacementChange` /
  `onPlacementChange` with `hostOwnsClamping: true`.

## Files

- `settings.gradle`, `build.gradle`, `app/build.gradle` — minimal Android
  project using the Android Gradle plugin.
- `app/src/main/` — native WebView harness app.
- `harness/index.html` — in-page G5/G6 fixture runner.
- `harness/fixtures/` — G6 phase-2 synthetic URL creatives.
- `baselines/g5-public-fixtures.web.jsonl` — committed web baseline report for
  the same public fixtures and Android phase-2 rows.
