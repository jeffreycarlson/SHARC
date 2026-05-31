# 005 Document Source Classification

Synthetic reduction for private corpus rows where HTML creatives create nested
documents without navigating the renderer document itself.

The fixture pins these validator boundaries:

- static `srcdoc` iframes should pass and report `srcdoc-frame`,
  `blank-or-opaque-document`, and `observed-frame` diagnostics.
- static `about:blank` iframes should pass and report
  `blank-or-opaque-document` and `observed-frame` diagnostics.
- external frame `src` assignments should pass and report `external-frame`,
  `insecure-frame`, `frame-src-assignment`, and `observed-frame` diagnostics.
  The fixture uses the runner's localhost HTTP server, so it intentionally
  exercises the `insecure-frame` class; HTTPS `secure-frame` classification is
  covered by triage unit fixtures.

This reduction does not classify nested iframe creation as a SHARC failure.
Nested documents are common creative behavior. The mechanism being pinned is
the distinction between allowed child-frame document activity and same-frame
renderer navigation, which remains covered by
`004-external-script-navigation-boundary`.
