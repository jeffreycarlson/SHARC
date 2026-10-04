# Vendored: IAB Open Measurement JS Clients (test-only)

The minimal subset of IAB Tech Lab's **Open-Measurement-JSClients** that the
reference verification scripts need. It is used only by
`test/node/test-omid-iab-reference-clients.js`, the gate that runs IAB's own
`ValidationVerificationClient` and `ComplianceVerificationClient` against
SHARC's real OMID relay and `window.omid3p` shim. It is never bundled and never
shipped: `package.json` `files` publishes `dist/` only.

| | |
| --- | --- |
| Upstream | https://github.com/InteractiveAdvertisingBureau/Open-Measurement-JSClients |
| Commit | `ec408560bbbcb46c566253d117927b839c687034` ("Version 1.6.5") |
| License | Apache License 2.0, see `LICENSE` (copied verbatim from the upstream root) |
| Copyright | IAB Technology Laboratory, Inc. |

## What is here

Every file is a byte-for-byte copy of the upstream file at the commit above,
at the same relative path. Nothing is modified.

- `src/verification-client/verification-client.js`
- `src/validation-verification-script/validation-verification-client.js`
- `src/compliance-verification-script/compliance-verification-client.js`
- The `src/common/*.js` modules those three `goog.require` (transitive closure).
- `templates/version-js.template`. Upstream's build generates
  `omid.common.version` from this template and `version.txt` (`1.6.5`). The
  test loader performs that substitution in memory. No generated file is
  committed.

The test loads the files as `goog.module`s with a small in-test loader. It does
not run a Closure build.

## Upgrading

Copy the same paths from a new upstream commit, update the commit, version and
the template substitution in the test, then rerun
`npm run test:omid-iab-reference-clients`.
