# SHARC Container State Machine Analysis

**Author:** Software Architect (Research Subagent)  
**For:** Jeffrey Carlson (Project Co-Chair), SHARC Working Group  
**Date:** 2026-04-03  
**Status:** Draft — Awaiting Jeffrey Carlson's Review and Final Decision

---

## Executive Summary

There are three competing state machines in the SHARC ecosystem. None of them is correct as-is. The PRD is under-specified (missing OS-driven visibility states). The POC code (`sharc-protocol.js`) is over-specified and partially wrong (conflates container init state with post-init states, and introduces `PASSIVE` which means two different things in different contexts). Jeffrey Carlson's original intent — to align with the DOM/Page Lifecycle API — was correct but the POC implementation didn't fully execute on it.

**Recommendation: Adopt a 7-state machine closely mirroring the Chrome/WebKit Page Lifecycle API, with two bookend states (`LOADING` and `UNLOADED`) that are SHARC-specific.** This gives ad creatives a predictable, platform-neutral view of container state that maps cleanly to both mobile WebView and web iframe environments.

---

## 1. The Three Competing State Machines

### 1.1 PRD Spec States

From `SHARC:Container:stateChange` in the README:

```
created → ready → active → inactive → closing → destroyed
```

| State      | PRD Description |
|------------|----------------|
| `created`  | Container created, not yet initialized; not queryable by creative |
| `ready`    | Init complete, creative can start; follows `created` |
| `active`   | Visible and in use (has focus and input) |
| `inactive` | Visible but no longer in use (focus, no input) |
| `closing`  | Close sequence initiated |
| `destroyed`| Unloaded, cannot function; not queryable by creative |

**Problems with PRD:**
- `inactive` is described as "visible but no longer in use (has focus but no input)" — this conflates visibility with focus ambiguously
- No state for when the container is not visible (minimized app, screen off, background tab)
- No `frozen` analog — critical for mobile where OS suspends WebView processes
- `created` and `destroyed` are described as non-queryable, yet they appear in the state enum — this is confusing
- The `inactive` state does not map to any real platform concept clearly; it sounds like it means "user tabbed away on desktop" but that's actually "hidden"

### 1.2 POC Code States (`sharc-protocol.js`)

```javascript
ContainerStates = {
  READY: 'ready',
  ACTIVE: 'active',
  PASSIVE: 'passive',
  HIDDEN: 'hidden',
  FROZEN: 'frozen',
  CLOSING: 'closing',
  UNLOADED: 'unloaded',
};
```

**Problems with POC:**
- **No `created`/`loading` state** — the POC starts at `READY`, skipping the pre-init phase entirely
- **`PASSIVE` is ambiguous** — In Chrome's Page Lifecycle, "passive" means "visible but no input focus" (e.g., a background window in split-screen). In MRAID/ad context, "passive" often means "playing but user isn't interacting." These are different things.
- `HIDDEN` and `FROZEN` from Chrome Page Lifecycle are correctly included but lack clear semantics in an ad container context
- `UNLOADED` vs PRD's `destroyed` — different names for the same terminal state
- No `closing` in the PRD sense is wrong — `CLOSING` is actually correctly in the POC but missing from the Chrome model (it's SHARC-specific and correct to have it)

### 1.3 Jeffrey Carlson's Intent

The intent was to base the state machine on the **DOM/Page Lifecycle API** (the Chrome/WebKit standard), which governs how browsers manage page resources. This intent is sound — it gives the creative developer a framework they already understand from web development, and it maps naturally to what actually happens in both WKWebView (iOS) and Android WebView.

---

## 2. Reference: The DOM/Page Lifecycle API

### 2.1 Page Visibility API (`document.visibilityState`)

The older, widely-supported API. Two states visible to content:

| visibilityState | Meaning |
|-----------------|---------|
| `visible`       | Page is at least partially visible (foreground tab, active window) |
| `hidden`        | Page is not visible (background tab, minimized, screen locked) |
| `prerender`     | Page being prerendered (deprecated in modern browsers) |

**Event:** `visibilitychange` fires when state changes.  
**Limitation:** Binary — doesn't capture focus, freeze, or termination nuances.

### 2.2 Page Lifecycle API (Chrome/WebKit — the modern standard)

Standardized by WICG. This is the comprehensive model:

| State       | Visible? | Has Focus? | JS Runs? | Description |
|-------------|----------|------------|----------|-------------|
| `active`    | ✅ Yes   | ✅ Yes     | ✅ Yes   | Foreground, focused, interactive |
| `passive`   | ✅ Yes   | ❌ No      | ✅ Yes   | Visible but not focused (split-screen, background window) |
| `hidden`    | ❌ No    | ❌ No      | ✅ Yes   | Not visible; background tab, minimized |
| `frozen`    | ❌ No    | ❌ No      | ❌ No    | CPU suspended; JS timers/tasks halted |
| `terminated`| ❌ No    | ❌ No      | Limited  | Page being unloaded normally |
| `discarded` | ❌ No    | ❌ No      | ❌ No    | Tab discarded by OS to free memory |

**Key events:** `visibilitychange`, `focus`, `blur`, `freeze`, `resume`, `pagehide`, `pageshow`

**State transitions (Page Lifecycle):**
```
active ←→ passive ←→ hidden → frozen → discarded
                    ↓
                terminated
```

### 2.3 iOS WKWebView Lifecycle

WKWebView runs its JavaScript engine in a **separate process** (`WebContent` process) from the app. Key lifecycle events:

**App-level (UIApplication) states:**
| iOS App State | Description |
|--------------|-------------|
| `Not Running` | App not launched |
| `Inactive`   | Foreground, no UI events (transitional — during phone call interruption, app switch) |
| `Active`     | Foreground, receiving events — the normal running state |
| `Background` | Not visible; limited execution time (~30s) |
| `Suspended`  | Background, no code execution; process may be killed without warning |

**WKWebView-specific:**
- **`webViewWebContentProcessDidTerminate`** — Called when iOS kills the WebContent process (low memory, backgrounding). This is the equivalent of Chrome's `discarded` state.
- WKWebView does NOT get a freeze/resume event from iOS; it gets process termination
- When the hosting app goes to `Background`, the WKWebView's JS process may be killed silently
- `applicationWillResignActive` → maps to Page Lifecycle `passive`
- `applicationDidEnterBackground` → maps to Page Lifecycle `hidden`
- WebContent process kill → maps to Page Lifecycle `frozen`/`discarded`
- `applicationWillEnterForeground` + `applicationDidBecomeActive` → maps to Page Lifecycle `active`

**iOS WKWebView state mapping:**
```
App Active + WKWebView visible → Page Lifecycle: active
App Inactive (phone call etc.) → Page Lifecycle: passive
App Background → Page Lifecycle: hidden
WebContent process killed → Page Lifecycle: frozen/discarded
App terminated → Page Lifecycle: terminated
```

### 2.4 Android WebView Lifecycle

Android WebView is an in-process component embedded in an Activity. The Activity lifecycle directly drives WebView lifecycle:

**Android Activity states:**
| Activity State | Description |
|---------------|-------------|
| `Created`     | Activity created, not visible |
| `Started`     | Becoming visible |
| `Resumed`     | Foreground, interactive — `onResume()` / `WebView.onResume()` |
| `Paused`      | Partially visible or losing focus — `onPause()` / `WebView.onPause()` |
| `Stopped`     | Not visible — `onStop()` |
| `Destroyed`   | Activity destroyed — `onDestroy()` |

**WebView-specific methods:**
- **`WebView.onResume()`** — Must be called in Activity `onResume()`. Resumes JS timers.
- **`WebView.onPause()`** — Must be called in Activity `onPause()`. Pauses JS timers, hints to browser.
- **`WebView.pauseTimers()`** — Stronger: pauses all WebViews globally in the process.
- **`WebView.resumeTimers()`** — Resumes all WebViews.

**Android WebView state mapping:**
```
Activity Resumed + WebView visible → Page Lifecycle: active
Activity Paused (partial visibility, multi-window no-focus) → Page Lifecycle: passive
Activity Stopped (completely hidden) → Page Lifecycle: hidden
Activity Stopped + low memory process kill → Page Lifecycle: frozen/discarded
Activity Destroyed → Page Lifecycle: terminated
```

---

## 3. Cross-Platform State Comparison Matrix

| Page Lifecycle API | PRD State      | POC State   | iOS WKWebView         | Android WebView        |
|--------------------|----------------|-------------|-----------------------|------------------------|
| —                  | `created`      | —           | WKWebView allocating  | Activity Created       |
| —                  | `ready`        | `ready`     | WKWebView loaded      | WebView navigated      |
| `active`           | `active`       | `active`    | App Active, WKWebView visible+focused | Activity Resumed, WebView focused |
| `passive`          | `inactive` ⚠️  | `passive`   | App Inactive (call interruption, split-screen) | Activity Paused, partially visible |
| `hidden`           | *(missing)* ❌ | `hidden`    | App Background        | Activity Stopped       |
| `frozen`           | *(missing)* ❌ | `frozen`    | WebContent process suspended/killed | Activity Stopped + pauseTimers() |
| `terminated`       | `closing`+`destroyed` | `closing`+`unloaded` | App terminated | Activity Destroyed |
| `discarded`        | *(missing)* ❌ | *(implicit in unloaded)* | WebContent process killed by OS | App process killed by OS |

**Legend:** ⚠️ = misnamed or ambiguous, ❌ = missing

### Key Observations

1. **The PRD's `inactive` is the Page Lifecycle's `passive`** — The PRD says "visible but no longer in use (has focus but no input)." Page Lifecycle's `passive` means "visible but no input focus." These are the same concept, just named differently. The PRD's name `inactive` is confusing because it sounds like the thing is off or stopped.

2. **The PRD is missing `hidden`, `frozen`, and `discarded`** — These are the three most critical OS-driven states for mobile. Not supporting them means creatives can't properly pause/resume when the app is backgrounded.

3. **The POC gets `hidden` and `frozen` right** — The POC code correctly includes these Chrome Page Lifecycle states. This is the better foundation.

4. **`discarded` should be collapsed into `frozen` for SHARC** — The distinction between frozen (suspended) and discarded (killed) is important internally, but from the creative's perspective, both mean "you can't do anything." SHARC doesn't need to expose this distinction in v1.

5. **Both `created` and `destroyed` are pre/post-communication states** — The PRD correctly notes these are not queryable. They should be renamed and clearly documented as container-internal bookends, not SHARC protocol states the creative ever sees as current state.

6. **`CLOSING` is correct and SHARC-specific** — Neither the Page Lifecycle API nor any mobile platform has a "closing" state for an embedded view. SHARC correctly adds this as an interstitial state to allow creatives to run close sequences (up to 2 seconds). Keep it.

---

## 4. Problems to Resolve

### 4.1 Naming: `inactive` vs `passive`
- **PRD** uses `inactive`, **POC** uses `passive`
- `passive` is the correct term (matches Page Lifecycle API, matches what it means)
- `inactive` implies the ad is not running — it IS running, just not focused
- **Decision needed:** Rename `inactive` → `passive` everywhere

### 4.2 Missing mobile states: `hidden` and `frozen`
- The PRD omits these entirely
- Without `hidden`: creative can't know when the app is backgrounded and should release resources / pause animations
- Without `frozen`: creative can't know when JS execution is about to be suspended and should flush state
- **Decision needed:** Add both `hidden` and `frozen` to the spec

### 4.3 Terminal state naming: `destroyed` vs `unloaded`
- PRD uses `destroyed`, POC uses `unloaded`
- `unloaded` is better — it's what actually happens (the WebView is unloaded)
- `destroyed` sounds violent and is ambiguous (was it an error or normal?)
- **Decision needed:** Use `unloaded` as the terminal state name

### 4.4 Pre-init state naming: `created` vs `loading`
- PRD uses `created`, POC has nothing
- The creative never sees this state (per PRD spec), so the name only matters internally
- `loading` is more descriptive of what's happening
- **Decision needed:** Rename `created` → `loading` for clarity, mark clearly as internal/non-queryable

### 4.5 `discarded` state
- When iOS kills the WKWebView process or Android kills the app process, the creative is gone — there's no notification to the creative
- From the creative's perspective, `frozen` and `discarded` look identical (JS stopped running)
- **Decision needed:** Do NOT expose `discarded` in v1. Handle at container level (container detects process kill via `webViewWebContentProcessDidTerminate` / equivalent). Extension candidate for v2.

---

## 5. Recommended SHARC v1 State Machine

### 5.1 The Seven States

| State      | Visible? | JS Active? | Focus/Input? | Who Triggers It |
|------------|----------|------------|--------------|-----------------|
| `loading`  | ❌       | Partial    | ❌           | Container (internal only) |
| `ready`    | ❌       | ✅         | ❌           | Container (after successful init) |
| `active`   | ✅       | ✅         | ✅           | Container (platform foreground + focus) |
| `passive`  | ✅       | ✅         | ❌           | Container (visible, no focus — split-screen, tab switch) |
| `hidden`   | ❌       | ✅         | ❌           | Container (app backgrounded, screen off) |
| `frozen`   | ❌       | ❌         | ❌           | Container (OS suspended JS — battery, memory) |
| `closing`  | Varies   | ✅ (2s max)| ❌           | Container or Creative |
| `unloaded` | ❌       | ❌         | ❌           | Container (internal only) |

> **Note:** `loading` and `unloaded` are container-internal bookend states. The creative never receives a `stateChange` message with these values — by definition, the creative cannot receive messages before init or after unload. They are retained in the enum for container-side logging and debugging.

### 5.2 State Definitions

**`loading`** (internal)
> The container has created the WebView and is loading the creative markup. The SHARC handshake has not started. The creative may post `createSession` during this phase.
>
> - Previous states: *(none)*
> - Next states: `ready` (init succeeded), `unloaded` (timeout or fatal error)
> - Creative queryable: **No**

**`ready`**
> The container has completed `Container:init` and is awaiting `Container:startCreative`. The creative is initialized but not yet displayed.
>
> - Previous states: `loading`
> - Next states: `active` (startCreative resolved), `unloaded` (startCreative rejected or timeout)
> - Creative queryable: **Yes**

**`active`**
> The container is visible and the hosting application/browser tab is in the foreground with user focus. The creative should be running normally.
>
> Maps to: Page Lifecycle `active`, iOS App State `active` with WKWebView visible, Android Activity `resumed` with WebView visible.
>
> - Previous states: `ready`, `passive`, `frozen` (on resume)
> - Next states: `passive`, `closing`
> - Creative queryable: **Yes**

**`passive`**
> The container is visible but the hosting application has lost input focus. The creative is still rendering but may not be receiving user interaction. Common in: split-screen multitasking (both iOS and Android), a phone call interruption on iOS, a dialog overlay.
>
> Maps to: Page Lifecycle `passive`, iOS `UIApplicationState.inactive` (transitional/split-screen), Android `Paused` in multi-window mode.
>
> - Previous states: `active`, `hidden`
> - Next states: `active`, `hidden`, `closing`
> - Creative queryable: **Yes**

**`hidden`**
> The container is not visible. The hosting application is in the background (user pressed Home, received a notification, switched apps), or the device screen is off. JavaScript continues to run but should release non-essential resources.
>
> Maps to: Page Lifecycle `hidden`, iOS `applicationDidEnterBackground`, Android `onStop()`.
>
> - Previous states: `passive`, `frozen` (on resume to hidden)
> - Next states: `passive`, `frozen`, `closing`, `unloaded`
> - Creative queryable: **Yes**

**`frozen`**
> The browser/OS has suspended JavaScript execution in the container. This occurs when the OS needs to reclaim CPU/memory. On iOS, this corresponds to the WebContent process being suspended or killed. On Android, this corresponds to `WebView.pauseTimers()`. The creative should have already saved any necessary state when entering `hidden`.
>
> Maps to: Page Lifecycle `frozen` (and implicitly `discarded` — these look identical to the creative), iOS WebContent process suspended, Android `pauseTimers()`.
>
> - Previous states: `hidden`
> - Next states: `active`, `passive`, `hidden` (on OS resume), `unloaded` (if OS kills while frozen)
> - Creative queryable: **No** (JS is suspended; the creative cannot respond to a getContainerState query)

**`closing`**
> The close sequence has been initiated. The container will unload after a maximum of 2 seconds. This state exists to give the creative time to fire closing trackers and run a close animation.
>
> This is a SHARC-specific state with no direct Page Lifecycle equivalent. It is the graceful handoff between an active session and termination.
>
> - Previous states: `active`, `passive`, `hidden`
> - Next states: `unloaded`
> - Creative queryable: **Yes** (but briefly)

**`unloaded`** (internal)
> The container has been destroyed and the WebView removed from the view hierarchy. No further communication is possible.
>
> - Previous states: `closing`, `loading` (error path)
> - Next states: *(none)*
> - Creative queryable: **No**

### 5.3 State Transition Diagram

```
                         ┌──────────────────────────────────┐
                         │            [PLATFORM]            │
                         └──────────────────────────────────┘

  ┌─────────┐   init ok   ┌───────┐  startCreative  ┌────────┐
  │ LOADING │────────────▶│ READY │───────────────▶│ ACTIVE │◀──────┐
  └─────────┘             └───────┘                 └────────┘       │
       │                      │                          │           │
   error/                 error/                      blur /     focus /
   timeout               timeout                   split-screen  resume
       │                      │                          │           │
       ▼                      ▼                          ▼           │
  ┌──────────┐           ┌──────────┐             ┌─────────┐       │
  │ UNLOADED │◀──────────│ UNLOADED │             │ PASSIVE │───────┘
  └──────────┘           └──────────┘             └─────────┘
                                                       │
                                              app backgrounded /
                                               screen off / tab hidden
                                                       │
                                                       ▼
  ┌──────────┐  close    ┌─────────┐  visibility  ┌────────┐
  │ UNLOADED │◀──────────│ CLOSING │◀─────────────│ HIDDEN │
  └──────────┘           └─────────┘    change     └────────┘
        ▲                     ▲               │
        │                     │               │ OS suspends JS
        │                     │               ▼
        │                     │          ┌────────┐
        └─────────────────────┴──────────│ FROZEN │
                             close       └────────┘
                            (on resume      │
                             or OS kill)    │ OS kills process
                                            │ (no event → UNLOADED)


  Legend:
    ──▶  Normal transition
    Creative-initiated close possible from: ACTIVE, PASSIVE, HIDDEN
    Container-initiated close possible from: ACTIVE, PASSIVE, HIDDEN, FROZEN
    FROZEN → UNLOADED (no event fired to creative; container detects process kill)
```

### 5.4 Valid State Transitions (Formal)

| From      | To                                  | Trigger |
|-----------|-------------------------------------|---------|
| `loading` | `ready`                             | `Container:init` accepted by creative |
| `loading` | `unloaded`                          | Init timeout; fatal error; createSession timeout |
| `ready`   | `active`                            | `Container:startCreative` accepted |
| `ready`   | `unloaded`                          | startCreative rejected; timeout |
| `active`  | `passive`                           | App/tab loses focus (blur, split-screen, phone interruption) |
| `active`  | `closing`                           | User activates close; `Creative:requestClose`; container initiates |
| `passive` | `active`                            | App/tab regains focus |
| `passive` | `hidden`                            | App goes to background; tab hidden |
| `passive` | `closing`                           | Close initiated while passive |
| `hidden`  | `passive`                           | App returns to foreground (but not yet focused) |
| `hidden`  | `frozen`                            | OS suspends JS (freeze event, or iOS WebContent process suspended) |
| `hidden`  | `closing`                           | Container triggers close while hidden |
| `hidden`  | `unloaded`                          | OS kills process while hidden (no event) |
| `frozen`  | `active`                            | OS resumes (resume event → focus) |
| `frozen`  | `passive`                           | OS resumes (resume event → visible, no focus) |
| `frozen`  | `hidden`                            | OS resumes (resume event → still hidden) |
| `frozen`  | `unloaded`                          | OS kills process while frozen (no event to creative) |
| `closing` | `unloaded`                          | Container unloads (max 2s after closing) |

---

## 6. Mapping SHARC States to Platform Events

### 6.1 Web (iframe in browser)

| SHARC State | DOM Events / APIs |
|-------------|-------------------|
| `loading`   | iframe created, script loading |
| `ready`     | `Container:init` resolved |
| `active`    | `document.visibilityState === 'visible'` + `document.hasFocus() === true` |
| `passive`   | `document.visibilityState === 'visible'` + `document.hasFocus() === false` |
| `hidden`    | `document.visibilityState === 'hidden'` |
| `frozen`    | `document.freeze` event |
| `closing`   | `Container:close` message |
| `unloaded`  | iframe removed from DOM |

### 6.2 iOS WKWebView

| SHARC State | iOS APIs / Events |
|-------------|-------------------|
| `loading`   | WKWebView init + `loadHTMLString` / `loadRequest` |
| `ready`     | `Container:init` resolved |
| `active`    | `applicationDidBecomeActive` + WKWebView visible |
| `passive`   | `applicationWillResignActive` (phone call, split-screen) |
| `hidden`    | `applicationDidEnterBackground` |
| `frozen`    | WKWebView process suspension (inferred from background timing; no direct callback) |
| `closing`   | `Container:close` message |
| `unloaded`  | `applicationWillTerminate` or WKWebView removed; `webViewWebContentProcessDidTerminate` → graceful unload |

### 6.3 Android WebView

| SHARC State | Android APIs / Events |
|-------------|----------------------|
| `loading`   | WebView created + `loadUrl` / `loadData` |
| `ready`     | `Container:init` resolved |
| `active`    | `Activity.onResume()` + `WebView.onResume()` |
| `passive`   | `Activity.onPause()` in multi-window (partially visible) |
| `hidden`    | `Activity.onStop()` |
| `frozen`    | `WebView.pauseTimers()` (called in `Activity.onStop()`) |
| `closing`   | `Container:close` message |
| `unloaded`  | `Activity.onDestroy()` or app process killed |

---

## 7. Changes from PRD and POC

### 7.1 Changes from PRD Spec

| Change | From PRD | To Recommended | Rationale |
|--------|----------|----------------|-----------|
| Rename state | `created` | `loading` | More descriptive; `created` ambiguous |
| Rename state | `inactive` | `passive` | Matches Page Lifecycle API; less confusing |
| Add state | *(missing)* | `hidden` | Critical for mobile background handling |
| Add state | *(missing)* | `frozen` | Critical for OS CPU suspension on mobile |
| Rename state | `destroyed` | `unloaded` | More accurate; `destroyed` implies error |
| Clarify | `closing` | `closing` | Keep as-is; it's correct |

### 7.2 Changes from POC Code

| Change | From POC | To Recommended | Rationale |
|--------|----------|----------------|-----------|
| Add state | *(missing)* | `loading` | Pre-init bookend; needed for completeness |
| Keep | `ready` | `ready` | Correct |
| Keep | `active` | `active` | Correct |
| Keep | `passive` | `passive` | Correct; matches Page Lifecycle |
| Keep | `hidden` | `hidden` | Correct; matches Page Lifecycle |
| Keep | `frozen` | `frozen` | Correct; matches Page Lifecycle |
| Keep | `closing` | `closing` | Correct; SHARC-specific |
| Rename | `unloaded` | `unloaded` | Keep POC name over PRD's `destroyed` |

---

## 8. Final Recommended State Enum

```javascript
ContainerStates = {
  LOADING:  'loading',   // Internal: pre-init; creative cannot query this state
  READY:    'ready',     // Init complete, awaiting startCreative
  ACTIVE:   'active',    // Visible + focused + interactive
  PASSIVE:  'passive',   // Visible + no focus (split-screen, call interruption)
  HIDDEN:   'hidden',    // Not visible (app backgrounded, tab hidden, screen off)
  FROZEN:   'frozen',    // JS suspended by OS (battery/memory management)
  CLOSING:  'closing',   // Close sequence in progress (max 2s)
  UNLOADED: 'unloaded',  // Internal: container destroyed; creative cannot query this state
};
```

---

## 9. States Deferred to Extensions

The following state-adjacent behaviors are intentionally **out of scope for SHARC v1** and should be addressed in future extensions:

### 9.1 `discarded` (OS tab/process discard)
- Chrome can discard background tabs entirely, losing all state
- iOS can kill WKWebView processes similarly
- The distinction between `frozen` (suspended) and `discarded` (killed) is invisible to the creative
- **Deferral reason:** Handling discard requires state restoration on reload — a complex feature (session resumption, creative state serialization) that goes beyond v1 scope

### 9.2 Prerender / Speculative Loading
- Chrome's `prerender` visibilityState allows a page to load before the user navigates to it
- Not applicable to ad containers in v1 (ads are loaded on demand)
- **Deferral reason:** Not a real ad use case yet; no clear revenue-driving reason to spec it now

### 9.3 Picture-in-Picture (PiP)
- Video ads in PiP have a distinct visibility state (visible but not in primary viewport)
- **Deferral reason:** PiP for ads is a VAST/SIMID concern; SHARC display ads typically wouldn't use PiP

### 9.4 Viewability State
- Whether an ad is actually in the viewport (vs. hidden) is a viewability/measurement concern handled by OMID
- **Deferral reason:** SHARC already delegates to Open Measurement SDK via extensions; don't duplicate

---

## 10. Spec Language Recommendations

The following changes should be made to the SHARC README (PRD):

### 10.1 `currentState` enum in `EnvironmentData`
```
// CHANGE:
currentState: one of: ready, active, passive, hidden, frozen, closing, unloaded

// (Remove: created, inactive, destroyed)
// (Add: hidden, frozen)
// (Rename: inactive→passive, destroyed→unloaded)
```

### 10.2 `Creative:getContainerState` resolve
```
// CHANGE:
currentState: one of: ready, active, passive, hidden, frozen, closing, unloaded
```

### 10.3 Updated Table of Container States
Replace the existing table with the 7-state model defined in Section 5.2 above.

---

## 11. Summary Recommendation

**Use this state machine for SHARC v1:**

```
loading → ready → active ⟷ passive ⟷ hidden → frozen
                     ↓          ↓         ↓         ↓
                  closing    closing   closing   unloaded
                     ↓          ↓         ↓
                  unloaded  unloaded  unloaded
```

**The names `passive`, `hidden`, and `frozen` come directly from the Chrome/WebKit Page Lifecycle API.** This is the right lineage. Jeffrey's original intent was correct — the POC code largely got there, and the PRD drifted away from it. The fix is to reconcile the PRD to match the POC names, add the missing `loading` bookend, and clarify which states are internal vs. creative-visible.

**Drop `inactive` and `destroyed` from the PRD.** They are confusingly named and don't correspond to platform concepts. `passive` and `unloaded` are strictly better.

---

*Document prepared for Jeffrey Carlson's review. Awaiting final disposition.*

---

## Final Decision (Jeffrey Carlson, 2026-04-02)

**Drop `closing` state. Drop `unloaded` as creative-facing state.**

The close sequence is handled by the `Container:close` message + creative `resolve` pattern. A separate `closing` state is redundant. `unloaded` is container-internal only.

**The SHARC v1 state machine maps perfectly to the Chrome/WebKit Page Lifecycle API:**

```
loading → ready → active ↔ passive ↔ hidden → frozen → terminated
```

Creative-queryable states: `ready`, `active`, `passive`, `hidden`, `frozen`
Container-internal bookends (never sent to creative): `loading`, `terminated`

`discarded` (OS process kill) is collapsed into `frozen` — deferred to extension in v2.
`closing` — dropped from v1. Can be added as extension if close sequence state is needed later.

**Rationale:** Simplicity first. Perfect Page Lifecycle alignment means web developers already understand this model. The `Container:close` message flow handles the close sequence without needing a dedicated state.
