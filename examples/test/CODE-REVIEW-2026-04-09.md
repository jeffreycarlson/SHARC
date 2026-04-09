# Code Review — SHARC Test Harness
**Date:** 2026-04-09  
**Reviewer:** Code Reviewer (subagent)  
**Commits reviewed:** `ba92160` → `44ee832` (last 10 commits)  
**Scope:** Test harness creative loading patterns, security fixes, documentation

---

## 🟢 Overall Assessment

The work in these commits is **solid and purposeful**. The core architectural problem (null-origin sandboxed iframes can't use `fetch()`, can't nest iframes without losing `allow-scripts`) was correctly identified and correctly solved. The XHR-sync + DOM injection + companion-JS callback pattern is the right tradeoff. The security fixes (path traversal guard, `127.0.0.1` bind, callback rename) directly address the recommendations from the prior architecture review and were applied cleanly.

The documentation (`CREATIVE-AUTHORING.md`, `ARCHITECTURE-NOTES.md`) is unusually good for test harness code — it explains *why* each unusual pattern exists, which is exactly what future contributors need.

**Fixes applied in this review:** 7 issues corrected (see §Fixes below).  
**Open items for next session:** 3 suggestions and 1 security item for the engineer.

---

## 🔴 Blockers (Must Fix) — all addressed in this review

### 1. Stale callback names in HTML comment headers

**Files:** `test-mraid-creative.html` (lines 12, 221), `test-safeframe-creative.html` (lines 12, 235), `safeframe-wrapper.html` (lines 102, 115)

The rename from `__mraidCreativeInit` → `__SHARC_TEST_mraidCreativeInit` (and `__sfCreativeInit` → `__SHARC_TEST_sfCreativeInit`) was applied to the `.js` files and the runtime code, but **not** to the HTML comment headers that document the loading contract. These headers are the first thing a contributor reads, so stale names here directly undermine the leakage-prevention goal of the rename.

**Severity:** Blocker — stale documentation defeats the purpose of the rename.  
✅ **Fixed.** All six stale references updated to the `__SHARC_TEST_` prefix.

---

### 2. `server.js` — GET `/` returns 500 instead of `index.html`

**File:** `server.js` (line ~31)

The path traversal fix correctly uses `path.resolve()` instead of `path.join()`. However, `path.resolve()` strips trailing separators, so a bare `GET /` request produces:

```javascript
filePath = path.resolve(ROOT, '.' + '/') // → ROOT (no trailing sep)
```

The subsequent guard `filePath.endsWith(path.sep)` is then `false`, so `index.html` is never appended. `fs.readFile(ROOT)` returns `EISDIR → 500`.

**Impact:** Navigating to `http://localhost:8765/` crashes with a 500 error. This is a user-facing regression from the path-traversal fix.

```javascript
// Before fix (broken):
if (filePath.endsWith(path.sep)) filePath += 'index.html';

// After fix:
if (filePath === ROOT || filePath.endsWith(path.sep)) {
  filePath = (filePath.endsWith(path.sep) ? filePath : filePath + path.sep) + 'index.html';
}
```

✅ **Fixed.**

---

## 🟡 Suggestions (Should Fix) — addressed in this review

### 3. `observeComplianceAd()` — `hasError` is declared but never set

**File:** `mraid-3-compliance-runner.html` (function `observeComplianceAd`)

The function comment says:
> "The IAB compliance ads self-report via `console.log('CHECK:' / 'FAIL:')`. We treat no fatal error + state reaching active as a pass."

But `hasError` is declared, never assigned, and `resolve(stateReachedActive && !hasError ? 'pass' : 'fail')` is always equivalent to `resolve(stateReachedActive ? 'pass' : 'fail')`. Dead variable, misleading comment. Also:

- The `onError` interception accessed `container._opts` (private/internal property) to patch the callback, which is fragile — if the internal property name changes, the hook silently does nothing.
- The check `setInterval` fired every 2000ms, meaning worst-case timeout was 30,000 + 2,000 = 32,000ms.

**Fixed by:**
- Replacing `hasError` with `hasFatalError`, wired to intercept `container.onError` via the public property (not `_opts`).
- Replacing the polling interval with `setTimeout(resolve, maxWait)` + a lightweight 500ms interval that resolves early if `container` is destroyed.
- Updating the comment to accurately describe pass criteria.

✅ **Fixed.**

### 4. `observeComplianceAd()` — private `_opts` coupling

Covered above. `container._opts.onStateChange` was patched by reaching into a private property. Replaced with direct property assignment on the container's public-facing `onStateChange` property.

✅ **Fixed.**

### 5. Missing `<script>`-stripped warning in both wrappers

**Files:** `mraid-wrapper.html`, `safeframe-wrapper.html`

`ARCHITECTURE-NOTES.md` §3 explicitly recommended:
> "Add a runtime warning if `DOMParser` finds `<script>` elements in the parsed HTML body and strips them."

This was not implemented. The silent drop of inline `<script>` tags is the most likely confusion point for future creative authors — the creative loads but does nothing, with no visible error.

```javascript
var strippedScripts = doc.body.querySelectorAll('script').length;
if (strippedScripts > 0) {
  console.warn('[MRAID Wrapper] ' + strippedScripts + ' <script> tag(s) in creative HTML' +
    ' were not executed. Move all script logic to the companion .js file.');
}
```

✅ **Fixed.** Added to both `mraid-wrapper.html` and `safeframe-wrapper.html`.

### 6. `server.js` — no "DEV ONLY" marker

**File:** `server.js`

`ARCHITECTURE-NOTES.md` §4 recommended: "Add a prominent comment at the top: `// DEV SERVER ONLY — NOT PRODUCTION — DO NOT DEPLOY`."

Not present in the committed code.

✅ **Fixed.** Added to line 3.

### 7. `ARCHITECTURE-NOTES.md` — stale callback name references and no completion status

The doc uses `__mraidCreativeInit` / `__sfCreativeInit` throughout and contains the recommendations in future tense, even though some of them (the rename, the path guard, the 127.0.0.1 bind) have now been completed. Updated all name references to `__SHARC_TEST_` and marked the rename recommendation as done.

✅ **Fixed.**

---

## 💭 Nits / Open Items (Not Fixed — Next Session)

### A. `observeComplianceAd()` — console interception not implemented

The comment accurately notes this is a future improvement:
> "Intercepting console output for automated pass/fail is a future improvement."

Worth tracking as a TODO. The IAB compliance ads use `console.log('FAIL:...')` and `console.log('CHECK:...')` as their self-reporting mechanism. Without intercepting these, the runner can only detect "state reached active" — it cannot distinguish a compliance test that ran and passed from one that ran and failed (but didn't crash). Consider:

```javascript
const origConsoleLog = console.log;
console.log = function(...args) {
  const msg = args.join(' ');
  if (msg.startsWith('FAIL:')) hasFatalError = true;
  origConsoleLog.apply(console, args);
};
```

Note: console interception affects the entire document, so restore it after the test.

### B. `mraid-3-compliance-runner.html` — `container.onStateChange` and `container.onError` are patched but not restored

After each test, `runTest()` calls `container.close()` and sets `container = null`, then creates a new container. The patched callbacks on the old container are discarded with it, so no leak — but if `runAllTests()` calls `runTest()` in a loop, the previous container's patched callbacks are on a destroyed object. No functional bug, but adding an explicit cleanup step (restoring original callbacks before closing) would make the intent clear.

### C. Security engineer item — `ARCHITECTURE-NOTES.md` §4 notes that `CORS: *` is intentional

The dev server sends `Access-Control-Allow-Origin: *` for all resources. This is correct and necessary for the test harness (sandboxed iframes need cross-origin resource headers). **No action needed**, but the security engineer should verify that no credentials, API keys, or build artifacts are ever served from this repo's root during development. The `127.0.0.1` bind reduces exposure, but the CORS `*` header means any local origin that can reach port 8765 (e.g., a malicious web page opened in the same browser) can read any served file.

---

## 📋 Files Changed in This Review

| File | Change |
|---|---|
| `examples/test/test-mraid-creative.html` | Updated 2 stale `__mraidCreativeInit` references to `__SHARC_TEST_mraidCreativeInit` |
| `examples/test/test-safeframe-creative.html` | Updated 2 stale `__sfCreativeInit` references to `__SHARC_TEST_sfCreativeInit` |
| `examples/safeframe-wrapper.html` | Updated 2 stale `__sfCreativeInit` references to `__SHARC_TEST_sfCreativeInit` in inline comments; added script-stripped warning |
| `examples/mraid-wrapper.html` | Added script-stripped warning |
| `server.js` | Fixed GET `/` → 500 (now serves `index.html`); added DEV ONLY comment |
| `examples/test/mraid-3-compliance-runner.html` | Fixed `observeComplianceAd()`: `hasFatalError` now wired to `container.onError`; removed `_opts` private access; replaced coarse 2s poll with `setTimeout` + 500ms early-exit poll |
| `examples/test/ARCHITECTURE-NOTES.md` | Updated all callback name references to `__SHARC_TEST_` prefix; marked rename recommendation as completed |

---

## ✅ What Was Done Well (Don't Change)

- **Path traversal guard is correct.** `path.resolve(ROOT, '.' + rawPath)` + prefix check correctly blocks `../` traversal. URL-encoded `%2e%2e` is not decoded by Node's `req.url`, so it resolves to a literal non-existent path → 404 (safe). The edge case of a sibling directory with the same prefix (`/sharc-evil/`) is also correctly blocked because the guard checks `startsWith(ROOT + path.sep)`.

- **`127.0.0.1` bind.** Correctly limits the dev server to loopback — was binding to all interfaces before.

- **`__SHARC_TEST_` rename.** The rename makes the test-harness-only nature of the callback unambiguous. Ugly-enough-to-notice is exactly right.

- **`CREATIVE-AUTHORING.md`.** Excellent. Clearly explains the HTML/JS split, the `__SHARC_TEST_*Init` contract, and the production/test differences with concrete side-by-side examples. The anti-pattern table is especially useful.

- **XHR sync + DOM injection pattern.** The architecture is sound for the null-origin context. The `setTimeout(0)` before script injection correctly defers execution until injected DOM is fully accessible. The `onerror` handler on the script tag catches load failures.

- **URL scheme validation in both wrappers.** `javascript:` and `data:` schemes are blocked; only `http:`/`https:` allowed. This is the right level of defense for a test harness.

- **`escHtml()` in both creative JS files.** User-visible log entries are HTML-escaped. No XSS from crafted MRAID event data.

- **Bootstrap pattern in `test-mraid-creative.js`.** The standard MRAID `getState() === 'loading'` / else-call-onReady directly pattern is correctly implemented and documented.

---

*Review complete. 7 fixes applied. 3 open items documented above.*
