# 002 Navigation Policy Post-Render

Synthetic reduction for private corpus rows that rendered successfully and then
triggered `unauthorized_navigation` shortly after render in the Creative Markup
path.

This fixture intentionally does not decide whether the pattern is a valid
wrapper-loading flow or an unobserved navigation escape. It pins the current
validator classification so that follow-up design work can discuss a public,
minimal reproduction instead of private `adm`.

The creative writes a small banner, logs DOM lifecycle markers, waits for
`window.load`, and then assigns `window.location.href` after 150 ms. In current
SHARC behavior, the container's load-event backstop terminates the placement with
`RENDERER_UNAUTHORIZED_NAVIGATION` and the validator buckets the row as
`navigation-policy`.
