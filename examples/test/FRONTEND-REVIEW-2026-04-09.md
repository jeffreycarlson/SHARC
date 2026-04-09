# Frontend Review — 2026-04-09

Scope: test harness HTML files in `examples/test/` and both creative wrappers (`examples/mraid-wrapper.html`, `examples/safeframe-wrapper.html`).

---

## Fixed — Silent Failures

### 1. `mraid-wrapper.html` — Missing `__SHARC_TEST_mraidCreativeInit` after script load

**Problem:** In the `script.onload` callback for the HTML-creative path, the wrapper checked whether `window.__SHARC_TEST_mraidCreativeInit` was defined and called it if so — but if the function was *not* defined (script loaded but forgot to export the hook), nothing happened and no error was shown. A developer loading a misconfigured creative would see a blank ad with zero feedback.

**Fix:** Added an `else` branch that calls `showError()` with a clear message:

```js
} else {
  showError('Creative script loaded but window.__SHARC_TEST_mraidCreativeInit is not defined.\n'
    + 'Ensure ' + jsUrl + ' exposes window.__SHARC_TEST_mraidCreativeInit.');
}
```

**File:** `examples/mraid-wrapper.html`

---

### 2. `safeframe-wrapper.html` — Missing `__SHARC_TEST_sfCreativeInit` after script load

**Problem:** Identical issue to #1 but for the SafeFrame path. If `window.__SHARC_TEST_sfCreativeInit` was not defined after script load, the failure was completely silent.

**Fix:** Same `else` + `showError()` pattern as above.

**File:** `examples/safeframe-wrapper.html`

---

### 3. `mraid-3-compliance-runner.html` — Bare `catch(e) {}` on `container.close()`

**Problem:** When tearing down the previous container before running the next test, a bare `catch(e) {}` swallowed any close error without even a console log entry. If the container was in a bad state and threw on `close()`, the runner would silently continue as if nothing happened.

**Fix:** Changed to `catch(e) { logErr('Error closing previous container: ' + e.message); }` so the error surfaces in the protocol log.

**File:** `examples/test/mraid-3-compliance-runner.html`

---

## Not Fixed — Recommendations Only

### R1. Loading indicator while creative loads

**Scope:** `mraid-test.html`, `safeframe-test.html` both have a shimmer overlay (`#ad-loading-overlay`) that shows on `loadAd()` and hides on `onStateChange → active`. `index.html` has no loading overlay at all.

**Recommendation:** Add a similar shimmer/spinner to `index.html` so the user has visual feedback while the container bootstraps. Also consider showing the overlay for the compliance runner (`mraid-3-compliance-runner.html`) while a test is running.

---

### R2. Timeout handling if creative never calls init

**Scope:** Both wrappers (`mraid-wrapper.html`, `safeframe-wrapper.html`) and the test harnesses.

**Recommendation:** If `__SHARC_TEST_mraidCreativeInit` / `__SHARC_TEST_sfCreativeInit` is never called (e.g., the script loads but hangs, or the creative has a JS runtime error before registering the hook), the wrappers currently wait forever with no timeout. Likewise, the harnesses show a perpetual loading shimmer if `onStateChange → active` never fires.

Suggested fix: set a watchdog (e.g., 10 s) in both the wrapper `onload` path and the harness `loadAd()` that calls `showError()` / `logErr()` and clears the shimmer if `active` state is never reached.

---

### R3. Consistency gaps between MRAID and SafeFrame harnesses

The two bridge harnesses are functionally equivalent but differ in small ways that could cause confusion during parallel development:

| Area | `mraid-test.html` | `safeframe-test.html` |
|---|---|---|
| Fallback iframe `onload` | Calls `hideLoadingOverlay()` | No `onload` handler — shimmer may persist |
| Info box | Explains MRAID contract | Explains SafeFrame contract + key differences from MRAID |
| State simulation labels | "Resume →A / →H" | Same labels (consistent ✓) |
| Creative URL note | Shows `mraid-wrapper.html` | Shows `safeframe-wrapper.html` (consistent ✓) |

**Recommendation:** Add an `onload = function () { hideLoadingOverlay(); }` to the SafeFrame fallback iframe (mirrors the MRAID harness). Consider extracting the shared `logMsg` / `escHtml` / `ts()` utilities into a shared `test-harness-common.js` to reduce drift risk.

---

### R4. Mobile / responsive considerations

All harnesses use a fixed two-column layout (`left-panel: 360px min-width` + flex right panel). On viewports narrower than ~700 px the right panel collapses to near-zero width and the log becomes unusable.

**Recommendation:**
- Add a `@media (max-width: 700px)` breakpoint that stacks the panels vertically (`flex-direction: column`).
- The ad slot is hardcoded at `320×250 px` which is fine for the current test creative, but the outer `.ad-slot-outer` container has no max-width constraint — on small screens it overflows.
- Consider capping `.left-panel` at `100%` width on narrow viewports.

---

### R5. Accessibility basics

Current harnesses have a few minor gaps:

| Item | File(s) | Recommendation |
|---|---|---|
| Buttons with emoji-only labels (e.g. `▶`, `✕`) have no `aria-label` | all harnesses | Add `aria-label="Load Ad"` etc. |
| Log panel (`#protocol-log`, `#messageLog`) has no `role` or `aria-live` | all harnesses | Add `role="log"` + `aria-live="polite"` so screen readers announce new entries |
| Sim buttons (`→ Active`, `→ Passive`, …) use arrow characters as labels | all harnesses | Consider replacing with text-only labels or adding `aria-label` |
| `<button>` elements inside `onclick=` attribute strings | all harnesses | Minor: inline `onclick` handlers are fine for test tooling but consider `addEventListener` for consistency with the rest of the script blocks |
| No `<label>` or visible focus ring override | all harnesses | The `btn:disabled` rule removes `transform` but focus styles rely entirely on browser defaults; add an explicit `:focus-visible` outline |

These are dev-tooling pages, so WCAG compliance is a lower priority than in production. Still worth fixing before any public demo or team onboarding.

---

*Review performed by EngineeringSeniorDeveloper — fixes committed as `fix: frontend review - surface silent failures as visible errors` and `docs: frontend review 2026-04-09`.*
