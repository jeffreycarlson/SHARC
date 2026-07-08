# G5 URL-mode fixtures — page ↔ row seam contract

Creative **pages** for the G5 Creative URL conformance matrix (ADR:
`~/Obsidian/dev-team/sharc/2026-07-05-g5-url-mode-conformance.md`). Pages live
here (Claude lane); the normalized validator **rows/manifests** that point at
them are the Codex lane (#423). This table is the seam contract: what each
page actually does, and what the row config must declare to get the intended
matrix shape.

Serving topology (mandatory): cross-origin — host page and creative page on
two different local origins via `server.cjs` (F1/F3 spikes use host `:1886x`
/ creative `:1886x+2`-style port pairs). `server.cjs` also provides the
`?__slow=<ms>` response-delay hook F8 depends on.

| Fixture page | Matrix shape(s) served | Row config (Codex side) must declare |
|---|---|---|
| `g5-f1-creative.html` (+ `g5-f1-host.html`) | **F1** SHARC-native full lifecycle (gate-U1+U2+U3 pass); asserted in real Chrome by `test/g5-red/test-g5-f1-conformance-browser.js` (R4) | declared SHARC (`requireSharcInit: true` semantics); no measurement sidecar; expect all URL gates pass |
| `g5-f2-plain-html.html` | **F2** plain-HTML floor (gate-U1 pass, no handshake expected, no-OMID-PASS); **F6** declared-7-installs-nothing (same page, row declares OMID); **F7** declared-SHARC-no-handshake (same page, row requires SHARC) | F2: `requireSharcInit: false`, no declared APIs. F6: declare api `7`, NO sidecar/install expectations in-iframe (T1 is publisher-page authority). F7: declare SHARC / `requireSharcInit: true` → expect 2212 fatal → `declared-sharc-no-handshake` |
| `g5-f2-plain-html.html` (again) | **F4** T1 sidecar authority on URL (publisher-page OMID, zero creative cooperation) | declare api `7` + `creativeMeta.measurement.omid` sidecar + `omidAutoInstall` (Rule 3b carve-out); expect the publisher-page service session to start (gate-U3 T1 leg); the page itself stays inert |
| `g5-f3-sharc-omid-shim.html` (+ `g5-f3-host.html`) | **F3** T2 self-included shim + synthetic omid3p vendor (gate-U3 T2 leg: shim subscribes); proven end-to-end by `test/browser/g5-f3-omid-shim-spike.js` | declare SHARC + api `7` + `creativeMeta.measurement.omid` sidecar + `omidAutoInstall`; expect `omidShimInit` over the port, shim install, vendor Register round-trip |
| `g5-f5-mraid-expecting.html` | **F5** MRAID-expecting creative on the no-injection URL path | declare api `3`/`5`/`6` (MRAID), `requireSharcInit: false`; expect `url-declared-api-unsupported`; the page records `mraid-undefined` in `document.title` / `#g5f5-outcome[data-outcome]` and never hangs |
| *(no page — dead endpoint)* | **F8a** fetch refused / 404 | point `creative.url` at a closed port or 404 path; expect `url-load-failed` |
| `g5-f8-slow-load.html` | **F8b** load past the gate window | serve via `server.cjs`; pass `?loadDelayMs=<ms>` on the page URL (harness clamps `?__slow` to 1..5000ms); delay > gate window → `url-load-timeout`; delay < window doubles as a near-miss control |
| `g5-f9-redirect.html` | **F9** post-load top-level navigation (auto-redirect shape) | `requireSharcInit: false`; expect the 2118 `unauthorized_navigation` backstop as the verdict → existing `navigation-policy` bucket |

Notes for row authors:

- **Pages are single-purpose and honest** — a page's behavior is exactly its
  fixture shape; matrix variation comes from the ROW (declared APIs, sidecar,
  `requireSharcInit`), never from page-side mode flags. F2 deliberately serves
  four row shapes unchanged.
- **F3 host arming pattern**: the g5-f3 host pre-loads a minimal flat-namespace
  `window.OmidSessionClient` stub so the bid-signaled auto-install path arms
  hermetically (the bridge's documented "publisher already loaded the OM SDK"
  branch; the `https:` script URLs in `omidAutoInstall` are never fetched).
  Validator rows that want the REAL OM SDK instead load the pinned
  `omweb-v1.js` on the publisher page the same way.
- **T2 named residual**: publisher→shim OMID *Event* relay
  (`_relayOmidEvent`) rides `window.postMessage` with a concrete targetOrigin
  and cannot reach the opaque-origin URL-variant iframe — it fails closed
  (console warn). Gate-U3's T2 leg is therefore "shim subscribes" (per the
  ADR), not "events delivered". Events-over-port is future work.
