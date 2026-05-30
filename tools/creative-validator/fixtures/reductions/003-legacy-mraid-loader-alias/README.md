# 003 Legacy MRAID Loader Alias

Synthetic reduction for private corpus rows that request a relative
`mraid.js` script as part of the MRAID environment contract.

The fixture pins the validator boundary:

- declared or sniffed MRAID evidence means the runner may satisfy relative
  `mraid.js` with an empty successful script response, because SHARC already
  installs `window.mraid` through the compatibility bridge.
- runtime-only `mraid.js` evidence without bid-declared or markup-sniffed MRAID
  is diagnostic only. The request is not aliased and should remain visible as a
  runtime-only signal.

The declared case uses `imp.banner.api: [3, 5]` (OpenRTB MRAID API codes). The
sniffed case has no API declaration, but its markup contains
`<script src="mraid.js">`, so the normalizer classifies it as `html-mraid`.
The runtime-only case deliberately constructs the URL as `'m' + 'raid.js'` so
the static normalizer does not sniff MRAID before the creative runs; that case
stays `html` and only records the runtime request. Aliased MRAID-active loads
should have `legacyMraidLoader.errorCount: 0`; unrelated probe or network 404
noise may still appear elsewhere in the report and is not the signal this
reduction pins.

This is a harness-fidelity reduction, not production SHARC guidance. It exists
so follow-up spec/operator discussions can point at public synthetic mechanics
instead of private `adm`.
