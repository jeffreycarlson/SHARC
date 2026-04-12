# MRAID 3.0 Compliance — Manual Runbook

This runbook covers the portion of the IAB MRAID 3.0 compliance suite that cannot
be exercised by the automated runner (`examples/test/mraid-3-compliance-runner.html`)
because the vendor compliance ad is gated on human interaction.

The automated runner handles `resize-negative` and `viewability` end-to-end. This
document is only for the `loadandevents` suite.

## Why this is manual

`examples/compliance-ads/loadandevents/aronmraid3.js` defines a 6-step workflow
(`stepchange(1)` through `stepchange(6)`) at lines 176-211. Each step injects an
`<a onclick="...">` button into `#step` and waits for a user tap. The taps drive
the lifecycle assertions at lines 333, 337, 350, 354, 373, 377, 395, 399 — 9 of
the 12 total `CHECK:` / `FAIL:` reporters in the suite. The remaining 3 fire at
bootstrap and are captured automatically.

A programmatic click driver was considered during the 2026-04-11 harness review
(see `docs/reviews/mraid-compliance-harness-2026-04-11.md` Decision 2). It was
rejected for this pass because step 2 ("Tap SDK Close Button") requires
cross-realm coordination with the container to collapse from the expanded state,
which pushes the driver past the ~50 LOC ceiling agreed with the reviewer panel.

When someone does implement the driver, the right hook is a per-step completion
signal from the wrapper back to the runner — probably an additional
`postMessage({source:'sharc-test-harness', kind:'step-complete', step:N})`
emitted from an observation shim layered over `aronmraid3.js`.

## Prerequisites

1. `node server.js` running from the repo root.
2. `http://localhost:8765/examples/test/mraid-3-compliance-runner.html` open in
   a browser window large enough to show the ad area plus the protocol log pane.
3. The browser devtools console open. The automated runner captures
   `console.log`/`console.error` from inside the creative iframe via an in-realm
   shim, but having the raw devtools console up makes drift easier to spot.

## Procedure

1. Click **Run** next to "Load & Events" (or use **Run All**).

2. The runner will load `mraid-wrapper.html?creative=compliance-ads/loadandevents/ad.html`,
   establish the SHARC handshake, advance to `active`, and execute `aronmraid3.js`
   through `initad()` → `stepchange(1)`. At this point the runner verdict will be
   **Manual** (yellow/orange) with 3 passing checks captured:
   - `CHECK: Detected MRAID_ENV`
   - `CHECK: In loading state.` *(first time only — subsequent runs may skip this
     if the creative is re-loaded into a ready container)*
   - `CHECK: State is default after ready`

3. Click the button labeled **Tap For Expand/stateChange Check** inside the ad
   area. This fires `expandstatecheck()` which calls `mraid.expand()` and
   registers a stateChange listener. Expected: the ad expands to fill the
   viewport, a log pane appears inside the expanded overlay, and a new console
   line reads `CHECK: Expand state change detected` (or the corresponding `FAIL:`).

4. Click **Tap SDK Close Button**. In a production environment this is the
   platform-native close chrome. In the SHARC harness there is no such chrome,
   so instead: click the **Close** button in the browser tab's top-right if the
   container added one, OR call `container.close()` from the devtools console:
   ```js
   container.close();
   ```
   Expected: the ad collapses back to default placement and the workflow
   advances to step 3.

5. Click **Tap For Expand/sizeChange Check**. Fires `expandsizecheck()`.
   Expected `CHECK: Expand size change detected`.

6. Click **Tap To Close Expand**. Fires `expandsizeclose()`.
   Expected `CHECK: Expand size close detected`.

7. Click **Tap To Check Logs**. Fires `expandlog()`. Expected the creative's
   internal log pane to display in a second expand, and a `CHECK:` line
   confirming log rendering.

8. Click **Tap To Unload**. Fires the creative's `unload()` which calls
   `mraid.unload()`. The SHARC MRAID bridge maps this to `SHARC.requestClose()`,
   which the container honours, firing `onClose` and surfacing `markDone('closed')`
   to the runner's observation loop.

9. At this point the runner's verdict should flip from **Manual** to **Passed (N)**
   where N is the total number of `CHECK:` lines captured (target: 12 / 12).
   Any `FAIL:` line captured along the way will instead produce a **Failed**
   verdict with the fail list preserved in the exported baseline JSON.

## Capturing a baseline after the manual run

Click **Export JSON** in the runner header. The downloaded file
`sharc-mraid3-baseline-YYYY-MM-DD-HHMMSS.json` contains the three-layer artifact
(compliance matrix + console stream + protocol trace) for all three suites,
including the interactively-driven `loadandevents` results. Commit this file
alongside any refactor whose protection against regression it is meant to
establish.

## Known gaps (not runbook bugs)

- `aronmraid3.js:100` has a typo: `if (mraid.getVersion == '3.0')` missing
  parentheses on `getVersion()`. The comparison is always `false`, so the
  `audioVolumeChange` listener is never registered in the vendor suite. The
  SHARC MRAID bridge implements `audioVolumeChange` correctly; the gap is in
  the IAB test vector, not in SHARC. Tag any missing audio-volume assertion in
  `compliance-expected-results.json` (when that file exists) as
  `skipped-vendor-bug`.

- The SHARC container does not surface a chrome "SDK close" button by default —
  step 4 of the runbook falls back to `container.close()` from devtools. If a
  publisher integration supplies a chrome close control, replace that step with
  "Click the platform close button" when running the procedure against that
  integration.
