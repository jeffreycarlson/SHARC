# Vendored OM SDK Web binaries (private, gitignored)

The creative validator's OMID harness runs the **real, pinned** OM SDK for Web
instead of a mock (#244 / #211A, design:
`0.7.11 #244 omweb service integration`, D6). The binaries live under
`tools/creative-validator/private/vendor/` — that path is **gitignored** (the
whole `private/` tree is). Only this manifest is committed. Per the #244
ratification the binaries must never ride into a public IAB push or the npm
tarball; production operators supply their own OM SDK URLs (0.7.3 D10).

## Pinned artifacts

| File | Version | SHA-256 | Size |
| --- | --- | --- | --- |
| `private/vendor/omweb-v1.js` | `1.5.2-google27` (embedded version string) | `52d26e14225a6ca8e783f4b2115863bd90470e2b43e739865c309cd0d91c22a1` | 45,746 B |
| `private/vendor/omid-session-client-v1.js` | `1.6.6-iab457` (embedded; npm package `1.6.6`) | `898e013362d2345b6fc0b79802c3fc39a84fc8d4ff217d12f9180ec79278da0c` | 75,341 B |

The SHA-256 is the pin. A re-fetch that does not match the recorded hash is an
**upgrade**, not a refresh: bump the version/hash here and rerun the full
private corpus (the corpus is the conformance suite — design D6, "upgrade =
bump + corpus rerun").

## Sources (fetched 2026-06-11)

- **`omweb-v1.js`** (OM SDK Service Script for Web):
  `https://pagead2.googlesyndication.com/omsdk/releases/live/omweb-v1.js`.
  `live` is a moving pointer maintained by Google for its OM SDK Web
  integrations; the hash above pins the exact build we validated. IAB Tech Lab
  distributes the service script through its Tools Portal for integrators to
  self-host; there is no IAB-published immutable public URL.
- **`omid-session-client-v1.js`** (OM SDK JS Session Client):
  npm package `@iabtechlab-omsdk/open-measurement@1.6.6`
  (`https://registry.npmjs.org/@iabtechlab-omsdk/open-measurement/-/open-measurement-1.6.6.tgz`,
  path `package/omsdk-js/Session-Client/omid-session-client-v1.js`) — IAB Tech
  Lab's official npm distribution of the OM SDK JS clients.

Version skew note: service `1.5.2` + session client `1.6.6` is the pinned pair
the corpus run validated. Treat the two files as one unit when upgrading.

## License

- **Session client:** Apache License 2.0 (LICENSE shipped in the npm package;
  copied alongside the binary as `private/vendor/SESSION-CLIENT-LICENSE`).
  Private CI use and local copies are clearly permitted.
- **Service script:** distributed by IAB Tech Lab under its OM SDK
  license/onboarding terms (portal-gated agreement); IAB's integration
  documentation directs integrators to host the file on their own CDN, and the
  copy above is publicly served by Google for the same purpose. Our use is a
  private, non-redistributed, gitignored CI fixture — within that distribution
  posture. The binary is never committed, never published, and never pushed to
  the public IAB tree.

## Restoring the fixtures on a fresh checkout

```bash
mkdir -p tools/creative-validator/private/vendor
curl -s -o tools/creative-validator/private/vendor/omweb-v1.js \
  'https://pagead2.googlesyndication.com/omsdk/releases/live/omweb-v1.js'
curl -sL 'https://registry.npmjs.org/@iabtechlab-omsdk/open-measurement/-/open-measurement-1.6.6.tgz' \
  | tar -xz -C /tmp package/omsdk-js/Session-Client/omid-session-client-v1.js
cp /tmp/package/omsdk-js/Session-Client/omid-session-client-v1.js \
  tools/creative-validator/private/vendor/
shasum -a 256 tools/creative-validator/private/vendor/*.js  # must match the table above
```

If the `omweb-v1.js` hash differs, the `live` pointer moved — either pin the
new build (update this manifest + full corpus rerun) or restore the recorded
build from a private backup.

Without these fixtures the harness falls back to the legacy mock OM SDK
session client and records `diagnostics.measurement.omid.sdkMode: "mock"`;
corpus conformance runs require `sdkMode: "service"` (the real pinned SDK).
