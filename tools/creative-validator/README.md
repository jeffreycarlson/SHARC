# SHARC Creative Validator

> **DO NOT COMMIT REAL CORPUS DATA.** Keep real bid responses, raw `adm`,
> reports, traces, screenshots, and normalized output under
> `tools/creative-validator/private/`.

Private-first hardening harness for real bid-derived creative compatibility
testing. Phase 1 normalizes cleaned OpenRTB export rows into stable test-case
records. It does not run a browser yet.

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

## Test

```bash
npm run test:creative-validator-normalizer
```
