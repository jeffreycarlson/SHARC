# SHARC (Secure HTML Ad Richmedia Container)

![Package status](https://img.shields.io/badge/package-v0.5.2%20(publishable--ready%2C%20not%20yet%20published)-informational)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/InteractiveAdvertisingBureau/SHARC/actions/workflows/ci.yml/badge.svg)](https://github.com/InteractiveAdvertisingBureau/SHARC/actions/workflows/ci.yml)

Secure HTML Ad Richmedia Container (SHARC) — IAB Tech Lab protocol

> 📋 **This is the IAB Tech Lab SHARC reference implementation.**
>
> For the full specification, API reference, and detailed design documents,
> see the [documentation](docs/) directory or the [official documentation site](https://iabtechlab.github.io/SHARC/).

## Overview

SHARC is a secure container API for managed communication between an app webview or webpage and a served ad creative.

**Goal**: _Write one ad; serve it anywhere._

SHARC is built on the same premise as IAB Tech Lab's SafeFrame and MRAID standards. Unlike these two standards, SHARC provides cross-platform interoperability—web, mobile in-app, CTV, and more—with a single API surface.

## Quick Start

```bash
# Available after the first npm publish
npm install @iabtechlab/sharc

# Use in your project
import { sharcProtocol } from '@iabtechlab/sharc/sharc-protocol';
import { SharcContainer } from '@iabtechlab/sharc/sharc-container';
import { SharcCreative } from '@iabtechlab/sharc/sharc-creative';
```

## Distribution and URL Guidance

SHARC is packaged as one npm package with versioned subpath exports:

- Container: `@iabtechlab/sharc/sharc-container`
- Creative: `@iabtechlab/sharc/sharc-creative`
- Protocol: `@iabtechlab/sharc/sharc-protocol`

**Note:** All modules ship as both IIFE (`.js` for `<script>` tags) and ESM (`.mjs` for bundlers).

After the package is published, public CDN URL patterns should mirror those entry points and the current `dist/` filenames:

- Container: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.5.2/dist/sharc-container.js`
- Creative: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.5.2/dist/sharc-creative.js`
- Protocol: `https://cdn.jsdelivr.net/npm/@iabtechlab/sharc@0.5.2/dist/sharc-protocol.js`

Versioning guidance:

- **Production:** pin exact semver, for example `@1.2.3`
- **Dev/staging:** floating minor or major aliases are acceptable, for example `@1.2` or `@1`
- **Do not rely on `latest`** for production integrations or long-lived test environments

Bridge public CDN URL policy is intentionally deferred for now. Treat bridge bundles as package artifacts used by SHARC, not as separately documented public CDN entry points yet.

## Documentation

- **[Full Specification](docs/)** — Complete protocol specification and API reference
- **[Architecture Overview](docs/architecture-overview.md)** — How the reference implementation works
- **[API Reference](docs/api-reference.md)** — Detailed API documentation
- **[MRAID Bridge](docs/design/mraid-bridge-design.md)** — MRAID 2.0/3.0 compatibility
- **[SafeFrame Bridge](docs/design/safeframe-bridge-design.md)** — SafeFrame compatibility

## Repository Structure

```
SHARC/
├── dist/              # Built modules (ESM + IIFE)
├── examples/          # Reference implementations and test harness
├── docs/              # Full specification and design documents
├── CHANGELOG.md       # Version history
├── LICENSE            # Apache 2.0
└── README.md          # This file
```

## Examples and Test Harness

The repository includes a local test harness for development:

```bash
# Start the development server
npm run dev

# Visit http://localhost:8765/test/browser/index.html
```

Use `?build=dist` to test with the production build:
```http
http://localhost:8765/test/browser/index.html?build=dist
```

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) and the [Architecture Overview](docs/architecture-overview.md) before submitting changes.

## Security

For security concerns, please see our [Security Policy](SECURITY.md).

## License

SHARC is licensed under the [Apache License 2.0](LICENSE).

## Contact

For questions or to get involved, email [support@iabtechlab.com](mailto:support@iabtechlab.com).

---

**IAB Tech Lab** | [iabtechlab.com](https://www.iabtechlab.com/)