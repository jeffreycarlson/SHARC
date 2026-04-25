# Security Policy

## Supported Versions

SHARC is currently in pre-1.0 development at package version `0.5.3` and is not yet publicly published to npm.

Until the first public release, the project supports the current development line on `main` / the latest `0.5.x` source state in this repository. Earlier snapshots are not maintained as supported release lines, and there is no backport commitment yet.

| Version / state | Supported |
| ------- | --------- |
| Current `main` / `0.5.x` development line | :white_check_mark: |
| Earlier pre-release snapshots | :x: |

## Reporting a Vulnerability

If you believe you've discovered a security vulnerability in SHARC, please follow these steps:

1. **Do not open a public issue**. Security vulnerabilities require careful handling to prevent exploitation before a fix is available.

2. **Email the security team**. Please report the vulnerability to:
   - **Email**: [support@iabtechlab.com](mailto:support@iabtechlab.com)
   - **Subject**: [SECURITY] SHARC Vulnerability Report

3. **Include the following information**:
   - A detailed description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact (severity assessment)
   - Your name/alias (optional)
   - Any suggestions for remediation (optional)

4. **What to expect**:
   - An acknowledgment within 48 hours
   - A status update within 7 days
   - A timeline for when fixes will be deployed
   - Credit for the discoverer (if requested)

## Security Best Practices

When using SHARC, please follow these security best practices:

### Container Implementations

- **Sandbox iframe containers**: Use the narrowest sandbox that still supports the ad experience. The current SHARC reference container uses:
  ```html
  <iframe sandbox="allow-scripts allow-forms allow-popups" ...>
  ```
  `allow-same-origin` is intentionally excluded. In combination with `allow-scripts`, it can let a same-origin creative remove its own sandbox and escape isolation. `allow-popups-to-escape-sandbox` is also intentionally excluded.

- **Content Security Policy (CSP)**: Implement a restrictive CSP that:
  - Only allows connections to known trusted origins
  - Disables `unsafe-inline` scripts
  - Restricts media and script sources
  - Uses `strict-dynamic` where appropriate

- **Origin and channel validation**: The SHARC reference path uses a transferred `MessageChannel` port after bootstrap; treat that private port as the primary trust boundary. If you implement any fallback `postMessage` path around SHARC, validate expected origins and do not send sensitive payloads to `*`.

### Creative Implementations

- **Input validation**: Never assume container-provided data is trustworthy. Validate all incoming messages.
- **Error handling**: Gracefully handle malformed messages without exposing internal state.
- **Resource loading**: Use HTTPS for all external resources. Validate certificate chains.
- **Session management**: Use cryptographically secure random values for session IDs.

### General Recommendations

- **Keep dependencies updated**: Regularly review and update npm dependencies.
- **Monitor for CVEs**: Subscribe to npm audit notifications for your dependencies.
- **Code review**: Have security-minded peers review code changes before merging.
- **Security scanning**: Consider integrating automated security scanning tools (e.g., Dependabot or equivalent).
- **Validate URLs**: Only allow approved navigation/tracker URL schemes (`https:` and, if required for legacy environments, `http:`).

## Security Headers

For HTML-based SHARC implementations, consider using the following HTTP security headers:

```
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'self';
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
```

## Acknowledgments

We thank the security research community for helping make SHARC more secure. Reports discovered and responsibly disclosed have led to significant improvements in the protocol's security posture.

## License Considerations

SHARC is licensed under Apache 2.0. Security fixes will be released as part of standard version updates. By submitting a bug fix for a security issue, you agree to license your contribution under the same Apache 2.0 license.
