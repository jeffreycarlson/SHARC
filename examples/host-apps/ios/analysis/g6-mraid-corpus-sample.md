# G6 iOS MRAID Corpus Sample

Issue: #436

This sanitized operator-run note records the G6 iOS in-app MRAID corpus sample. The private normalized rows, creative markup, URLs, and full reports remain under `tools/creative-validator/private/` and are intentionally not committed.

## Selection Method

- Input corpus: `tools/creative-validator/private/...`
- Web baseline report: `tools/creative-validator/private/...`
- Requested sample size: 50
- Selected rows: 50
- Filter: executable Creative Markup rows (`creative.mode === "adm-html"`) with MRAID declared, sniffed, or carried in `creativeMeta.apis`.
- Stratification: deterministic round-robin across `bidder | admKind | MRAID signal` buckets, with stable hash ordering inside each bucket.

### Sample Buckets

- By bidder: `{"aarki":3,"aarkieu":3,"appodealdsp":1,"bidease":2,"kayzen":6,"liftoff":3,"linkedin":3,"loopme":6,"loopmeuseasttwo":3,"mobvista":3,"operaeu":1,"rubiconeustaticdirect":1,"rubiconstatic":6,"rubiconweststatic":4,"taurusx":2,"triapodi":2,"youappi":1}`
- By adm kind: `{"html":23,"html-mraid":27}`
- By MRAID signal: `{"declared":50}`

## Verdict Comparison

- Compared rows: 50
- Verdict changes: 0
- Pass -> fail changes: 0
- SHARC-attributed pass -> fail regressions: 0
- Regression clean: yes

No row-level verdict changes were observed.

## Local Artifacts

- Sample JSONL: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/sample.jsonl`
- Web baseline JSONL: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/web-baseline.jsonl`
- iOS report JSONL: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/ios-report.jsonl`
- Comparison JSON: `tools/creative-validator/private/g6-ios-mraid-corpus-sample/compare.json`
