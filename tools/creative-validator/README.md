# SHARC Creative Validator

> **DO NOT COMMIT REAL CORPUS DATA.** Keep real bid responses, raw `adm`,
> reports, traces, screenshots, and normalized output under
> `tools/creative-validator/private/`.

Private-first hardening harness for real bid-derived creative compatibility
testing. The current tool normalizes cleaned OpenRTB export rows into stable
test-case records and can run executable HTML-ish cases through the local SHARC
Creative Markup renderer.

## Private Corpus

Keep real corpus files and generated output under:

```text
tools/creative-validator/private/
```

That path is ignored by git. Do not commit real bid responses, raw `adm`,
tracking URLs, advertiser domains, device/user identifiers, reports, traces, or
screenshots.

Never pass `--out` outside `tools/creative-validator/private/` when running
against private data. The CLI enforces that boundary by default.

Sanitized aggregate analysis notes can live under
`tools/creative-validator/analysis/` when they omit raw creative IDs, raw markup,
bidder names, full URLs, and private source-origin keys. See
[`analysis/omid-inline-vendor-post-301.md`](analysis/omid-inline-vendor-post-301.md)
for the post-#301 OMID inline-vendor snapshot.

## Normalize

```bash
node tools/creative-validator/src/cli.js normalize \
  "tools/creative-validator/private/*.cleaned.json" \
  --out tools/creative-validator/private/normalized/cases.jsonl
```

Input shape:

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

The CLI expects the cleaned export shape used by the private corpus workflow,
not raw OpenRTB bid-request or bid-response documents.

Output is JSONL, one normalized test case per bid.

## Run

Build first so the local renderer and container artifacts are current:

```bash
npm run build
node tools/creative-validator/src/cli.js run \
  tools/creative-validator/private/normalized/cases.jsonl \
  --out tools/creative-validator/private/reports/report.jsonl
```

Useful run options:

```text
--render-timeout-ms 10000
--settle-ms 2000
--port 18865
--renderer-port 18866
--creative-port 18867
--renderer-url http://localhost:18866/examples/renderer/
--repo-root .
--omid-sdk-mode <mock|service>
--omid-sdk-load-failure
--verbose
```

The runner executes HTML-ish and Creative URL cases where
`expectations.execute` is `true`. VAST, native JSON, and unknown payloads are
reported as skipped `unsupported-input` cases. Expected MRAID and SafeFrame
markup cases use the local `dist/sharc-creative.js` SDK inline so bridge probes
can exercise the SHARC-backed compatibility surface without fetching a
production SDK. Creative URL cases load from a third local origin via
`--creative-port`; the validator does not inject into URL creative documents.

Each report row contains the case identifiers and diagnostic signals, but does
not duplicate raw `creative.html`.

## MRAID Conformance Gates

The validator has a committed, CI-runnable MRAID conformance fixture at
`tools/creative-validator/fixtures/mraid-lifecycle-gates/`. It wires the three
in-repo IAB MRAID 3.0 compliance ads from
`examples/compliance-ads/{loadandevents,resize-negative,viewability}` plus a
synthetic never-fires-ready negative into the staged MRAID delivery gates. The
test entry is:

```bash
npm run test:creative-validator-mraid-lifecycle-gates
```

That test is part of `npm run test:all:built`, uses only committed files, and
must stay runnable without `tools/creative-validator/private/` corpus data. The
positive ads prove delivery, not sampled state alone: parse-time `loading`, no
early `ready`/`stateChange("default")`, `ready` at or after document load,
late-listener replay for `ready`, visible-state callbacks, and the
resize-negative replayable `error`. The synthetic negative intentionally fails
gate 2; if it passes, the delivery-proof gate is no longer live.

## Creative URL Conformance Gates

The validator has a committed, CI-runnable Creative URL fixture at
`tools/creative-validator/fixtures/url-lifecycle-gates/`. It runs one
SHARC-native URL creative from a third local origin, one declared-SHARC
no-handshake negative, and one URL-load-failed negative. The test entry is:

```bash
npm run test:creative-validator-url-lifecycle-gates
```

That test is part of `npm run test:all:built`, uses only committed files, and
requires no private corpus data. Private-corpus URL regression runs stay local
under `tools/creative-validator/private/`, just like the MRAID corpus closeout.

Full private-corpus regression is a separate local/operator step. It requires
gitignored normalized inputs and reports under `tools/creative-validator/private/`
and is not expected to run in CI. To close a conformance pass, run the current
corpus, triage it, and compare it with the Slice-D baseline report:

```bash
npm run build
node tools/creative-validator/src/cli.js run \
  tools/creative-validator/private/normalized/cases.jsonl \
  --out tools/creative-validator/private/reports/current-report.jsonl
node tools/creative-validator/src/cli.js triage \
  tools/creative-validator/private/reports/current-report.jsonl \
  --out tools/creative-validator/private/triage/current-summary.json
node tools/creative-validator/src/cli.js compare \
  tools/creative-validator/private/reports/slice-d-baseline-report.jsonl \
  --current tools/creative-validator/private/reports/current-report.jsonl \
  --notes tools/creative-validator/private/regression/notes.json \
  --out tools/creative-validator/private/regression/current-vs-slice-d.json
```

The optional notes file is how local triage records causes for verdict changes.
Keys may be `bidId`, `crid`, `sourceFile:rowIndex`, or the stable row key
emitted in the comparison report. Each note should include `attribution`
(`creative-flake`, `creative-expired`, `sharc-fix`, `sharc`, or another local
label) and a short `cause`. The compare command exits non-zero for any
pass-to-fail change attributed to `sharc` or left as `needs-triage`, which is
the local regression-clean gate.

For MRAID and SafeFrame cases, the runner injects a small validator probe into
the creative document and records `diagnostics.bridgeProbes[].bridges`. These
probes check bridge presence, read-only/basic methods, and, for SHARC-installed
bridges, a small set of active navigation/placement methods (`mraid.open`,
`mraid.expand`, `$sf.ext.register`, and `$sf.ext.redirect` when present).
Expected bridge absence classifies as `bridge-missing`; method-call failures
classify as `bridge-api-error`. They are compatibility smoke tests for corpus
triage, not a complete MRAID or SafeFrame compliance suite. Probe-originated
bridge calls are reported under `navigationDiagnostics.probeBridgeCalls`;
`navigationDiagnostics.bridgeCalls` remains reserved for creative-initiated
bridge calls. Probe results are accepted only from the current renderer iframe,
the expected renderer origin, and the current per-case nonce. The runner records
a small number of early/late samples and classifies against the latest sample so
MRAID auto-install timing does not turn an eventually installed bridge into a
false `bridge-missing` failure. If no probe runs, the case falls through to the
existing rendered/inconclusive buckets instead of being treated as a bridge
absence.

The runner caches the fetched local SDK and bridge-probe source for the lifetime
of one harness page. This keeps batch runs consistent; a failed local SDK fetch
causes subsequent bridge cases in the same run to fail the same way.

When an executable case declares OMID capability via AdCOM API `7`, the runner
records that capability signal separately from actual OMID measurement payloads.
The normalizer also records inline OMID-aware vendor scripts in `adm` as a
separate instrumentation signal. Known real-world script signals include
DoubleVerify `dvtp_src.js`, IAS/Integral `adsafeprotected` or `integralads`
scripts, Moat/Oracle `moatads` scripts, and direct `omid3p` observer probes.
If the case also carries a sanitized
`creativeMeta.measurement.omid.verificationScripts` sidecar, the runner enables
the container's `omidAutoInstall` path with validator-owned HTTPS placeholder
SDK URLs. When the pinned REAL OM SDK binaries are present under
`tools/creative-validator/private/vendor/` (see [`VENDORED.md`](VENDORED.md)),
request interception serves them for those URLs and the harness top window
runs the real `omweb-v1.js` service + session client
(`diagnostics.measurement.omid.sdkMode: "service"`); without them the harness
falls back to the legacy in-page mock OM SDK Session Client
(`sdkMode: "mock"`). Corpus conformance runs require service mode. Pass
`--omid-sdk-mode <mock|service>` to pin the mode explicitly (the committed
tests pin `mock` for hermeticity), and `--omid-sdk-load-failure` to abort the
SDK script requests so the real `feature_load_failed → measurement-omid` path
is exercised (#211A).

In service mode the harness registers a validator-owned **canary verification
client** (`harness/omid-canary-verification-client.js`) as one extra
`VerificationScriptResource`, so the real service injects it next to the
vendor copies. The canary subscribes through the OM SDK verification-service
postMessage protocol and reports what the service actually delivers
(`diagnostics.measurement.omid.service.canary`). The harness also observes —
beside, never through — the omid_v1 protocol traffic on the harness top
window, attributing client→service subscription messages to vendors via the
service's own injected-iframe registry
(`diagnostics.measurement.omid.service.subscriptionsByVendor`). A vendor row
passes on the **service channel** (`inlineVendor.servicePassed`,
`deliveryChannel: "service"`) when the expected vendor's service-injected copy
subscribed via the verification-service protocol AND the canary observed
sessionStart + impression delivered on that path. The omid3p (0.7.8 shim)
channel is unchanged and still passes creative-window subscribers; the canary
is excluded from `verificationScriptCount` and all vendor facets. Inline-vendor rows without a
sidecar are also run through a validator-owned temporary sidecar synthesized
from the normalized inline HTTPS vendor script URLs; this changes only the
private run input, not the committed normalized corpus row. The synthesized
sidecar defaults to `accessMode: "limited"`; private sweeps can run with
`--omid-inline-vendor-access-mode full` to compare vendor activation behavior
without changing the normalized corpus. The validator shim does not enforce
different JS capabilities for `limited` versus `full`; the flag changes the
declared `VerificationScriptResource.accessMode` label so real vendor scripts
can self-route on the mode they observe. The real browser harness wraps
`window.omid3p` inside the renderer frame before the creative runs and records
whether inline vendor code found OMID, subscribed through
`registerSessionObserver` or `addEventListener`, and received lifecycle
callbacks under `diagnostics.measurement.omid.inlineVendor`. The broad
`subscriptionObserved` flag means some OMID subscriber was seen while an inline
vendor script was present; `expectedVendorSubscriptionObserved` is the stricter
pass/fail signal that requires the subscription call's script source URL to
classify to one of the normalized inline vendors. Caller-supplied OMID
`vendorKey` and `injectionId` strings are recorded for debugging, but they are
not trusted for attribution.

For inline-vendor diagnostics, `passed` is the attributed runtime observation
flag: the expected vendor found OMID, produced an attributed subscription, and
received at least one callback. The strict sessionStart/loaded/impression
observation is exposed separately as `lifecycleComplete`, while
`lifecycleNotObserved` separates subscribed-but-not-callbacked rows from true
no-subscription failures. Unrelated OMID subscribers remain visible through
`unattributedSubscriptionObserved`, `unattributedSubscriptionCalls`, and
`callsByVendorKey` but do not satisfy the inline vendor gate. Inline vendor
expectations are still derived from vendor URLs found in the creative markup;
they are not proof that a publisher, SSP, or DSP authorized that vendor for the
impression. Stack-derived attribution can also be spoofed by a deliberately
crafted inline script using `//# sourceURL=...`; treat these diagnostics as
private harness evidence, not vendor-conformance or trust claims. Report rows include
`diagnostics.measurement.omid` so private corpus triage can distinguish
"container can support OMID but the bid supplied no sidecar" from "OMID sidecar
installed and the container-owned session started." Cap-value measurement uses
#252's enforced unit: cumulative register-calls per session.

Report rows also include `diagnostics.network`, a compact summary of
transport-level failed requests, HTTP error responses, and CORS/CSP-like console
messages grouped by origin, status, and resource type. These facets are
diagnostic by default: a creative that renders successfully can still pass while
showing broken pixels or third-party resource failures for later triage.
During one `run` invocation, the runner also keeps an in-process LRU cache for
successful `http:`/`https:` script responses and serves later matching script
URLs from that cache across fresh browser contexts. This reduces repeated vendor
CDN fetches without persisting private creative traffic to disk. `no-store`
responses, failed responses, non-GET requests, and the special MRAID `mraid.js`
alias are not cached. Cache counters and approximate decoded body bytes appear
under `diagnostics.network.scriptCache` and aggregate under
`corpusDiagnostics.network.scriptCache`.

Report rows include `diagnostics.navigationDiagnostics` for bounded navigation
source signals captured before creative markup runs. The harness records
`document.write`/`document.writeln` counts, lifecycle state, written character
counts, and pattern flags such as `iframe`, `location`, `metaRefresh`, and
`scriptSrc`; it also records `window.open` counts and bridge/API calls such as
`mraid.open` or `SHARC.requestNavigation` with sanitized URL protocol and
origin. Script loads are recorded as sanitized discovery/load/error events with
URL protocol/origin and lifecycle timing so repeated post-render navigation
failures can be correlated with third-party script execution. It does not store
raw written markup or full private URLs.

## Triage

After a corpus run, aggregate one or more private report JSONL files:

```bash
node tools/creative-validator/src/cli.js triage \
  "tools/creative-validator/private/reports/*.jsonl" \
  --out tools/creative-validator/private/triage/summary.json
```

The summary groups rows by outcome status, diagnosis bucket, bidder, media type,
`admKind`, sanitized API declaration, and expected bridge. Failed rows are also
grouped by bucket + bidder + mtype + adm kind + API declaration, with bounded
sample IDs and a `reductionCandidates` list to guide manual issue filing and
synthetic fixture promotion. Like normalize/run output, triage summaries stay
under `tools/creative-validator/private/` by default.

The `diagnostics` section adds aggregate-only facets for repeated failure
patterns: security-event counts, security-event sets, unauthorized-navigation
variant/timing bins, and network shapes based on failed request/response and
CORS/CSP console counts. These are intended to replace ad hoc private scripts
when deciding which repeated failures deserve synthetic reductions.
Navigation source facets summarize failed rows by `document.write` count,
document-write pattern flags, `window.open` count/protocol, and bridge call
count/method/protocol. Script-load facets summarize failed rows by script count,
load/error count, protocol, origin, and load status so navigation-policy
clusters can be split by likely trigger mechanism.

The `corpusDiagnostics` section covers the full report set, including passed
rows. Use it for non-fatal runtime signals such as external script-load errors,
CORS/CSP-like console output, failed document probes, and bidder-specific
clusters after the fatal failure count is already zero. These facets are
aggregate-only and still avoid raw creative markup. They are still private-tier:
the facets key by real bidder names and script origins, so summaries must not
be shared with bidders.
`corpusDiagnostics.network.scriptCache` aggregates the per-row script cache
counters so corpus runs can report approximate decoded external script bytes
fetched from network versus replayed from the in-process cache.

Script-load corpus facets split error rows into diagnostic classes:
`legacy-mraid-loader`, `external-script-aborted`, `external-script-dns`,
`external-script-transport`, `external-script-http`, `script-csp-blocked`, and
`script-load-event`. This keeps the MRAID compatibility alias separate from real
external dependency failures and makes repeated CDN/DNS/CSP patterns visible
without exposing raw creative URLs. Rows can belong to more than one class, so
`errorEventsByClass` is not expected to sum to `byErrorCount`. The
`script-csp-blocked` class is an approximation: current runner reports CSP-like
console messages without resource typing, so this class means the row had both
script errors and CSP-like console output.

Document-source facets attribute nested document activity observed inside the
renderer document. The runner passively records frame discovery, frame `src`
assignments via attributes and direct property setters when the assigned URL
resolves to an origin, form discovery, and form submissions; triage aggregates
them by source kind, protocol, origin, tag name, and bidder. These diagnostics
are meant to explain failed-document/CSP clusters without changing validator
pass/fail classification. They are private-tier for the same reason as the
other corpus diagnostics: they key by real bidder names and ad-server origins,
so summaries must not be shared with bidders.
Triage also assigns document-source classes (`external-frame`,
`secure-frame`, `insecure-frame`, `blank-or-opaque-document`,
`frame-src-assignment`, `observed-frame`, `form-source`, `srcdoc-frame`) to
separate normal nested iframe activity from same-frame renderer navigation.
`blank-or-opaque-document` is limited to frame-like sources whose target is
`about:` or otherwise opaque, so URL-less form submissions stay in
`form-source` only.
Rows can belong to multiple classes, so event-class totals are diagnostic
facets and are not expected to sum to `rowsWithDocumentSources`.

OMID facets under `corpusDiagnostics.omid` aggregate the per-row OMID outcomes
the runner records at `diagnostics.measurement.omid`. They separate OMID
capability signals from actual instrumentation and measurement sidecars: AdCOM
API `7` increments `rowsCapabilityDeclared`, inline OMID-aware vendor scripts in
`adm` increment `rowsInlineInstrumented`, and sanitized verification scripts
increment `rowsWithSidecar` and drive the extension/session progress counters.
`byInstrumentationSignal` buckets each row as `declared-api7+inline-vendor`,
`declared-api7-only`, `inline-vendor-only`, or `absent`; this is the primary
declared-vs-instrumented-vs-absent corpus readout for the 0.7.8 OMID verifier.
Inline-vendor runtime facets additionally bucket synthesized access mode,
subscription/runtime outcome, and lifecycle observation completeness. Lifecycle
observation uses `complete`, `partial`, `subscribed-none`, or `not-applicable`;
`not-applicable` means the vendor did not subscribe, so lifecycle callbacks
could not be expected. Expected-vendor attribution is summarized separately in
`inlineVendorRowsByExpectedAttribution`; `unattributed-subscription` runtime
rows mean OMID was used by some script but not by the expected inline vendor.
Those rows are deliberate hard failures for inline-vendor validation; inspect
the runtime-outcome facet before interpreting them as ordinary no-subscription
failures.
`inlineVendorRowsByDiagnosticOutcome` gives the runner's more specific per-row
explanation:

| Outcome | Meaning |
| --- | --- |
| `not-run` | The row did not run inline-vendor measurement. |
| `omid3p-missing` | The expected inline vendor could not find `window.omid3p`. |
| `no-subscription` | `window.omid3p` existed, but no subscription call was observed. |
| `expected-vendor-lifecycle` | A subscription from an expected vendor source was observed and lifecycle callbacks fired. |
| `expected-vendor-service-delivery` | The expected vendor measured via the REAL service path (#244): its service-injected copy subscribed through the verification-service protocol and the canary observed delivery. |
| `expected-vendor-no-lifecycle` | A subscription from an expected vendor source was observed, but no lifecycle callback fired. |
| `unattributed-lifecycle` | Subscription and callbacks were observed, but the subscription source did not match the expected vendor allowlist. |
| `unattributed-no-lifecycle` | A subscription from a non-allowlisted or unknown source was observed, but no lifecycle callback fired. |

Source facets such as
`inlineVendorSubscriptionCallsBySourceOrigin` and
`inlineVendorUnattributedCallsBySourceOrigin` aggregate the captured stack/script
origins for subscription calls, so proxy-hosted vendor traffic can be separated
from true no-subscription rows. These origin-keyed facets are private-tier.
This is measurement, not policy: the validator's
`expectedVendorSubscriptionObserved` gate is unchanged by these facets. Source
attribution uses `document.currentScript` and Chrome/V8 stack frames where
available; `unknown` can mean either no parseable source frame or an async
subscription whose useful caller frame was unavailable. If a call exposes
multiple source URLs, the first expected-vendor match is treated as attributed,
so this source mapping is a diagnostic signal rather than attestation. The
runner and normalizer OMID vendor-host allowlists are pinned together by
`tools/creative-validator/test/test-normalizer.js` so classifier drift does not
silently inflate unattributed-subscription counts.
`inlineVendorSubscriptionCap` measures the unit enforced by the 0.7.8 shim cap:
cumulative `registerSessionObserver` plus `addEventListener` calls per session.
It reports `rowsMeasured`, nearest-rank `median`/`p99`/`max`, and count buckets
over all measured inline-vendor rows, including rows with zero subscription
calls; p99 therefore reflects the upper tail of vendors that did subscribe.
Triage emits the distribution only; the cap recommendation is a release decision
derived from `ceil(p99 * 1.25)` and reviewed against the current shim default
(`64`). In the initial 96-row inline-vendor corpus, nearest-rank p99 equals max,
so a recommendation of `73` is effectively max plus 25% tail-uncertainty
headroom. This sizes the legitimate-traffic false-positive floor, not the
security/DoS ceiling; before copying a value into the shim, review replay-cost
bounds, cap-hit telemetry, and corpus coverage because the initial sample is
IAS/DV-dominant. `rowsBySdkMode` splits OMID-relevant rows by real-service vs mock runs;
`inlineVendorRowsByDeliveryChannel` attributes each measured inline-vendor row
to `omid3p`, `service`, `both`, or `none`; `serviceSubscriptionRowsByVendor`,
`serviceCanaryRows`, and the `serviceInjectedResourceCount` distribution
(distinct service-injected vendor resources per session, canary excluded)
supply the #244 D7 `MAX_OMID_VERIFICATION_RESOURCES` evidence.
`inlineVendorSessionProfile` reports row-run wallclock duration
(`outcome.durationMs`, including the validator settle floor) and
`geometryChange` callback volume, so corpus runs can inform emission-side cache
and event-rate bounds without claiming true OMID session lifetime.
`byOutcome` assigns each capability-declared row a single mutually-exclusive
progress label (`capability-no-sidecar`, `sidecar-no-extension`,
`extension-no-feature`, `feature-no-session`, `session-started`,
`session-finished`). `capabilityNoSidecarRowsByBidder` is a provenance signal,
not a failure; `sessionNotStartedRowsByBidder` only counts rows that supplied an
OMID sidecar but did not reach a started session. The top-level `rows*` counters
count whatever the row's booleans report, while `byOutcome`,
`byVerificationScriptCount`, and the `*ByBidder` maps only count rows where OMID
capability was declared. These facets are diagnostics-only and do not affect
validator pass/fail classification. They are private-tier for the same reason as
the other corpus diagnostics: they are keyed by real bidder names, so the summary
is private-tier and must not be shared with bidders. Aggregate-only, no raw
markup.

The runner tests also document the current navigation-policy boundary for
external scripts: a script that loads and does nothing passes; a script that
creates a nested iframe passes; a script that navigates the renderer document
with `window.location`, meta refresh, or same-frame form submit is classified
as `navigation-policy`.

For MRAID-active cases, the runner treats relative `mraid.js` script requests as
the legacy SDK loader required by MRAID environments. Those requests receive an
empty successful JavaScript response because SHARC already installs
`window.mraid` through the injected bridge. If a creative requests `mraid.js`
without declared or sniffed MRAID evidence, the request is not aliased and still
surfaces as a runtime-only diagnostic. This is validator-harness fidelity, not
SHARC product guidance; whether production deployments should serve a no-op
`mraid.js` endpoint or document the request as benign remains a separate
operator/spec question.

Committed reductions live under `tools/creative-validator/fixtures/reductions/`
and must be synthetic. Each reduction directory should include a short README
describing the private failure pattern it represents and the behavior it pins.
The checked-in cleaned-corpus JSON is the canonical fixture input. Avoid keeping
duplicate creative markup in companion files unless tooling derives one copy
from the other or the companion is explicitly marked non-canonical.

Promotion workflow:

1. Identify a repeated private-corpus pattern from report/triage output.
2. Reduce it to the smallest synthetic cleaned-corpus fixture that preserves the
   mechanism and removes bidder domains, tracking URLs, private IDs, creative
   artwork, and raw vendor markup.
3. Add a README that names the public mechanism being pinned and explicitly says
   what the reduction does not decide when the product/spec question is still
   open.
4. Add or reuse validator tests that exercise the reduction's behavior. Keep the
   private corpus report path out of committed files and PR text.

`001-normalizer-cleaned-corpus` pins the cleaned export shape and normalizer
classification/extraction behavior. `002-navigation-policy-post-render`
captures the current Creative Markup behavior for a creative that renders and
then navigates its own iframe: the validator buckets it as `navigation-policy`.
`003-legacy-mraid-loader-alias` captures relative `mraid.js` loader aliasing for
MRAID-active cases and the runtime-only diagnostic boundary when no MRAID signal
exists. `004-external-script-navigation-boundary` captures the boundary between
allowed external script/document activity and same-frame renderer navigation
attempts that remain `navigation-policy` failures.
`005-document-source-classification` captures normal nested document activity:
static `srcdoc`/`about:blank` frames and external frame `src` assignments should
pass while emitting document-source classes for private corpus triage.
`006-blank-opaque-document-sources` captures delayed opaque child documents:
post-load `about:blank`, URL-less, and `srcdoc` iframe creation should pass
while separating row-level blank/opaque prevalence from repeated event counts.
`007-csp-embedded-frame-diagnostics` captures Chromium CSP Embedded
Enforcement diagnostics from child iframes that do not opt into the renderer
iframe's CSP. These rows should pass while reporting CSP console and
document-source diagnostics, without being conflated with script CSP failures.

### Security

The runner executes real creative JavaScript. Run private corpus passes from a
VM, container, or dedicated low-privilege user, not from a host/session with
deploy keys, production credentials, or private notes mounted. Chrome launches
with its OS sandbox enabled by default. If a disposable environment requires
disabling it, set `SHARC_VALIDATOR_CHROME_NO_SANDBOX=1`; do not use that mode
on a normal developer laptop.

## Test

```bash
npm run test:creative-validator-normalizer
npm run test:creative-validator-diagnose
npm run test:creative-validator-runner
npm run test:creative-validator-triage
```
