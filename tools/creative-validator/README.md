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
per-case nonce; forged or duplicate probe messages are ignored. If the probe
does not run, the case falls through to the existing rendered/inconclusive
buckets instead of being treated as a bridge absence.

The runner caches the fetched local SDK and bridge-probe source for the lifetime
of one harness page. This keeps batch runs consistent; a failed local SDK fetch
causes subsequent bridge cases in the same run to fail the same way.

When an executable case declares OMID via AdCOM API `7` and carries a sanitized
`creativeMeta.measurement.omid.verificationScripts` sidecar, the runner enables
the container's `omidAutoInstall` path with validator-owned HTTPS placeholder
SDK URLs and an in-page mock OM SDK Session Client. Report rows include
`diagnostics.measurement.omid` so private corpus triage can distinguish "OMID
declared but no sidecar" from "OMID sidecar installed and the container-owned
session started." This validates SHARC's measurement wiring; it does not contact
real verification vendors or certify OM SDK vendor behavior.

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
origin. It does not store raw written markup or full private URLs.

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
count/method/protocol so navigation-policy clusters can be split by likely
trigger mechanism.

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
