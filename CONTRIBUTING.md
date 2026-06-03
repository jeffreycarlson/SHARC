# How to contribute

We'd love to accept your patches and contributions to SHARC. There are just a few guidelines to follow.

## Before you start

- Read `docs/architecture-overview.md` for orientation to the reference implementation layout, load-bearing invariants, and the test harness.
- Check `docs/architecture-design.md` and `docs/api-reference.md` — these are the authoritative design and wire-protocol references.
- Skim `CHANGELOG.md` to see recent changes and the semver policy (MAJOR = protocol or public API break).

## Submitting a patch

1. **Open an issue first.** Even for small changes, it's helpful to know what people are working on. Mention that you plan to work on it so it can be assigned to you. For protocol or public API changes, please discuss the design in an issue *before* opening a PR.

2. **Fork and branch.** Follow the normal [forking](https://help.github.com/articles/fork-a-repo) workflow. Keep each group of changes on a separate branch so that a pull request only includes commits related to that bug or feature.

3. **Verify in the test harness.** There is no automated test runner. Run `node server.cjs` and drive the relevant harness page (`test/browser/index.html`, `test/browser/mraid-test.html`, `test/browser/safeframe-test.html`, or `test/browser/mraid-3-compliance-runner.html`) to exercise your change. Read the protocol trace in the log pane to confirm correct behavior. For bug fixes, add or extend a scenario in the relevant harness when feasible.

4. **License header.** All contributions must be licensed under Apache 2.0. New source files under `src/`, `examples/`, or `test/` should carry an SPDX license identifier (`// SPDX-License-Identifier: Apache-2.0`) at the top.

5. **Follow the repo conventions.** Don't regress the invariants called out in `docs/architecture-overview.md` — notably: `MessageChannel` transport, Structured Clone serialization (no `JSON.stringify` on the wire), sandbox flag discipline (no `allow-same-origin`), and preferring a feature string + extension over core protocol changes.

6. **Write well-formed commit messages.** This project uses [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. A short subject line plus a body explaining the *why*. See recent `git log` for examples.

7. **Update the changelog.** Add an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog format) describing the externally visible change. PRs that change behavior without a changelog entry will be asked to add one.

8. **Push and open a pull request.** Link the PR to the originating issue.

## Branch protection and required checks

The `main` branch is protected:

- Required check: `Build, Size, and Pack Test`
- Required status checks must be up to date before merge
- Required linear history, matching the project's squash/rebase merge style

Required checks shall not be disabled or renamed without an explicit governance
decision. The local CI parity guard is an accidental-drift defense: it catches
cases where `test:all:built` and the workflow step list diverge unintentionally.
Intentional workflow bypasses are handled by PR review today and by GitHub
branch protection as SHARC moves toward multi-maintainer governance. See the
[parity-guard threat-model comment](./scripts/check-ci-test-all-built-parity.js#L2-L24)
and [PR #300](https://github.com/jeffreycarlson/SHARC/pull/300) for the
empirical review context.

## Releasing

Maintainers: see [`RELEASING.md`](./RELEASING.md) for the version bump and publish workflow.

## Questions

For questions about IAB Tech Lab governance or how to get involved with the working group, email [support@iabtechlab.com](mailto:support@iabtechlab.com).
