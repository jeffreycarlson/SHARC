# Security Policy

## Supported Versions

SHARC is currently publishable-ready at `0.3.0`, but not yet publicly published to npm. Until the first public release, security fixes should be tracked against the current mainline development state.

| Version | Supported |
| ------- | --------- |
| 0.3.x (current package line) | :white_check_mark: |
| < 0.3.0 | :x: |

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

- **Sandbox iframe containers**: Always use `sandbox` attributes with minimal permissions:
  ```html
  <iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups" ...>
  ```
  Avoid `allow-same-origin` unless absolutely necessary, and never use `allow-scripts` without it.

- **Content Security Policy (CSP)**: Implement a restrictive CSP that:
  - Only allows connections to known trusted origins
  - Disables `unsafe-inline` scripts
  - Restricts media and script sources
  - Uses `strict-dynamic` where appropriate

- **Origin validation**: Verify the `origin` header in `postMessage` events and only accept messages from expected publishers/ad networks.

### Creative Implementations

- **Input validation**: Never assume container-provided data is trustworthy. Validate all incoming messages.
- **Error handling**: Gracefully handle malformed messages without exposing internal state.
- **Resource loading**: Use HTTPS for all external resources. Validate certificate chains.
- **Session management**: Use cryptographically secure random values for session IDs.

### General Recommendations

- **Keep dependencies updated**: Regularly review and update npm dependencies.
- **Monitor for CVEs**: Subscribe to npm audit notifications for your dependencies.
- **Code review**: Have security-minded peers review code changes before merging.
- **Security scanning**: Consider integrating automated security scanning tools (e.g., Snyk, Dependabot).

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
