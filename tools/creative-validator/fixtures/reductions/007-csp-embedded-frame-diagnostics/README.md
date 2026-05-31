# 007 CSP Embedded Frame Diagnostics

Synthetic reduction for private corpus rows where creatives create child
iframes that trigger Chromium CSP Embedded Enforcement console messages while
the top-level SHARC creative continues to run successfully.

The May 30, 2026 post-#245 private corpus pass showed this pattern as common
and non-fatal: CSP-like console diagnostics appeared in 458 passed rows, mostly
from external child frames blocked by the renderer iframe's embedded CSP
requirement. Only 5 of those rows also had script-load errors, so the dominant
pattern is child-frame CSP diagnostics rather than broken creative scripts.

The fixture pins these validator boundaries:

- a child iframe whose response does not opt into the embedder's CSP should pass
  the creative row and report CSP console diagnostics.
- delayed child-frame creation should pass and classify as normal
  document-source activity as well as CSP console diagnostics.
- CSP console diagnostics without script-load errors should not be classified
  as `script-csp-blocked`.

The companion `tools/creative-validator/fixtures/csp-embedded-child.txt` file is
load-bearing: the dev server returns it as a successful non-HTML response
without a Content-Security-Policy header, which is what lets Chromium produce
the embedded-enforcement console diagnostic for the child document load.

This reduction does not weaken the renderer CSP requirement. It documents that
Chromium's CSP Embedded Enforcement console output is expected diagnostic noise
for child frames that do not opt in with compatible policy headers, and remains
distinct from SHARC navigation-policy or bridge failures.
