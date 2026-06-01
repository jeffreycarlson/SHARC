# Releasing

This project follows [semver](https://semver.org/): MAJOR = protocol or public API break, MINOR = new feature (backwards-compatible), PATCH = fix.

## Cutting a release

```bash
# 1. Move the [Unreleased] section in CHANGELOG.md to a dated version heading.
#    Example: ## [Unreleased] → ## [0.5.1] — 2026-04-21

# 2. Bump the version. `npm version` runs scripts/sync-version.js via the
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
| `SECURITY.md` | Current package version marker |
| `docs/current-status.md` | Current package version marker |
| `docs/api-reference.md` | Current package version marker |
| `package.json` / `package-lock.json` | `version` field (via `npm version` itself) |

`SHARC_VERSION` in `sharc-protocol.js` is the canonical runtime constant — the container imports it and emits it in the `SHARC:Container:handshake` bootstrap message. The `@version` JSDoc tags are informational only.

## What still needs manual attention

- **`CHANGELOG.md`** — the `[Unreleased]` heading must be renamed to the new dated version heading before running `npm version`. The script does not touch the changelog.
- **Prose-embedded historical refs** — `sync-version.js` updates only the stable current-version markers. Before publishing, run `grep -nE "0\\.7\\.[0-9]" SECURITY.md docs/*.md` and verify any remaining older versions are historical release references, not stale current-status prose.
- **Release notes** — if publishing a GitHub release, copy the relevant changelog section into the release body.

## npm publishing

Tagging `v*` triggers `.github/workflows/release.yml`, which runs `npm run check:ci` (version guard, build, full dist-based test suite, consumer type check, bfcache, perf, size budgets, and strict tarball validation), then validates and hashes the exact tarball passed to `npm publish <tarball>` with provenance attestation. It then uploads `dist/` as a workflow artifact.

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

If `npm version` fails mid-flight or you need to run the sync manually:

```bash
node scripts/sync-version.js   # reads package.json, propagates to all files listed above
npm run build                  # rebuild dist
```
