# MRAID Conformance Close — Issue #417

Private corpus rerun date: 2026-07-05.

This note records the aggregate result of the local-only corpus regression run
for issue #417. Detailed row-level reports, notes, and rerun files remain under
`tools/creative-validator/private/regression/issue-417/` and are not committed.

## Inputs

- Baseline build: Slice-D commit `613433a`.
- Current build: `cc8c4bd` (`test: add MRAID lifecycle validator gates (#419)`).
- Normalized corpus: latest 1,745-row private normalized corpus file.
- Local comparison command: `creative-validator compare`.

## CI-Runnable Conformance Gate

The committed fixture at
`tools/creative-validator/fixtures/mraid-lifecycle-gates/` ran as expected:

- 3 IAB MRAID compliance ads passed the staged gates.
- The synthetic never-fires-ready row failed gate 2.
- Gate 2 asserted `ready` delivery at or after document load and late ready
  replay.

## Private Corpus Result

| Run | Passed | Failed | Skipped | Total |
| --- | ---: | ---: | ---: | ---: |
| Slice-D baseline | 851 | 89 | 805 | 1,745 |
| Current | 852 | 88 | 805 | 1,745 |

Comparison totals:

- Verdict changes: 10.
- Pass-to-fail changes: 2.
- SHARC-attributed pass-to-fail regressions: 0.
- Undocumented pass-to-fail changes after triage notes: 0.
- Added/missing rows: 0.

Verdict-change causes:

- 3 rows moved from `failed/renderer-timeout` to `passed/passed`; recorded as
  SHARC/validator improvement.
- 5 rows stayed in `failed/measurement-omid` with reason-text movement only;
  recorded as diagnostic classification movement. The OMID reasons vocabulary
  work is intentionally out of #417 scope.
- 2 rows moved from `passed/passed` to `failed/renderer-timeout` in the full
  run. Both passed in 3/3 targeted current reruns, with MRAID `ready` delivered
  after document load, so they were recorded as transient creative/network/browser
  timing rather than SHARC E3 ready-timing regressions.

Conclusion: the current build is corpus regression-clean under #417's
conformance-clean definition.
