# SHARC Distribution Design

**Status:** Current distribution guidance for the publishable package shape, with longer-term pipeline details below.
**Audience:** SHARC maintainers, IAB Tech Lab working group members, and integrators deciding how to consume SHARC artifacts.
**Scope:** How SHARC should be packaged, versioned, and referenced via npm or public CDN URLs.

SHARC now has a concrete package shape in `package.json` and `dist/`. This document keeps the longer-form distribution design, but the canonical public URL guidance should follow the package as it exists today.

## Canonical public entry points

SHARC should document and promote only these public artifact categories for now:

- **Container:** `@iabtechlab/sharc/sharc-container`
- **Creative API:** `@iabtechlab/sharc/sharc-creative`
- **Protocol:** `@iabtechlab/sharc/sharc-protocol`

For public CDN documentation, use URL patterns that map directly to the current package name, version, and `dist/` filenames:

- Container: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.5.0/dist/sharc-container.js`
- Creative API: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.5.0/dist/sharc-creative.js`
- Protocol: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.5.0/dist/sharc-protocol.js`

These examples are intentionally canonicalized around exact package artifacts, not around a specific CDN vendor. When SHARC is published, provider-specific examples can be added for jsDelivr, unpkg, or an official IAB Tech Lab host without changing the underlying pattern.

## Versioning guidance

- **Production:** pin an exact semver version such as `@1.2.3`
- **Dev or staging:** floating aliases such as `@1.2` or `@1` are acceptable when testing upcoming patch or minor updates
- **Avoid `latest`:** do not recommend `latest` for production, certification, or persistent staging environments

The same rule applies to npm imports and CDN URLs: production integrations should be reproducible and reviewable, while non-production environments may trade some stability for convenience.

## Bridge URL policy

Public CDN URL policy for bridge bundles is intentionally **deferred**. SHARC currently ships bridge artifacts in the package, but they should not yet be documented as canonical standalone public CDN entry points. For now, public URL guidance should stay focused on the container, creative API, and protocol artifacts only.

---

## 1. Why This Matters

SHARC today lives only as source files under `examples/`. To use them, a publisher or creative developer must clone the repo, copy files into their own build, and manage versioning by hand. This is acceptable for early reference-implementation work but blocks the three things adoption actually depends on:

1. **Drop-in CDN usage.** A publisher should be able to add a single `<script>` tag with a pinned version and SRI hash and get a working SHARC container. No build step, no copy-paste, no version drift.
2. **npm installability.** Creative developers who build ads with Webpack, Vite, Rollup, or esbuild expect `npm install @iabtechlab/sharc` to give them a typed, tree-shakeable module.
3. **Versioned release discipline.** Once SHARC ships outside the repo, every release must have a stable identity, a signed hash, and a published changelog. The current "Unreleased" accumulation in `CHANGELOG.md` works for contributors but not for downstream integrators who need to pin a version.

**Compliance context:** The MRAID 3.0 compatibility bridge currently passes the full `loadandevents` and `resize-negative` suites (the latter with 3 accepted spec divergences per ADR-PC-001/006 — container-owned close-button rendering rather than rejecting offscreen-close hints). `resize-positive` is **known-red** with 6 fails bucketed under issue #20 (resize timeout cascade in the vendor compliance ad — verdict `known-issue`, surfaced explicitly in the baseline as `suite.knownIssues[]` rather than buried in a fail tally). `viewability` is a Chart.js dashboard requiring visual review rather than machine assertions. The compliance baseline is captured in `test/browser/sharc-mraid3-baseline-*.json` and regenerated via `scripts/regen-mraid3-baseline.js`; the diff harness gate flags any new fail, any drift in the per-rule `expectedCount` for accepted divergences, and any drift in the `expectedFailCount` for known issues — so a regression, a partial fix, OR a positive change against the spec all surface immediately.

This document defines the distribution pipeline so those three properties hold from v1.0.0 onward.

---

## 2. Constraints (Load-Bearing)

These are non-negotiable and any proposal must respect them. They come from `docs/architecture-overview.md`, `CLAUDE.md`, and the security model of the container.

1. **The creative library must stay under 5KB minified + gzipped.** This is a hard budget, not aspirational. Creatives are loaded inside ad slots where every byte competes with creative content.
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
- One scoped package also means one 2FA surface, one publish token, and one review surface — better supply chain hygiene than splitting into five packages with five independent compromise paths.

**License field:** `Apache-2.0` (SPDX identifier, matches repo LICENSE).

**Repository field:** points at the canonical GitHub repo so npm, jsDelivr, and UNPKG all surface a valid link.

**Publisher:** the npm org `@iabtechlab` must be owned by the IAB Tech Lab organization account. Individual contributors do not publish directly — publishing happens via GitHub Actions OIDC (see §10), not from developer laptops.

**Access control:** Since publishing is CI-driven, the real threat surface is GitHub repo access, not npm org 2FA. Required protections:
- **GitHub:** Branch protection on `main`, tag protection for `v*` tags, hardware-backed 2FA (YubiKey/WebAuthn) for GitHub repo admins.
- **npm:** Hardware-backed 2FA on the `@iabtechlab` npm org as defense-in-depth. The primary publish path is OIDC (no long-lived npm token), but org admin access still needs 2FA.

### 3.1 Pre-Publish Governance Checklist

Before the first `npm publish`, the following IAB Tech Lab artifacts must exist:

- [ ] `@iabtechlab` npm org created and owned by the IAB Tech Lab organization account
- [ ] `SECURITY.md` with vulnerability disclosure address, PGP key, and embargo policy
- [ ] `CODEOWNERS` file with designated reviewers
- [ ] CLA or DCO requirement for external contributors
- [ ] Working group sign-off record for the v1.0.0 release
- [ ] Granular publish token provisioned as `NPM_TOKEN` GitHub secret

---

## 4. Package Structure: Multiple Entry Points

SHARC is not a single library. It has at least four distinct consumer audiences, each with different size budgets and different load patterns:

| Consumer | What they import | Size budget | Load pattern |
|---|---|---|---|
| Publisher / SSP | Container | No hard budget (loaded once per page) | Page-level `<script>` or bundled into ad server JS |
| Creative developer | Creative API | **<5KB gzipped** | Loaded inside the ad creative itself, every byte counts |
| Legacy MRAID creative (via bridge) | MRAID bridge | ~3KB gzipped target | Injected by the container, not by the creative |
| Legacy SafeFrame creative (via bridge) | SafeFrame bridge | ~3KB gzipped target | Injected by the container |
| Verification vendor (via extension) | OMID bridge | ~2KB gzipped target | Registered as a container extension |

A single monolithic bundle that forces all consumers to load everything would blow the creative library budget. The solution is **one package with multiple entry points**, exposed via the modern `"exports"` field in `package.json`:

```json
{
  "name": "@iabtechlab/sharc",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/container/index.d.ts",
      "import": "./dist/container/index.esm.js",
      "default": "./dist/container/index.esm.js"
    },
    "./creative": {
      "types": "./dist/creative/index.d.ts",
      "import": "./dist/creative/index.esm.js",
      "default": "./dist/creative/index.esm.js"
    },
    "./bridges/mraid": {
      "types": "./dist/bridges/mraid.d.ts",
      "import": "./dist/bridges/mraid.esm.js",
      "default": "./dist/bridges/mraid.esm.js"
    },
    "./bridges/safeframe": {
      "types": "./dist/bridges/safeframe.d.ts",
      "import": "./dist/bridges/safeframe.esm.js",
      "default": "./dist/bridges/safeframe.esm.js"
    },
    "./bridges/omid": {
      "types": "./dist/bridges/omid.d.ts",
      "import": "./dist/bridges/omid.esm.js",
      "default": "./dist/bridges/omid.esm.js"
    },
    "./package.json": "./package.json"
  },
  "typesVersions": {
    "*": {
      "creative": ["dist/creative/index.d.ts"],
      "bridges/mraid": ["dist/bridges/mraid.d.ts"],
      "bridges/safeframe": ["dist/bridges/safeframe.d.ts"],
      "bridges/omid": ["dist/bridges/omid.d.ts"]
    }
  },
  "unpkg": "dist/container/index.js",
  "files": ["dist/", "README.md", "LICENSE", "CHANGELOG.md"],
  "sideEffects": ["./dist/bridges/*.js", "./dist/bridges/*.esm.js"],
  "engines": { "node": ">=20.11.0" },
  "publishConfig": { "access": "public", "provenance": true }
}
```

**Key design decisions in this `package.json` shape:**

- **`"types"` is first in every `"exports"` condition, `"default"` is last.** Webpack 5 and TypeScript `moduleResolution: "bundler"` resolve conditions top-to-bottom; wrong order = misresolution.
- **`"typesVersions"` fallback** covers TypeScript users on `moduleResolution: "node"` (still common). Without it, subpath imports like `@iabtechlab/sharc/creative` show no autocomplete.
- **No `"require"` condition.** CJS is not shipped (see §5). A browser-focused ad container has no SSR story; ESM-in-Node has been stable since v14.13.
- **No top-level `"browser"` field.** Conflicts with `"exports"` conditional resolution in modern bundlers. The CDN IIFE bundles are separate artifacts, not package.json entry points.
- **`"sideEffects"` carve-out for bridges.** Bridges intentionally install `window.mraid` / `window.$sf` as side effects and must not be tree-shaken. Core and creative library remain `sideEffects`-free.
- **`"unpkg"` field** controls the default file UNPKG serves at the bare package URL.
- **`"publishConfig": { "provenance": true }`** ensures npm provenance attestation via GitHub Actions OIDC on every publish.
- **Webpack 4 is not supported.** Webpack 4 does not understand `"exports"` and will fail with `Module not found`. Webpack 4 users should load the IIFE bundle via `<script>` tag instead.

**Why one package instead of five:**
- Single version to pin (`@iabtechlab/sharc@1.0.0`), single changelog, single release cadence.
- Consumers only pay for what they import (tree-shaking + `"sideEffects"` carve-out).
- Internal protocol constants can be shared at build time via the bundler without duplication. With separate packages, the protocol would either be duplicated across five `dist/` trees (multiplying size) or require a sixth `@iabtechlab/sharc-protocol` package that reintroduces version-skew-at-install — exactly the failure mode protocol-aware semver exists to prevent.
- One 2FA surface, one publish token, one review surface — better supply chain hygiene.

**Why multiple entry points instead of a single bundle:**
- Honors the 5KB creative library budget.
- Creative developers never accidentally pull in the container code, which is dead weight for them.
- Bridges can be loaded lazily by the container only when needed.

---

## 5. Bundle Formats

Each entry point ships two formats:

| Format | Filename suffix | Consumer |
|---|---|---|
| **ESM** | `*.mjs` | Modern bundlers (Vite, Rollup, esbuild, Webpack 5+). Default for `import` resolution. |
| **IIFE** | `*.js` | Direct `<script>` tag via CDN. All modules (core + bridges). |

**ESM is primary.** The `"import"` fields in `"exports"` point at ESM. Modern bundlers resolve this by default and can tree-shake unused exports. This is the 2026 default for any new library.

**IIFE is the CDN format** for direct `<script>` consumption, because that's what publishers and ad ops teams paste into ad servers. IIFE bundles are always minified and always shipped with a `.map` source map alongside. IIFE is preferred over UMD because UMD's AMD/CJS detection branches are ~200 bytes of dead code for `<script>` consumers — at a 5KB budget that's meaningful waste.

| Entry point | IIFE global | Standalone CDN bundle? |
|---|---|---|
| Container | `window.SHARC` | Yes |
| Creative API | `window.SHARC` (same global; container and creative never co-exist in the same realm) | Yes |
| MRAID bridge | `window.mraid` (installed by container via `injectIntoMarkup`) | **No** — ESM only for container's internal consumption |
| SafeFrame bridge | `window.$sf` (installed by container via `injectIntoMarkup`) | **No** — ESM only |
| OMID bridge | `window.SHARC.extensions.omid` (namespaced under existing global) | **No** — registered as extension |

Bridges do not get standalone IIFE bundles. They are injected by the container into the creative iframe via `injectIntoMarkup` and run as inline scripts. This collapses the canonical CDN URLs from five to **two** (container + creative only) — a much simpler integration story.

**Browser targets:**

| Entry point | Target | Rationale |
|---|---|---|
| Creative API | `es2019` | Covers iOS Safari 12.2+, Android WebView 75+ — the floor for live ad inventory |
| Container | `es2020` | Publishers control update cadence; `es2020` enables optional chaining natively |

**TypeScript declarations (`*.d.ts`)** are generated for every entry point via JSDoc + `tsc --emitDeclarationOnly`. The reference implementation is plain JavaScript; JSDoc-generated declarations give downstream TypeScript consumers type safety and IDE autocomplete without the maintenance burden of hand-authored `.d.ts` files.

**What we do NOT ship:**
- **CJS.** A browser-focused ad container has no SSR story. ESM-in-Node has been stable since v14.13. Dropping CJS eliminates the dual-package hazard (two copies of protocol constants in the same process if a bundler resolves both ESM and CJS).
- **UMD.** Dead format for new libraries in 2026. IIFE gives the same `window.*` global with smaller output.
- **AMD / SystemJS.** Dead formats in 2026.
- **Unminified IIFE.** CDN consumers always want the minified version; source is available via the source map.

---

## 6. Build Toolchain

**Bundler:** [Rollup](https://rollupjs.org/) 4 with the following plugin set:

| Plugin | Purpose |
|---|---|
| `@rollup/plugin-node-resolve` | Resolve internal module graph (not runtime deps — there are none). |
| `@rollup/plugin-commonjs` | Handle `module.exports` UMD pattern in `sharc-protocol.js` source. |
| `@rollup/plugin-terser` | Minify IIFE output. |
| `@rollup/plugin-replace` | Build-time `__VERSION__` injection so bundles report their own version at runtime. |
| `rollup-plugin-filesize` | Print gzipped + brotli size per bundle to stdout during build — immediate visibility on the 5KB creative library budget. |

**TypeScript declarations** are generated outside Rollup via `tsc --emitDeclarationOnly` as a separate npm script (`npm run types`). This reads JSDoc annotations from the source files and emits `.d.ts` to `dist/`. Running `tsc` outside Rollup avoids conflating compilation with declaration generation.

**Why Rollup and not esbuild, Vite, or Webpack:**
- **Rollup** produces the cleanest library output. Zero runtime helpers in ESM mode, minimal wrapping in IIFE mode. esbuild always emits a helper preamble (`__defProp`, `__name`, etc.) that costs 300–800 bytes — at a 5KB budget that's 6–16% burned on bundler scaffolding.
- **esbuild** is faster but emits more wrapper code and has weaker tree-shaking for libraries. Good for apps; Rollup wins for libraries.
- **Vite** is a dev-server-plus-Rollup; for a pure library with no dev UI it's overkill.
- **Webpack** is for apps, not libraries. Its library output is historically poor (large runtime, inconsistent ESM interop).

**Build config:** `rollup.config.js` exports an array of configs (one per entry point). All modules (core + bridges) produce both `[esm, iife]` output. Build time is ~3 seconds.

**Build command:** `npm run build` runs Rollup. Output goes to `dist/` (`.js` for IIFE, `.mjs` for ESM).

**Version propagation:** `npm version <major|minor|patch>` triggers `scripts/sync-version.js`, which propagates the version from `package.json` to `SHARC_VERSION` in protocol, `@version` JSDoc tags, and README badge/CDN URLs.

**Build-time assertions (to be enforced by `npm run build` once that command exists):**
- **No `JSON.stringify` in output.** A grep assertion verifies that `JSON.stringify` does not appear in any `dist/*.js` file — protects the Structured Clone invariant through the build pipeline.
- **Protocol contract snapshot.** A deterministic JSON dump of `ProtocolMessages`, `ContainerMessages`, `CreativeMessages`, state-machine transitions, and message-arg schemas is generated to `dist-meta/protocol-contract.json`. CI diffs this against the previous release tag; any change blocks merge unless the PR title starts with `protocol:` and the CHANGELOG `### Protocol` section is non-empty. This enforces §9's semver rules via tooling, not discipline.
- **Tree-shake smoke test** (`npm run test:treeshake`): imports only `@iabtechlab/sharc/creative` into a fixture, bundles with esbuild, and asserts the output contains zero strings from `sharc-container.js`.

**No watch mode in CI.** Local development still uses `node server.js` directly against source files in `examples/`. The build pipeline is only run at release time and on CI for every PR.

---

## 7. CDN Delivery

**Recommended:** [jsDelivr](https://www.jsdelivr.com/) (`cdn.jsdelivr.net/npm/@iabtechlab/sharc@<version>/dist/...`)
**Alternate origin:** [UNPKG](https://unpkg.com/) (`unpkg.com/@iabtechlab/sharc@<version>/dist/...`)

Both are **free, npm-backed, and automatic** — publishing to npm automatically makes both CDNs serve the package, no separate setup required. jsDelivr is the recommended default because it uses a multi-CDN origin fallback (Cloudflare, Fastly, StackPath) and has better long-term reliability metrics than UNPKG's single-origin setup.

**CDN choice is an integration-time decision, not a runtime failover.** jsDelivr and UNPKG normalize and compress payload bytes differently, so a single SHA-384 hash cannot match both. Publishers pick one CDN and pin its SRI hash. UNPKG is documented as "alternate origin requiring re-pinning a different SRI hash from `SRI.md`." There is no runtime failover `<script onerror>` pattern — it's impossible to implement correctly with SRI.

**Break-glass mirror:** Each release's `dist/` tree is also uploaded as a GitHub Release asset, providing a known-good byte source the maintainers control even if both CDNs go sideways.

### 7.1 Canonical URLs

Every release documents its canonical URLs in `CHANGELOG.md` and on the GitHub release page. With bridges not shipped as standalone CDN artifacts (see §5), only two URLs are canonical:

```
https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/sharc-container.js
https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/sharc-creative.js
```

**Versioning rule:** production URLs MUST include an exact version. `@latest`, `@1`, and `@1.0` are forbidden in production guidance. The risk of a silent behavior change mid-campaign is too high. The CHANGELOG explicitly tells integrators: "Never use floating version tags in production ad servers."

### 7.2 Subresource Integrity (SRI)

**SRI is mandatory for SHARC.** An ad container whose delivery can be silently swapped by a CDN compromise is a security-fail by construction. Every published URL in the CHANGELOG and on the GitHub release page includes the SHA-384 integrity hash.

Canonical integration example for publishers:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@1.0.0/dist/sharc-container.js"
  integrity="sha384-<hash>"
  crossorigin="anonymous"></script>
```

**Hash generation:** the release pipeline generates SHA-384 hashes for every `*.js` file from the **local `dist/` build artifact** via `openssl dgst -sha384 -binary <file> | openssl base64 -A`. Hashes are written to `release/<version>/SRI.md` (one file per CDN origin, since compression differs), committed to the release tag, and embedded in the CHANGELOG entry and GitHub release body.

**Hash generation happens BEFORE `npm publish`** — this is critical. Generating hashes from CDN-served bytes (the previous draft's approach) has two flaws: (1) it races CDN propagation delay (5–30 minutes, occasionally hours), and (2) if npm publish is compromised, the hash faithfully describes the malicious bytes. Generating from the local `dist/` establishes the hash as an assertion of what was built, not a transcription of what was shipped.

**Post-publish verification:** After `npm publish`, the release pipeline downloads the files from both jsDelivr and UNPKG and verifies byte-for-byte equality against the local `dist/` artifacts. Mismatch = `npm unpublish` within 72h and incident response.

**SRI is NOT required for the ESM entry points** because those are consumed via bundlers that run their own integrity verification against `package-lock.json`. SRI only applies to CDN `<script>` loading.

### 7.3 SRI Monitoring

A GitHub Actions cron job (`.github/workflows/sri-monitor.yml`, `*/15 * * * *`) continuously verifies CDN integrity:

1. Downloads both CDN URLs for the latest published version
2. Computes SHA-384 hashes
3. Compares against `release/<version>/SRI.md`
4. On divergence, opens a GitHub issue labeled `incident:sri-mismatch`

This provides a ~15-minute MTTD for CDN integrity failures, vs. the previous "until a publisher emails us" posture.

### 7.4 Source Maps

Source maps (`*.map` files) are published alongside the minified IIFE bundles. They are:
- **Public.** No secrets in SHARC source; there's no reason to withhold them.
- **Versioned identically** to the bundles. Source maps for `sharc@1.0.0/dist/sharc-container.js` live at `sharc@1.0.0/dist/sharc-container.js.map`.
- **Absolute paths stripped.** Rollup `sourcemapPathTransform` removes build-machine paths from the `sources` array.
- **Not SRI-hashed.** Source maps are loaded by devtools, not the runtime, and are not security-critical.

---

## 8. Size Budget Enforcement

The 5KB creative library budget is enforced by tooling, not by review discipline.

**Tool:** [`size-limit`](https://github.com/ai/size-limit) with the `@size-limit/preset-small-lib` preset (the idiomatic form for library size tracking in 2026). Config in `.size-limit.json`:

```json
[
  {
    "name": "creative library",
    "path": "dist/creative/index.js",
    "limit": "5 KB"
  },
  {
    "name": "container",
    "path": "dist/container/index.js",
    "limit": "25 KB"
  },
  {
    "name": "MRAID bridge",
    "path": "dist/bridges/mraid.esm.js",
    "limit": "3 KB"
  },
  {
    "name": "SafeFrame bridge",
    "path": "dist/bridges/safeframe.esm.js",
    "limit": "3 KB"
  },
  {
    "name": "OMID bridge",
    "path": "dist/bridges/omid.esm.js",
    "limit": "2 KB"
  }
]
```

Budgets are gzipped (the default for `@size-limit/preset-small-lib`). For reference, jsDelivr serves brotli, which gives ~18% headroom: `5KB gzipped ≈ 4.2KB brotli`.

**Enforcement:** `npm run size` runs before every release. In CI, `size-limit` runs on every PR and fails the build if any bundle exceeds its limit.

**Container budget (25KB gzipped, soft).** Set now to prevent silent bloat. The container is less size-critical than the creative library, but unbounded budgets drift. Exceeding 25KB triggers review; exceeding 40KB (hard cap) fails the build.

**Budget changes** require a CHANGELOG entry explaining why, and are treated as architecture decisions (i.e., discussed in an issue before the PR that changes them). Raising the creative library budget is a warning sign that the library is absorbing complexity that should live in the container.

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

**Target state:** releases should be CI-driven via GitHub Actions (`.github/workflows/release.yml`), triggered by pushing a `v*` tag. The release manager prepares the release locally, but `npm publish` should happen in CI with OIDC provenance attestation, never from a developer's laptop.

**Current blocker:** the workflow can be scaffolded now, but it is intentionally blocked until `package.json`, `package-lock.json`, `tsconfig.json`, the ESM refactor, and the protocol-contract snapshot/diff tooling exist. Until those land, SHARC does not have a functioning publish pipeline.

**Pre-release channel:** `@iabtechlab/sharc@1.0.0-rc.1` (semver pre-release tags) lets the working group and design-partner publishers pressure-test the package surface before committing to a stable version. RC publishes follow the same pipeline with `--tag next` instead of `--tag latest`.

The sequence:

0. **Verify `package.json` exists and is correct**
   - `name`, `version`, `type: "module"`, `exports`, `typesVersions`, `files`, `engines`, `publishConfig`, `sideEffects`, `repository`, `license` — all per §4
   - `devDependencies` pinned to exact versions (not `^`); `package-lock.json` committed

1. **Pre-flight checks**
   - `git status` clean, on `main`, synced with `origin/main`
   - `CHANGELOG.md` has an `## [Unreleased]` section ready to promote
   - Current version in `package.json` matches the previous released tag

2. **Version bump**
   - Decide MAJOR / MINOR / PATCH per §9
   - Update `package.json` version
   - Promote `## [Unreleased]` → `## [X.Y.Z] — YYYY-MM-DD` in `CHANGELOG.md`
   - Add a fresh `## [Unreleased]` header at the top
   - Verify `### Protocol` section is present (empty = `*None.*`; non-empty if protocol changed)

3. **Build + verify**
   - `npm run build` — produces `dist/` for all entry points
   - `npm run size` — verifies size budgets
   - `npm run test:treeshake` — verifies creative library doesn't pull in container code
   - Build-time assertions pass (no `JSON.stringify` in output, protocol contract snapshot stable or explicitly changed)
   - `npm pack --dry-run` — inspect tarball contents; verify no `.env`, sessions, or local artifacts
   - **As of 2026-04-15 this step is not yet runnable in-repo** because the package/build toolchain has not been created.

4. **Generate SRI hashes (BEFORE publish)**
   - `openssl dgst -sha384 -binary <dist-file> | openssl base64 -A` for every `*.js`
   - Write to `release/<version>/SRI.md` (separate hashes per CDN will be added post-verification)
   - Commit `SRI.md` to the release branch

5. **Tag, push, and let CI publish**
   - `git tag -s vX.Y.Z` (PGP-signed tag)
   - `git push origin vX.Y.Z`
   - GitHub Actions `release.yml` should trigger: same build, then `npm publish --provenance --access public` using `NODE_AUTH_TOKEN` from GitHub secrets plus GitHub OIDC (`permissions: { id-token: write, contents: write }` in practice; `id-token: write` is the attestation-critical permission).
   - If the workflow exists before the build prerequisites land, it should fail fast with a clear prerequisite error rather than pretending publish support is live.

6. **Post-publish verification**
   - Download from both jsDelivr and UNPKG (after propagation; CI retries with backoff)
   - Verify byte-for-byte equality against local `dist/` artifacts
   - Compute SHA-384 of CDN-served bytes; verify they match `release/<version>/SRI.md`
   - **Mismatch = incident:** `npm unpublish` within 72h, `npm deprecate` immediately, alert maintainers
   - Upload `dist/` tree as GitHub Release assets (break-glass mirror)

7. **Create GitHub release**
   - CHANGELOG entry + SRI hashes in the body
   - CycloneDX SBOM attached (trivial with zero deps, but expected for supply chain compliance)
   - Link to npm provenance attestation

8. **Post-release**
   - Verify SRI monitoring cron (§7.3) picks up the new version
   - Update `LAST_KNOWN_GOOD.md` with the new version
   - Announce on appropriate IAB Tech Lab channels

**Rollback discipline:** Patch revert within 24h of confirmed regression. `npm deprecate "<bad>" "regression in X; use <good>"` within 4h of confirmation. `LAST_KNOWN_GOOD.md` updated immediately.

**Release cadence:** Patch releases as needed (no minimum cadence). Minor releases batched monthly maximum. Major releases require 30-day RFC window.

**This pipeline is documented in `docs/release-process.md`** (to be created separately; this document describes what the pipeline produces, not the step-by-step runbook). The release-process doc must also include the incident response runbook for a compromised release: who declares, how to unpublish, how to notify downstream, how to coordinate CDN cache purge, and how to issue a CVE.

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

`sharc-protocol.js` is not a consumer-facing entry point. It's the shared protocol core and is inlined into each bundle that needs it. Downstream code that wants to interact with the protocol directly does so through `@iabtechlab/sharc` (container) or `@iabtechlab/sharc/creative` (creative API), never by importing the protocol file alone.

### 11.1 Source Prerequisites (gate for Rollup)

The current source files use a CJS/browser-global wrapper (two-branch IIFE with `module.exports` / `window.*` branches). This is **not** true ESM and cannot be consumed by Rollup's ESM input mode as-is. `@rollup/plugin-commonjs` also won't work because the `module.exports` assignment is inside the IIFE, not at the top level.

**Before the build pipeline can be wired up, the source files must be refactored to true ESM.** This means:

1. Replace the CJS/browser-global wrapper IIFE in each `examples/sharc-*.js` with standard `export` / `import` statements.
2. The test harness must be updated to load ESM source (either via `<script type="module">` or a shim for the dev server).
3. The test harness `?build=dist` mode switch (for verifying built output) should be added at the same time.

This is a code change, not a doc change. It is tracked as a v1.0.0 prerequisite and must land before `rollup.config.js` can be created.

---

## 12. Decisions Closed and Remaining

### Closed (settled by review panel, do not re-litigate)

| # | Decision | Outcome | Source |
|---|---|---|---|
| 2 | TypeScript declarations | JSDoc-generated `.d.ts` (not hand-authored) | SA, FD, PM |
| 3 | Bridges: separate packages or bundled? | Bundled — one package with multi-entry `"exports"`. Splitting later breaks every integrator's import path and 5x's the token-management burden. | Unanimous |
| 4 | Unscoped alias (`sharc`)? | No. Scoped only (`@iabtechlab/sharc`). | SA, PM |
| 5 | CI platform | GitHub Actions | DevOps, Security |
| 6 | Container size budget | 25KB gzipped soft / 40KB hard (see §8) | SRE, SA |
| — | Bundle formats | ESM + IIFE. Drop CJS. | SA, FD |
| — | CDN format | IIFE, not UMD | SA, FD |
| — | `"sideEffects"` | Carve-out for bridges | SA, FD, DevOps |
| — | npm `--provenance` | Mandatory via GitHub Actions OIDC | Security, DevOps, FD |
| — | SRI hash ordering | Generate from local `dist/` before publish | Security, DevOps |
| — | CDN failover | Integration-time choice, not runtime | SRE |
| — | Browser target | `es2019` creative API, `es2020` container | FD |

### Still open (requires Jeffrey / IAB Tech Lab input)

1. **Who owns `@iabtechlab` on npm today?** Hard blocker for first publish. If the answer is "nobody yet," the realistic first-publish date is months out and this doc should say so. (See §3.1 governance checklist.)
2. **Is there a charter buyer or design-partner publisher willing to integrate against an RC build before 1.0?** Without one, §1's adoption framing is unfalsifiable.
3. **CLA or DCO requirement for external contributors?** IAB Tech Lab may have an existing policy; needs confirmation.

---

## 13. v1.0.0-Blocker Artifacts

All of the following must exist before first publish. They are tracked as separate issues/PRs but listed here for completeness:

| Artifact | Owner | Purpose |
|---|---|---|
| `SECURITY.md` | Security Engineer | Vulnerability disclosure address, PGP key, embargo policy, response SLA |
| `SUPPORT.md` | SRE | Support intake, triage SLA, required diagnostic fields |
| `LAST_KNOWN_GOOD.md` | Release manager | Pinned known-good version, updated as final release step |
| `.github/ISSUE_TEMPLATE/bug-production-incident.yml` | SRE | Required fields: SHARC version, browser/UA, container/creative side, integration mode, CDN URL + observed SRI, minimal repro, business-impact tier |
| `release/<version>/SRI.md` | Release pipeline | Per-release, per-CDN SRI hashes |
| `INTEGRATION.md` | Frontend Developer | Canonical copy-paste block per consumer type (publisher CDN, creative ESM, legacy MRAID, legacy SafeFrame) |
| `docs/release-process.md` | DevOps + Security | Step-by-step runbook including rollback and incident response |
| `.github/workflows/ci.yml` | DevOps | Build + size + treeshake + pack-dry-run on every PR |
| `.github/workflows/release.yml` | DevOps | Tag-triggered publish scaffold with `--provenance`. **Exists only as guarded scaffolding until the package/build prerequisites land. Must include `id-token: write`; attestation does not work correctly without it.** |
| `.github/workflows/sri-monitor.yml` | SRE | `*/15 * * * *` cron for CDN integrity verification |
| `package.json` | DevOps | Still missing. Required for the §4 package shape and step 0 of §10 |
| `tsconfig.json` | DevOps | Still missing. Required for `tsc --emitDeclarationOnly` to generate `.d.ts` from JSDoc |
| `dist-meta/protocol-contract.json` generator | Software Architect | Still missing. Required to dump protocol constants deterministically for CI diffing (see §6) |
| Source ESM refactor | Senior Developer | Still missing. Current CJS/browser-global wrappers must become true ESM before Rollup works (see §11.1) |

## 14. What This Document Does Not Cover

- **The release runbook itself** (`docs/release-process.md`) — step-by-step instructions for the release manager.
- **CI/CD pipeline configuration details** — GitHub Actions workflows live in `.github/workflows/` once they exist.
- **Changelog automation** — whether to adopt `changesets`, `release-please`, or stay manual. Recommendation: stay manual for v1.0.0, revisit after 3 releases.
- **Deprecation policy** — when can we remove an API that's been marked deprecated? Needs its own discussion tied to the semver policy in §9.
- **React/Vue wrapper packages** — future work, not v1. Creative developers will ask; note it as "planned."
- **Stackblitz/CodeSandbox starter template** — critical for adoption (ad creative devs won't clone the repo), but not a publish blocker. First post-1.0.0 DX priority.

---

## 15. Public Service Levels

SHARC is an open-source reference implementation, not a hosted service. The project commits to the following service levels and explicitly declines others:

| Commitment | Target | Measurement |
|---|---|---|
| Wire-protocol stability in PATCH releases | 100% (zero regressions) | Audited per §9; any regression triggers immediate patch revert |
| Security advisory acknowledgement | < 24 hours from confirmed report | GitHub Security Advisory timestamp |
| Security fix or documented mitigation | < 7 days from confirmation | GitHub Security Advisory resolution |
| Production-incident issue triage | < 2 business days, best-effort | GitHub issue first-response timestamp |
| Regression rollback (deprecate + LKG update) | < 24 hours from confirmation | `npm deprecate` timestamp |

**Explicitly not committed:** CDN availability, response latency, geographic reach. These are inherited from jsDelivr and UNPKG and are outside the project's operational control. Integrators requiring contractual availability should self-host the published artifacts behind their own CDN and pin SRI accordingly.

---

## 16. Summary

**Target end state: one package, four consumers, mandatory SRI, CI-driven provenance, strict protocol-aware semver.**

- Publish `@iabtechlab/sharc` to npm with multiple entry points via `"exports"`.
- Ship ESM for bundler consumers, IIFE minified for CDN `<script>` consumers (container + creative only), and `.d.ts` for TypeScript via JSDoc.
- Build with Rollup 4 + Terser, and enforce the 5KB creative library budget and 25KB container budget with `size-limit`.
- Deliver via jsDelivr (recommended) or UNPKG (alternate); CDN choice is integration-time, not runtime.
- Require SRI on every CDN URL, generated from local `dist/` before publish, verified against CDN after, with continuous integrity monitoring via GitHub Actions cron.
- Publish only from GitHub Actions OIDC with `--provenance`, never from a laptop.
- Treat protocol breaks as MAJOR version bumps even if the code API is unchanged, enforced by CI via protocol contract snapshot diffing.
- Keep contributors editing `examples/`, with the future build pipeline reading from there and writing `dist/` at release time.
- **Current blockers still outside this task:** the ESM refactor, `package.json`, `tsconfig.json`, and the `dist-meta/protocol-contract.json` generator / CI diff script.