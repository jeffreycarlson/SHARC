# Releasing

This project follows [semver](https://semver.org/): MAJOR = protocol or public API break, MINOR = new feature (backwards-compatible), PATCH = fix.

## Cutting a release

```bash
# 1. Move the [Unreleased] section in CHANGELOG.md to a dated version heading.
#    Example: ## [Unreleased] → ## [0.5.1] — 2026-04-21

# 2. Bump the version. For 0.x releases, use `patch` for the next 0.x.y
#    release; `minor` jumps to the next 0.(x+1).0 line.
#    `npm version` runs scripts/sync-version.js via the
#    version lifecycle hook, which propagates the new version across source.
npm version <major|minor|patch>

# 3. Rebuild dist with the new version.
npm run build

# 4. Run the same gate used by CI/release before pushing.
npm run check:ci

# 5. Push the commit and tag.
git push && git push --tags
```

## What gets auto-updated

`scripts/sync-version.js` (run by the `npm version` lifecycle hook) propagates the version to:

This list is for verification after the bump; do not edit these entries manually unless the sync script fails and you are following the troubleshooting path below.

| File | What is updated |
|------|-----------------|
| `src/sharc-protocol.js` | `SHARC_VERSION` constant + `@version` JSDoc |
| `src/sharc-container.js` | `@version` JSDoc |
| `src/lifecycle-adapters/base-adapter.js` | `@version` JSDoc |
| `src/lifecycle-adapters/html-adapter.js` | `@version` JSDoc |
| `src/sharc-creative.js` | `@version` JSDoc |
| `src/sharc-mraid-bridge.js` | `@version` JSDoc |
| `src/sharc-safeframe-bridge.js` | `@version` JSDoc |
| `src/sharc-omid-bridge.js` | `@version` JSDoc |
| `src/sharc-omid-shim.js` | `@version` JSDoc |
| `src/sharc-navigation-bridge.js` | `@version` JSDoc |
| `src/sharc-protocol-router.js` | `@version` JSDoc |
| `README.md` | Version badge + CDN example URLs |
| `README.md` | Current package version marker |
| `SECURITY.md` | Current package version marker |
| `docs/current-status.md` | Current package version marker |
| `docs/api-reference.md` | Current package version marker |
| `docs/getting-started.md` | Current package version marker (registered after its marker silently froze at 0.7.3 while omitted from both the `sync-version.js` replacement table and the `version`-script `git add` list) |
| `package.json` / `package-lock.json` | `version` field (via `npm version` itself) |

`SHARC_VERSION` in `sharc-protocol.js` is the canonical runtime constant — the container imports it and emits it in the `SHARC:Container:handshake` bootstrap message. The `@version` JSDoc tags are informational only.

## Pre-1.0 semver caveat

For `0.x` releases, `npm version patch` produces the next patch version
(`0.7.8` to `0.7.9`), while `npm version minor` jumps to the next minor line
(`0.7.8` to `0.8.0`). Rename `[Unreleased]` to the dated release heading before
running `npm version`; the release workflow now hard-fails if that section is
missing. If you bump the wrong version before pushing, recover with
`git reset --hard HEAD~1 && git tag -d vX.Y.Z`, then rerun the correct
`npm version` command. This caveat comes from
`~/Obsidian/dev-team/sharc/feedback-semver-patch-for-prerelease.md`.

## What still needs manual attention

- **`CHANGELOG.md`** — the `[Unreleased]` heading must be renamed to the new dated version heading before running `npm version`. The script does not touch the changelog, and the release workflow blocks before npm publish if the matching section is missing.
- **Prose-embedded historical refs** — `sync-version.js` updates only the stable current-version markers. Before publishing, run `grep -nE "0\\.7\\.[0-9]+" SECURITY.md docs/*.md README.md CONTRIBUTING.md` and verify any remaining older versions are historical release references, not stale current-status prose. (The `[0-9]+` matches two-digit patches like `0.7.10`–`0.7.12`; a bare `[0-9]` misses them.)
- **Size-history snapshot** — after `npm run size:built` has measured the release candidate, commit a `docs/size-history/<version>.json` snapshot in the existing `{name,path,size,limit}` shape. `npm run size-history:check` compares the latest two snapshots and fails if a bundle grows more than 10% without a raised size limit documenting the decision.
- **Release notes** — if publishing a GitHub release, copy the relevant changelog section into the release body.

## npm publishing

Tagging `v*` triggers `.github/workflows/release.yml`, which first verifies that `CHANGELOG.md` has a section for the tag version, then runs `npm run check:ci` (version guard, production build, full dist-based test suite, consumer type check, bfcache, perf, size budgets, and strict tarball validation), then validates and hashes the exact tarball passed to `npm publish <tarball>` with provenance attestation. It then uploads `dist/` as a workflow artifact.

**Publishing is gated on the `NPM_TOKEN` repository secret.** When the secret is absent, the workflow emits a notice and skips the publish step cleanly — the rest of the pipeline still runs and the dist artifact is still uploaded.

### Adding `NPM_TOKEN`

Required before the first real npm publish. The token must come from an npmjs.org account with **Publish** rights on the `@iabtechlab` scope:

1. On npmjs.org: *Account → Access Tokens → Generate New Token → Classic Token (Automation)* (or a granular token scoped to `@iabtechlab/sharc` with read+write).
2. Add it to the repo:
   ```bash
   gh secret set NPM_TOKEN --repo jeffreycarlson/SHARC
   # paste the token when prompted
   ```
3. Re-run the release workflow for the current tag (or tag a new patch): `gh run rerun <run-id> --repo jeffreycarlson/SHARC`.

The token itself is never logged — only the resulting provenance attestation (public by design) appears in the workflow output. Rotate the token on a regular schedule, and revoke it immediately if it ever appears outside the repo's secrets UI.

## Troubleshooting

`npm run check:ci` tests the production bundle, not the development build. This
can make failures harder to debug because sourcemaps are absent, but it keeps
the release gate aligned with the artifact that is published. Reproduce locally
with `npm run build:prod && npm run test:all:built`, then switch to
`npm run build && npm run test:all:built` if you need sourcemaps to inspect a
failure.

If `npm version` fails mid-flight or you need to run the sync manually:

```bash
node scripts/sync-version.js   # reads package.json, propagates to all files listed above
npm run build                  # rebuild dist
```
