# Frontend Review — 2026-04-09

**Reviewer:** Senior Developer (frontend engineering & UX perspective)  
**Scope:** Test harnesses, wrappers, and test creatives in `examples/test/` and `examples/`

---

## Summary

The test harnesses are well-crafted developer tools with a premium dark UI, real-time protocol logging, and clear state visualization. The codebase is consistent between MRAID and SafeFrame variants. This review found **3 bugs** (1 critical, 2 moderate) that were fixed, plus several UX improvements applied and a set of larger recommendations.

---

## Bugs Fixed

### 🔴 Critical: Compliance runner ad paths are wrong (`getAdUrl()` missing prefix)

**File:** `mraid-3-compliance-runner.html`  
**Issue:** `getAdUrl()` returned paths like `loadandevents/ad.html` but the compliance ads live at `compliance-ads/loadandevents/ad.html`. The wrapper resolves URLs relative to `examples/mraid-wrapper.html`, so every compliance test would 404 silently — the ad slot stays blank with no error.  
**Fix:** Prefixed all paths with `compliance-ads/`.

### 🟡 Moderate: Session poll interval never times out

**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** `setInterval(..., 100)` polls for the session ID indefinitely. If `SHARC.Container` never establishes a session (init failure, protocol mismatch), the interval runs forever — a slow memory/CPU leak in a developer's browser tab.  
**Fix:** Added `setTimeout(function () { clearInterval(sessionPoll); }, 10000)` — 10-second safety net.

### 🟡 Moderate: `updateState(null)` produces trailing space in className

**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** `el.className = 'state-val ' + (state || '')` produces `'state-val '` when state is null/undefined, leaving a trailing space in the class attribute.  
**Fix:** Changed to `el.className = state ? 'state-val ' + state : 'state-val'`.

---

## UX Improvements Applied

### Loading shimmer on ad slot

**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** The ad slot was a blank black rectangle until the iframe rendered. No visual feedback that loading was in progress.  
**Fix:** Added a CSS shimmer animation overlay (`#ad-loading-overlay`) that appears on "Load Ad" click and hides when the container reaches `active` state, or on close/error. Gives instant visual feedback.

### Missing `state-val.loading` CSS

**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** The `loading` state displayed in the default color (inherited from `.state-val`) — indistinguishable from an unknown state. Every other state (`active`, `passive`, `hidden`, `frozen`, `ready`, `dead`) had a distinct color.  
**Fix:** Added `.state-val.loading { color: #fbbf24; }` (amber/yellow).

### Compliance runner: errors not visually distinguishable from system messages

**File:** `mraid-3-compliance-runner.html`  
**Issue:** The log used `logMsg('sys', ...)` for errors — errors appeared in gray, identical to informational system messages. The `err` direction had no CSS or label defined.  
**Fix:** Added `.log-err` CSS (red), `err: '✗ERR'` to the direction labels map, and a `logErr()` helper. Changed all error-path logging to use `logErr()`.

### Compliance runner: silently swallowed teardown error

**File:** `mraid-3-compliance-runner.html`  
**Issue:** `try { container.close(); } catch(e) {}` — if teardown throws, the error is completely invisible.  
**Fix:** Changed to `catch(e) { logErr('Error closing previous container: ' + e.message); }`.

---

## Error Visibility (Wrappers)

**Note:** The error visibility improvements for `mraid-wrapper.html` and `safeframe-wrapper.html` (visible red error overlays replacing console-only errors) were applied in the security review commit (`ca95427`). This review confirms they are adequate — all `console.error()` calls now also surface a visible `#sharc-load-error` overlay.

---

## Recommendations (Not Yet Implemented)

### R1: Mobile/Responsive Layout

**Priority:** Medium  
**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** The left panel has `min-width: 360px` and the layout is `display: flex` with no `@media` breakpoints. On viewports narrower than ~720px, the page forces a horizontal scroll — unusable on mobile. These harnesses test *mobile ad formats* (320×250), so mobile usability matters.  
**Recommendation:** Add a `@media (max-width: 768px)` breakpoint that stacks `.main-layout` vertically, sets `.left-panel` to `width: 100%; min-width: auto`, and collapses the protocol log into a toggleable panel or a bottom sheet. The ad slot (320px wide) fits a phone screen; the sidebar controls and log just need to stack below it.

### R2: Auto-scroll pause on user scroll-up

**Priority:** Low  
**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** `autoScroll` is hardcoded to `true`. If a developer scrolls up in the protocol log to inspect an earlier message, the next log entry immediately snaps the scroll back to the bottom. This is a common UX annoyance in streaming log views.  
**Recommendation:** Add a scroll event listener that sets `autoScroll = false` when the user scrolls away from the bottom, and re-enables it when they scroll back to the bottom. Pattern:
```js
logEl.addEventListener('scroll', function () {
  autoScroll = (logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20);
});
```

### R3: Creative load timeout in test harnesses

**Priority:** Medium  
**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** If the creative never loads (XHR succeeds but the script hangs, or `__SHARC_TEST_*Init()` is never called), the harness sits in "loading" state forever with no indication anything is wrong. The compliance runner has a 30s timeout, but the main harnesses don't.  
**Recommendation:** Add a 15-second timeout after clicking "Load Ad" that, if the state hasn't progressed past `loading`, logs a warning: `"Creative may not have loaded — still in 'loading' state after 15s"` and shows an amber indicator.

### R4: Compliance runner — intercept console.log for pass/fail

**Priority:** Low  
**File:** `mraid-3-compliance-runner.html`  
**Issue:** The compliance runner note says "intercepting console output for automated pass/fail is a future improvement." The IAB compliance ads self-report via `console.log('CHECK:' / 'FAIL:')`. Currently the runner only observes state changes, which is a weak pass/fail heuristic.  
**Recommendation:** Intercept `console.log` inside `observeComplianceAd()`:
```js
const origLog = console.log;
console.log = function (...args) {
  origLog.apply(console, args);
  const msg = args.join(' ');
  if (msg.includes('FAIL:')) hasFatalError = true;
  if (msg.includes('CHECK:')) logOk(msg);
};
```

### R5: Keyboard shortcut discoverability

**Priority:** Low  
**Files:** `mraid-test.html`, `safeframe-test.html`  
**Issue:** `Cmd+L` to load and `Escape` to close are useful shortcuts but completely undiscoverable. No tooltip, no help text, no footer hint.  
**Recommendation:** Add a small footer or tooltip: `⌘L Load · Esc Close`.

### R6: Compliance runner `observeComplianceAd` — interval leak on Promise double-resolve

**Priority:** Low  
**File:** `mraid-3-compliance-runner.html`  
**Issue:** `observeComplianceAd()` creates both a `setTimeout` (30s) and a `setInterval` (500ms). If the interval resolves the Promise first, the timeout still fires `resolve()` again. While Promises ignore double-resolve, the `pollCheck` interval should be cleared inside the timeout path too.  
**Recommendation:** Add `clearInterval(pollCheck)` inside the `setTimeout` callback:
```js
const timer = setTimeout(() => {
  clearInterval(pollCheck);
  resolve(...);
}, maxWait);
```

### R7: `observeComplianceAd` callback interception is fragile

**Priority:** Low  
**File:** `mraid-3-compliance-runner.html`  
**Issue:** The function intercepts `container.onError` and `container.onStateChange` by reassigning properties on the container object. This assumes these are writable own-properties. If the container uses `Object.defineProperty`, getters, or an internal options object, the interception silently does nothing.  
**Recommendation:** If the SHARC.Container API supports an `addEventListener`-style pattern, use that instead. Otherwise, document this fragility with a comment and add a defensive check (e.g., verify that the property was actually replaced).

---

## Consistency Assessment

The MRAID and SafeFrame harnesses are highly consistent:
- ✅ Identical layout structure (left panel + right log)
- ✅ Same button grid and simulation controls
- ✅ Same protocol log format with directional labels
- ✅ Same keyboard shortcuts
- ✅ Consistent color theming (purple for MRAID, teal for SafeFrame)
- ✅ Both share the same JS patterns (state management, logging, fallback)

The only intentional differences are:
- Bridge-specific terminology (MRAID events vs SafeFrame callbacks)
- SafeFrame info box has additional notes about API differences
- Color accent (purple vs teal) for visual distinction

This is excellent consistency for developer tooling.

---

## Files Modified

| File | Changes |
|------|---------|
| `examples/test/mraid-test.html` | Loading shimmer, `state-val.loading` CSS, `updateState` fix, session poll timeout, loading overlay hooks |
| `examples/test/safeframe-test.html` | Same as MRAID harness (matching changes) |
| `examples/test/mraid-3-compliance-runner.html` | `getAdUrl()` path fix, `logErr` support + CSS, error logging improvements |
| `examples/mraid-wrapper.html` | *(Already fixed in security review)* Error overlay for all failure paths |
| `examples/safeframe-wrapper.html` | *(Already fixed in security review)* Error overlay for all failure paths |
