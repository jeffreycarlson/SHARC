# Security Review — SHARC Test Harness
**Date:** 2026-04-09
**Reviewer:** Security Engineer (subagent)
**Scope:** Three items flagged by code reviewer from commits `ba92160` → `6d65fe7`
**Files changed:** `examples/mraid-wrapper.html`, `examples/safeframe-wrapper.html`

---

## Summary

| # | Item | Security Risk? | Action |
|---|------|----------------|--------|
| 1 | Console interception not implemented | ❌ No — test coverage gap only | No code change; see analysis |
| 2 | Callback cleanup/restore pattern | ⚠️ Low — exploitable only in narrow edge cases | **Fixed** — delete-before-call pattern added to both wrappers |
| 3 | CORS `*` on dev server (`127.0.0.1` only) | ⚠️ Residual — no secrets served mitigates; documented | No code change; see analysis |

---

## Item 1 — Console Interception Not Yet Implemented

**Assessment: Test coverage gap. Not a security concern.**

### Context
`mraid-3-compliance-runner.html` runs IAB MRAID 3.0 compliance ads inside SHARC containers. The IAB test ads self-report via `console.log('CHECK:...')` and `console.log('FAIL:...')`. The runner's `observeComplianceAd()` notes this as a future improvement.

### Why This Is Not a Security Risk

The compliance runner page and the creative iframe are **separate browsing contexts**. The `console` global on the runner page belongs to the runner's window. `console.log` calls made inside the sandboxed wrapper iframe land in the **iframe's devtools context**, not the runner's. Intercepting `console.log` on the runner page would intercept runner-page output only — it would not capture messages emitted by creative-side JS.

There is no path by which creative-side console output leaks sensitive data *to* the runner or *to* an attacker:

- The sandbox (`allow-scripts` only, no `allow-same-origin`) prevents the iframe from accessing anything outside its own document.
- Console output is visible in browser DevTools — this is the normal developer debugging channel, not a covert exfiltration path.
- The test harness serves no credentials, session tokens, or PII. Creative JS has nothing sensitive to log.

### What it Actually Is
This is a **test automation fidelity gap**: the runner can detect "state reached active" but cannot detect a compliance ad that reports `FAIL:` via console without crashing. The compliance runner may report `pass` when the ad actually logged a `FAIL:` check.

### Recommendation

**Do implement console interception — but correctly, using `postMessage`, not `console.log` monkey-patching.**

The correct approach for capturing iframe console output is to override `console` inside the wrapper frame and relay messages to the runner via `postMessage`. Monkey-patching `console.log` on the runner page does nothing useful.

The code reviewer's suggested snippet intercepts the *runner page's* console:

```javascript
// ⚠️ This is WRONG — it intercepts the runner's console, not the iframe's console
const origConsoleLog = console.log;
console.log = function(...args) { ... };
```

The correct implementation has two parts:

**Part A — in `mraid-wrapper.html` (or a shared harness script):**
```javascript
// Relay console output to the runner via postMessage
// (Only in test harness builds — guard with a query param or build flag)
if (location.search.includes('testMode=1')) {
  ['log', 'warn', 'error'].forEach(function(level) {
    var orig = console[level];
    console[level] = function() {
      var args = Array.from(arguments).map(String);
      try {
        // postMessage to parent — safe because runner is same origin as wrapper
        window.parent.postMessage({ type: '__SHARC_TEST_console', level: level, args: args }, '*');
      } catch(e) {}
      orig.apply(console, arguments);
    };
  });
}
```

**Part B — in `mraid-3-compliance-runner.html`:**
```javascript
window.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== '__SHARC_TEST_console') return;
  var msg = e.data.args.join(' ');
  logSys('[creative console.' + e.data.level + '] ' + msg);
  // Wire FAIL: / CHECK: to the compliance result
  if (msg.startsWith('FAIL:')) hasFatalError = true;
});
```

**Note on the sandbox boundary:** The sandboxed wrapper iframe has `allow-scripts` only (no `allow-same-origin`). `postMessage` *does* work across sandbox boundaries regardless of `allow-same-origin` — the iframe can `window.parent.postMessage(...)` successfully. The runner can receive it via `addEventListener('message', ...)`. The `targetOrigin` in `postMessage` should be set to the runner's origin (not `'*'`) if the runner is same-origin with the wrapper, which it is in the dev server setup.

**Priority:** Low. The current runner is useful without it. Implement when the compliance test suite is being hardened for CI use.

**No code change made for this item.** The fix requires design decisions about `testMode` gating and which files own the relay. Tracking as a future improvement per the existing comment in `observeComplianceAd()`.

---

## Item 2 — Callback Cleanup/Restore Pattern

**Assessment: Low severity — exploitable in narrow edge cases. Fixed.**

### The Pattern
After the wrapper loads the creative HTML and injects the companion `.js` via `<script src>`, the creative registers itself:

```javascript
// test-mraid-creative.js
window.__SHARC_TEST_mraidCreativeInit = function init() { ... };
```

The wrapper's `script.onload` handler then calls it:

```javascript
// mraid-wrapper.html (before fix)
script.onload = function () {
  if (typeof window.__SHARC_TEST_mraidCreativeInit === 'function') {
    window.__SHARC_TEST_mraidCreativeInit();  // called once
  }
  // function remains on window after this point
};
```

### Attack Analysis

#### Can a malicious creative re-invoke the init callback?

In the current architecture: **not via external callers**. The wrapper iframe is sandboxed (`allow-scripts` only). Nothing outside the sandbox can call `window.__SHARC_TEST_mraidCreativeInit` because:

1. External pages cannot access the sandboxed iframe's `window` object (cross-origin frame access is blocked).
2. The null-origin sandbox prevents the creative from accessing `window.parent`, so it cannot stage an attack through the parent frame.

#### What a malicious creative *can* do

A malicious creative runs in the **same document** as the wrapper (same window object, same DOM). It can:

1. **Re-invoke the callback itself** — the function is on `window`, the creative set it, and the creative can call `window.__SHARC_TEST_mraidCreativeInit()` again at any time after init:
   ```javascript
   // Malicious creative: re-invoke to re-run init
   setTimeout(function() {
     window.__SHARC_TEST_mraidCreativeInit(); // re-registers all event listeners
   }, 5000);
   ```
   This re-runs the init function: re-appends the protocol-log element, re-registers MRAID event listeners, and re-runs the bootstrap. In the test creative this doubles up event listeners. In a more complex creative it could corrupt state, inject DOM nodes, or generate spurious protocol events that confuse the SHARC container.

2. **Replace the callback** — a malicious creative could overwrite the property before the wrapper calls it:
   ```javascript
   window.__SHARC_TEST_mraidCreativeInit = function () { /* malicious code */ };
   ```
   This is already possible during the synchronous execution window between `document.body.innerHTML` injection and the `setTimeout(0)` callback in the wrapper. However, the wrapper is the one *setting up* this call chain, and the creative is loaded at a known point — this is not a realistic escalation path.

3. **Re-injection of DOM** — calling init twice re-runs `document.getElementById('protocol-log').appendChild(...)` repeatedly. This is DOM pollution, not sandbox escape.

#### Can this escape the sandbox?

**No.** The sandbox attribute on the outer SHARC container iframe constrains what the wrapper document can do. The creative and wrapper share the same sandbox, so re-invocations remain sandboxed. There is no escalation path to the publisher page.

#### Blast radius assessment

Severity: **Low**. The risk is:
- Test result corruption (spurious events, doubled listeners)
- UI state confusion in the test harness
- Not a sandbox escape or data exfiltration risk

In a production creative serving scenario, this pattern does not appear (the `__SHARC_TEST_` callbacks are test harness only), so production is unaffected.

### Fix Applied

**Delete the callback from `window` before invoking it** — the delete-before-call pattern eliminates the persistent reference. After the wrapper calls the function, no reference remains on the shared `window` for the creative (or any future code path) to invoke again.

**`examples/mraid-wrapper.html`** — changed `script.onload`:
```javascript
// Before
script.onload = function () {
  if (typeof window.__SHARC_TEST_mraidCreativeInit === 'function') {
    window.__SHARC_TEST_mraidCreativeInit();
  }
};

// After
script.onload = function () {
  if (typeof window.__SHARC_TEST_mraidCreativeInit === 'function') {
    var initFn = window.__SHARC_TEST_mraidCreativeInit;
    // Delete before calling: prevents a malicious or buggy creative from
    // re-invoking init (re-injecting DOM, re-registering listeners) if the
    // callback reference leaks or if a future code path calls it again.
    delete window.__SHARC_TEST_mraidCreativeInit;
    initFn();
  }
};
```

The same pattern was applied to **`examples/safeframe-wrapper.html`** for `window.__SHARC_TEST_sfCreativeInit`.

### Residual Consideration

The creative JS file itself holds a reference to `init` via the function declaration inside — but since `window.__SHARC_TEST_mraidCreativeInit` is deleted *before* `initFn()` runs, the creative cannot re-register by the simple `window.__SHARC_TEST_mraidCreativeInit = function init() {...}` pattern, because overwriting the property after deletion would require explicit re-assignment, which the legitimate test creatives don't do.

A truly malicious creative could still call a locally-captured reference or re-assign the property. This is an unavoidable consequence of sharing the same browsing context — the creative and wrapper run in the same window. The correct long-term fix for untrusted creatives is a dedicated sandboxed iframe per creative (nested-iframe model described in `ARCHITECTURE-NOTES.md §5`).

---

## Item 3 — CORS `*` on Dev Server (localhost-only binding)

**Assessment: Acceptable for dev use. Residual risks documented and manageable.**

### Configuration
`server.js` serves:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: *
```
Server is bound to `127.0.0.1:8765` (loopback only — not all interfaces).

### Why `*` Is Necessary Here
The sandboxed wrapper iframe has `origin: null` (null-origin sandbox). CORS preflight uses the document's origin in the `Origin` header. A null-origin request cannot use a specific `Allow-Origin` target — the only headers that satisfy null-origin CORS are `*` or `null`. Since `null` is not valid in `Access-Control-Allow-Origin`, `*` is the correct and only viable value for this use case.

### Threat Analysis

#### What `127.0.0.1` binding prevents
- **LAN/network attackers**: Cannot reach port 8765 at all. The socket is bound to loopback only.
- **Remote attackers**: No exposure — the port is not reachable from outside the machine.

#### Residual risks with CORS `*` on localhost

**1. DNS Rebinding (Low-Medium)**

Attack flow:
1. Attacker controls `evil.com` with short TTL
2. Developer visits `evil.com` in the same browser session the dev server is running
3. `evil.com` resolves to `127.0.0.1:8765`
4. JavaScript at `evil.com` makes `fetch('http://evil.com:8765/server.js')` (same-origin from browser's perspective after rebinding)
5. With CORS `*`, the server responds and the response is readable

**Actual risk**: The server serves static source files from the SHARC repo. No secrets, no credentials, no session tokens are served. An attacker who reads `server.js` or `sharc-protocol.js` gains access to open-source code. This is acceptable.

**If the repo ever contains secrets** (build artifacts with embedded API keys, `.env` files reachable from `ROOT`, etc.) this risk becomes material. Mitigation: a `HOST` header whitelist (`localhost` / `127.0.0.1` only) would defeat DNS rebinding at essentially zero cost.

**2. Malicious Browser Extension (Low)**

Browser extensions can make cross-origin requests bypassing standard CORS checks (they have `XMLHttpRequest` with `mozSystem` or Manifest V3 `fetch` with host permissions). A compromised extension could read files from the dev server regardless of `Allow-Origin`. This is a browser extension threat model, not a server configuration issue. Not mitigated by CORS headers. Acceptable for a dev server.

**3. Other Local Processes (Low)**

Any process on the machine can connect to `127.0.0.1:8765` (CORS headers are irrelevant for non-browser clients like `curl`). This is standard for any local dev server and is not a CORS issue.

**4. Local Web Page in Same Browser Session (Low-Medium)**

A web page opened in the same browser can `fetch('http://localhost:8765/...')` and, with `Access-Control-Allow-Origin: *`, read the response. This is the code reviewer's concern (Item C). The page would need to know port 8765 is active and serving SHARC files. Content served: open-source JS files. Risk: low.

### Verdict

**No code change required.** The `*` CORS is architecturally necessary (null-origin sandbox), the `127.0.0.1` binding eliminates network-level exposure, and the served content contains no secrets. The dev server already carries the `// DEV SERVER ONLY — NOT FOR PRODUCTION USE — DO NOT DEPLOY` banner.

**One low-cost hardening option worth considering in a future pass:**

Add a `Host` header whitelist to defeat DNS rebinding at zero functionality cost:
```javascript
// At the top of the request handler:
const host = req.headers['host'] || '';
if (host !== 'localhost:8765' && host !== '127.0.0.1:8765') {
  res.writeHead(400);
  res.end('Bad Request');
  return;
}
```
This makes the server reject any request whose `Host` header doesn't match — the defining characteristic of a DNS rebinding request. **Not implementing this now** because: (a) it changes behavior for legitimate multi-device dev setups where developers proxy through another hostname, and (b) the served content has no secret value. Documenting for future hardening.

---

## Code Changes Made

| File | Change | Reason |
|------|--------|--------|
| `examples/mraid-wrapper.html` | `script.onload`: stash → delete `__SHARC_TEST_mraidCreativeInit` → call | Prevent creative re-invocation of init callback |
| `examples/safeframe-wrapper.html` | `script.onload`: stash → delete `__SHARC_TEST_sfCreativeInit` → call | Same |

---

## What Was Not Changed and Why

| Item | Decision |
|------|----------|
| Console interception in `mraid-3-compliance-runner.html` | No change — requires `postMessage` relay design (not a console.log monkey-patch), scope exceeds this review |
| `Access-Control-Allow-Origin: *` in `server.js` | No change — architecturally necessary for null-origin sandbox; `127.0.0.1` bind is the correct layer of defense; no secrets served |
| `Host` header whitelist in `server.js` | Not implemented — low value given no secrets; left as documented future option |

---

*Security review complete. 2 files changed. Item 1 documented as future improvement with correct implementation guidance. Item 2 fixed (delete-before-call). Item 3 confirmed acceptable with residual risks documented.*
