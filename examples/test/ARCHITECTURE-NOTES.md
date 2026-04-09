# SHARC Test Harness — Architectural Review Notes

**Author:** Software Architect (subagent)
**Date:** 2026-04-09
**Scope:** Test harness creative loading patterns introduced to resolve null-origin sandbox issues
**Files Reviewed:**
- `examples/mraid-wrapper.html`
- `examples/safeframe-wrapper.html`
- `examples/test/test-mraid-creative.js`
- `examples/test/test-safeframe-creative.js`
- `examples/test/mraid-3-compliance-runner.html`
- `server.js`

---

## Executive Summary

The patterns introduced are **sound for their purpose**: they correctly solve a real constraint (null-origin sandboxed iframes cannot use `fetch()`, and nested iframes lose `allow-scripts`). The XHR-sync + DOM injection + companion-JS callback pattern is the right tradeoff given the SHARC sandbox model. No critical risks were introduced. Several documentation and guard-rail gaps exist that should be addressed before external contributors encounter these files.

The primary architectural concern is **leakage risk**: the `__SHARC_TEST_mraidCreativeInit` / `__SHARC_TEST_sfCreativeInit` callback contract and the HTML/JS split convention are useful patterns that could plausibly migrate into production creatives without being designed for that context.

> **Status (2026-04-09):** The rename recommendation in §2 has been implemented. All callback references now use the `__SHARC_TEST_` prefix.

---

## Pattern Assessments

---

### 1. XHR Sync + DOM Injection

**Verdict: Acceptable for test harness — annotate as test-only, do not promote to production**

**What it does:**
The wrapper uses synchronous `XMLHttpRequest` to load the creative HTML, parses it with `DOMParser`, injects `<style>` tags from `<head>`, sets `document.body.innerHTML` to the creative body content, then loads the companion `.js` file via `<script src>` with an `onload` callback.

**Why it was necessary:**
The SHARC container sandboxes the wrapper iframe with `allow-scripts` only (no `allow-same-origin`). This produces `origin: null`. In null-origin contexts:
- `fetch()` is blocked by the browser (CORS pre-flight requires a real origin)
- A nested iframe loses `allow-scripts` (child inherits the parent sandbox with no additional grants)
- Synchronous XHR is deprecated-but-functional and not CORS-gated in the same way

The solution is correct: sync XHR is the only viable same-document loading mechanism in this environment. The `setTimeout(..., 0)` before script injection ensures the DOM from `innerHTML` is parsed and accessible before the creative script runs — this replaces the earlier `requestAnimationFrame` polling workaround and is cleaner.

**Risks and limitations:**
- **Sync XHR blocks the main thread.** In a test harness loading a few KB of HTML this is not meaningful. In a production loader loading a 100KB+ creative with assets, it would be a hard jank source. This is the primary reason not to promote this to production.
- **`innerHTML` drops `<script>` tags silently.** This is intentional and documented in the HTML comments, but it means any future creative author who puts logic inline in their HTML will silently lose it. The convention must be documented explicitly (see §3 below).
- **`innerHTML` injection is safe here** because: (a) the creative HTML is served from the same origin as the wrapper (the dev server), (b) the sandbox already constrains what scripts can do, and (c) the wrapper strips inline `<script>` by design. For production, a sandboxed iframe with its own document is the correct model — `innerHTML` injection is not appropriate for untrusted third-party creative HTML.
- **`DOMParser` + `adoptNode` vs. `innerHTML`:** The style adoption with `adoptNode` is correct. The body injection uses `innerHTML` rather than `adoptNode` per element, which is slightly less precise (event listeners on original nodes, if any, are lost). For DOM-only structure this is fine.

**Recommendation:**
Add a comment in both wrapper files making explicit that sync XHR is a test-only workaround:
```
// TEST HARNESS ONLY: sync XHR is a workaround for null-origin fetch() restriction.
// Production creative loading must use a proper sandboxed iframe with its own document.
```

---

### 2. `window.__SHARC_TEST_mraidCreativeInit` / `window.__SHARC_TEST_sfCreativeInit` Callback Contract

**Verdict: Acceptable for test harness — must be clearly blocked from production use**

**What it does:**
The wrapper loads the companion `.js` file via `<script src>`. After load, it checks for `window.__SHARC_TEST_mraidCreativeInit` (or `__SHARC_TEST_sfCreativeInit`) and calls it if present. The creative JS registers this function to signal "I'm ready to be initialized; the DOM and `window.mraid` / `window.$sf` are guaranteed available."

**Why it is a good pattern (within the test harness):**
This replaces a fragile polling loop (`requestAnimationFrame` retry until DOM elements are found) with a clean push-based initialization. The contract is explicit: the wrapper calls the init function exactly once, after both DOM and bridge are ready. This is analogous to AMD's `define()` or a module's exported `init()`.

**Why it must not become a production pattern:**
Real MRAID and SafeFrame creatives are loaded in their own iframe document. They do not use this pattern — they use the standard `mraid.getState() === 'loading'` / `ready` event bootstrap, and SafeFrame's `$sf.ext.register()`. If a third-party creative author sees `__SHARC_TEST_mraidCreativeInit` in SHARC examples and adopts it, their creative will silently fail in any MRAID SDK that doesn't call the init function (i.e., every non-SHARC SDK).

**Documentation gap:**
The comment in `test-mraid-creative.js` (line 1) and both wrapper files explains the pattern clearly, but there is no prominent warning that this is incompatible with non-SHARC MRAID environments. A developer copying `test-mraid-creative.js` as a starting point for a real creative would introduce a SHARC dependency.

**Recommendations:**
1. Rename the global to something more obviously test-scoped, e.g., `window.__SHARC_TEST_mraidCreativeInit`. This makes it ugly enough to not accidentally copy.
2. Add a top-of-file block comment to both `.js` files:
   ```
   // ⚠️ SHARC TEST HARNESS ONLY
   // This file uses window.__SHARC_TEST_mraidCreativeInit — a SHARC test convention.
   // Real MRAID creatives use standard MRAID bootstrap (mraid.getState() / 'ready' event).
   // Do NOT use this pattern in production creatives deployed to non-SHARC environments.
   ```
3. Consider having the wrapper *not* call the init function if it's running outside the test harness (e.g., check a query param like `?testMode=1`). This is overkill for the current scope but would add friction against accidental production use.

---

### 3. Companion `.js` File Convention

**Verdict: Needs improvement — underdocumented, latent confusion risk for third-party authors**

**What it does:**
HTML creatives are assumed to pair with a same-basename `.js` file:
```
test-mraid-creative.html  ← DOM structure and styles only
test-mraid-creative.js    ← All script logic
```
The wrapper derives the JS URL from the HTML URL via a regex replace: `resolvedUrl.replace(/\.html(\?.*)?$/, '.js$1')`.

**Where it is documented:**
In the inline comments of both wrapper files and in the HTML files themselves. Not documented anywhere outside the examples directory.

**Why it exists:**
`innerHTML` injection (see §1) silently drops `<script>` tags. Separating DOM structure from script logic is the only viable pattern given the injection-based loading model. It's clean and consistent once you understand the constraint.

**Risks:**
- **Silent failure:** If a creative author adds a `<script>` tag to the `.html` file (a natural instinct), it will silently disappear after injection. There is no error, no console warning. The creative will appear to load but exhibit incorrect behavior. This is the most likely form of confusion.
- **Derivation is implicit:** The `.js` URL is derived automatically, not declared. If the creative HTML lives at `/ads/my-ad.html`, the wrapper will look for `/ads/my-ad.js` without any indication to the author.
- **Extension matching is narrow:** The regex `\.html(\?.*)?$` handles query strings but not hash fragments or unusual URL forms. Unlikely to matter in practice.
- **No graceful fallback:** If the `.js` file is absent (404), `script.onerror` fires and logs an error, but the creative appears as a static HTML page with no interaction. For a test harness this is fine; it would be confusing in a documentation example.

**Recommendations:**
1. Add a `CREATIVE-AUTHORING.md` in `examples/` documenting the convention and its rationale. Two paragraphs: why `<script>` tags don't work in injected HTML, and the `.html` / `.js` split pattern.
2. Add a runtime warning if `DOMParser` finds `<script>` elements in the parsed HTML body and strips them:
   ```javascript
   var strippedScripts = doc.body.querySelectorAll('script').length;
   if (strippedScripts > 0) {
     console.warn('[MRAID Wrapper] ' + strippedScripts + ' <script> tag(s) in creative HTML were not executed.'
       + ' Move all script logic to the companion .js file.');
   }
   ```
3. For compliance ads (IAB test vectors loaded by `mraid-3-compliance-runner.html`), these ads have their own inline scripts. Document explicitly that the compliance runner path bypasses the XHR/inject model (or if it doesn't, that the compliance ads must be adapted for it).

---

### 4. Node.js Dev Server (`server.js`)

**Verdict: Acceptable as a dev-only tool — must be clearly marked as such, with path traversal protection added**

**What it does:**
A minimal HTTP server that serves files from the repo root, sets `Access-Control-Allow-Origin: *`, and returns standard MIME types. Uses async `fs.readFile` (the code uses the callback form, which is async — this is fine).

**Acceptable aspects:**
- CORS `*` is necessary for the test harness: sandboxed iframes need cross-origin resource access, and the dev server is running locally with no sensitive data.
- The async `fs.readFile` (not `fs.readFileSync`) is the right choice — no blocking I/O.
- Simple and auditable — under 50 lines.

**The path traversal gap:**
```javascript
let filePath = path.join(ROOT, req.url.split('?')[0]);
```
`path.join` does *not* prevent path traversal. On POSIX:
```
path.join('/project', '../../../etc/passwd')  // → '/etc/passwd'
```
A URL of `/../../../etc/passwd` will resolve outside the project root. `path.join` normalizes `..` segments but does not clamp to the root. The correct guard is:
```javascript
const resolved = path.resolve(ROOT, req.url.split('?')[0].slice(1));
if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) {
  res.writeHead(403); res.end('Forbidden'); return;
}
```

For a localhost-only dev server started manually by the developer, this is a low-severity gap — it requires the developer to browse to a crafted URL, or for another local process to make a crafted request. However:
- The server binds to `0.0.0.0` implicitly via `http.createServer().listen(PORT)` with no host argument. On a machine connected to a network, this means the dev server is accessible from LAN peers without authentication.
- If a developer runs this server with `npm start` and forgets to stop it, any LAN device can read any file the Node process can access.

**Recommendations:**
1. **Add path traversal protection** (the fix above) — this is a single guard and the risk is real enough to justify it.
2. **Bind to `127.0.0.1` only** unless multi-device testing is needed:
   ```javascript
   .listen(PORT, '127.0.0.1', () => { ... })
   ```
3. Add a prominent comment at the top: `// DEV SERVER ONLY — NOT PRODUCTION — DO NOT DEPLOY`.
4. Consider adding a `--help` usage note and a `CTRL-C to stop` reminder in the startup log.

---

### 5. Overall Creative Loading Architecture

**Verdict: Correct for the current constraints — review as SHARC evolves toward production**

**The wrapper + creative separation is sound:**
The fundamental architecture — wrapper establishes the bridge, creative loads into the same document — is the right solution given the null-origin sandbox constraint. The alternatives (nested iframe, blob URL, `srcdoc=`) all have worse tradeoffs:

| Alternative | Problem |
|---|---|
| Nested iframe | Child inherits sandbox, loses `allow-scripts` |
| `srcdoc=` | Still null-origin; no easier to establish bridge |
| Blob URL | `URL.createObjectURL` unavailable in some sandboxes; same-origin semantics vary |
| `allow-same-origin` sandbox | SEC-001: sandbox escape if wrapper is same-origin as publisher |

The current approach (XHR-load body, inject DOM, load companion JS) is the correct forced move.

**The XHR + init-callback vs. a formal Creative Loading API:**
The current pattern is a test harness workaround, not a designed API. For production use, SHARC should define a formal creative loading lifecycle distinct from the XHR/inject workaround:

1. **Production model:** Creative is loaded in a dedicated sandboxed iframe as a full document. The wrapper page is the iframe's `src`. The creative document loads its own scripts, uses standard MRAID/SafeFrame bootstrap, and communicates with the SHARC container via `MessageChannel` (already the protocol transport). No XHR loading, no `innerHTML` injection.

2. **The wrapper's job in production:** Establish `window.mraid` / `window.$sf` synchronously via `<script>` tags in `<head>` before any creative script runs. This is already what both wrappers do. That part is correct and should be preserved.

3. **What changes in production:** Instead of XHR-loading a creative URL and injecting its body, the wrapper IS the iframe document. The container sets `iframe.src` to `mraid-wrapper.html?creative=<url>`, and the wrapper loads the creative in a *child* iframe — but this child iframe needs `allow-scripts`. The outer sandbox can grant this with `allow-scripts` (it already does). The inner sandbox needs `allow-scripts` as well. **This is the crux that the test harness was avoiding:** granting `allow-scripts` to a nested iframe requires `allow-scripts` in the outer sandbox (which we have) and an explicit inner `<iframe sandbox="allow-scripts">` on the child frame.

   The reason the test harness avoided a nested iframe was the null-origin sandbox issue — but that issue was specifically about the XHR/fetch constraints, not about nested scripts. A production implementation should revisit this: a nested `<iframe sandbox="allow-scripts" src="<creative>">` inside the wrapper should work, with the SHARC bridge injected via `document.write` or a bootstrap script in the child's URL. This is a separate design task.

4. **Formalizing the creative loading API:** If SHARC ever supports a JS-only creative embed format (no wrapper iframe at all — creative injects into publisher DOM), a formal `SHARCCreativeLoader` class with explicit lifecycle methods (`load()`, `unload()`, `onReady(cb)`) would make the contract explicit and prevent the ad-hoc init-callback pattern from spreading.

**What should NOT come from the test harness into production:**
| Pattern | Verdict |
|---|---|
| `window.__SHARC_TEST_mraidCreativeInit` / `__SHARC_TEST_sfCreativeInit` callback | ❌ Block — SHARC-specific, non-standard, silently incompatible with other MRAID SDKs |
| HTML/JS file split convention | ❌ Block from production creative format — it's an artifact of `innerHTML` injection |
| Synchronous XHR creative loading | ❌ Block — blocks main thread, deprecated |
| `innerHTML` injection of creative body | ❌ Block for untrusted third-party creatives |
| Script load guard (`script.onerror`) | ✅ Promote — good defensive pattern |
| URL scheme validation (`http:` / `https:` only) | ✅ Promote — already in production SDK, consistent here |
| `setTimeout(..., 0)` for DOM-ready before script load | ✅ Promote — correct microtask ordering technique |

---

## Consolidated Recommendations

### For the Test Harness (immediate)

1. **Add path traversal guard to `server.js`** and bind to `127.0.0.1`. (Security — low severity but easily fixed.)
2. **Add a console warning** when `<script>` tags are stripped from injected creative HTML. Saves confusion for future creative authors.
3. ~~**Rename `__mraidCreativeInit` / `__sfCreativeInit`** to include a `_SHARC_TEST_` prefix to make them obviously test-scoped.~~ ✅ **Done** — all callbacks renamed to `__SHARC_TEST_mraidCreativeInit` / `__SHARC_TEST_sfCreativeInit`.
4. **Add a `CREATIVE-AUTHORING.md`** explaining the HTML/JS split convention and why inline scripts don't work in the injected model.

### For the Production Implementation (separate track)

1. **Define a formal creative loading lifecycle** for SHARC production use. The current wrapper is a good starting point but needs the XHR/inject path replaced with a proper nested iframe approach.
2. **The nested iframe path is viable** if the outer wrapper uses `<iframe sandbox="allow-scripts" src="<creative-url>">` — this preserves script isolation without the `fetch()`/XHR constraint because the inner frame has its own document and origin.
3. **The `window.mraid` / `window.$sf` injection model is correct** — the SHARC bridge scripts in `<head>` establishing the global before creative scripts run is the right approach and should be preserved in production.
4. **Document the null-origin constraint** in `docs/mraid-bridge-design.md` and `docs/safeframe-bridge-design.md` so future implementers understand why the wrapper must be same-origin with the SHARC assets.
