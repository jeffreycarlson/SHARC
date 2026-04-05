# SHARC Reference Implementation — Fix Summary

**Author:** Software Architect (subagent)  
**Date:** 2026-04-03  
**Scope:** All Critical and High security issues, all 3 blocking code review issues, plus Medium and yellow-flag code review issues.

---

## Syntax Check Status

All three files pass `node --check`:

```
✅ sharc-protocol.js — PASS
✅ sharc-container.js — PASS
✅ sharc-creative.js  — PASS
```

---

## Critical Fixes

### SEC-001 — `allow-same-origin` removed from iframe sandbox (`sharc-container.js`)

**Status:** ✅ Fixed

Removed `allow-same-origin` from the iframe sandbox attribute list. This attribute combined with `allow-scripts` on a same-origin iframe allows a malicious creative to remove its own sandbox and gain full publisher-page access. MessageChannel does **not** require `allow-same-origin`; the transferred port works across origins.

Also removed `allow-popups-to-escape-sandbox` (SEC-010): this grants opened popups full unsandboxed capability including `window.opener` access. All navigation should go through `requestNavigation` instead.

---

## High Severity Fixes

### SEC-002 — Fallback transport JSON.stringify removed (`sharc-protocol.js`)

**Status:** ✅ Fixed (also fixes 🔴 Code Review Blocker: Fallback uses JSON.stringify)

Both `SHARCContainerProtocol._sendMessage()` and `SHARCCreativeProtocol._sendMessage()` in the fallback path previously called `JSON.stringify(message)` before posting. This violates the spec (architecture-design.md §3.3) which mandates Structured Clone.

`window.postMessage()` already uses Structured Clone natively — the message object is now passed directly without serialization. The `_setupFallbackTransport` receive path also removed the `JSON.parse` branch; it now passes `event.data` directly (already a plain object via Structured Clone).

Added a detailed comment explaining the `*` targetOrigin rationale for the fallback path (bootstrap-only `*` is justified; fallback uses `*` only because the architecture doc describes this as "effectively zero real-world cases").

### SEC-003 — URL validation on `requestNavigation` (`sharc-container.js`)

**Status:** ✅ Fixed

Added `_isNavigationUrlSafe(url)` method that parses the URL and only permits `https:` and `http:` schemes. All other schemes (`javascript:`, `data:`, `file:`, custom OS deep-links, etc.) are rejected. The container now rejects the protocol message with `ErrorCodes.MESSAGE_SPEC_VIOLATION` for unsafe URLs before any navigation action.

### SEC-004 — URL validation on `reportInteraction` tracker URIs (`sharc-container.js`)

**Status:** ✅ Fixed

`_handleReportInteraction` now filters `trackingUris` through `_isNavigationUrlSafe()` and caps the array at 20 entries (`MAX_TRACKERS`) before firing. Unsafe URIs are silently dropped (they never reach `_fireTrackers`). This prevents SSRF, scheme abuse, and tracker flooding.

### SEC-005 — `requestFeature` arbitrary message type construction (`sharc-creative.js`)

**Status:** ✅ Fixed

Added strict regex validation (`/^com\.[a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9]*$/i`) on `featureName` before constructing the message type string. Feature names that don't conform are rejected with a descriptive error. This prevents creatives from crafting feature names that produce message types colliding with built-in protocol handlers (e.g., `com.evil.x.Close` → `SHARC:Creative:requestClose`).

---

## Code Review Blocker Fixes (🔴)

### Fallback transport uses JSON.stringify

**Status:** ✅ Fixed — see SEC-002 above.

### `requestNavigation` never resolved/rejected by container (`sharc-container.js`)

**Status:** ✅ Fixed

`_handleRequestNavigation()` previously had the comment "Navigation message does not require a resolve" — this was wrong. The spec requires `resolve` or `reject`. The handler now:
- **Validates the URL** (SEC-003) and rejects with `MESSAGE_SPEC_VIOLATION` for unsafe URLs.
- **Resolves** on successful navigation (custom handler or default `window.open`).
- **Rejects** with `ErrorCodes.UNSPECIFIED_CONTAINER` when no navigation handler can handle the type.

Also added `CreativeMessages.REQUEST_NAVIGATION` to `MESSAGES_REQUIRING_RESPONSE` in `sharc-protocol.js` (was missing — without it, `_sendMessage` treated navigation as fire-and-forget and resolved immediately with `undefined`).

### `requestNavigation` return value dropped on creative SDK (`sharc-creative.js`)

**Status:** ✅ Fixed

`SHARCCreativeSDK.requestNavigation()` previously called `this._proto.requestNavigation(...)` without returning the result, making `await SHARC.requestNavigation(...)` impossible. It now returns the promise. The dead-state early return also now returns `Promise.resolve()` instead of `undefined` for API consistency.

---

## Medium / Yellow-Flag Code Review Fixes

### 🟡 `terminate()` breaks messageId sequencing (`sharc-protocol.js`)

**Status:** ✅ Fixed

`terminate()` now has an idempotency guard (`if (this._terminated) return`). The synthetic reject message passed to each pending callback now includes the correct `messageId` in `args` (using the map key, cast to Number). Both `terminate()` and `reset()` now reject pending callbacks before clearing the map to prevent hanging Promises.

### 🟡 `HIDDEN → PASSIVE` transition missing from state table

**Status:** ✅ Confirmed already present (no bug). The code review note confirmed this after re-checking.

### 🟡 `ACTIVE → HIDDEN` transition missing in container (`sharc-protocol.js`, `sharc-container.js`)

**Status:** ✅ Fixed

Added `ContainerStates.HIDDEN` to the `ACTIVE` transitions in `STATE_TRANSITIONS`. The Page Lifecycle API can fire `visibilitychange` from the `active` state on mobile without a prior `blur` event. `_onVisibilityChange()` in the container now handles `ACTIVE` and `PASSIVE` as separate branches (both transition to `HIDDEN`) with clear comments explaining the rationale.

### 🟡 Duplicate close listener behavior in creative SDK (`sharc-creative.js`)

**Status:** ✅ Fixed

The `_closeHandler` private field and the separate `if (event === 'close')` assignment in `on()` have been removed. `_handleClose()` now reads all listeners from `_eventListeners['close']` directly, runs them all inside the watchdog (collecting their return Promises via `Promise.all`), and resolves only after all handlers complete (or the watchdog fires). Previously:
- `_emit('close')` fired the listener once.
- `this._closeHandler()` fired the last-registered listener a second time.
- Only the last-registered handler participated in the watchdog.

### 🟡 `MESSAGES_REQUIRING_RESPONSE` missing `REQUEST_NAVIGATION` (`sharc-protocol.js`)

**Status:** ✅ Fixed — `CreativeMessages.REQUEST_NAVIGATION` added to the Set.

### 🟡 `_destroy()` double-call guard (`sharc-container.js`)

**Status:** ✅ Fixed

Added `this._destroyed = false` to the constructor and a `if (this._destroyed) return; this._destroyed = true;` guard at the top of `_destroy()`. `_handleFatalError` can call `_destroy()` up to three times (`.then()`, `.catch()`, and the `setTimeout` fallback); the guard ensures `_onClose` fires exactly once and the iframe is not removed multiple times.

---

## Additional Medium Security Fixes

### SEC-006 — Session ID format validation (`sharc-protocol.js`)

**Status:** ✅ Fixed

`SHARCContainerProtocol.acceptSession()` now validates the provided session ID against a UUID v4 regex before accepting it. Invalid IDs are rejected with `ErrorCodes.INIT_SPEC_VIOLATION`. The private `_isValidUUID()` helper is used for this check.

### SEC-007 — Rate limiting on incoming messages (`sharc-protocol.js`)

**Status:** ✅ Fixed

Added a sliding-window rate limiter (`_rateLimitAllow()`) that permits a maximum of 50 messages per second. Excess messages are dropped with a `console.warn`. The `_rateLimiterTimestamps` array is managed in the base class constructor and evicts timestamps older than 1 second on each check.

### SEC-011 — Unbounded `_pendingResponses` map (`sharc-protocol.js`)

**Status:** ✅ Fixed

`_sendMessage()` now checks `Object.keys(this._pendingResponses).length >= 100` before inserting a new pending response entry. Requests exceeding the cap are rejected immediately with an explanatory error.

### SEC-012 — `requestPlacementChange` CSS injection via string dimensions (`sharc-container.js`)

**Status:** ✅ Fixed

Added `_sanitizeDimension(val)` that accepts only non-negative numbers (converted to `${n}px`) or strings matching `\d+(\.\d+)?(px|%)`. All other strings (including those containing semicolons, CSS property chains, or viewport units) are rejected (return `null`) and not applied to the iframe style. `_applyIframeDimensions()` now uses this sanitizer.

---

## Issues Not Fixed (Out of Scope / Low / Documented)

- **SEC-008** (Bootstrap origin validation) — Low: `event.source !== window.parent` check should be added. Not fixed in this pass; requires coordination with spec on expected container identity.
- **SEC-009** (Creative log forwarding) — Low: `console.log` of `msg.args.message` without truncation. Minor and out of scope for this pass.
- **SEC-013** (Test harness exposes `_protocol`) — Low: test file only, not in scope.
- **SEC-014** (messageId monotonicity) — Low: requires tracking last-seen remote messageId; deferred.
- **SEC-015** (No CSP on iframe) — Low: publisher-side configuration; not a code fix.
- **SEC-016** (Math.random UUID fallback) — Low: only used when `crypto.randomUUID` is unavailable (very rare modern environments).
- **iframe 50ms boot delay** — Code review yellow flag: fragile but not a security issue; not changed.
- **Double-destroy race in `_handleFatalError`** — Fixed via `_destroy()` guard above.
