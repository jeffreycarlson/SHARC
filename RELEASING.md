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

# 4. Push the commit and tag.
git push && git push --tags
```

## What gets auto-updated

`scripts/sync-version.js` (run by the `npm version` lifecycle hook) propagates the version to:

| File | What is updated |
|------|-----------------|
| `examples/sharc-protocol.js` | `SHARC_VERSION` constant + `@version` JSDoc |
| `examples/sharc-container.js` | `@version` JSDoc |
| `examples/sharc-creative.js` | `@version` JSDoc |
| `examples/sharc-mraid-bridge.js` | `@version` JSDoc |
| `examples/sharc-safeframe-bridge.js` | `@version` JSDoc |
| `examples/sharc-omid-bridge.js` | `@version` JSDoc |
| `README.md` | Version badge + CDN example URLs |
| `package.json` / `package-lock.json` | `version` field (via `npm version` itself) |

`SHARC_VERSION` in `sharc-protocol.js` is the canonical runtime constant — the container imports it and emits it in the `SHARC:Container:handshake` bootstrap message. The `@version` JSDoc tags are informational only.

## What still needs manual attention

- **`CHANGELOG.md`** — the `[Unreleased]` heading must be renamed to the new dated version heading before running `npm version`. The script does not touch the changelog.
- **Release notes** — if publishing a GitHub release, copy the relevant changelog section into the release body.

## Troubleshooting

If `npm version` fails mid-flight or you need to run the sync manually:

```bash
node scripts/sync-version.js   # reads package.json, propagates to all files listed above
npm run build                  # rebuild dist
```
