# G5 — Creative URL-Mode Conformance Close

Date: 2026-07-05/06. Contracts converged at the merge of #424 (srcdoc removal),
#425 (validator URL-mode leg, closes #423), and the Claude-lane design branch
(red contracts, F1/F3 spikes, T2 seam, fixture pages). Everything referenced
here is committed and CI-runnable — **zero private-corpus dependency**. This is
the first fully public SHARC gate closure.

## The ratified contract

Tagline: **"Run HTML, or get rich-media features via SHARC."** The Creative URL
path is defined by the **no-injection invariant** — the container never touches
the creative document. Plain HTML is SUPPORTED (first-class floor); SHARC is
always RECOMMENDED. MRAID/SafeFrame are structurally excluded (they require
injection). This carries forward the industry's existing MRAID-or-HTML opt-in
structure with the rich tier modernized: creative-self-loaded instead of
host-injected. OMID reaches URL creatives in three tiers: (T1) bid sidecar →
publisher-page OM SDK service, full authority, zero creative cooperation;
(T2) creative self-includes the shim, nonce delivered over the established
port (`SHARC:Container:omidShimInit`); (T3) self-carried session client —
documented, never built.

## Claims → executable proof (the traceability map)

| # | Ratified clause | Executable proof | Would fail if the clause were false |
|---|---|---|---|
| 1 | A SHARC-only URL creative works end-to-end with zero injection, cross-origin | `test/browser/g5-f1-url-mode-spike.js` (14/14 real Chrome) + `test/g5-contracts/test-g5-f1-conformance-browser.js` (R4 — lifecycle **and** validator verdict production) | R4 red |
| 2 | `ready` is document-load-anchored on the URL tier (E3 carried forward) | gate-U2 (`ready.firstAt >= documentLoadAt`) in `evaluateUrlLifecycleGates` + the F1 fixture's self-reported readyState | gate-U2 fails, R4 red |
| 3 | Plain HTML floor renders to steady state and PASSES; no OMID = PASS | `sharc-url-passing`/floor rows in `tools/creative-validator/fixtures/url-lifecycle-gates/` + `test-url-lifecycle-gates.js` | fixture row fails |
| 4 | No MRAID/SafeFrame on the URL path | R2 F5-NEG → `url-declared-api-unsupported` (`test/g5-contracts/test-g5-url-gates-contract.js`) + Rule 3b constructor pins (`test/node/test-creative-sources.js`, incl. the `bridges: []` edge) | R2 red / unit pins red |
| 5 | No container-side injection into URL creatives, ever | Structural: `useMarkupInjection` + `_fetchAndInjectCreative` + the only `srcdoc` assignment **removed** (#424); removal-contract pins in `test-creative-sdk-injection.js` §10 (incl. prototype tombstones); harness URL mode skips SDK-inline + probe injection (`markup-runner.html`) | tombstone pins red |
| 6 | Declared-but-absent APIs classify cleanly, never hang | R2 F7-NEG → `declared-sharc-no-handshake` (2212-keyed); R2 F8 → `url-load-failed` / `url-load-timeout`; committed synthetic negatives in `test-url-lifecycle-gates.js` | R2 red / fixture rows misclassify |
| 7 | Post-load redirects surface the security backstop as the verdict | R2 F9-NEG → `navigation-policy` (the 2118 backstop IS the verdict) + `g5-f9-redirect.html` fixture page | R2 red |
| 8 | T2: shim nonce-over-port without injection; shim itself unchanged | R3 (3 tests, `test-g5-omid-shim-nonce-over-port-contract.js`) + `test/browser/g5-f3-omid-shim-spike.js` (17/17 real Chrome: wrong-nonce refused, vendor Register rides the port) | R3 red |
| 9 | Cross-origin is the proven topology | All browser proofs serve the creative from a third local origin; the validator runner enforces `creative-port` distinctness | spikes/tests fail |

## Convergence evidence

`npm run test:g5-url-contracts` (the promoted contract suite, wired into
`test:all:built`): **12/12 green** at the post-merge tree — R1 (normalizer,
2) + R2 (gates/buckets, 6) + R3 (T2 seam, 3) + R4 (F1 end-to-end verdict, 1).
R1/R2 were additionally verified green byte-unmodified against the #425 branch
before its merge (cross-lane joint-contract check). The MRAID markup gates and
the fail-closed corpus `compare` machinery are untouched and green.

## Named residuals (accepted)

- **Local HTTP vs production HTTPS CDN** — TLS/redirect/caching behavior
  untested; same posture as the G2 closure.
- **Publisher→shim OMID *event* relay** fails closed against the opaque-origin
  URL iframe (`_relayOmidEvent` posts with a concrete targetOrigin). Gate-U3's
  T2 leg is "shim subscribes," per the ADR; events-over-port is future work
  outside the ratified seam.
- **`creativeSdkUrl`** on URL containers is a stored no-op (shared-config
  ergonomics); the injector feature is never advertised there.

## Pointers

ADR: `~/Obsidian/dev-team/sharc/2026-07-05-g5-url-mode-conformance.md`
(gates U1–U3, bucket table with attribution polarity, lane split — ratified
2026-07-05). Issues: #423 (validator leg contract), #259 (closed — srcdoc
removed). PRs: #424, #425, plus the Claude-lane design-branch PR that carries
this note.
