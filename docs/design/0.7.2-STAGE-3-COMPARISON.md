# SHARC 0.7.2 — Stage 3 Spike Comparison

**Date:** 2026-05-15
**Stage:** Plan C Stage 3 — locked design vs. parallel spike implementation
**Locked design:** `docs/design/0.7.2-non-sharc-loading.md` (16 sections, ~12k words, refined 2026-05-15)
**Spike branch:** `spike/sharc-creative-validator` (commits `06f0c1f`, `684a045`, `102e894` + uncommitted WIP)

---

## TL;DR

The spike and the locked design operate at **different architectural layers**. They share a small behavioral surface (the `requireSharcInit` boolean in the container constructor) where convergence is high. Outside that surface they barely overlap:

- **Design** lives at the **container layer** — new accessors, framework detection in `_resolveApiFramework`, HTML lifecycle adapter, G1–G12 security guardrails, state-machine edge addition.
- **Spike** lives at the **validator/harness layer** — bid-validator framework detection, orchestrator container-routing, harness bypass when no SHARC declaration. The container-side change is one ~45-line constructor option + extension auto-call.

**Stage 4 decision (Jeffrey, 2026-05-15): implement #89 fresh per the locked design; park the spike branch until #89 merges; then update the validator to use the shipped 0.7.2 architecture.** Reverse-signal pass on the spike's container-side work yielded two small items (extension error-resilience pattern → noted for 0.7.2 second-half; renderer backstop skip-first → separate PR), neither of which changes the locked #89 design. See § 5 for the full disposition.

---

## 1. Convergence table

| Axis | Locked design | Spike | Verdict |
|---|---|---|---|
| Constructor option name | `requireSharcInit` | `requireSharcInit` | ✅ Identical |
| Default value | `true` (strict) | `true` (strict) | ✅ Identical |
| Location of guard in `load()` | wrap `_startSessionTimeout()` | wrap `_startSessionTimeout()` | ✅ Identical (commit `06f0c1f` line ~1135) |
| Variant interaction | identical for URL + Markup | identical (no variant branching) | ✅ Identical |
| Which timeouts skip | only `createSession` | only `createSession` | ✅ Identical |
| Wire-format impact | none | none ("container-local flag") | ✅ Identical |
| Test infrastructure | jsdom-primary, deferred Puppeteer/browser harness | jsdom (`test-require-sharc-init.js`, 158 lines) | ✅ Same approach |
| Renderer backstop scope | G2 stays armed regardless | uncommitted WIP refines backstop with skip-first for Markup `document.write` | ✅ Compatible — spike WIP enhances G2 without weakening it |
| Version 0.7.2 framing | "first half" (non-SHARC loading); OMID is second half | `package.json` set to 0.7.2 unilaterally with OMID baked in | ⚠️ Same target version, different scope split |

The behavioral surface where the actual `requireSharcInit` option exists is **highly convergent**. Both implementations gate `_startSessionTimeout()` on a boolean, both default `true`, both leave wire format untouched. The spike got the small piece right.

---

## 2. Divergence table

| Axis | Locked design | Spike | Why each is justified | Stage 4 disposition |
|---|---|---|---|---|
| Type validation on the option | Throw `TypeError` if value is not `undefined \| boolean` (Q4) | `this._requireSharcInit = requireSharcInit !== false` — coerces all non-`false` values to `true` (including `null`, `0`, `''`, strings, etc.) | Design favors loud failure on operator mistakes; spike favors defensive normalization (its own test #4 asserts `[undefined, null, 0, '']` all → `true`) | **Adopt design.** Operator-input strict validation is the SHARC convention (`allowPopups` family). Spike's silent coercion masks bugs. |
| Framework detection location | Inside the container — `_resolveApiFramework(creativeMeta)` returns the AdCOM code; exposed via `container.apiFramework` getter | Inside the bid-validator tooling — `sanitizeApiDeclarations()` + `isSharcRuntime()` exported from `tools/creative-validator/src/bid-validator.js`; container has no equivalent | Different consumers: design serves operators who construct `SHARCContainer` directly; spike serves the validator tooling | **Both stay.** Container-side is the canonical SHARC capability (operator-facing). Tooling-side stays as harness-internal optimization. They are not competitors. |
| SHARC API code values | Placeholder constants `SHARC_API_CODE`, `SAFEFRAME_API_CODE` (numeric values locked at AdCOM publication, § 6.3) | Hardcoded `[10, 11, 12]` for "SHARC 1.0, 1.1, 2.0 draft" in `SHARC_API_CODES` set | Spike picked plausible-but-unofficial integers; design defers to AdCOM publication | **Adopt design's constant pattern.** When AdCOM publishes, the spike's hardcoded array won't necessarily match. Refactor to named constants in `src/sharc-protocol.js`. |
| OMID container-side wiring | Excluded from 0.7.2 first half; defer to 0.7.2 second half (Q5) | Spike auto-calls extension `augmentEnvironmentData()` at construction time for every extension exposing it — primary consumer is OMID | Spike shipped OMID first half together; design split it for scope discipline + independent design pass | **Defer per design.** Move spike's `augmentEnvironmentData` auto-call to 0.7.2 second-half design pass. Don't ship as first half. |
| `container.apiFramework` accessor | New in 0.7.2; frozen at construction (G10); JSDoc anchored to AdCOM `APIFramework` | Not present | Design adds operator-facing diagnostic surface; spike has equivalent signal in validator-layer payload (`payload.sharc.requireSharcInit`) | **Adopt design.** Operators using `SHARCContainer` directly need it; tooling-layer signal doesn't satisfy that audience. |
| `container.hasSharcSession` accessor | New in 0.7.2; getter proxying `_sessionId` | Not present | Design adds outcome-driven companion to declaration-driven `apiFramework` | **Adopt design.** Trivial implementation (~0.25h); operator value is the disambiguation vs. `sessionId !== null`. |
| HTML lifecycle adapter (§ 8) | New `src/lifecycle-adapters/{base,html}-adapter.js`; drives `LOADING → ACTIVE` for non-handshake creatives; ~8h estimate | Not present | Design adds lifecycle observability for non-SHARC creatives; spike's harness bypasses SHARCContainer entirely for non-SHARC, so adapter wasn't needed in the spike model | **Adopt design.** This is the lifecycle-observability promise of #89 Option C; without it the container is functionally inert post-LOADING for non-SHARC creatives. |
| State machine `LOADING → ACTIVE` edge (§ 4.5) | One added edge in `STATE_TRANSITIONS` | Not present | Required by HTML adapter (above); spike doesn't need it because it doesn't have the adapter | **Adopt design.** Required for the adapter; trivial diff. |
| G7 framework-aware late handshake warn | Late `createSession` after `requireSharcInit: false` emits `console.warn` with 4 forensic fields; matrix branched on declared framework | Not present | Closes SE confused-deputy gap; spike doesn't surface this signal at all | **Adopt design.** SE flagged the gap; warn is the diagnostic-loudness payoff that compensates for the lost fatal-timeout. |
| G9 bridge auto-install timeout warn | Bridge module emits `console.warn` with strict integer cap value on auto-install timeout | Not present (no bridge auto-install changes in spike) | Operational visibility for bridge wiring failures | **Adopt design.** Independent of the rest; ~1h work in bridge modules. |
| G10 frozen `apiFramework` invariant | MUST be non-writable, never mutated by handshake or late callbacks | Not present (no accessor exists) | Locks an immutability invariant that prevents operator-dashboard drift | **Adopt design.** Required as part of `apiFramework` accessor. |
| G11 cookbook lint (temporal coupling) | Manual at-merge verification + optional CI grep check | Not present | Doc-surface guardrail | **Adopt design + upgrade.** Make CI grep check required, not optional, since merge-time verification is the kind of thing that gets skipped under pressure (review pushback item from earlier in this session). |
| G12 SHARC supersession | Priority-aware bridge resolver inhibits MRAID/SafeFrame bridges when SHARC code is declared; OMID stays orthogonal | Not present (spike's `_mapAdComApisToBridges` predates this design) | Honors creative-author intent for portable creatives | **Adopt design.** ~1h work in `_mapAdComApisToBridges`. |
| `creativeMeta.apis` enrichment from `imp.banner.api` | Not in design (creativeMeta is operator-supplied) | Spike's `extractCreativeMetaApis()` merges `imp.banner.api` from matched impression into `creativeMeta.apis` | Spike serves bid-response normalization; design treats `creativeMeta` as operator-provided | **Keep in validator layer only.** Container should not auto-merge from bid signals; that's the validator's job. No container-side change. |
| Harness routing when no SHARC declaration | Not addressed (design assumes SHARCContainer is always used) | Spike harness bypasses `SHARCContainer` entirely and renders directly into slot when `isSharcRuntime() === false` | Different architectural model: spike does "container-per-API"; design does "unified container tolerates any creative" | **Surface to Jeffrey.** This is a meaningful design philosophy split — the harness behavior contradicts the unified-container value proposition of #89. See Stage 4 open questions. |
| Naming collision risk | Single name `requireSharcInit` at container layer | **Same name** at both container AND validator/orchestrator layers with **different semantics** (container: skip timeout / validator: choose SHARC vs. sandbox container) | Convenient shorthand at validator layer; risks operator confusion | **Rename validator-layer flag.** Suggest `useSharcContainer` or `containerKind` in the orchestrator/payload layer to prevent meaning-overload. |

---

## 3. Spike-only items (in spike, not in design)

| Item | Where | Disposition |
|---|---|---|
| Extension `augmentEnvironmentData()` auto-call at construction | `src/sharc-container.js:860–880` (commit `06f0c1f`) | **Defer to 0.7.2 second-half** per Q5. Don't bundle into first-half ship. |
| `sanitizeApiDeclarations()` + `isSharcRuntime()` exports | `tools/creative-validator/src/bid-validator.js` (commit `102e894`) | **Keep in validator layer.** Useful tooling; doesn't need to move into container. |
| `extractCreativeMetaApis()` — merges `imp.banner.api` from matched impression | Same file | **Keep in validator layer.** Bid-response normalization is the validator's job. |
| `KNOWN_API_CODES` set in bid-validator (`{1,2,3,5,6,7,8,9,10,11,12}`) | Same file | **Keep but correct factual errors.** Spike comments label codes 8/9 as "OMID 1.1/1.2" — per AdCOM v1.0 those codes are **SIMID 1.0 / 1.1**. Correct the labels; behavior is fortuitously right. |
| `SHARC_API_CODES = {10, 11, 12}` constant | Same file | **Replace with `SHARC_API_CODE` symbolic constant** referencing the container's named constant (§ 6.3 of design). When AdCOM publishes, swap the integer once, not in two places. |
| Harness orchestrator container-routing based on `payload.sharc.requireSharcInit` | `tools/creative-validator/src/renderer-orchestrator.js` (commit `102e894`) | **Rename the flag** at orchestrator layer to disambiguate from container-layer `requireSharcInit`. Suggest `useSharcContainer: boolean` or `containerKind: 'sharc' \| 'sandbox'`. |
| Harness skip-first renderer backstop pattern (Markup variant) | Uncommitted WIP in `src/sharc-container.js:3192–3216` | **Adopt — file as separate PR.** This is a genuine G2 refinement (handles the expected `document.write` load event without flagging it as unauthorized navigation). Does not weaken security; documents the expected event. |
| Skip-first test coverage update | Uncommitted WIP in `test/node/test-creative-sources-load.js:1806–1825` | **Adopt with the skip-first refinement.** Test now dispatches two load events to verify backstop arms correctly. |
| Test file `test-require-sharc-init.js` (158 lines, 6 cases) | `test/node/` (commit `06f0c1f`) | **Adopt as starting point** but rewrite test #4 (falsy normalization → `true`) to expect `TypeError` per design Q4. |
| Tooling test file `test-require-sharc-init.js` (232 lines, 28 cases, in `tools/creative-validator/`) | `tools/creative-validator/` (commit `102e894`) | **Keep in tooling.** Tests validator-layer logic, not container. |

---

## 4. Design-only items (in design, not in spike)

| Item | § ref | Estimated implementation cost |
|---|---|---|
| `container.apiFramework` accessor + `_resolveApiFramework` helper | § 6, § 7.2 | 2.0h |
| `container.hasSharcSession` accessor | § 7.1 | 0.25h |
| Three-layer detection picker | § 6.1, § 6.2 | included in `_resolveApiFramework` |
| HTML lifecycle adapter (base class + HTML adapter) | § 8 | ~5h |
| Adapter wiring in `load()` (`_selectLifecycleAdapter` + attach/detach) | § 8.2 | 1.5h |
| State machine `LOADING → ACTIVE` edge | § 4.5 | 0.25h |
| G7 framework-aware late handshake warn (4 forensic fields) | § 7.4, G7 | 1.0h |
| G9 bridge auto-install timeout warn (strict integer cap value) | § 10.1, G9 | 1.0h |
| G10 frozen `apiFramework` invariant | G10 | included in accessor work |
| G11 cookbook + temporal-coupling read pattern | § 11.2, § 12, G11 | included in doc updates |
| G12 SHARC supersession in `_mapAdComApisToBridges` | § 6.7, G12 | 0.75h |
| Anti-example § 11.4 (legacy MRAID without SHARC SDK) | § 11.4 | included in doc updates |
| Test file `test-html-lifecycle-adapter.js` | § 15.4 | 2.5h |
| Test file `test-non-sharc-loading.js` | § 15.3 | 2.5h |
| `test-bridges-detection.js` expansion for `apiFramework` + G10/G12 | § 15.2 | 2.5h |
| Doc updates (api-reference, architecture-design, creative-cookbook, getting-started, SECURITY.md check) | § 12 | 2.0h |

**~20h of design-only work** that is not yet present in any form in the spike. This is the bulk of the 23h estimate from § 16.

---

## 5. Stage 4 decision (Jeffrey, 2026-05-15) — **implement #89 fresh per locked design; park spike**

After review, Jeffrey rejected the hybrid cherry-pick path and chose a cleaner sequencing:

1. **Implement #89 fresh** on `feat/89-non-sharc-loading` per the locked design. **No cherry-picks from the spike.** Even the small ~45-line container skeleton goes in fresh — adopting it as-is would carry the spike's falsy-coercion validation, the spike's factual SIMID/OMID labels, the spike's premature 0.7.2 version bump, and the spike's OMID auto-wire that belongs in second-half.
2. **Park the spike branch.** Do not edit, do not rebase, do not cherry-pick from. Leave it as a historical reference until #89 merges to main.
3. **After #89 merges to main:** update the spike's validator (`tools/creative-validator/`) to use the now-shipped 0.7.2 architecture — `container.apiFramework`, `container.hasSharcSession`, named SHARC code constants, renamed validator-layer flag (to avoid collision with the container's `requireSharcInit`). At that point the four open questions from the prior version of this section get answered as part of the validator-update PR, not as part of #89.

### Reverse-signal pass (what the spike's container-side work contributed to #89)

Jeffrey asked for a final pass: did the spike's container-side code surface any architectural ideas worth retroactively incorporating into the locked design? **Yield is limited.** Two items, both small, both **outside** #89's first-half scope:

| Item | Source | Disposition |
|---|---|---|
| **A — Extension error resilience pattern.** Spike's auto-call to `ext.augmentEnvironmentData()` is wrapped in try/catch + non-blocking `console.warn` so a broken extension doesn't crash construction. | `src/sharc-container.js:860–880` (commit `06f0c1f`) | **Note for the 0.7.2 second-half OMID design pass.** The auto-call itself doesn't ship in first-half (Q5 lock). When it lands, this is a sensible error-handling shape. |
| **B — Renderer backstop skip-first for Markup variant.** Spike's WIP adds a `{ once: true }` skip handler that consumes the expected first `load` event from `document.write(creativeHtml)`, then arms the real backstop for any subsequent (unauthorized) load. Test updated to dispatch two load events. | `src/sharc-container.js:3192–3216` + `test/node/test-creative-sources-load.js:1806–1825` (uncommitted spike WIP) | **Separate PR / issue, independent of #89.** Genuine G2 refinement. Can land anytime. Worth filing now so it doesn't get lost. |

Everything else in the spike's container-side work is either convergent (the `requireSharcInit` boolean shape itself), divergent in a way the locked design wins (falsy coercion vs. strict validation), or deferred (OMID auto-wire). No design changes to #89.

### Spike validator disposition (parked work)

The spike's `tools/creative-validator/` is substantial validator harness work — `sanitizeApiDeclarations()`, `isSharcRuntime()`, `extractCreativeMetaApis()`, container orchestration, MRAID/SafeFrame container backends. **All of it stays in the spike branch unchanged** until #89 merges. At that point a follow-up workstream:

- Updates the validator to consume `container.apiFramework` instead of its own `isSharcRuntime()` for SHARC detection (or, more likely, keeps both — validator's tool-side detection is for bid-response normalization, container's accessor is for runtime).
- Replaces hardcoded `SHARC_API_CODES = {10, 11, 12}` with the named constant from `src/sharc-protocol.js`.
- Corrects the SIMID/OMID labels in `KNOWN_API_CODES` (codes 8, 9 are SIMID 1.0/1.1, not OMID 1.1/1.2).
- Renames the validator-layer `requireSharcInit` flag to disambiguate from the container's option (suggest `useSharcContainer` or `containerKind`).
- Reconciles `package.json` version with whatever main is at when the validator update lands.
- Either adopts the design's unified-container model in the harness (every creative wrapped in `SHARCContainer`) or keeps the current container-per-API split as a deliberate harness-only choice. **Surface to Jeffrey at validator-update time.**

The total ~23h of #89 implementation work is per the design's § 16 — no spike-derived shortcuts.

---

## 6. Stage 5 launch

Implementation runs against design § 16's 21-step handoff table. Senior Developer agent owns Stages 5+ (implement → review → security audit → devops/sre). Operates in the `SHARC-claude` worktree on `feat/89-non-sharc-loading`. Does not touch the spike worktree or its uncommitted WIP. Does not bump `package.json` to 0.7.2 (version bump is at release per CLAUDE.md).

---

## 7. Methodology note

This is the meeting point where the synthesis layer reads both sources after the architect / PM / SE worked blind to the spike during Stages 1+2. The convergence on the `requireSharcInit` core is meaningful signal — independent paths reached the same shape, which validates both. The divergence is concentrated almost entirely in **what got added around** the core (design's framework detection, HTML adapter, G1–G12 guardrails vs. spike's tooling-layer detection and OMID auto-wire). That asymmetry is what Plan C was designed to surface, and it confirms the design's architectural-breadth investment.

The recommendation is **not** "the design wins" or "the spike wins." It's "the design wins on what the container should expose to operators; the spike wins on what the validator tooling should compute from bid signals; they land in different files and one PR per layer."

---

*End of Stage 3 comparison. Stage 4 is Jeffrey's decision on the recommendation + open questions above; Stage 5 is the implementation pipeline (Senior Developer → Code Reviewer → Security Engineer → DevOps).*
