# 001 Normalizer Cleaned Corpus

Synthetic cleaned-corpus fixture for the creative validator normalizer.

This fixture covers the private corpus export shape without carrying real bid
responses or creative markup. It includes representative banner, native, video,
MRAID, SafeFrame, SHARC, and OMID sidecar signals so normalizer tests can pin
classification, API extraction, bid metadata, and unsupported-input handling.

The fixture is not intended to execute every creative. It is the source-of-truth
input for normalizer tests and should stay small enough for manual review.
