# 004 External Script Navigation Boundary

Synthetic reduction for private corpus rows where ordinary HTML creatives load
third-party JavaScript and the loaded script either creates nested document
content or attempts to navigate the renderer document.

The fixture pins the validator boundary:

- an external script that loads and does nothing should pass.
- an external script that creates a nested iframe should pass and report
  document-source diagnostics. The iframe creates new document content within
  the renderer frame without navigating the renderer document itself.
- an external script that assigns `window.location.href` should fail with the
  `navigation-policy` bucket.

This reduction does not decide whether particular vendors, CDNs, or wrapper
flows are good or bad. External scripts are a normal creative dependency. The
mechanism being pinned is narrower: loading script resources is allowed, while
script-driven same-frame navigation remains a renderer navigation-policy
violation. The bid requests use `secure: 1` to match the surrounding synthetic
OpenRTB fixture convention; during validator runs, local fixture scripts are
served over the runner's localhost HTTP server.
