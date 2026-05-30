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
--renderer-url http://localhost:18866/examples/renderer/
--repo-root .
--verbose
```

The v0 runner executes only HTML-ish cases where `expectations.execute` is
`true`. VAST, native JSON, unknown payloads, and Creative URL mode are reported
as skipped `unsupported-input` cases. Expected MRAID and SafeFrame cases use the
local `dist/sharc-creative.js` SDK inline so bridge probes can exercise the
SHARC-backed compatibility surface without fetching a production SDK.

Each report row contains the case identifiers and diagnostic signals, but does
not duplicate raw `creative.html`.

For MRAID and SafeFrame cases, the runner injects a small validator probe into
the creative document and records `diagnostics.bridgeProbes[].bridges`. These
probes check bridge presence plus a few read-only/basic methods, then classify
expected bridge absence as `bridge-missing` and method-call failures as
`bridge-api-error`. They are compatibility smoke tests for corpus triage, not a
complete MRAID or SafeFrame compliance suite. Probe results are accepted only
from the current renderer iframe, the expected renderer origin, and the current
per-case nonce. The runner records a small number of early/late samples and
classifies against the latest sample so MRAID auto-install timing does not turn
an eventually installed bridge into a false `bridge-missing` failure. If no probe
runs, the case falls through to the existing rendered/inconclusive buckets
instead of being treated as a bridge absence.

The runner caches the fetched local SDK and bridge-probe source for the lifetime
of one harness page. This keeps batch runs consistent; a failed local SDK fetch
causes subsequent bridge cases in the same run to fail the same way.

When an executable case declares OMID capability via AdCOM API `7`, the runner
records that capability signal separately from actual OMID measurement payloads.
If the case also carries a sanitized
`creativeMeta.measurement.omid.verificationScripts` sidecar, the runner enables
the container's `omidAutoInstall` path with validator-owned HTTPS placeholder SDK
URLs and an in-page mock OM SDK Session Client. Report rows include
`diagnostics.measurement.omid` so private corpus triage can distinguish
"container can support OMID but the bid supplied no sidecar" from "OMID sidecar
installed and the container-owned session started." This validates SHARC's
measurement wiring; it does not contact real verification vendors or certify OM
SDK vendor behavior.

Report rows also include `diagnostics.network`, a compact summary of
transport-level failed requests, HTTP error responses, and CORS/CSP-like console
messages grouped by origin, status, and resource type. These facets are
diagnostic by default: a creative that renders successfully can still pass while
showing broken pixels or third-party resource failures for later triage.

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

Script-load corpus facets split error rows into diagnostic classes:
`legacy-mraid-loader`, `external-script-aborted`, `external-script-dns`,
`external-script-transport`, `external-script-http`, `script-csp-blocked`, and
`script-load-event`. This keeps the MRAID compatibility alias separate from real
external dependency failures and makes repeated CDN/DNS/CSP patterns visible
without exposing raw creative URLs.

Document-source facets attribute nested document activity observed inside the
renderer document. The runner passively records frame discovery, frame `src`
assignments via attributes and direct property setters when the assigned URL
resolves to an origin, form discovery, and form submissions; triage aggregates
them by source kind, protocol, origin, tag name, and bidder. These diagnostics
are meant to explain failed-document/CSP clusters without changing validator
pass/fail classification. They are private-tier for the same reason as the
other corpus diagnostics: they key by real bidder names and ad-server origins,
so summaries must not be shared with bidders.

OMID facets under `corpusDiagnostics.omid` aggregate the per-row OMID outcomes
the runner records at `diagnostics.measurement.omid`. They separate OMID
capability signals from actual measurement sidecars: AdCOM API `7` increments
`rowsCapabilityDeclared`, while sanitized verification scripts increment
`rowsWithSidecar` and drive the extension/session progress counters.
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

`001-normalizer-cleaned-corpus` pins the cleaned export shape and normalizer
classification/extraction behavior. `002-navigation-policy-post-render`
captures the current Creative Markup behavior for a creative that renders and
then navigates its own iframe: the validator buckets it as `navigation-policy`.

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
