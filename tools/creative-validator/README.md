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
as skipped `unsupported-input` cases.

Each report row contains the case identifiers and diagnostic signals, but does
not duplicate raw `creative.html`.

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
```
