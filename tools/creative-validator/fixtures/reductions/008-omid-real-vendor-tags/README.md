# 008 OMID Real Vendor Tags

G3 evidence corpus: controlled creatives embedding REAL verification vendor
tags (IAS, Pixalate, DoubleVerify) so the validator's service-mode OMID path
can be proven against live vendor code instead of synthetic probes.

All placement/client identifiers are synthetic. Both vendor CDNs were verified
live (2026-06-12) to serve their real scripts for synthetic identifiers:

- **IAS** — `https://pixel.adsafeprotected.com/rjss/st/<entityId>/<placementId>/skeleton.js`.
  The rjss skeleton endpoint serves the identical ~330 KB OMID-aware loader
  regardless of the ID path segments. This is the exact tag shape observed on
  all 8 IAS-inline cases in the private corpus.
- **Pixalate** — `https://q.adrta.com/s/<clientId>/aa.js?cb=<cb>#<clientId>;paid=...`
  (documented analytics tag, pixalate.com knowledge base). The aa.js bootstrap
  loads `q.adrta.com/r.js`, then `pix.adrta.com/cdnf.js`, which bundles the
  official IAB `OmidVerificationClient` (`1.6.1-iab283`, lazily fetched from
  `pix.adrta.com/1.6.1-iab283/omid.js`). Real tag shape — not approximated.
- **DoubleVerify** — `https://cdn.doubleverify.com/dvtp_src.js?ctx=...` with
  synthetic campaign parameters (multi-vendor case only; DV is already proven
  at corpus scale).

Cases:

| id | proves |
|----|--------|
| `g3-ias-banner-early` | IAS tag in head of a simple banner |
| `g3-ias-late-tag` | IAS tag as the last element of the body |
| `g3-ias-plus-dv-multivendor` | IAS + DV side by side in one creative |
| `g3-pixalate-inline` | Pixalate analytics tag inline in the adm (organic shape) |
| `g3-pixalate-sidecar` | Pixalate tag delivered as a bid-ext `VerificationScriptResource` |

Run (service mode, requires the pinned vendored OM SDK binaries and live
network access to the vendor CDNs):

```
node tools/creative-validator/src/cli.js normalize \
  tools/creative-validator/fixtures/reductions/008-omid-real-vendor-tags/cleaned-corpus.fixture.json \
  --out tools/creative-validator/private/normalized/omid-real-vendor-tags.jsonl
node tools/creative-validator/src/cli.js run \
  tools/creative-validator/private/normalized/omid-real-vendor-tags.jsonl \
  --out tools/creative-validator/private/reports/omid-real-vendor-tags-report.jsonl
```

A run without network access to the vendor CDNs fails with the
`vendor-fetch-failed` bucket — that is a finding, not a skip.
