# SHARC Distribution Design — Review Artifact

**Date:** 2026-04-10
**Target doc:** `docs/distribution-design.md` (draft, committed on this branch)
**Branch:** `feat/distribution-design`
**Status:** Still blocked for full rollout. Some hygiene follow-ups may land incrementally, but the package/build pipeline remains blocked until the code-level prerequisites land on main.

---

## Parking rationale

Two of the findings surfaced in review (tree-shaking barrel-ref refactor and JSDoc hardening) require actual code changes in `examples/sharc-*.js`, not doc changes. Those should land on main as independent improvements before the distribution design doc is revised, so:

1. The doc can reference a codebase that already supports the structure it proposes.
2. The code changes benefit the project regardless of whether the distribution design doc lands.
3. The feature branch, when resumed, rebases cleanly on an improved main.

## Execution plan when resuming

1. **Rebase `feat/distribution-design` on main** to pick up the post-refactor code.
2. **Revise `docs/distribution-design.md`** to incorporate the 14 consolidated findings below and the closed decisions.
3. **Address PM escalations** (npm org ownership, RC channel, compliance claims) — may require out-of-band conversation with IAB Tech Lab.
4. **Create the v1.0.0-blocker artifacts** (SECURITY.md, SUPPORT.md, LAST_KNOWN_GOOD.md, INTEGRATION.md, issue templates, GitHub Actions workflows). If any workflow lands early, keep it explicitly guarded so it does not imply SHARC is already publishable before `package.json`, `tsconfig.json`, the ESM refactor, and protocol-contract tooling exist.
5. **Re-review** (or at minimum, delta-review) with the same 6-agent panel.

---

## Review panel

Six agents reviewed the draft in two waves:

**Wave 1 (4 agents, essential):**
- Product Manager
- Software Architect
- Security Engineer
- DevOps Automator

**Wave 2 (2 agents, added after gap analysis):**
- Frontend Developer
- SRE (Site Reliability Engineer)

---

## Decisions closed (no longer open for debate)

These emerged from the reviews with unanimous or strong agreement and should be treated as settled when the doc is revised. Do not re-litigate.

| Decision | Outcome | Source |
|---|---|---|
| One package vs. five | **One package** (`@iabtechlab/sharc`) with multi-entry `"exports"` | Unanimous across all 6 reviewers |
| Bundle formats | **ESM + IIFE only.** Drop CJS. | Software Architect, Frontend Developer |
| Bundler choice | **Rollup** — concretely because it emits no runtime helpers in ESM and minimal wrapping in IIFE, vs. esbuild's 300–800 bytes of preamble that costs 6–16% of the 5KB budget | Software Architect |
| TypeScript declarations | **JSDoc-generated `.d.ts`** (not hand-authored) | Software Architect, Frontend Developer, PM |
| CDN format | **IIFE, not UMD.** UMD's AMD/CJS detection branches are ~200 bytes of dead code in every bundle. Rollup `format: 'iife'` with explicit `name:` per entry point. | Software Architect, Frontend Developer |
| Top-level `"browser"` field | **Remove.** Conflicts with `"exports"` conditional resolution; use the `"browser"` *condition* inside `"exports"` instead. | Software Architect, Frontend Developer |
| IIFE global names | **Container → `window.SHARC`. Creative SDK → `window.SHARC` (same global; never co-exist in the same realm). MRAID/SafeFrame bridges → NO standalone IIFE bundle** (injected by container as inline script via `injectIntoMarkup`). OMID bridge → `window.SHARC.extensions.omid` (namespaced under existing global). | Frontend Developer |
| Canonical CDN URLs | **Collapses from 5 to 2** (container + creative only; bridges are not standalone CDN artifacts) | Frontend Developer |
| Browser target | **`es2019` for creative SDK** (covers iOS Safari 12.2+, Android WebView 75+, the floor for live ad inventory). **`es2020` for container** (publishers control update cadence). | Frontend Developer |
| Size budget unit | **Express as `5KB gzipped / 4.2KB brotli`.** jsDelivr serves brotli since 2022, ~18% headroom for free. | Frontend Developer |
| `"sideEffects"` carve-out | **`"sideEffects": ["./dist/bridges/*.js", "./dist/bridges/*.esm.js"]`** — bridges intentionally install `window.mraid`/`window.$sf` as side effects and must not be tree-shaken. | Software Architect, Frontend Developer |
| CDN failover model | **Integration-time choice, NOT runtime.** jsDelivr and UNPKG compress differently — a single SHA-384 cannot match both. Publishers pick one CDN and pin its hash. UNPKG is "alternate origin requiring re-pinning a different SRI hash from `SRI.md`." | SRE |
| SRI hash ordering | **Generate from local `dist/` artifact BEFORE `npm publish`**, verify against CDN-served bytes AFTER publish. Current draft's "download from jsDelivr and hash" approach races CDN propagation AND validates whatever bytes were shipped (including compromised ones). | Security Engineer, DevOps Automator |
| `npm publish --provenance` | **Mandatory.** Publish must happen via GitHub Actions OIDC, not from a release manager's laptop. 2026 table-stakes; gives Sigstore attestation for free. | Security Engineer, DevOps Automator, Frontend Developer |
| Protocol-aware semver enforcement | **Tooling, not discipline.** Generate a protocol contract snapshot at build time (`dist-meta/protocol-contract.json`) — deterministic dump of message enums, state transitions, arg schemas. CI diffs against previous release tag; non-empty diff requires `protocol:` commit prefix and non-empty `### Protocol` CHANGELOG section. | Software Architect |
| Build-time JSON.stringify assertion | **Grep assertion in CI** that `JSON.stringify` does not appear in any `dist/*.js` output — protects the Structured Clone invariant through the build pipeline. | Security Engineer |

---

## Consolidated findings (14 items for the revision pass)

### Unanimous / cross-reviewer reinforcement
- One-package model (§4)
- Drop CJS, switch UMD→IIFE
- `"sideEffects"` carve-out for bridges
- npm `--provenance`

### Critical / blocks first publish

**1. SRI hash ordering is wrong** (Security + DevOps) — §10 step 5 must generate hashes from local `dist/` before `npm publish`, then verify against CDN after.

**2. npm `--provenance` mandatory** (Security) — publish must happen via GitHub Actions OIDC.

**3. `SECURITY.md` is a v1.0.0 blocker** (Security + PM) — disclosure address, PGP key, embargo policy. Currently §13 punts this.

**4. No `package.json` exists yet** (DevOps) — §10 assumes it; step 0 is missing entirely.

**5. Rollup plugin set is incomplete** (DevOps) — missing `@rollup/plugin-commonjs`, `@rollup/plugin-replace`. The `typescript`/`dts` "or" wording is wrong — need both in separate passes, or `tsc` outside Rollup.

**6. `.size-limit.json` as drafted will throw** (DevOps) — `gzip: true` isn't a valid field in current `size-limit`; need `@size-limit/preset-small-lib`.

**7. `"sideEffects": false` breaks the bridges** (Software Architect + Frontend Developer + DevOps) — bridges install `window.mraid`/`window.$sf` as side effects and will be tree-shaken. Need `"sideEffects": ["./dist/bridges/*.js", "./dist/bridges/*.esm.js"]`.

**8. `"exports"` condition ORDER matters** (Frontend Developer) — `"types"` MUST be first, `"default"` MUST be last. Current draft will misresolve in Webpack 5 and TypeScript `moduleResolution: "bundler"`.

**9. `typesVersions` fallback required** (Frontend Developer) — for TypeScript users on `moduleResolution: "node"` (still common). Without it, subpath imports show no autocomplete.

**10. Webpack 4 won't work at all** (Frontend Developer) — doesn't understand `"exports"`. Needs an explicit "not supported, use IIFE bundle" note.

**11. Tree-shaking will break at `sharc-creative.js:50`** (Frontend Developer) — `window.SHARC.Protocol` barrel-ref blocks the smoke test. Requires refactor to a pure-ESM `_protocol-constants.js` shared module. **This is a code change, not a doc change.** → Addressed as task #7 (refactor branch).

**12. JSDoc discipline is currently insufficient** (Frontend Developer) — current `examples/sharc-*.js` uses `@param {Function}` everywhere, which generates useless `any`-typed `.d.ts`. Needs `@callback` typedefs, explicit `@typedef` for domain types. **This is a code change, not a doc change.** → Addressed as task #8 (JSDoc hardening branch).

**13. Runtime CDN failover with SRI is impossible** (SRE) — jsDelivr and UNPKG compress differently, single SHA-384 can't match both. Commit to integration-time CDN choice with separate hashes published per CDN.

**14. SRI blast radius has no detection mechanism** (SRE) — MTTD is currently "until a publisher emails us." Required: GitHub Actions cron (`*/15 * * * *`) that fetches both CDN URLs, computes SHA-384, compares to `release/<version>/SRI.md`, opens an incident-labeled issue on divergence.

### Additional SRE gaps (rollback + support)

- **No rollback discipline.** Commit to patch revert within 24h, `npm deprecate` within 4h, pinned `LAST_KNOWN_GOOD.md` updated as final step of §10.
- **No support intake.** Need `SUPPORT.md` + `bug-production-incident.yml` issue template with required diagnostic fields.
- **Add §15 Public Service Levels** committing to wire-protocol stability (100% in PATCH), security advisory ack (<24h), security fix/mitigation (<7d), incident triage (<2 business days), regression rollback (<24h). Explicitly decline CDN availability and latency SLOs (inherited from jsDelivr/UNPKG).

### PM adoption gaps

- **Add RC/beta channel** (`@iabtechlab/sharc@1.0.0-rc.1`) — lets working group pressure-test package surface before committing to semver.
- **Missing compliance/parity claims** — MRAID 3.0 compliance suite pass rate is the single most powerful adoption argument and is nowhere in §1.
- **Missing integrator feedback loop** — how do integrators report issues, signal breakage, get zero-day advisories?
- **§3 governance under-specified** — add a §3.1 "Pre-Publish Governance Checklist" listing IAB Tech Lab artifacts that must exist day one (CLA/DCO, SECURITY.md, CODEOWNERS, working group sign-off record).

### v1.0.0-blocker artifacts to create

All of these must exist before first publish:

- `SECURITY.md` (Security Engineer)
- `SUPPORT.md` (SRE)
- `LAST_KNOWN_GOOD.md` or README badge (SRE)
- `.github/ISSUE_TEMPLATE/bug-production-incident.yml` (SRE)
- `release/<version>/SRI.md` pinned per release (SRE)
- `INTEGRATION.md` canonical copy-paste block per consumer (Frontend Developer)
- `docs/release-process.md` including rollback runbook (Security + SRE)
- `.github/workflows/ci.yml` and `release.yml` (DevOps). `release.yml` may exist as guarded scaffolding, but that does not remove the missing package/build blockers.
- `.github/workflows/sri-monitor.yml` cron (SRE)
- `package.json` (DevOps — step 0 is still missing)

### New DX items (Frontend Developer)

- `package.json` `engines` field (Node ≥18 for build)
- `unpkg` field in `package.json` (controls default UNPKG bare URL)
- Stackblitz/CodeSandbox starter template (ad creative devs won't clone the repo)
- `@types/iabtechlab__sharc` fallback on DefinitelyTyped for Webpack 4 / old TS users
- React/Vue wrapper packages — "future work" note, not v1

---

## Escalations for Jeffrey (unresolved)

1. **Who owns `@iabtechlab` on npm today?** (Hard blocker per PM, Security, DevOps)
2. **Is there a charter buyer or design-partner publisher willing to integrate against an RC build before 1.0?** (PM — without one, §1's adoption framing is unfalsifiable)
3. **Current MRAID 3.0 compliance suite pass rate?** (PM — the adoption lever; needs to be captured as task #6 baseline)
4. **Refactor `examples/sharc-creative.js` now** (code change for finding #11) to enable clean tree-shaking, or ship v1.0.0 with imperfect tree-shaking and fix in v1.1.0? → **Decision: do it now**, before doc revision. Tracked as task #7.
5. **JSDoc hardening pass** on `examples/sharc-*.js` (code change for finding #12) — do it before v1.0.0 or ship with weak `.d.ts` and fix in v1.1.0? → **Decision: do it now**, before doc revision. Tracked as task #8.

---

## Raw reviews (verbatim)

The six reviews are preserved below verbatim for future reference. Each was scoped to a specific section of the doc with context about the other reviewers' findings (for waves 2 onward).

---

### 1. Product Manager Review

**Top-Line Verdict: Revise** (not rethink)

The doc is technically thorough and the engineering choices are mostly right. But it reads as a build/release plan dressed up as a distribution strategy. The "will integrators actually use this" question is under-served, and §11's dual-source model has a quiet failure mode that will bite within ~6 months.

#### Findings

**1. §1's three-pillar framing is necessary but not sufficient.** Drop-in CDN, npm, and versioned releases are table stakes — they unblock adoption, they don't *cause* it. What's missing as adoption levers: (a) a copy-pasteable "hello world" integration for each of the four consumer types, (b) parity claims vs. MRAID/SafeFrame (compliance %, supported features), (c) a public conformance/badging story so an SSP can prove "SHARC-compliant" to a buyer. A publisher doesn't switch from MRAID because npm exists; they switch because their security team mandates it or because a major DSP requires it. Neither motivator appears in §1.

**2. §11's "edit `examples/`, build to `dist/`" model will erode.** The moment a contributor needs to debug a bug that only reproduces in the bundled output, or wants to add a true unit test, the source-of-truth boundary will get fuzzy. The pragmatic fix isn't to flip the model — it's to commit to it explicitly: add a CI gate (step 3 of §10) that runs the harness against `dist/` on every PR, not just at release. Without that, the "verified at release time only" loop means a contributor can land a change that breaks the bundled output and nobody notices for weeks. Also missing: what happens when `examples/` contains test creatives that *aren't* part of the package? The mapping table in §11 implicitly says "everything else stays test fixture" but doesn't say it.

**3. §12's open decisions are mostly right, but priority is wrong.** Decisions 1 (npm org ownership) and 5 (CI platform) are blockers — they must resolve before first publish. Decision 2 (TS declarations) and 6 (container size budget) are over-thinking; ship JSDoc-generated and a soft 25KB budget, move on. Decision 3 (separate bridge packages) is actually the most consequential and is being treated as reversible — it isn't, really. Once the MRAID bridge ships as `@iabtechlab/sharc/bridges/mraid`, splitting it later breaks every integrator's import path. **Missing decision:** what's the pre-1.0 channel? An RC/beta tag (`@iabtechlab/sharc@1.0.0-rc.1`) lets the working group pressure-test the package surface without committing to semver. Strongly recommend adding this.

**4. §3 governance is under-specified for an IAB Tech Lab artifact.** The doc names `@iabtechlab` as the org but skips the actual gating questions: Who has publish rights? Is there a working-group vote required for MAJOR releases? Is there a CLA or DCO requirement for external contributors? Where does security disclosure go (§13 punts this to a future `SECURITY.md` — but that file needs to exist *before* first publish, not after). Recommendation: add a §3.1 "Pre-Publish Governance Checklist" that lists the IAB Tech Lab artifacts that must exist on day one (CLA, SECURITY.md, CODEOWNERS, working group sign-off record).

**5. Missing entirely: the integrator feedback loop.** No mention of how integrators report issues, request features, or signal breakage. No mention of telemetry/adoption measurement (how will we know if anyone is using it?). No deprecation communication policy (§13 punts this too). For a security-critical container, also missing: a public advisory channel for "if you're on v1.0.x, upgrade now" zero-day comms. A product person reading this doc has no idea how SHARC will *learn* from its users post-launch.

#### Questions to escalate to Jeffrey

1. **Who at IAB Tech Lab actually owns `@iabtechlab` on npm today?** This is decision #1 in §12 and it's a hard blocker. If the answer is "nobody yet," the realistic first-publish date is months out, and the doc should say so.
2. **Is there a charter buyer or design-partner publisher willing to integrate against an RC build before 1.0?** Without one, you're shipping into a vacuum and §1's adoption framing is unfalsifiable.
3. **What's the compliance story?** Does SHARC pass the MRAID 3.0 compliance suite at 100% via the bridge? That number is the single most powerful adoption argument and it's nowhere in this doc. If it's not 100% yet, the gap is the most important thing in §1.

---

### 2. Software Architect Review

**Verdict: Architecturally sound with two specific corrections required**

The doc is the right shape. One package + multi-entry exports, Rollup, mandatory SRI, and protocol-aware semver are all defensible 2026 calls. Two sections are actively wrong as written, and three decisions are deferred that should be made now.

#### Findings

**§4 — One package vs separate (correct, but tighten the rationale).** Bundled wins because the bridges and creative SDK all `import` from `sharc-protocol.js`. With separate packages you get either (a) protocol duplicated across five `dist/` trees, multiplying the 5KB budget risk, or (b) a sixth `@iabtechlab/sharc-protocol` package that all five depend on, reintroducing version-skew-at-install — exactly the failure mode protocol-aware semver exists to prevent. **What would change my mind:** the bridges shipping on a faster cadence than the core, or a third-party wanting to publish their own bridge. Neither is true today. Decision: stay bundled, close §12.3.

**§5 — Wrong on two counts.**

1. **Drop CJS.** A browser-focused ad container with no SSR story does not need CJS in 2026. It costs you a build target, doubles the `exports` matrix, and the only consumer is `require()` from old Node tooling that has nothing to do with running ads. ESM + UMD is sufficient. If Node tooling complains, ESM-in-Node has been stable since 14.13. Removing CJS also removes the dual-package-hazard risk (two copies of protocol constants in the same process if a bundler picks both).
2. **The `"browser"` field is legacy and conflicts with `"exports"`.** Modern resolvers use the `"browser"` *condition* inside `"exports"`, which the doc already does correctly. Delete any plan to also set a top-level `"browser"` field — it's a footgun and modern bundlers ignore it when `"exports"` is present.

Also: **prefer IIFE over UMD** for the CDN bundle. UMD's AMD/CommonJS detection branches are dead code for `<script>` consumers and add ~200 bytes you're paying for inside the 5KB budget. Rollup `format: 'iife'` with `name: 'SHARC'` gives you the same `window.SHARC` global, smaller, and removes a class of "what does UMD do under SystemJS" questions nobody wants to answer.

**§6 — Rollup is correct.** The reason is concrete: Rollup emits zero runtime helpers in ESM mode and minimal wrapping in IIFE mode, where esbuild always emits a helper preamble (`__defProp`, `__name`, etc.) that costs 300-800 bytes. At a 5KB budget that's 6-16% of the budget burned on bundler scaffolding. Keep Rollup.

**§9 — "Reviewer discipline" is not enforcement.** The protocol-aware semver rule is unenforceable as written. Make it tooling:

- Generate a **protocol contract snapshot** at build time — a deterministic JSON dump of `ProtocolMessages`, `ContainerMessages`, `CreativeMessages`, state-machine transitions, and message-arg schemas. Commit it as `dist-meta/protocol-contract.json`.
- CI diffs the snapshot against the previous release tag. Any change blocks merge unless the PR title starts with `protocol:` and the CHANGELOG `### Protocol` section is non-empty.
- Without this, §9 is aspirational and the first patch release will silently break wire compat.

**§11 — Dual-source invites drift, fix the seam now.** Editing `examples/` and shipping from `dist/` is fine *if* the test harness can be pointed at either source. Add a query-string switch (`?build=dist`) to the harness now, not "manual step until automated". Otherwise contributors will verify against source, ship `dist/`, and the first regression is a Rollup minification edge case nobody caught. Also: `examples/sharc-protocol.js` being inlined into five bundles via Rollup's tree-shaker is correct, but pin it — a `// @sharc-protocol-boundary` comment that the build asserts on, so a future contributor can't accidentally split protocol constants across files.

#### Architectural gaps to close before implementation

1. **Where do the IIFE bundles put their global?** `window.SHARC` for the container, but the creative SDK and bridges need explicit names declared now (`window.SHARC` vs `window.SHARCCreative` is hand-waved in §5). The "no new globals" invariant means this must be decided, not discovered.
2. **Protocol contract snapshot file path and format** — needs to exist as an artifact in `dist/` so downstream tooling can verify it.
3. **Decide §12.2 now: JSDoc-generated `.d.ts`.** Hand-authored doubles maintenance for a reference implementation with no full-time staff. Lock it in.
4. **§12.6 container budget: set it.** 25KB gzipped soft, 40KB hard. Unbounded budgets always drift; the moment to set the number is before the first release, not after.
5. **Treeshake verification.** `"sideEffects": false` is asserted but nothing tests it. Add a smoke test: import only `@iabtechlab/sharc/creative` into a fixture, bundle with esbuild, assert the output contains zero strings from `sharc-container.js`. Catches the day someone adds a top-level side effect.

---

### 3. Security Engineer Review

**Verdict: NEEDS REVISION before first publish.** The design correctly identifies SRI as mandatory and pins exact versions, but §10 step 5 has a real race window, and the pipeline lacks the supply-chain controls (provenance, signing, dual control) appropriate for a security-critical container shipping to ad-tech production.

#### Findings (by severity)

**CRITICAL — §10 step 5: SRI hashes generated *after* `npm publish`**

There is a meaningful race window. The instant `npm publish` returns, jsDelivr and UNPKG can serve `@iabtechlab/sharc@X.Y.Z` to anyone who guesses or scrapes the version (npm registry is public; new versions are visible within seconds). Between publish and the GitHub release going live, a consumer can fetch the file with **no SRI hash to pin against**, and a reviewer comparing the eventual hash has no independent baseline.

Worse, the proposal generates the hash *from the CDN-served file*. If the npm artifact is tampered with at publish time (compromised token, malicious post-install, npm registry compromise), the hash will faithfully describe the malicious bytes, and SRI will validate the attack.

**Required fix:** generate SHA-384 from the **local build artifact in `dist/`** *before* `npm publish`, commit/sign that hash, then *after* publish download from both jsDelivr and UNPKG and verify byte-for-byte equality. Mismatch = unpublish (`npm unpublish` within 72h) and incident response. This converts SRI from "transcribing what the CDN says" into "asserting what we built."

**CRITICAL — Missing provenance / signing**

For an ad container, npm provenance attestation (`npm publish --provenance`, SLSA Level 3 via GitHub Actions OIDC) and Sigstore/cosign signing of the `dist/` artifact are table-stakes in 2026. The design omits both. Without provenance, a stolen npm token is sufficient to ship a compromised release that passes every check in §10 because the release manager never sees it. **Required for v1.0.0.**

**HIGH — Release manager is a single point of compromise (§10)**

Manual local publish from a release manager's machine means:

- A compromised laptop (malware, stolen session) compromises every release
- No dual control / no second-reviewer signoff
- No reproducible build to detect tampering
- The 2FA prompt protects the npm account, not the bytes being published

**Minimum for v1.0.0:** hardware-backed 2FA (YubiKey/WebAuthn, not TOTP) on the npm org; publish only from a clean checkout on a dedicated machine; PGP-sign the git tag; CHANGELOG entry pre-merged through PR review (so the release manager cannot unilaterally introduce changes at release time).
**Required by v1.1.0:** CI-driven publish via GitHub Actions with OIDC (no long-lived npm token), `--provenance`, dual-approval environment protection rule, reproducible builds.

**HIGH — CDN trust model is "trust npm"**

jsDelivr and UNPKG are both npm mirrors. They will serve whatever npm has. Pinning SRI correctly protects against **CDN-edge tampering and version drift**, but does **not** protect against:

- (a) compromised npm publish token → both CDNs serve the malicious bytes; SRI validates them
- (b) registry-level tampering → same outcome
- (e) dependency confusion → not applicable here (scoped package, no transitive deps), **this is a real win of the zero-deps + scoped-name choice**

A publisher who pins SRI from the GitHub release page is still vulnerable if the GitHub release body itself was authored from compromised bytes. SRI is necessary but not sufficient; provenance closes the gap.

**MEDIUM — Attack vectors per question 1**

- **(a) Compromised npm account during publish:** SRI as designed does **not** cover this. Provenance + dual control does.
- **(b) Compromised CDN origin:** SRI **does** cover this — this is exactly what SRI is for.
- **(c) Compromised release manager machine:** SRI does **not** cover this. Reproducible builds + CI publish does.
- **(d) Compromised GitHub repo after tag push:** Partially covered if SRI lives outside the repo (release body is mutable by repo admins). PGP-signed tags and external transparency log help.
- **(e) Dependency confusion:** Not applicable (scoped, zero deps). Good.

**MEDIUM — Single-package vs multi-package**

The single-package model in §4 is **better** for supply chain here: one 2FA surface, one publish token scope, one review surface, one CHANGELOG to scrutinize. Splitting into five packages would 5x the token-management burden and create five independent compromise paths. Decision §12.3 (keep bundled) is correct on security grounds. Document this in §3.

**LOW — Source maps (§7.3)**

Public source maps are **fine**. SHARC has no secrets, the source is already on GitHub, and source maps materially help downstream debugging and incident forensics. Confirm no internal hostnames, file paths from the build machine, or developer usernames leak into the `sources` array — strip absolute paths in Rollup config (`sourcemapPathTransform`).

**LOW — `npm unpublish` window**

72-hour unpublish window is the only emergency rollback. §10 should document a "yank" runbook: deprecate the version, publish a `.1` patch with a CHANGELOG security advisory, and coordinate with jsDelivr/UNPKG cache purge endpoints (jsDelivr supports purge via `purge.jsdelivr.net`).

#### Missing entirely

1. **SBOM generation** — CycloneDX or SPDX, attached to GitHub release. Trivial (zero deps) but expected.
2. **SLSA provenance attestation** — see CRITICAL above.
3. **Sigstore/cosign signing of `dist/`** — independent of npm.
4. **`SECURITY.md`** — vulnerability disclosure address, PGP key, embargo policy, response SLA. §13 acknowledges this; it should be a v1.0.0 blocker, not deferred.
5. **Incident response runbook for a compromised release** — who declares, how to unpublish, how to notify downstream, how to coordinate with jsDelivr/UNPKG, how to issue a CVE.
6. **Key rotation policy** — npm token rotation cadence, PGP key rotation, hardware key backup/recovery.
7. **Reproducible builds verification** — two release managers building independently and comparing hashes before publish.
8. **Pre-publish `npm pack` audit** — diff the tarball contents against expected file list to catch accidental inclusion of `.env`, sessions, or local artifacts (the `files` field in §4 helps but is allow-list, not audit).

#### Minimum controls before v1.0.0 publish

1. Fix §10 step 5: hash from local artifact pre-publish, verify against CDN post-publish (CRITICAL)
2. `npm publish --provenance` via GitHub Actions OIDC (CRITICAL — do not publish from a laptop)
3. Hardware-backed 2FA on the `@iabtechlab` npm org
4. PGP-signed git tags
5. `SECURITY.md` with disclosure address and PGP key
6. SBOM attached to GitHub release
7. Strip absolute paths from source maps
8. Documented incident response + unpublish runbook
9. `npm pack` content audit step in §10

#### Deferrable to v1.1.0+

1. Sigstore/cosign signing alongside npm provenance (defense in depth)
2. Dual-approval environment protection rule in GitHub Actions
3. Reproducible builds with two-party verification
4. Automated CDN integrity polling (cron job that re-fetches and re-verifies SRI hashes weekly)
5. Container size budget — not a security concern, but a defense against bloat hiding payloads

#### What's genuinely fine

- Scoped package name choice (`@iabtechlab/sharc`) — correct, prevents typosquatting and signals ownership
- Mandatory exact-version pinning, no `@latest`/`@1`/`@1.0` (§7.1) — exactly right
- Zero runtime dependencies (§2.2) — eliminates dependency confusion and transitive CVE exposure entirely; this is the single most impactful supply-chain decision in the doc
- SHA-384 choice (§7.2) — correct algorithm; SHA-256 is acceptable but SHA-384 is the modern default
- Single-package model for supply chain hygiene (§4)
- `crossorigin="anonymous"` in the SRI example (§7.2) — correct, required for SRI on cross-origin scripts
- Structured Clone constraint preserved through bundling (§2.3) — critical that Rollup/Terser cannot regress this; add a build-time grep assertion that `JSON.stringify` does not appear in any `dist/*.js` output

---

### 4. DevOps Automator Review

**Top-line verdict: Needs gaps filled before first publish.** The design is directionally correct (Rollup, multi-entry, size-limit, jsDelivr, SRI) but the release pipeline as written will fail on first attempt. The good news: every gap is small and concrete. Estimate half a day of setup to make it operable.

#### Findings by impact

##### Will-break (blocks first publish)

1. **No `package.json` exists yet.** §10 jumps to `npm publish` but the repo has no `package.json`, no `engines` field, no `publishConfig`, no `.npmrc`, no `peerDependencies`, no `devDependencies` lockfile. Step 0 is missing entirely.
2. **Rollup plugin set is incomplete.** Missing: `@rollup/plugin-commonjs` (needed if any source uses `module.exports` UMD pattern — `sharc-protocol.js` does), `@rollup/plugin-replace` (for build-time `__VERSION__` injection so the bundle reports its own version), and a JSON plugin if you want to import package.json for that. `rollup-plugin-dts` is a *separate pass* from `@rollup/plugin-typescript` — listing them with "or" is wrong; you typically need both (one to compile, one to bundle .d.ts). For pure JSDoc-to-dts, `tsc --emitDeclarationOnly` runs outside Rollup as a separate `npm script`.
3. **Single `rollup.config.js` won't cleanly handle 5×3 = 15 targets.** Use a config that exports an **array** of configs (one per entry point) where each entry produces an `output: [esm, cjs, umd]` triple. Build time on a developer laptop: ~3-8 seconds total — Rollup is fast for this size; not a concern.
4. **`size-limit` against Rollup output is fine, but config needs `@size-limit/file` preset explicitly** (`size-limit` v11 split into preset packages). The `gzip: true` field doesn't exist in current size-limit; gzipping is the default for `@size-limit/file`. Config snippet in §8 will throw "unknown option" on first run. Alternative worth considering: `size-limit` is still maintained in 2026 but **Bundlewatch** and **`@size-limit/preset-small-lib`** (the preset, not raw package) are the idiomatic forms now.
5. **Step 5 SRI generation is ordered wrong.** §10 says generate hashes *after* `npm publish` by downloading from jsDelivr. jsDelivr has propagation lag (5-30 min, occasionally hours) and serves a brotli-recompressed payload, not the npm tarball bytes. Hash the **local `dist/` files** before publish, then verify they match jsDelivr post-publish. Otherwise step 5 races CDN propagation and the release manager will sit refreshing for an hour.
6. **`npm publish` 7-step manual flow is non-atomic.** Concrete failure modes: (a) publish succeeds, hash gen fails → version is now permanently consumed on npm (you cannot republish `1.0.0`, must bump to `1.0.1`); (b) 2FA OTP times out mid-publish; (c) size-limit fails *after* publish since it's step 3 only — fine, but if a contributor edits between steps the local state is dirty. Recovery for (a): `npm deprecate @iabtechlab/sharc@1.0.0 "broken release, use 1.0.1"` and re-cut. **Add an `npm publish --dry-run` and `npm pack && tar -tf` inspection as mandatory step 3.5** before the real publish.

##### Friction (won't block but will hurt)

7. **"Verify against `dist/` before publish" (§10 step 3) is hand-waved.** The harness loads `examples/sharc-container.js` at fixed paths. To verify against `dist/`, you need either (a) a query-string mode switch in the harness (`?source=dist`) that rewrites script srcs, or (b) symlinks `examples/sharc-container.js → dist/container/index.umd.min.js` during verification, or (c) a second harness HTML file. None exist. As written, this step is aspirational. Realistic v1 plan: skip this step for v1.0.0, add `?source=dist` mode in v1.1.0.
8. **`dist/` gitignored + locally built = non-reproducible.** Two release managers on different Node versions will produce byte-different outputs (terser changes between minor versions, Rollup chunk hashing). Fix: pin exact versions in `package.json` (`"rollup": "4.21.0"` not `^4.21.0`), commit `package-lock.json`, add `engines: { node: ">=20.11.0 <21" }`, and have CI publish — not the release manager's laptop. Until CI exists, document the exact `node --version` and `npm --version` in `docs/release-process.md`.
9. **No CI plan at all.** §12.5 leaves it open. Concrete v1 plan below.

##### Polish

10. UMD global naming: §5 says "exposes `window.SHARC` (or `window.SHARCCreative`, etc.)" — the bridge entry points need explicit UMD `name` settings or Rollup auto-generates ugly names. Specify them in §6.
11. Tooling versions: target **Node 20 LTS** (Node 18 is EOL April 2025; in 2026 it's a year past EOL). **npm 10**, **Rollup 4** (Rollup 3 is fine but 4 is current and the plugin set named is 4-compatible). Pin in `engines`.
12. `"sideEffects": false` is correct but the bridges *do* have side effects (they install `window.mraid`). They need either `"sideEffects": ["./dist/bridges/*"]` or per-file annotation. As written, a tree-shaker may eliminate the bridge.

#### Concrete first CI workflow (`.github/workflows/ci.yml`)

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20.11.0', cache: 'npm' }
      - run: npm ci
      - run: npm run build
      - run: npm run size            # size-limit
      - run: npm pack --dry-run      # show what would publish
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist/ }
```

And `.github/workflows/release.yml` triggered on `v*` tag push: same build, then `npm publish --provenance --access public` using `NODE_AUTH_TOKEN` from secrets, then `gh release create` with the CHANGELOG section + SRI hashes (computed from `dist/` *before* publish step). `--provenance` is the 2026 default for npm and gives you Sigstore attestation for free — the design doc should require it.

#### Minimum changes required before first publish attempt

1. Create `package.json` with: `name`, `version`, `type: "module"`, `engines.node: ">=20.11.0"`, `exports` map (as drafted), `files: ["dist"]`, `publishConfig: { access: "public", provenance: true }`, `repository`, `license`, `scripts: { build, size, prepublishOnly: "npm run build && npm run size" }`, pinned devDeps.
2. Create `rollup.config.js` as an **array of 5 configs** (one per entry point), each with `output: [esm, cjs, umd]`. Add `@rollup/plugin-commonjs` and `@rollup/plugin-replace` to the plugin list in §6.
3. Fix `.size-limit.json` to drop the bogus `gzip: true` field; add `@size-limit/preset-small-lib` to devDeps.
4. Reorder §10: hash `dist/` locally → `npm pack --dry-run` inspect → `npm publish --dry-run` → `npm publish --provenance` → tag → release → post-publish CDN verify.
5. Pin `node-version` in `engines` and document the exact version in `docs/release-process.md`. Commit `package-lock.json`.
6. Add `.github/workflows/ci.yml` (build + size + pack-dry-run on every PR). This is the single highest-leverage gap closure.
7. Create the npm `@iabtechlab` org and provision a granular publish token stored as `NPM_TOKEN` GitHub secret **before** attempting release. §12 decision #1 is a hard blocker.
8. Add `.npmignore` *or* rely on `files` field — pick one; doc currently implies `files` but doesn't say so explicitly.
9. For v1.0.0, **explicitly remove or defer §10 step 3 "verify against `dist/`"** — it isn't wired up. File a follow-up issue.
10. Add `"sideEffects"` carve-out for bridge files so tree-shakers don't eliminate the `window.mraid` install.

---

### 5. Frontend Developer Review

**Verdict: Needs revision before publish.** The architecture is sound but several details will frustrate real integrators. Most are fixable in §4–§6 without changing the strategy.

#### Findings

**1. `"exports"` map is broken in practice (§4).** Three concrete bugs:

- `"browser"` as a sibling key is wrong — it's an `"exports"` *condition*, not a free-form key. Bundlers ignore it; some throw. Move it inside or delete it (Software Architect already flagged this).
- **Condition order matters.** `"types"` MUST come first. `"default"` MUST come last. Webpack 5 and TypeScript `moduleResolution: "bundler"` will misresolve otherwise.
- TypeScript users on `moduleResolution: "node"` (still common) won't see subpath types at all unless `typesVersions` is added as a fallback. Without it, `import from '@iabtechlab/sharc/creative'` autocompletes nothing in older tsconfigs.

Vite/Webpack5/esbuild handle subpath exports fine with the correct shape. **Webpack 4 will fail cryptically** (`Module not found`) because it doesn't understand `"exports"` at all — needs an explicit "Webpack 4 not supported, use the UMD bundle" note in the doc.

**2. Tree-shaking smoke test is realistic but `sideEffects: false` as drafted will silently break the bridges.** Adopt the carve-out: `"sideEffects": ["./dist/bridges/*.js", "./dist/bridges/*.esm.js"]`. The smoke test command:

```
esbuild fixture.js --bundle --minify --format=esm | grep -c "SHARCContainer" → must be 0
```

Lives in CI as `npm run test:treeshake`. It WILL fail if (a) protocol constants are imported via barrel files that re-export container symbols, or (b) class static initializers touch container code. Both are present in `sharc-creative.js` line 50 (`window.SHARC.Protocol`) — needs refactor to a pure-ESM internal `_protocol-constants.js` shared module.

**3. JSDoc-generated `.d.ts` is good enough — barely.** Looking at `sharc-creative.js`, the JSDoc is decent but inconsistent: `onReady` documents callback as `Function` (becomes `(...args: any[]) => any`, useless). Minimum discipline required:

- Replace every `@param {Function}` with explicit `@callback` typedefs
- Add `@typedef` for `EnvironmentData`, `Feature`, `PlacementOptions`, `RequestPlacementChangeArgs`
- Use `@returns {Promise<SomeType>}` not `Promise<Object>`

Without this, TS users get autocomplete on method names but `any` everywhere inside. That's the realistic gap and it's significant.

**4. Browser target is missing entirely (§5/§6).** This is the single biggest gap. Recommendation: **target `es2019`** for the creative SDK (covers iOS Safari 12.2+, Android WebView 75+, all 2019+ browsers). Avoid `es2020` because optional chaining adds bytes when down-leveled and `es2019` is the floor for live ad inventory. Container can target `es2020` (publishers control update cadence). Document this as a table in §6 — frontend devs will ask within five minutes.

**5. Publisher copy-paste experience is inconsistent (§7.1).** Four consumers, four different snippets, scattered across CHANGELOG/README/docs. Add a top-level `INTEGRATION.md` (or §15) with one canonical block per audience, kept in sync with releases. CHANGELOG should *link* to it, not duplicate.

**6. IIFE global names — concrete proposal:**

- Container → `window.SHARC` (already the invariant)
- Creative SDK → `window.SHARC` (same global; the creative and container never co-exist in the same realm, so there's no collision — this is the whole point of the "no new globals" rule)
- MRAID bridge → **no IIFE bundle**. The bridge is injected by the container into the creative iframe via `injectIntoMarkup`. It runs as inline script in the creative realm and installs `window.mraid` (already an allowed global). Ship ESM-only for the container's internal consumption; ship a raw text/string export for injection. No standalone CDN URL.
- SafeFrame bridge → same pattern as MRAID. Installs `window.$sf`. ESM-only + raw string for injection.
- OMID bridge → `window.SHARC.extensions.omid` (namespaced under the existing allowed global, not a new one). Registered as an extension, not loaded standalone.

This collapses §7.1's five canonical URLs to **two** (container + creative) — much simpler integration story.

**7. 5KB gzipped is achievable but tight.** Current `sharc-creative.js` is ~750 LOC of mostly-uncompressed code; minified+gzipped will land around 3.5–4.2KB based on similar SDKs (SIMID is ~4KB). The watchdog, feature regex, and fatal-error path all stay. Breaking point: if you add a second close watchdog or a reconnect mechanism. **Switch the budget unit to brotli** once jsDelivr brotli serving is confirmed (it is, since 2022) — gives ~18% headroom for free. Express both: `5KB gzipped / 4.2KB brotli`.

**8. Missing DX concerns:**

- No `@types/iabtechlab__sharc` fallback story for Webpack 4 / older TS users
- No Stackblitz/CodeSandbox starter template — critical for adoption; ad creative devs will not clone the repo
- No `package.json` `engines` field — should declare `"node": ">=18"` for the build, not the runtime
- No `provenance: true` in §10 publish step — npm provenance attestations are table stakes in 2026 for security-critical packages
- No mention of `unpkg` field in `package.json` (controls the default file UNPKG serves at the bare URL)
- No React/Vue wrapper packages — not required for v1 but worth a "future work" note since creative devs will ask

#### 2026 assumptions worth correcting

- The doc treats CJS as worth shipping (§5). In 2026, CJS-only consumers of a brand-new package are ~3% of the market and all of them can use the UMD. Drop CJS (matches Software Architect).
- "UMD" in §5 should be "IIFE" — UMD's AMD branch is dead weight and adds bytes against the 5KB budget (Software Architect already flagged).
- §5 says AMD/SystemJS are dead. Correct. Same applies to UMD itself for new libraries.

---

### 6. SRE Review

#### Top-line verdict

**Not operable in steady state as written.** The doc is a strong *publishing* design but treats the day after first publish as out of scope. Sections 7, 10, and 12 collectively imply a posture of "publish and hope." For a security-critical artifact embedded in revenue-bearing ad paths, that is an SLO-debt trap. Three reliability-critical gaps must close before v1.0.0 ships; the rest can be deferred with explicit acknowledgment.

#### Findings by impact

##### Reliability-critical (block first publish)

- **§7 — "secondary CDN" is undefined.** Runtime failover with SRI is effectively impossible: jsDelivr and UNPKG normalize/compress differently, so a single SHA-384 hash will not match both. The doc must commit to **integration-time choice, not runtime failover**: publishers pick one CDN and pin its SRI hash. UNPKG's role is documented as "alternate origin if jsDelivr is unreachable; requires re-pinning a different SRI hash from `SRI.md`." Anything else is wishful thinking.
- **§7.2 — SRI blast radius is unbounded and invisible.** A single corrupted byte at the CDN bricks every pinned integrator simultaneously, and the doc has zero detection mechanism. MTTD is currently "until a publisher emails us." Required before publish: a synthetic check (see below) plus a **hash manifest pinned in the repo at `release/<vX.Y.Z>/SRI.md`** so any integrator can independently verify they've been compromised vs. the repo-of-record.
- **§10 — no rollback discipline.** "Cut a new patch" is the only stated path. No "last known good" badge, no committed advisory SLA, no `npm deprecate` workflow. The release-process doc must commit to: patch revert within 24h of confirmed regression; `npm deprecate "<bad>" "regression in X; use <good>"` within 4h of confirmation; pinned "Last Known Good" line in `README.md` updated by the release manager.

##### High

- **§6 SLOs / no observability at all.** Document an explicit position: SHARC inherits jsDelivr's availability SLO (~99.9%) and commits to **two project-controlled SLOs only**: (a) zero wire-protocol regressions in PATCH releases (already implied by §9; make it a public SLO), (b) security advisory acknowledgement within 24h, fix or mitigation within 7 days. Decline availability and latency SLOs explicitly — the project does not control the CDN. Stating this is more credible than silence.
- **§10 — no support intake or triage SLA.** Need a `SUPPORT.md` and a GitHub issue template `bug-production-incident.yml` with required fields: SHARC version, browser/UA, container or creative side, integration mode (npm/CDN), CDN URL + observed SRI, minimal repro, business-impact tier. Triage SLA: best-effort 2 business days, no 24/7 on-call, stated explicitly.
- **§7 — no break-glass mirror.** Recommend the SHARC team mirror each released `dist/` tree to a GitHub Release asset (not just the tag) so integrators have a known-good byte source the maintainers control even if both CDNs go sideways. GitHub Releases is free and immutable per asset.

##### Medium

- **Release cadence undefined.** Propose explicit text in §10: "Patch releases as needed (no minimum cadence). Minor releases batched monthly maximum. Major releases require 30-day RFC window." Lower cadence reduces regression surface, which matches the "strict semver" posture.
- **Toil in §10.** Steps 1, 2, 4, 6 are automatable today via `release-please` or `changesets` + a GitHub Action. Steps 3 (manual harness), 5 (download-from-CDN-and-rehash), and 7 (post-release verification) are automatable but require the CI work DevOps Automator scoped. **Fundamentally manual:** the §9 "does this byte change on the wire?" judgment call. Everything else is just not-yet-automated. Break-even: at 3 releases the automation pays for itself.
- **§12 open question on container size budget.** From a reliability standpoint, set a soft 25KB gzipped budget and alert (not fail) on regression — silent bloat erodes integrator trust and is a leading indicator of feature creep into core.

##### Low

- **Missing entirely:** error budget policy (declare "n/a — no availability SLO"), public post-mortem template (`docs/postmortems/TEMPLATE.md`), dependency health monitoring (zero runtime deps so n/a, but devDeps need Dependabot — DevOps territory), status page (defer; link to jsDelivr's and UNPKG's), incident log retention (GitHub issues are the log; state retention = forever).

#### Minimum operational controls before first publish

**Must-have before v1.0.0:**

1. §7 rewritten to make CDN choice integration-time, with separate SRI hashes per CDN published in `SRI.md`.
2. **Synthetic monitoring.** Concrete spec: **UptimeRobot free tier** (50 monitors, 5-min cadence, free), three monitors:
   - `HEAD https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@<latest>/dist/creative/index.umd.min.js` — alert on non-200
   - `HEAD https://unpkg.com/@iabtechlab/sharc@<latest>/dist/creative/index.umd.min.js` — alert on non-200
   - **Integrity check via GitHub Actions cron** (`schedule: '*/15 * * * *'`): downloads both CDN URLs, computes SHA-384, compares to `release/<latest>/SRI.md`, opens a GitHub issue labeled `incident:sri-mismatch` on divergence. Free, runs in repo, audit-trailed.
   - Alerts route to a dedicated GitHub issue label (no PagerDuty, no Slack required) plus email to a maintainer alias. Realistic for OSS with no paid on-call.
3. `SUPPORT.md` + production-incident issue template.
4. Rollback runbook section in `docs/release-process.md` with the deprecate/revert/advisory decision tree.
5. `LAST_KNOWN_GOOD.md` (or a badge in README) updated by the release manager as the final step of §10.

**Deferrable post-1.0.0:** geographically distributed synthetic checks, latency SLO, automated rollback, status page, chaos/CDN failure injection.

#### Concrete SLO proposal for v1.0.0

Add a new §15 to the doc:

> **§15 Public Service Levels**
>
> SHARC is an open-source reference implementation, not a hosted service. The project commits to the following service levels and explicitly declines others:
>
> | Commitment | Target | Measurement |
> |---|---|---|
> | Wire-protocol stability in PATCH releases | 100% (zero regressions) | Audited per §9; any regression triggers immediate patch revert |
> | Security advisory acknowledgement | < 24 hours from confirmed report | GitHub Security Advisory timestamp |
> | Security fix or documented mitigation | < 7 days from confirmation | GitHub Security Advisory resolution |
> | Production-incident issue triage | < 2 business days, best-effort | GitHub issue first-response timestamp |
> | Regression rollback (deprecate + LKG update) | < 24 hours from confirmation | `npm deprecate` timestamp |
>
> **Explicitly not committed:** CDN availability, response latency, geographic reach. These are inherited from jsDelivr and UNPKG and are outside the project's operational control. Integrators requiring contractual availability should self-host the published artifacts behind their own CDN and pin SRI accordingly.

This posture is honest, defensible, and gives integrators something to point at without creating debt the project cannot service.
