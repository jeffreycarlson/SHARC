# 006 Blank/Opaque Document Sources

Synthetic reduction for private corpus rows where creatives create delayed
opaque nested documents (`about:blank`, URL-less iframes, and `srcdoc`) after the
main creative document is already running.

The May 30, 2026 post-#232 private corpus pass showed this pattern as common
and non-fatal: `blank-or-opaque-document` appeared in 217 passed rows,
`srcdoc-frame` in 12 passed rows, and none of the blank/opaque rows had failed
document requests. Most examples were delayed observed iframes rather than
same-frame renderer navigation.

The fixture pins these validator boundaries:

- delayed `about:blank` iframe creation should pass and classify as
  `blank-or-opaque-document` + `observed-frame`.
- delayed URL-less `srcdoc` iframe creation should pass and classify as
  `blank-or-opaque-document` + `observed-frame` + `srcdoc-frame`.
- repeated opaque iframe creation should pass and increase event counts without
  changing the row-level pass/fail bucket.

This reduction does not make opaque child frames a SHARC failure. It documents
that opaque nested documents are normal creative behavior and remain distinct
from same-frame renderer navigation-policy failures.
