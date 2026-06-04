# OMID Inline Vendor Corpus Snapshot - Post-#301

Snapshot date: 2026-06-03

Related work: #244, #295, #301

This note records the sanitized aggregate outcome from the post-#301 private
corpus run. It is intended as a durable reference for the 0.7.8 OMID validator
work without committing raw creative data.

## Privacy Boundary

The source corpus, normalized rows, executable reports, and triage JSON remain
under `tools/creative-validator/private/` and are gitignored. This public note
intentionally omits raw creative IDs, raw markup, bidder names, full URLs, and
source-origin keys. Origin-keyed and bidder-keyed triage facets remain
private-tier evidence only.

## Run Scope

The run used the private inline-OMID-vendor subset:

- Input: `tools/creative-validator/private/normalized/openrtb-parsing-20260601-post-281-omid-inline-cases.jsonl`
- Report: `tools/creative-validator/private/reports/openrtb-parsing-20260603-post-301-omid-inline-limited-report.jsonl`
- Triage: `tools/creative-validator/private/triage/openrtb-parsing-20260603-post-301-omid-inline-limited-summary.json`
- Mode: `--omid-inline-vendor-access-mode limited`
- Runner timing: `--render-timeout-ms 4000 --settle-ms 3000`

All counts below use a denominator of **97 inline-instrumented OMID rows**, not
the full creative corpus.

## Outcome

| Facet | Count |
| --- | ---: |
| Passed | 10 |
| Failed | 86 |
| Skipped | 1 |
| Measurement-OMID bucket | 86 |
| Unsupported input bucket | 1 |

Pass/fail totals stay flat versus the #301 readout; #301 added source
diagnostics and did not change OMID runtime behavior.

## Inline Vendor Signals

| Normalized vendor signal | Rows |
| --- | ---: |
| DoubleVerify | 88 |
| IAS / Integral | 9 |

The classifier signal is "inline vendor instrumentation appears in `adm`." It
is distinct from AdCOM API `7` capability declaration and from SHARC's
validator-owned synthesized sidecar path.

## Runtime Breakdown

| Runtime outcome | Rows |
| --- | ---: |
| `omid3p-no-subscription` | 75 |
| `unattributed-subscription` | 11 |
| `observed-lifecycle` | 10 |
| `not-run` | 1 |

| Diagnostic outcome | Rows |
| --- | ---: |
| `no-subscription` | 75 |
| `unattributed-lifecycle` | 11 |
| `expected-vendor-lifecycle` | 10 |
| `not-run` | 1 |

Re-run drift note: this 2026-06-03 snapshot shifted one row from
`no-subscription` to `unattributed-lifecycle` versus the #301 readout
(`76 -> 75`, `10 -> 11`), reflecting attribution-timing sensitivity in
corpus re-runs. The same row moved in the cap histogram from bucket `0` to
bucket `17`.

Interpretation:

- `expected-vendor-lifecycle` is the positive #244 signal: the expected inline
  vendor found `window.omid3p`, subscribed, and received lifecycle callbacks.
- `no-subscription` means the inline vendor was detected in markup, but no OMID
  subscription was observed from that vendor during the run.
- `unattributed-lifecycle` means OMID lifecycle activity occurred, but source
  attribution did not classify the subscriber as the expected inline vendor.

The private triage summary has source-origin and source-vendor facets for the
remaining unattributed cases. Those details are intentionally not copied here.

## Subscription Cap Measurement

The measured unit matches #252: cumulative `registerSessionObserver` plus
`addEventListener` calls per session.

| Metric | Value |
| --- | ---: |
| Rows measured | 96 |
| Median | 0 |
| p99 | 58 |
| Max | 58 |
| Recommended cap | 73 |

Distribution buckets:

| Calls per session | Rows |
| --- | ---: |
| 0 | 75 |
| 3 | 1 |
| 17 | 5 |
| 37 | 6 |
| 38 | 7 |
| 45 | 1 |
| 58 | 1 |

The recommendation is `ceil(p99 * 1.25)`, so this run continues to support
`MAX_OMID_SUBSCRIPTIONS = 73` as the validator-derived legitimate-traffic
floor. That value is not a security ceiling by itself; bridge-side defaults
still need to account for replay cost, telemetry, and broader corpus coverage.
At `n=96`, nearest-rank p99 equals the single maximum observation, so this
recommendation is effectively max plus 25% headroom; the headroom absorbs tail
uncertainty rather than sitting above a stable percentile. A corpus past roughly
100 measured rows would make p99 distinct from max.

## Session Profile

| Metric | Median | p99 | Max |
| --- | ---: | ---: | ---: |
| Run duration ms | 3062 | 3075 | 3075 |
| `geometryChange` callbacks | 0 | 12 | 12 |

The duration metric is validator row wallclock and includes the configured
settle floor. Treat it as harness timing, not true OMID session lifetime.

## Next Questions

1. Investigate the 75 `no-subscription` rows before changing container
   behavior; these may be vendor precondition, access-mode, script-load, or
   attribution setup issues.
2. Keep the 11 `unattributed-lifecycle` rows separate from no-subscription
   failures. They prove an OMID path ran, but not that the expected inline vendor
   used it.
3. Preserve the denominator wording in #244 status updates: these results cover
   the 97 inline-instrumented OMID rows only.
4. Re-run the snapshot after any bridge or validator change that alters OMID
   subscription timing, lifecycle replay, or stack/source attribution.
