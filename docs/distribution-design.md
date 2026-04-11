# SHARC Distribution Design

**Status:** Draft — pending review from Product Manager, Software Architect, Security Engineer, and DevOps Automator agents.
**Audience:** SHARC maintainers, IAB Tech Lab working group members, and future contributors who will implement the distribution pipeline.
**Scope:** How SHARC's JavaScript reference implementation is packaged, versioned, built, and delivered to publishers, SSPs, and ad creative developers.

This document supersedes the informal "just edit files under `examples/`" workflow for *distribution* purposes only. The source-of-truth files remain under `examples/`; this document describes how those files become an installable, CDN-available package.

---

## 1. Why This Matters

SHARC today lives only as source files under `examples/`. To use them, a publisher or creative developer must clone the repo, copy files into their own build, and manage versioning by hand. This is acceptable for early reference-implementation work but blocks the three things adoption actually depends on:

1. **Drop-in CDN usage.** A publisher should be able to add a single `<script>` tag with a pinned version and SRI hash and get a working SHARC container. No build step, no copy-paste, no version drift.
2. **npm installability.** Creative developers who build ads with Webpack, Vite, Rollup, or esbuild expect `npm install @iabtechlab/sharc` to give them a typed, tree-shakeable module.
3. **Versioned release discipline.** Once SHARC ships outside the repo, every release must have a stable identity, a signed hash, and a published changelog. The current "Unreleased" accumulation in `CHANGELOG.md` works for contributors but not for downstream integrators who need to pin a version.

This document defines the distribution pipeline so those three properties hold from v1.0.0 onward.

---

## 2. Constraints (Load-Bearing)

These are non-negotiable and any proposal must respect them. They come from `docs/architecture-overview.md`, `CLAUDE.md`, and the security model of the container.

1. **The creative SDK must stay under 5KB minified + gzipped.** This is a hard budget, not aspirational. Creatives are loaded inside ad slots where every byte competes with creative content.
2. **Zero runtime dependencies.** The reference implementation currently has zero `node_modules` requirements and must stay that way. Build-time devDependencies are fine; shipping dependencies are not.
3. **Structured Clone on the wire, never `JSON.stringify`.** No build-time or bundler transformation may reintroduce JSON serialization of the protocol.
4. **No new globals on `window`** except `window.SHARC`, the bridge-injected `window.mraid` / `window.$sf` / `window.MRAID_ENV`, and test-harness init callbacks. Build output must not pollute the global namespace with bundler runtime helpers or polyfills.
5. **Protocol breaks = MAJOR version bump**, regardless of whether JavaScript signatures change. This is stricter than standard semver: a release that is wire-incompatible with a previous release is MAJOR even if the public JS API is source-compatible. (See §9.)
6. **Security-critical loading.** SHARC is an ad container whose entire purpose is isolating untrusted creative content from publisher pages. A compromised CDN delivery of SHARC defeats the whole product. SRI is mandatory, not optional. (See §7.)

---

## 3. Package Identity

**Name:** `@iabtechlab/sharc` (scoped npm package under the IAB Tech Lab org)

**Rationale:**
- The scope signals institutional ownership, matching how IAB Tech Lab publishes other packages (e.g., `@iabtechlab/uid2-*`).
- An unscoped name like `sharc` would be a land-grab on a generic term and could be claimed or confused with other projects.
- The scope also enables later splitting into sibling packages (`@iabtechlab/sharc-cli`, `@iabtechlab/sharc-compliance`) without renaming the core.

**License field:** `Apache-2.0` (SPDX identifier, matches repo LICENSE).

**Repository field:** points at the canonical GitHub repo so npm, jsDelivr, and UNPKG all surface a valid link.

**Publisher:** the npm org `@iabtechlab` must be owned by the IAB Tech Lab organization account, with 2FA required for publish. Individual contributors publish via scoped tokens, not personal npm credentials.

---

## 4. Package Structure: Multiple Entry Points

SHARC is not a single library. It has at least four distinct consumer audiences, each with different size budgets and different load patterns:

| Consumer | What they import | Size budget | Load pattern |
|---|---|---|---|
| Publisher / SSP | Container | No hard budget (loaded once per page) | Page-level `<script>` or bundled into ad server JS |
| Creative developer | Creative SDK | **<5KB gzipped** | Loaded inside the ad creative itself, every byte counts |
| Legacy MRAID creative (via bridge) | MRAID bridge | ~3KB gzipped target | Injected by the container, not by the creative |
| Legacy SafeFrame creative (via bridge) | SafeFrame bridge | ~3KB gzipped target | Injected by the container |
| Verification vendor (via extension) | OMID bridge | ~2KB gzipped target | Registered as a container extension |

A single monolithic bundle that forces all consumers to load everything would blow the creative SDK budget. The solution is **one package with multiple entry points**, exposed via the modern `"exports"` field in `package.json`:

```json
{
  "name": "@iabtechlab/sharc",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/container/index.d.ts",
      "import": "./dist/container/index.esm.js",
      "require": "./dist/container/index.cjs",
      "browser": "./dist/container/index.umd.min.js",
      "default": "./dist/container/index.esm.js"
    },
    "./creative": {
      "types": "./dist/creative/index.d.ts",
      "import": "./dist/creative/index.esm.js",
      "require": "./dist/creative/index.cjs",
      "browser": "./dist/creative/index.umd.min.js",
      "default": "./dist/creative/index.esm.js"
    },
    "./bridges/mraid": { "...": "..." },
    "./bridges/safeframe": { "...": "..." },
    "./bridges/omid": { "...": "..." },
    "./package.json": "./package.json"
  },
  "files": ["dist/", "README.md", "LICENSE", "CHANGELOG.md"],
  "sideEffects": false
}
```

**Why one package instead of five:**
- Single version to pin (`@iabtechlab/sharc@1.0.0`), single changelog, single release cadence.
- Consumers only pay for what they import (`"sideEffects": false` + tree-shaking).
- Internal protocol constants can be shared at build time via the bundler without duplication.
- Easier for the IAB Tech Lab working group to govern one release artifact than five.

**Why multiple entry points instead of a single bundle:**
- Honors the 5KB creative SDK budget.
- Creative developers never accidentally pull in the container code, which is dead weight for them.
- Bridges can be loaded lazily by the container only when needed.

---

## 5. Bundle Formats

Each entry point ships three formats:

| Format | Filename suffix | Consumer |
|---|---|---|
| **ESM** | `*.esm.js` | Modern bundlers (Vite, Rollup, esbuild, Webpack 5+). Default for `import` resolution. |
| **CJS** | `*.cjs` | Node environments, older tooling, SSR. Required for `require()`. |
| **UMD (minified)** | `*.umd.min.js` | Direct `<script>` tag via CDN. Exposes `window.SHARC` (or `window.SHARCCreative`, etc., per entry point). |

**ESM is primary.** The `"module"` and `"import"` fields point at ESM. Modern bundlers resolve this by default and can tree-shake unused exports. This is the 2026 default for any new library.

**UMD is the legacy fallback** but is the format served from CDN URLs for direct `<script>` consumption, because that's what publishers and ad ops teams actually paste into ad servers. UMD bundles are always minified (`*.umd.min.js`) and always shipped with a `.map` source map alongside.

**TypeScript declarations (`*.d.ts`)** are generated for every entry point. Even though the reference implementation is plain JavaScript, declarations give downstream TypeScript consumers type safety and IDE autocomplete. Declarations are hand-authored or generated via JSDoc + `tsc --emitDeclarationOnly`.

**What we do NOT ship:**
- AMD. Dead format in 2026.
- SystemJS. Dead format in 2026.
- IIFE as a separate format — UMD already works as an IIFE when loaded via `<script>`.
- Unminified UMD. CDN consumers always want the minified version; source is available via the source map.

---

## 6. Build Toolchain

**Bundler:** [Rollup](https://rollupjs.org/) with the following plugin set:

| Plugin | Purpose |
|---|---|
| `@rollup/plugin-node-resolve` | Resolve internal module graph (not runtime deps — there are none). |
| `@rollup/plugin-terser` | Minify UMD output. |
| `@rollup/plugin-typescript` *(or)* `rollup-plugin-dts` | Emit `.d.ts` declarations from JSDoc. |
| `rollup-plugin-filesize` | Print gzipped size per bundle to stdout during build — immediate visibility on the 5KB creative SDK budget. |

**Why Rollup and not esbuild, Vite, or Webpack:**
- **Rollup** produces the cleanest library output. Minimal wrapper overhead, no bundler runtime helpers in ESM output, proper tree-shaking support. This is why it's the default for almost every modern JS library (Svelte, Vue core, Preact, D3, etc.).
- **esbuild** is faster but emits more wrapper code and has weaker tree-shaking for libraries. Good for apps; Rollup wins for libraries.
- **Vite** is a dev-server-plus-Rollup; for a pure library with no dev UI it's overkill.
- **Webpack** is for apps, not libraries. Its library output is historically poor (large runtime, inconsistent ESM interop).

**Build command:** `npm run build` → runs Rollup with a single config that produces all entry points and all formats in one pass. Output goes to `dist/`, which is `.gitignore`d.

**No watch mode in CI.** Local development still uses `node server.js` directly against source files in `examples/`. The build pipeline is only run at release time (locally by the release manager, and on CI for verification).

---

## 7. CDN Delivery

**Primary:** [jsDelivr](https://www.jsdelivr.com/) (`cdn.jsdelivr.net/npm/@iabtechlab/sharc@<version>/dist/...`)
**Secondary:** [UNPKG](https://unpkg.com/) (`unpkg.com/@iabtechlab/sharc@<version>/dist/...`)

Both are **free, npm-backed, and automatic** — publishing to npm automatically makes both CDNs serve the package, no separate setup required. jsDelivr is the primary recommendation because it uses a multi-CDN origin fallback (Cloudflare, Fastly, StackPath) and has better long-term reliability metrics than UNPKG's single-origin setup.

### 7.1 Canonical URLs

Every release documents its canonical URLs in `CHANGELOG.md` and on the GitHub release page. Example for v1.0.0:

```
https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/container/index.umd.min.js
https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/creative/index.umd.min.js
https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/bridges/mraid.umd.min.js
https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/bridges/safeframe.umd.min.js
https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/bridges/omid.umd.min.js
```

**Versioning rule:** production URLs MUST include an exact version. `@latest`, `@1`, and `@1.0` are forbidden in production guidance. The risk of a silent behavior change mid-campaign is too high. The CHANGELOG explicitly tells integrators: "Never use floating version tags in production ad servers."

### 7.2 Subresource Integrity (SRI)

**SRI is mandatory for SHARC.** An ad container whose delivery can be silently swapped by a CDN compromise is a security-fail by construction. Every published URL in the CHANGELOG and on the GitHub release page includes the SHA-384 integrity hash.

Canonical integration example for publishers:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/container/index.umd.min.js"
  integrity="sha384-<hash>"
  crossorigin="anonymous"></script>
```

**Hash generation:** the release pipeline generates SHA-384 hashes for every `*.umd.min.js` file via `openssl dgst -sha384 -binary <file> | openssl base64 -A` and writes them into a `SRI.md` file committed to the release tag, plus embedded in the CHANGELOG entry and the GitHub release body.

**Hash generation must happen after the final minification** (i.e., the hashed byte sequence must exactly match what the CDN serves). This means hash generation is the last step of the release pipeline, after `npm publish` but before the GitHub release is marked as published.

**SRI is NOT required for the ESM/CJS entry points** because those are consumed via bundlers that run their own integrity verification against `package-lock.json`. SRI only applies to CDN `<script>` loading.

### 7.3 Source Maps

Source maps (`*.map` files) are published alongside the minified UMD bundles. They are:
- **Public.** No secrets in SHARC source; there's no reason to withhold them.
- **Versioned identically** to the bundles. Source maps for `sharc@1.0.0/dist/creative/index.umd.min.js` live at `sharc@1.0.0/dist/creative/index.umd.min.js.map`.
- **Not SRI-hashed.** Source maps are loaded by devtools, not the runtime, and are not security-critical.

---

## 8. Size Budget Enforcement

The 5KB creative SDK budget is enforced by tooling, not by review discipline.

**Tool:** [`size-limit`](https://github.com/ai/size-limit) with a `.size-limit.json` config in the repo root:

```json
[
  {
    "name": "creative SDK (gzipped)",
    "path": "dist/creative/index.umd.min.js",
    "limit": "5 KB",
    "gzip": true
  },
  {
    "name": "MRAID bridge (gzipped)",
    "path": "dist/bridges/mraid.umd.min.js",
    "limit": "3 KB",
    "gzip": true
  },
  {
    "name": "SafeFrame bridge (gzipped)",
    "path": "dist/bridges/safeframe.umd.min.js",
    "limit": "3 KB",
    "gzip": true
  },
  {
    "name": "OMID bridge (gzipped)",
    "path": "dist/bridges/omid.umd.min.js",
    "limit": "2 KB",
    "gzip": true
  }
]
```

**Enforcement:** `npm run size` runs before every release. In CI (once CI exists), `size-limit` runs on every PR and fails the build if any bundle exceeds its limit. There is no container bundle budget because container size is less performance-critical and fluctuates naturally with feature additions.

**Budget changes** require a CHANGELOG entry explaining why, and are treated as architecture decisions (i.e., discussed in an issue before the PR that changes them). Raising the creative SDK budget is a warning sign that the SDK is absorbing complexity that should live in the container.

---

## 9. Semver Policy (Protocol vs Code)

SHARC semver is **stricter than standard semver** because the package versions two things simultaneously: the JavaScript API surface *and* the wire protocol. The rule:

| Change type | Version bump |
|---|---|
| Protocol break (wire incompatibility between container and creative versions) | **MAJOR** |
| Public JS API break (removes or changes signature of exported function) | **MAJOR** |
| New protocol message type (backwards compatible, old versions ignore it) | **MINOR** |
| New feature string / extension (opt-in via `hasFeature()`) | **MINOR** |
| New public JS API (additive) | **MINOR** |
| Bug fix that doesn't change wire behavior | **PATCH** |
| Bug fix that inadvertently changes wire behavior | **MAJOR** (yes, even if tiny) |
| Build toolchain change, doc-only change | **PATCH** |

**Why this is stricter than default semver:** a silent protocol change between a container version and a creative version breaks ads at runtime, in production, with no compile-time signal. Downstream integrators pin SHARC versions for exactly this reason. A patch bump that accidentally changes wire format is a betrayal of that pin — so we refuse to ship such changes as patches even if the signature-level API is unchanged.

**Practical consequence:** the release manager reviews every PR's diff against `sharc-protocol.js` specifically and asks "does this change a byte that goes on the wire?" If yes, it's MINOR at minimum and MAJOR if it's incompatible.

**CHANGELOG format:** Keep a Changelog, with an explicit `### Protocol` subsection under each release that lists any wire-level changes. Empty `### Protocol` sections are explicit (`*None.*`) to make it obvious the release is wire-compatible.

---

## 10. Release Pipeline

Releases are **locally driven by a release manager** (Jeffrey today; later, a designated committer) and verified by CI (once CI exists). The sequence:

1. **Pre-flight checks**
   - `git status` clean, on `main`, synced with `origin/main`
   - `CHANGELOG.md` has an `## [Unreleased]` section ready to promote
   - Current version in `package.json` matches the previous released tag

2. **Version bump**
   - Decide MAJOR / MINOR / PATCH per §9
   - Update `package.json` version
   - Promote `## [Unreleased]` → `## [X.Y.Z] — YYYY-MM-DD` in `CHANGELOG.md`
   - Add a fresh `## [Unreleased]` header at the top

3. **Build**
   - `npm run build` — produces `dist/` for all entry points
   - `npm run size` — verifies size budgets
   - `npm run test:harness` *(manual step until automated)* — drive the test harness against the built bundles, not the source files, to verify the build output behaves identically

4. **Publish to npm**
   - `npm publish --access public` (scoped packages default to private; `--access public` is required)
   - 2FA prompt on publish

5. **Generate SRI hashes**
   - Download the just-published files from jsDelivr (to match exactly what consumers get)
   - Generate SHA-384 hashes
   - Write to `SRI.md` in the release tag

6. **Tag and release**
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`
   - Create GitHub release with CHANGELOG entry + SRI hashes in the body

7. **Post-release**
   - Verify jsDelivr and UNPKG URLs resolve and serve expected content
   - Verify SRI hashes match what the CDN actually serves (paranoia check)
   - Announce on appropriate IAB Tech Lab channels

**This pipeline is documented in `docs/release-process.md`** (to be created separately; this document describes what the pipeline produces, not the step-by-step runbook).

---

## 11. Migration Path From Current Layout

The current `examples/sharc-*.js` files do not move. They remain the source of truth for the reference implementation. The build pipeline reads from `examples/` and writes to `dist/`. This means:

- **Contributors keep editing `examples/`.** Nothing about the day-to-day workflow changes.
- **`dist/` is `.gitignore`d.** Only `npm publish` sees it; it never enters git history.
- **The test harness still loads from `examples/`** for the development loop.
- **A separate verification step** (step 3 of §10 above) loads the test harness from `dist/` to confirm the build output matches source behavior before publishing.

**File mapping:**

| Source file | Package entry point | Output path |
|---|---|---|
| `examples/sharc-protocol.js` | *(internal, shared)* | Inlined into container, creative, and bridge bundles |
| `examples/sharc-container.js` | `@iabtechlab/sharc` | `dist/container/index.*` |
| `examples/sharc-creative.js` | `@iabtechlab/sharc/creative` | `dist/creative/index.*` |
| `examples/sharc-mraid-bridge.js` | `@iabtechlab/sharc/bridges/mraid` | `dist/bridges/mraid.*` |
| `examples/sharc-safeframe-bridge.js` | `@iabtechlab/sharc/bridges/safeframe` | `dist/bridges/safeframe.*` |
| `examples/sharc-omid-bridge.js` | `@iabtechlab/sharc/bridges/omid` | `dist/bridges/omid.*` |

`sharc-protocol.js` is not a consumer-facing entry point. It's the shared protocol core and is inlined into each bundle that needs it. Downstream code that wants to interact with the protocol directly does so through `@iabtechlab/sharc` (container) or `@iabtechlab/sharc/creative` (creative SDK), never by importing the protocol file alone.

---

## 12. Decisions Still Open

These are flagged for review by the agent panel and/or Jeffrey:

1. **Should `@iabtechlab` npm org be created now, or wait for IAB Tech Lab to formalize governance?** The org name is available on npm; the question is who owns the account and 2FA token. Blocks first publish.
2. **TypeScript declarations: hand-authored or JSDoc-generated?** JSDoc is cheaper to maintain but less expressive. Hand-authored `.d.ts` gives better developer experience but doubles the surface to keep in sync. Lean: start with JSDoc-generated, upgrade to hand-authored if consumer feedback demands it.
3. **Should the MRAID / SafeFrame bridges be *separate npm packages* (`@iabtechlab/sharc-mraid-bridge`, etc.) instead of entry points in the main package?** Argument for separate: cleaner ownership, lower blast radius on updates. Argument for bundled: single version, single changelog, simpler governance. Current recommendation: bundled (see §4), but this is reversible later.
4. **Should we publish an unscoped convenience alias (`sharc`) in addition to `@iabtechlab/sharc`?** npm permits it but IAB Tech Lab convention appears not to. Lean: no, scoped only.
5. **CI platform.** GitHub Actions is the default. Does IAB Tech Lab have an existing CI standard across `IABTechLab` org repos that we should follow?
6. **Size budget for the container.** Currently unbounded. Should we set a soft budget (e.g., 20KB gzipped) to prevent drift?

---

## 13. What This Document Does Not Cover

- **The release runbook itself** (`docs/release-process.md`) — step-by-step instructions for the release manager.
- **CI/CD pipeline configuration** — GitHub Actions workflows live in `.github/workflows/` once they exist.
- **Changelog automation** — whether to adopt `changesets`, `release-please`, or stay manual. Recommendation: stay manual for v1.0.0, revisit after 3 releases.
- **Deprecation policy** — when can we remove an API that's been marked deprecated? Needs its own discussion tied to the semver policy in §9.
- **Vulnerability disclosure** — where do we receive security reports, how are they triaged, and what is the embargo policy? This should live in a `SECURITY.md` at the repo root, not here.

---

## 14. Summary

**One package, four consumers, mandatory SRI, strict protocol-aware semver.**

- Publish `@iabtechlab/sharc` to npm with multiple entry points via `"exports"`.
- Ship ESM + CJS for bundler consumers; UMD minified for CDN `<script>` consumers; `.d.ts` for TypeScript.
- Build with Rollup + Terser; enforce the 5KB creative SDK budget with `size-limit`.
- Deliver via jsDelivr (primary) and UNPKG (secondary), both automatic from npm.
- Mandatory SRI on every CDN URL, documented in CHANGELOG + GitHub release.
- Protocol breaks are MAJOR version bumps even if the code API is unchanged.
- Contributors keep editing `examples/`; the build pipeline reads source from there and writes `dist/` at release time.

The approach the ChatGPT PDF proposed (npm + jsDelivr + UMD) is correct in the abstract but underspecifies the pieces that actually matter for a security-critical ad container: SRI, multi-entry-point structure, size-budget enforcement, and the protocol-aware semver policy. This document fills those gaps.
