# SHARC Reference Implementation — Code Review

**Reviewer:** OpenClaw Code Review Agent  
**Date:** 2026-04-03  
**Scope:** First-pass implementation review against architecture-design.md and api-reference.md  
**Audience:** Jeffrey Carlson, Project Co-Chair  

---

## Executive Summary

The implementation is solid for a first pass. The architecture is faithfully translated, the code is readable, and the most important design decisions (MessageChannel primary transport, Structured Clone, Page Lifecycle state machine) are correctly implemented. There are no catastrophic bugs that would cause silent failures at scale.

That said, there are **three issues that should be fixed before this is used as a normative reference**, and a handful of spec divergences that will confuse implementers reading the code alongside the spec. None rise to the level of "embarrassing to ship" on their own, but collectively they matter for a reference implementation — people will copy this code verbatim.

**Priority summary:**
- 🔴 **Block before release (3 issues):** fallback transport uses JSON.stringify in violation of spec, navigation message is not resolved/rejected by container, `requestNavigation` drops its return value on the creative SDK side.
- 🟡 **Fix before release, lower urgency (7 issues):** messageId sequencing bug in `terminate()`, `HIDDEN → PASSIVE` transition missing from state table, duplicate/conflicting close listener behavior in `on('close')`, iframe 50ms boot delay, double-destroy race in `_handleFatalError`, missing `REQUEST_NAVIGATION` from `MESSAGES_REQUIRING_RESPONSE`, missing `test-creative.html`.
- 🟢 **Quality improvements (several):** minor API design nits, missing JSDoc, edge case gaps.

---

## File 1: `sharc-protocol.js`

### 1. Overall Quality

Good. This is the most important file and it's in the best shape. The class hierarchy is clean, the message bus abstraction is sound, the constants are well-organized. The state machine is a genuinely nice piece of work — enforcing transitions without throwing is the right call for a runtime library.

### 2. Bugs and Correctness Issues

#### 🔴 Bug: Fallback transport uses `JSON.stringify` — spec violation

**Location:** `SHARCContainerProtocol._sendMessage()` (overridden), `SHARCCreativeProtocol._sendMessage()` (overridden), `SHARCCreativeProtocol._setupFallbackTransport()`

The spec (architecture-design.md §3.3, api-reference.md §2) is explicit and emphatic: **no JSON.stringify**. The fallback transport path in both the container and creative protocol overrides uses `JSON.stringify`:

```javascript
// sharc-protocol.js — container fallback
this._fallbackTarget.postMessage(JSON.stringify(message), '*');

// sharc-protocol.js — creative fallback  
window.parent.postMessage(JSON.stringify(message), '*');

// sharc-protocol.js — creative fallback receive
const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
```

I understand the fallback path exists for a stated "effectively zero real-world cases" scenario. But this is a **reference implementation**. If it ships with `JSON.stringify` in it, implementers will copy it, and the spec's Structured Clone requirement will be undermined from day one.

The fix is straightforward: `window.postMessage` already uses Structured Clone. The fallback should pass the message object directly, not as a JSON string:

```javascript
// Correct fallback send — postMessage uses Structured Clone natively
this._fallbackTarget.postMessage(message, '*');
```

The `JSON.parse` receive path in `_setupFallbackTransport` should also be removed.

#### 🟡 Bug: `terminate()` breaks pending response correlation

**Location:** `SHARCProtocolBase.terminate()`

```javascript
terminate() {
  this._terminated = true;
  const termError = { errorCode: ErrorCodes.UNSPECIFIED_CONTAINER, message: 'Protocol terminated' };
  Object.values(this._pendingResponses).forEach((cb) => {
    cb({ type: ProtocolMessages.REJECT, args: { value: termError } });
  });
```

The synthetic reject message sent to each pending callback is missing the required `messageId` in `args`. The `_handleResponse` method reads `data.args.messageId` to correlate the response. More importantly, the callbacks here were already looked up by their messageId key — they don't need re-correlation. This is probably fine at runtime because the callback is called directly, but the synthetic message structure is malformed. If any callback does inspect the message structure (for error handling), it'll see a malformed object. At minimum, add a comment; better is to call the callbacks with a properly structured synthetic message.

#### 🟡 Bug: `STATE_TRANSITIONS` is missing `HIDDEN → PASSIVE`

**Location:** `STATE_TRANSITIONS` constant, `sharc-protocol.js`

```javascript
[ContainerStates.HIDDEN]: [ContainerStates.PASSIVE, ContainerStates.FROZEN, ContainerStates.TERMINATED],
```

Wait — this is actually correct in the constant. But compare to the container's `_onVisibilityChange`:

```javascript
// sharc-container.js
} else if (document.visibilityState === 'visible') {
  if (state === ContainerStates.HIDDEN) {
    this.setState(ContainerStates.PASSIVE);
  }
}
```

`HIDDEN → PASSIVE` is in the state table, so the transition is valid. ✅ No bug here. See the container section for related handling concerns.

#### 🟡 Issue: `MESSAGES_REQUIRING_RESPONSE` is missing `REQUEST_NAVIGATION`

**Location:** `MESSAGES_REQUIRING_RESPONSE` Set, `sharc-protocol.js`

```javascript
const MESSAGES_REQUIRING_RESPONSE = new Set([
  ContainerMessages.INIT,
  ContainerMessages.START_CREATIVE,
  ContainerMessages.FATAL_ERROR,
  ContainerMessages.CLOSE,
  CreativeMessages.GET_CONTAINER_STATE,
  CreativeMessages.GET_PLACEMENT_OPTIONS,
  CreativeMessages.REPORT_INTERACTION,
  CreativeMessages.REQUEST_PLACEMENT_CHANGE,
  CreativeMessages.REQUEST_CLOSE,
  CreativeMessages.GET_FEATURES,
  ProtocolMessages.CREATE_SESSION,
]);
```

`CreativeMessages.REQUEST_NAVIGATION` is absent. Per the spec, `requestNavigation` requires `resolve` or `reject`. Without it, `_sendMessage` will use fire-and-forget and the creative's `requestNavigation()` call will resolve immediately with nothing, defeating the entire "log all navigation events" guarantee. This also means the creative can't distinguish between "you handle it" (reject 2105) and "we handled it" (resolve).

### 3. API Design Issues

#### `SHARCProtocolBase._resolve()` and `_reject()` are underscore-prefixed but are called from outside the class

In `sharc-container.js`, the container calls `this._protocol._resolve(msg, ...)` and `this._protocol._reject(msg, ...)` directly (not through a wrapper). This is a leaky abstraction. The protocol should expose `acceptSession`, but the container shouldn't need to reach into `_resolve` directly. `SHARCContainerProtocol` should expose `resolveMessage(msg, value)` and `rejectMessage(msg, code, text)` as public methods.

#### `SHARCCreativeProtocol` exposes `resolve()` and `reject()` publicly, but the container protocol does not

The creative protocol correctly exposes `resolve(msg, value)` and `reject(msg, code, text)` as first-class public methods because creative SDK code needs to call them. The container protocol doesn't — it reaches down to `_resolve` instead. Inconsistent.

#### `requestFeature` generates nonstandard message types

**Location:** `SHARCCreativeSDK.requestFeature()` in `sharc-creative.js` (see that section)

The feature name splitting happens on `.` and takes the last segment, then capitalizes it. For `com.iabtechlab.sharc.audio` this produces `SHARC:Creative:requestAudio`. That's correct. But for a feature like `com.example.myCompany.customTracking`, you get `SHARC:Creative:requestCustomTracking` — fine. What about `com.example.feature`? You get `SHARC:Creative:requestFeature` — which is a collision with a hypothetical `getFeatures` method or any feature literally named "feature". The spec says the message type is `SHARC:Creative:request` + feature name capitalized, but doesn't define exactly how the full namespaced name maps to the type. This needs a spec note.

### 4. Missing Edge Cases

- **`createSession` before port is ready:** If `createSession()` is called before `_attachPort()` has been called (i.e., the bootstrap `SHARC:port` message hasn't arrived yet), `_sendMessage` returns `Promise.reject(new Error('No MessagePort available'))`. The creative SDK catches this (`_startSession` has a `.catch`), but the session is then dead. There's no retry mechanism. In fast-loading pages this is fine, but in slow environments (large creative bundles) where `createSession` is called before the port bootstrap arrives, the ad will silently fail. The protocol should either queue the message or the creative should be able to re-initiate.

- **Multiple `SHARC:port` messages:** `_onBootstrapMessage` removes the listener after the first `SHARC:port` message (correct, uses `{ once: true }` equivalent). But it doesn't validate that the message came from a trusted source. The architecture document acknowledges the `*` targetOrigin concern. However, the creative's `_onBootstrapMessage` accepts a port from *any* origin. A malicious script on the page could send a fake `SHARC:port` message and hijack the creative's protocol. The spec says to document this; the code should at minimum have a comment explaining why this is acceptable, citing architecture-design.md §5.

- **`removeListener` doesn't prevent double-add:** If `addListener` is called twice with the same callback, `removeListener` only removes the first occurrence. Not a critical bug, but a source of hard-to-debug double-dispatch.

### 5. Line-Level Notes

- **Line ~152, `_sendMessage`:** The comment says "Fire-and-forget — still return a resolved Promise for API consistency." Good. But the returned `Promise.resolve()` has no value. Callers who do `await _sendMessage(...)` get `undefined`. That's probably fine for fire-and-forget, but worth documenting explicitly.

- **`_onPortMessage`:** The comment "could be a race during session establishment" is doing a lot of work. Be more specific: this is the case where a `resolve` or `reject` arrives for a `createSession` we already cleaned up. Add a note.

- **`SHARCStateMachine` swallows listener errors:** The `onChange` dispatch does `try { fn(...); } catch(e) { /* swallow */ }`. For a reference implementation that devs will run in dev mode, swallowing errors makes debugging harder. Log the error even if you don't rethrow:
  ```javascript
  } catch(e) { console.error('[SHARC StateMachine] onChange listener error:', e); }
  ```

---

## File 2: `sharc-container.js`

### 1. Overall Quality

Good structure, all the right handlers are present. The lifecycle handling is mostly correct. The main concerns are an architectural leak (calling `_resolve` directly on the protocol), a behavior gap in navigation handling, and a double-destroy race condition.

### 2. Bugs and Correctness Issues

#### 🔴 Bug: `requestNavigation` is never resolved or rejected

**Location:** `_handleRequestNavigation()`, `sharc-container.js`

```javascript
_handleRequestNavigation(msg) {
  const navArgs = msg.args || {};
  if (this._onNavigation) {
    this._onNavigation(navArgs);
  } else {
    // Default behavior: open clickthrough in new tab
    const { url, target } = navArgs;
    if (url && (target === 'clickthrough' || !target)) {
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }
    }
  }
  // Navigation message does not require a resolve
}
```

The comment "Navigation message does not require a resolve" is **wrong**. Per api-reference.md §7:

> `SHARC:Creative:requestNavigation` — **Requires response:** `resolve` or `reject`

This is a real bug. The creative sends `requestNavigation` and awaits the result. The container never responds. The creative's promise hangs forever until timeout (or never, since there's no timeout on this specific message). The critical behavioral contract — reject with 2105 means "creative, you handle this" — is completely broken. On web, the container should reject with 2105. On mobile, it should open the URL and resolve.

Fix:
```javascript
_handleRequestNavigation(msg) {
  const navArgs = msg.args || {};
  if (this._onNavigation) {
    this._onNavigation(navArgs);
    this._protocol._resolve(msg, {});
  } else {
    const { url, target } = navArgs;
    if (url && (target === 'clickthrough' || !target)) {
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }
      this._protocol._resolve(msg, {});
    } else {
      // Container cannot handle this navigation type
      this._protocol._reject(msg, ErrorCodes.UNSPECIFIED_CONTAINER, 'Navigation type not handled');
    }
  }
}
```

#### 🟡 Bug: Double-destroy race in `_handleFatalError`

**Location:** `_handleFatalError()`, `sharc-container.js`

```javascript
_handleFatalError(errorCode, message = '') {
  this._onError && this._onError(errorCode, message);
  this._protocol.sendFatalError(errorCode, message)
    .then(() => this._destroy())
    .catch(() => this._destroy());
  // Destroy after 1s regardless
  setTimeout(() => this._destroy(), 1000);
}
```

`_destroy()` can be called up to three times: once in `.then()`, once in `.catch()`, and once in the `setTimeout`. `_destroy` doesn't guard against multiple calls — it tries to remove the iframe from the DOM each time (no-op after first call since `this._iframe` is set to `null`), fires `_onClose` each time, and calls `terminate()` on the protocol each time (which is idempotent, but `_onClose` firing three times is not acceptable). Fix: add `if (this._destroyed) return;` guard at top of `_destroy()`.

#### 🟡 Issue: 50ms iframe boot delay is a fragile workaround

**Location:** `_createIframe()`, `sharc-container.js`

```javascript
iframe.addEventListener('load', () => {
  setTimeout(() => {
    this._protocol.initChannel(iframe.contentWindow);
  }, 50);
});
```

The comment says: "Small delay to ensure creative's window.addEventListener is set up." This is a race condition workaround that will fail under load. The correct fix is for the creative to not rely on the `load` event timing — instead, the container should send the port immediately on `load`, and the creative's bootstrap listener should be set up synchronously before any `defer`/`async` scripts run. The 50ms delay is too short under CPU throttling and too long for performance.

Per the api-reference.md, the spec says the container sends the port "after the iframe loads." The correct pattern is for the creative's bootstrap listener to be in a synchronous inline script at the top of `<head>`, not in a `DOMContentLoaded` listener. The creative SDK's `init()` call (and thus the bootstrap listener registration) is deferred to `DOMContentLoaded` in some paths. Document this constraint explicitly, or remove the artificial delay and fix the timing in the creative SDK.

#### 🟡 Issue: `setState` sends `stateChange` before the transition is applied for `READY` state

**Location:** `_handleInitResolved()` and `setState()`, `sharc-container.js`

```javascript
_handleInitResolved(resolveValue) {
  this.setState(ContainerStates.READY);
  if (this.autoStart) {
    this._sendStartCreative();
  }
}
```

`setState` calls `_protocol.sendStateChange(ContainerStates.READY)`. But per the state machine design, `stateChange` to `ready` is implicit — the container is only in `ready` between `init` resolving and `startCreative` being sent, which is typically sub-millisecond when `autoStart: true`. The spec says the creative should receive `startCreative` immediately after init resolves (with only a `ready` stateChange notification in between). This is fine architecturally, but could cause a creative that handles `stateChange('ready')` to do something before `startCreative` arrives. Low risk, no change needed, but worth documenting.

#### 🟡 Issue: `active → hidden` transition is missing

**Location:** `_onVisibilityChange()`, `sharc-container.js`

```javascript
_onVisibilityChange() {
  const state = this._stateMachine.getState();
  if (document.visibilityState === 'hidden') {
    if (state === ContainerStates.ACTIVE || state === ContainerStates.PASSIVE) {
      this.setState(ContainerStates.HIDDEN);
    }
  }
```

`ACTIVE → HIDDEN` is not in `STATE_TRANSITIONS`:
```javascript
[ContainerStates.ACTIVE]: [ContainerStates.PASSIVE, ContainerStates.TERMINATED],
```

So `this.setState(ContainerStates.HIDDEN)` from `ACTIVE` will fail silently (state machine returns `false`, logs a warning, doesn't transition). The tab-hidden scenario requires going `ACTIVE → PASSIVE → HIDDEN` as two transitions. The Page Lifecycle API can fire `visibilitychange` without a prior `blur` event in some cases (e.g., mobile app backgrounding on Android). Either add `ACTIVE → HIDDEN` to `STATE_TRANSITIONS`, or ensure the container transitions through `PASSIVE` first when needed.

The architecture-design.md §4.4 says the transition path is `passive → hidden`, not `active → hidden`. So if the browser fires `visibilitychange` while `active`, the container should first transition to `passive`, then `hidden`. Fix `_onVisibilityChange` to do both steps when currently `active`.

### 3. API Design Issues

#### Direct access to `_protocol._resolve` and `_protocol._reject`

The container reaches into the protocol's private internals:
```javascript
proto._resolve(msg, { currentState: responseState });
proto._resolve(msg, { currentPlacementOptions: ... });
proto._resolve(msg, { features: this.supportedFeatures });
proto._reject(msg, ...);
```

This is fine for now but should be surfaced as `resolveMessage` / `rejectMessage` public methods on `SHARCContainerProtocol` before this ships as a reference. External implementers should not see underscore-prefixed methods in a normative example.

#### `onNavigation` callback receives args but no response mechanism

The `onNavigation` callback is called with `navArgs` but the callback author has no way to indicate whether navigation was handled (and thus whether to resolve or reject the protocol message). The callback should either return a boolean/promise, or the container should make a decision based on the navigation type and environment. As written, using `onNavigation` breaks the protocol because the message is never resolved (see bug above).

### 4. Missing Edge Cases

- **`createSession` received twice:** If the creative sends a second `createSession` (e.g., after a page reload inside the iframe), the container calls `acceptSession` again, overwriting the sessionId. All pending responses from the old session will be orphaned. Add a guard: if `this._protocol.sessionId` is already set, ignore or reject the second `createSession`.

- **iframe navigation away:** If the iframe navigates to a new URL (not a SHARC creative), the `MessagePort` will still be attached and waiting. The container will time out on messages that never come. There's no "iframe navigated away" detection. This is an edge case, but for a reference implementation it should be mentioned.

- **`startCreative` called when state is not `READY`:** `_sendStartCreative` has no state guard. It can be called at any time if `autoStart` is false and the integrator calls `start()` at the wrong time. The `start()` public method does have a guard, but `_sendStartCreative` itself doesn't — and it's called directly from `_handleInitResolved` too.

- **Tracker firing (`_fireTrackers`) on `mode: 'no-cors'`:** The `fetch` result in `no-cors` mode returns an "opaque" response — there's no status code. The `success: true` result doesn't mean the tracker actually succeeded; it means the request was sent (or at least attempted). The spec says to "include per-tracker results" in the resolve value. The `statusCode` field in the resolve result will always be `undefined` for no-cors fetches. Document this limitation clearly.

### 5. Line-Level Notes

- **`_initArgs` construction in `_handleCreateSession`:** 

  ```javascript
  const initArgs = {
    environmentData: {
      ...this.environmentData,
      currentState: ContainerStates.READY,
      version: SHARC_VERSION,
    },
    supportedFeatures: this.supportedFeatures,
  };
  this._protocol.sendInit(initArgs.environmentData, initArgs.supportedFeatures)
  ```
  
  This spreads `environmentData` and adds `currentState` and `version`. This means if the caller passes `version` or `currentState` in their `environmentData`, it gets overridden. Good. But `SHARC_VERSION` is `'0.1.0'` — this needs to be `'1.0.0'` before release, or the creative will see a version it doesn't recognize.

- **`_getMaxPlacement` fallback dimensions:**
  ```javascript
  width: this.containerEl.offsetWidth || 300,
  height: this.containerEl.offsetHeight || 250,
  ```
  The `|| 300` / `|| 250` fallbacks are MRAID banner dimensions. A SHARC reference implementation probably shouldn't hardcode those. Use `0` and let the integrator provide correct dimensions.

- **`_applyIframeDimensions` ignores `x` and `y`:** The placement spec includes `x` and `y` coordinates, but `_applyIframeDimensions` only sets `width` and `height`. This means `requestPlacementChange` can't reposition the iframe. Fine for now if absolute positioning isn't needed, but should be noted.

---

## File 3: `sharc-creative.js`

### 1. Overall Quality

This is the best-written of the three JS files. The watchdog pattern for close is correct and thoughtful. The `hasFeature` sync/`getFeatures` async duality matches the spec well. The auto-boot pattern with `setTimeout(startSession, 0)` is appropriate.

### 2. Bugs and Correctness Issues

#### 🔴 Bug: `requestNavigation` return value is dropped

**Location:** `SHARCCreativeSDK.requestNavigation()`, `sharc-creative.js`

```javascript
requestNavigation(args) {
  if (this._dead) return;
  this._proto.requestNavigation({ target: 'clickthrough', ...args });
}
```

Two problems:
1. The return value of `this._proto.requestNavigation(...)` is dropped. The creative cannot `await` the result, which means it can never know whether to handle navigation itself (reject 2105) or whether the container handled it (resolve).
2. `if (this._dead) return;` — returns `undefined` instead of a rejected promise, inconsistent with every other method.

Fix:
```javascript
requestNavigation(args) {
  if (this._dead) return Promise.resolve(); // Or Promise.reject — document the choice
  return this._proto.requestNavigation({ target: 'clickthrough', ...args });
}
```

And this only matters if the container bug above (never resolving navigation) is also fixed.

#### 🟡 Bug: `on('close', callback)` replaces the watchdog handler on multiple calls

**Location:** `SHARCCreativeSDK.on()`, `sharc-creative.js`

```javascript
on(event, callback) {
  if (!this._eventListeners[event]) {
    this._eventListeners[event] = [];
  }
  this._eventListeners[event].push(callback);

  // Special case: 'close' listener stored separately for the watchdog mechanism
  if (event === 'close') {
    this._closeHandler = callback;
  }
  return this;
}
```

If the creative calls `SHARC.on('close', handler1)` and then `SHARC.on('close', handler2)`, both are added to `_eventListeners['close']` (so both fire on `_emit('close')`). But `this._closeHandler` is set to `handler2` only — meaning only `handler2` gets the watchdog timer. `handler1` fires via `_emit` but without any timing constraint.

This is confusing and probably not the intended behavior. The close watchdog should apply to *all* close handlers, or the API should only allow one close handler (like `onClose` instead of `on('close', ...)`).

The simplest fix: run all registered `close` listeners inside the watchdog:
```javascript
_handleClose(msg) {
  const closeListeners = this._eventListeners['close'] || [];
  // Emit normally (fire-and-forget for non-watchdog purposes)
  this._emit('close');
  
  if (closeListeners.length === 0) {
    this._proto.resolve(msg, {});
    return;
  }
  
  let done = false;
  const resolve = () => { if (!done) { done = true; this._proto.resolve(msg, {}); } };
  const watchdog = setTimeout(resolve, CLOSE_WATCHDOG_MS);
  
  // Run all close handlers, collect any returned Promises
  const results = closeListeners.map(fn => {
    try { return fn(); } catch(e) { return Promise.resolve(); }
  });
  
  Promise.all(results.map(r => r && typeof r.then === 'function' ? r : Promise.resolve(r)))
    .then(() => { clearTimeout(watchdog); resolve(); })
    .catch(() => { clearTimeout(watchdog); resolve(); });
}
```

#### 🟡 Issue: `_featureSet` is built from `f.name || f`

**Location:** `_handleInit()`, `sharc-creative.js`

```javascript
this._featureSet = new Set(supportedFeatures.map((f) => f.name || f));
```

The fallback `|| f` means if a feature is passed as a plain string (not an object), it still works. That's a reasonable defensive move, but the spec defines features as objects with `name`, `version`, and `functions`. The fallback silently accepts malformed feature data. A reference implementation should validate:

```javascript
this._featureSet = new Set(
  supportedFeatures
    .filter(f => typeof f === 'object' && f.name)
    .map(f => f.name)
);
```

### 3. API Design Issues

#### `requestFeature` message type generation is fragile

**Location:** `SHARCCreativeSDK.requestFeature()`, `sharc-creative.js`

```javascript
const messageType = `SHARC:Creative:request${this._capitalize(featureName.split('.').pop() || featureName)}`;
```

This takes the last `.`-separated segment of the feature name. For `com.iabtechlab.sharc.audio` → `SHARC:Creative:requestAudio`. But the spec says:

> The message type is `SHARC:Creative:request` + the feature name (capitalized)

This is ambiguous about whether "capitalized" means just the first letter of the last segment, or the entire short name. Critically, this means the message type produced by the SDK must exactly match what the container expects. If a container implements the handler for `SHARC:Creative:requestAudio` and the SDK sends `SHARC:Creative:requestAudio`, they match. But if the feature name is `com.iabtechlab.sharc.openMeasurement` → `SHARC:Creative:requestOpenMeasurement`. What if the feature name is `com.iabtechlab.sharc.open-measurement` (hypothetical)? The `.split('.').pop()` gives `open-measurement`, then `_capitalize` gives `Open-measurement`. Not valid as a message type identifier.

The spec needs to define this more precisely. For now, a comment warning that feature names should not contain hyphens or other non-identifier characters would help.

#### `getFeatures()` async vs `getSupportedFeatures()` sync — redundant API surface

The SDK exposes three ways to get features: `hasFeature(name)` (sync), `getSupportedFeatures()` (sync, returns cached array), and `getFeatures()` (async, round-trips to container). The spec endorses `hasFeature` for synchronous checks and `Creative:getFeatures` for late-binding queries. But `getSupportedFeatures()` isn't in the spec's API surface (api-reference.md §8.2). It should either be removed or explicitly documented as a convenience method that returns cached init data.

#### `requestNavigation` silently injects a default `target`

```javascript
return this._proto.requestNavigation({ target: 'clickthrough', ...args });
```

The spread order means `args.target` overrides the default `'clickthrough'`. That's correct. But if the caller passes no `target`, they get `'clickthrough'` silently. This is a convenience default. Document it explicitly so creative developers know it's there.

### 4. Missing Edge Cases

- **`onReady` called after `Container:init` already received:** If the creative loads slowly and `Container:init` arrives before `SHARC.onReady(callback)` is registered, `_handleInit` will see `_onReadyCallback === null` and resolve immediately without calling the callback. The creative's setup code never runs. The fix is to buffer the init message until `onReady` is registered, or to document that `onReady` must be called synchronously before `DOMContentLoaded`. This is a known race condition in SDKs of this type and should be explicitly addressed.

- **`_dead` check doesn't return consistent types:** `requestNavigation` returns `undefined` when dead. `requestClose` returns `Promise.resolve()`. `reportInteraction` returns `Promise.reject(new Error('SDK is dead'))`. These should be consistent. Pick one behavior and apply it everywhere.

- **No way to unregister `onReady` or `onStart`:** `onReady` and `onStart` register callbacks but there's no `offReady` / `offStart`. Not critical, but relevant for test environments where the SDK might be reused.

- **Extension `requestFeature` messages not in `MESSAGES_REQUIRING_RESPONSE`:** Extension feature messages use dynamically-generated types like `SHARC:Creative:requestAudio`. These will never match the hardcoded set in `MESSAGES_REQUIRING_RESPONSE`, so `_sendMessage` will treat them as fire-and-forget and return a resolved promise immediately. Feature requests never resolve/reject. This is a real functional bug for anyone building extensions.

  Fix: `_sendMessage` should check if the type starts with `SHARC:Creative:request` (for any message, not just the predefined ones) and treat those as requiring responses. Or pass an explicit flag to `_sendMessage`.

### 5. Line-Level Notes

- **`_boot()` guard:**
  ```javascript
  _boot() {
    if (this._initialized) return;
    this._initialized = true;
  ```
  Good — idempotent boot. But `_initialized` is set before `_proto.init()` is called. If `_proto.init()` throws (shouldn't, but defensively), `_initialized` is `true` and subsequent `_boot()` calls silently do nothing. Swap order: set `_initialized` after `_proto.init()` succeeds.

- **`_handleClose` emits 'close' via `_emit` AND stores `_closeHandler` separately.** The same function can be invoked twice for the same close event: once via `_emit('close')` and once via `this._closeHandler()`. If `on('close', fn)` was called once, `fn` runs twice. This is the same root issue as the multiple-close-