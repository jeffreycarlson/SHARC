# Architecture Design: Enhanced Placement Change System

**Version:** 0.3 (Draft)  
**Author:** Software Architecture, SHARC Working Group  
**Status:** Draft — Pending Review  
**PRD:** `docs/prd-placement-changes.md` v1.1  
**Last Updated:** 2026-04-12

---

## Table of Contents

1. [Overview and Relationship to PRD](#1-overview-and-relationship-to-prd)
2. [Pre-existing Bugs to Fix](#2-pre-existing-bugs-to-fix)
3. [Protocol Changes](#3-protocol-changes)
4. [Container-Side Design](#4-container-side-design)
5. [Creative SDK Design](#5-creative-sdk-design)
6. [Animation Strategy](#6-animation-strategy)
7. [Close Region Ownership Model](#7-close-region-ownership-model)
8. [MRAID Bridge Changes](#8-mraid-bridge-changes)
9. [Wire Protocol Additions](#9-wire-protocol-additions)
10. [Decisions and Trade-offs](#10-decisions-and-trade-offs)

---

## 1. Overview and Relationship to PRD

This document is the architecture design of record for the Enhanced Placement Change System described in `docs/prd-placement-changes.md`. It covers the technical design decisions, module boundaries, wire protocol changes, and integration patterns that implement the five PRD milestones:

1. **Placement policy** (container-local enforcement)
2. **Close region validation** (protocol wire change + container validation)
3. **MRAID `resize()` end-to-end** (bridge wiring + close region)
4. **`getPlacementConstraints()` query** (new protocol message)
5. **Animation hints** (additive protocol field)

This document also addresses six implementation concerns raised by the frontend developer review that the PRD does not cover, most importantly: the close button ownership model (container-owned in all states as of v0.3), the CSS animation strategy (transform-based rather than width/height transitions), position reset on restore, `allowOffscreen` enforcement, `constraintsChange` event semantics, and a pre-existing `getSupportedFeatures` exposure bug.

**v0.3 design change:** The container owns the close button in ALL placement change states (resize, maximize, fullscreen). The close button is a DOM element on the publisher page, outside the sandbox. The creative's `closeRegion` field is a positioning hint, not a rendering directive. See Section 7 for the full rationale and ADR-PC-006 for the decision record.

**Guiding constraint:** The placement change system is the most complex request/response flow in SHARC. Every design choice here must preserve two invariants: (a) the container has final authority over all placement mutations, and (b) the creative never needs more than one round trip to achieve a valid placement change once it has queried constraints.

---

## 2. Pre-existing Bugs to Fix

These bugs exist in the current codebase and must be fixed as part of this work. They are not new features; they are correctness issues that would be exposed or worsened by the placement change enhancements.

### 2.1 `getSupportedFeatures()` Not Wired into `window.SHARC`

**Location:** `sharc-creative.js`, line 651 (class method) vs. lines 713-738 (window.SHARC exposure block)

The `SHARCCreativeSDK` class defines `getSupportedFeatures()` at line 651, which returns `this._features`. However, the `window.SHARC` exposure block (line 713-738) does not include it. The method is unreachable from creative code that uses the `window.SHARC` global.

**Fix:** Add to the exposure block:

```javascript
window.SHARC = {
  // ...existing entries...
  getSupportedFeatures: () => _sdkInstance.getSupportedFeatures(),
};
```

This is a one-line addition. It must ship before or alongside the placement constraints feature, because `getPlacementConstraints` depends on feature detection working correctly from the creative's perspective.

### 2.2 `allowOffscreen` Accepted but Silently Ignored

**Location:** `sharc-container.js`, line 978 (destructuring) and line 743 of `sharc-mraid-bridge.js` (sent on wire)

The MRAID bridge sends `allowOffscreen` in the `requestPlacementChange` args (line 743). The container destructures it from `msg.args` but never evaluates it. The field passes through the wire and is silently discarded.

**Fix:** Enforce `allowOffscreen` in the validation pipeline (see Section 4.3, step 5). When `allowOffscreen === false` (either from the request or the placement policy), the container must validate that the entire resized ad fits within viewport bounds. When `allowOffscreen` is absent from the request, fall back to the placement policy's `allowOffscreen` value, then to `true` (permissive default for backward compatibility).

### 2.3 Position Not Reset on `restore`/`minimize`

**Location:** `sharc-container.js`, lines 999-1004

The `minimize`/`restore` case resets dimensions to `environmentData.currentPlacement` but explicitly does not reset `position`, `left`, or `top` CSS properties. The inline comment acknowledges this: "does not reset position/left/top CSS." If a creative resizes with a `targetPosition` offset (e.g., an MRAID resize with `offsetX`/`offsetY`), then triggers `restore`, the iframe stays at the offset position with the original dimensions. The MRAID bridge's `close()` from resized state maps to `requestPlacementChange({ intent: 'restore' })`, so this bug causes MRAID resize creatives to appear visually misplaced after close.

**Fix:** The `minimize`/`restore` case must reset iframe positioning. The container needs to store the pre-resize position state and restore it. See Section 4.5 for the full design.

---

## 3. Protocol Changes

### 3.1 New Message Type

| Message | Direction | Purpose |
|---------|-----------|---------|
| `SHARC:Creative:getPlacementConstraints` | Creative -> Container | Query what the container allows before requesting a change |

### 3.2 New Fields on Existing Messages

| Message | Field | Type | Required | Notes |
|---------|-------|------|----------|-------|
| `Creative:requestPlacementChange` | `closeRegion` | `CloseRegion` | No (unless policy demands it) | Placement hint: creative suggests where the container should position its close button |
| `Creative:requestPlacementChange` | `allowOffscreen` | `boolean` | No | Creative declares whether it expects to extend beyond viewport |
| `Creative:requestPlacementChange` | `transition` | `TransitionHint` | No | Animation preference; container may ignore |
| `Container:placementChange` | `transition` | `TransitionHint` | No | Actual animation timing applied by container |

### 3.3 Updated Semantics

**`requestPlacementChange` can now reject.** The current api-reference.md states the container always resolves. This changes to:

- **resolve**: Placement change accepted. Resolve value contains actual resulting placement.
- **reject with 2203**: Policy violation — intent not allowed, dimensions exceed limits, offscreen violation.
- **reject with 2211**: Malformed request — missing required `closeRegion` (when policy demands it). Note: an offscreen close region hint does NOT cause rejection; the container overrides to a visible default position (see Section 4.4).

This is a behavioral contract change. Creatives that do not handle rejection will see an unhandled Promise rejection. The mitigation is that rejection only occurs when a publisher configures a `placementPolicy` — the zero-policy default path is identical to today.

### 3.4 New Feature Strings

| Feature String | Meaning |
|---------------|---------|
| `com.iabtechlab.sharc.placement.resize` | Container supports validated resize with close region enforcement |
| `com.iabtechlab.sharc.placement.constraints` | Creative can query placement constraints |
| `com.iabtechlab.sharc.placement.animate` | Container supports animated placement transitions |

---

## 4. Container-Side Design

### 4.1 Placement Policy Option

The `SHARCContainer` constructor accepts a new `placementPolicy` option. This is purely container-local configuration — it is never sent over the wire.

```javascript
const container = new SHARCContainer({
  creativeUrl: '...',
  containerEl: document.getElementById('ad-slot'),
  environmentData: { /* ... */ },
  placementPolicy: {
    maxWidth: 728,
    maxHeight: 480,
    allowedIntents: ['resize', 'restore'],
    requireCloseRegion: true,
    allowOffscreen: false,
    customValidator: null,
  },
});
```

**Storage:** The policy is stored as `this._placementPolicy` at construction time. Missing fields fall back to permissive defaults: `maxWidth: Infinity`, `maxHeight: Infinity`, `allowedIntents: ['resize', 'maximize', 'fullscreen', 'minimize', 'restore']`, `requireCloseRegion: false`, `allowOffscreen: true`, `customValidator: null`.

**Location for changes:** `sharc-container.js` constructor (around line 85-130).

### 4.2 Pre-resize Position Snapshot

To fix the restore/position bug (Section 2.3), the container must store the iframe's position state before any resize modifies it.

**New private field:** `this._preResizeCSSState`

```javascript
// Stored before the first resize intent is applied
this._preResizeCSSState = null;

// In _handleRequestPlacementChange, before applying resize:
if (intent === 'resize' && !this._preResizeCSSState) {
  this._preResizeCSSState = {
    position: this._iframe.style.position || '',
    left:     this._iframe.style.left || '',
    top:      this._iframe.style.top || '',
    width:    this._iframe.style.width || '',
    height:   this._iframe.style.height || '',
  };
}
```

This snapshot is taken once, on the first resize. Subsequent resizes (without an intervening restore) do not overwrite it. The restore case uses it to reset. See Section 4.5.

### 4.3 Validation Pipeline

The rewritten `_handleRequestPlacementChange` applies validation before execution. The pipeline runs top-to-bottom; the first failing check rejects the message and short-circuits.

**Validation order:**

1. **Intent allowlist.** If `_placementPolicy.allowedIntents` is configured and `intent` is not in the list, reject with `2203`: `"Intent '[intent]' not allowed by placement policy"`.

2. **Dimension limits.** If `intent === 'resize'` and `targetDimensions` is present, validate `width <= maxWidth` and `height <= maxHeight`. Reject with `2203` if exceeded.

3. **Close region presence.** If `intent === 'resize'` and `_placementPolicy.requireCloseRegion === true`, validate that `closeRegion` is present in the request. Reject with `2211` if missing.

4. **Close region hint resolution.** If `closeRegion` is present, resolve the effective close button position using `_resolveClosePosition()` (Section 4.4). If the hinted position would be offscreen, the container overrides to `top-right` -- it does NOT reject the placement change. Store the resolved position for use by the close button renderer (Section 4.7).

5. **Offscreen enforcement.** Determine the effective `allowOffscreen` value: use the request's `allowOffscreen` if explicitly set, otherwise fall back to `_placementPolicy.allowOffscreen`, otherwise `true`. If the effective value is `false` and `intent === 'resize'`, validate the entire resized ad fits within viewport bounds. Reject with `2203` if it would extend offscreen.

6. **Custom validator.** If `_placementPolicy.customValidator` is defined, call it with the full request args. If it returns `{ allowed: false, reason: '...' }`, reject with `2203` and the reason string.

7. **Execute.** All checks passed. Apply the placement change and resolve.

**Backward compatibility:** When `_placementPolicy` is `undefined` (the default), steps 1-6 are skipped entirely — the method behaves exactly as it does today.

```javascript
_handleRequestPlacementChange(msg) {
  const args = msg.args || {};
  const { intent, targetDimensions, targetPosition, closeRegion, allowOffscreen, transition } = args;

  // ── Validation pipeline (only when policy is configured) ──
  if (this._placementPolicy) {
    const rejection = this._validatePlacementRequest(args);
    if (rejection) {
      this._protocol._reject(msg, rejection.code, rejection.message);
      return;
    }
  }

  // ── Execution (with position snapshot, animation, and close button) ──
  let updatedPlacement = { ...(this.environmentData.currentPlacement || {}) };

  // Resolve close button position from hint (Section 4.4)
  const resolvedClose = closeRegion
    ? this._resolveClosePosition(closeRegion, targetDimensions || updatedPlacement, targetPosition)
    : { position: 'top-right', size: 50, overridden: false };

  switch (intent) {
    case 'resize':
      this._snapshotPreResizeState();
      this._currentIntent = 'resize';
      if (targetDimensions) {
        updatedPlacement = { ...updatedPlacement, ...targetDimensions };
        this._applyIframeDimensions(targetDimensions, transition);
      }
      if (targetPosition) {
        this._applyIframePosition(targetPosition);
      }
      this._createCloseButton(resolvedClose.position);   // Container-owned close
      break;
    case 'maximize':
    case 'fullscreen':
      this._snapshotPreResizeState();
      this._currentIntent = intent;
      updatedPlacement = this._getMaxPlacement();
      this._applyIframeDimensions(updatedPlacement, transition);
      this._createCloseButton('top-right');               // Container-owned close
      break;
    case 'minimize':
    case 'restore':
      this._currentIntent = null;
      updatedPlacement = this._restorePreResizeState();
      this._removeCloseButton();                          // Remove close on restore
      break;
    default:
      console.warn('[SHARCContainer] Unknown placement intent:', intent);
  }

  this.environmentData.currentPlacement = updatedPlacement;
  const resolvePayload = { placementUpdate: updatedPlacement };
  if (transition && this._supportsAnimation()) {
    resolvePayload.transition = this._clampTransition(transition);
  }
  this._protocol._resolve(msg, resolvePayload);
  this.notifyPlacementChange(updatedPlacement);
}
```

### 4.4 Close Region Hint Validation

The creative's `closeRegion` field on `requestPlacementChange` is a **placement hint** -- the creative suggests where the container's close button should be positioned, and the container decides whether to honor the hint or fall back to a default.

The container validates the hint and uses it to position its own close button (see Section 4.7). If the hinted position would place the close button offscreen, the container **accepts the resize but overrides the close position to a visible default (top-right)** rather than rejecting the placement change. The close button is a safety mechanism that should never prevent a valid resize from executing.

```javascript
/**
 * Validates a close region hint and returns the effective close position.
 * The container always renders its own close button — this determines WHERE.
 * @param {Object} closeRegion - { position: string, size: number } hint from creative
 * @param {Object} targetDimensions - { width, height }
 * @param {Object} targetPosition - { x, y } or null (use current iframe position)
 * @returns {{ position: string, size: number, overridden: boolean }}
 * @private
 */
_resolveClosePosition(closeRegion, targetDimensions, targetPosition) {
  const size = Math.max(closeRegion.size || 50, 50);  // Enforce minimum 50 DIPs
  const hintedPosition = closeRegion.position || 'top-right';

  // Compute close region screen-space rect for the hinted position
  const adX = targetPosition ? targetPosition.x : (this._iframe ? this._iframe.offsetLeft : 0);
  const adY = targetPosition ? targetPosition.y : (this._iframe ? this._iframe.offsetTop : 0);
  const adW = targetDimensions.width;
  const adH = targetDimensions.height;

  const rect = this._computeCloseRegionRect(adX, adY, adW, adH, hintedPosition, size);

  // Check against viewport — if offscreen, override to default, do NOT reject
  const viewport = this._getViewportBounds();
  if (rect.left < 0 || rect.top < 0 ||
      rect.right > viewport.width || rect.bottom > viewport.height) {
    console.warn('[SHARCContainer] Close region hint offscreen at', hintedPosition, '— defaulting to top-right');
    return { position: 'top-right', size, overridden: true };
  }

  return { position: hintedPosition, size, overridden: false };
}
```

**Key behavioral change from v0.2:** The close region geometry check no longer rejects the placement change request. Previously, an offscreen close region would reject with error code `2211`. Now, the container accepts the resize and silently overrides the close button to a visible default position. This aligns with the principle that the close affordance is the container's responsibility -- the creative's hint is advisory, not authoritative.

The validation pipeline step 4 (Section 4.3) is updated accordingly: the `closeRegion` geometry check calls `_resolveClosePosition` to determine where the container will render its close button, but never short-circuits with a rejection based on close position alone. The `closeRegion.size` minimum of 50 DIPs is still enforced, but since the container renders the close button, the size field is informational -- the container ensures its close button meets the 50 DIP minimum regardless.

### 4.5 Position Reset on Restore

The `minimize`/`restore` case must reset both dimensions and position. The container uses the `_preResizeCSSState` snapshot stored at resize time.

```javascript
/**
 * Snapshots the iframe's CSS state before resize, if not already captured.
 * @private
 */
_snapshotPreResizeState() {
  if (this._preResizeCSSState || !this._iframe) return;
  this._preResizeCSSState = {
    position: this._iframe.style.position,
    left:     this._iframe.style.left,
    top:      this._iframe.style.top,
    width:    this._iframe.style.width,
    height:   this._iframe.style.height,
  };
}

/**
 * Restores iframe CSS state to the pre-resize snapshot.
 * Clears the snapshot so the next resize captures fresh state.
 * @returns {Object} The original placement dimensions to use as updatedPlacement.
 * @private
 */
_restorePreResizeState() {
  if (this._preResizeCSSState && this._iframe) {
    this._iframe.style.position = this._preResizeCSSState.position;
    this._iframe.style.left     = this._preResizeCSSState.left;
    this._iframe.style.top      = this._preResizeCSSState.top;
    this._iframe.style.width    = this._preResizeCSSState.width;
    this._iframe.style.height   = this._preResizeCSSState.height;
  }
  this._preResizeCSSState = null;

  // Return the original placement from environmentData
  // Note: environmentData.currentPlacement has been mutated by resize.
  // We need the ORIGINAL placement. Store it separately.
  return { ...(this._originalPlacement || this.environmentData.currentPlacement || {}) };
}
```

**Additional requirement:** The container must store `this._originalPlacement` at construction time (a copy of `environmentData.currentPlacement`). This is the placement state to restore to, independent of any mutations that `_handleRequestPlacementChange` applies to `environmentData.currentPlacement`.

```javascript
// In constructor, after environmentData is stored:
this._originalPlacement = { ...(this.environmentData.currentPlacement || {}) };
```

**Location for changes:** `sharc-container.js`, constructor (around line 130) and `_handleRequestPlacementChange` (lines 999-1004).

### 4.6 `getPlacementConstraints` Handler

New handler registered alongside the existing `GET_PLACEMENT_OPTIONS` handler (line 581 of `sharc-container.js`).

```javascript
proto.addListener(CreativeMessages.GET_PLACEMENT_CONSTRAINTS, (msg) => {
  this._onMessage && this._onMessage('received', msg);
  const policy = this._placementPolicy || {};
  proto._resolve(msg, {
    maxWidth:           policy.maxWidth != null ? policy.maxWidth : null,
    maxHeight:          policy.maxHeight != null ? policy.maxHeight : null,
    allowedIntents:     policy.allowedIntents || ['resize', 'maximize', 'fullscreen', 'minimize', 'restore'],
    requireCloseRegion: !!policy.requireCloseRegion,
    allowOffscreen:     policy.allowOffscreen !== false,
  });
});
```

The `customValidator` is intentionally omitted from the response. It is opaque container-side logic that creatives should not inspect.

### 4.7 Container-Side Close Button Rendering

The container renders the close button as a DOM element on the publisher page, positioned as a **sibling** to the ad iframe. This element lives outside the sandbox and is immune to creative CSS, JavaScript, and DOM manipulation.

**Implementation:**

```javascript
/**
 * Creates and positions the container-owned close button.
 * Called on resize, maximize, and fullscreen intents.
 * @param {string} position - Resolved close position ('top-right', 'top-left', etc.)
 * @private
 */
_createCloseButton(position) {
  this._removeCloseButton();

  const btn = document.createElement('div');
  btn.className = 'sharc-close-button';
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'Close advertisement');
  btn.setAttribute('tabindex', '0');

  // Default styling — X icon via CSS, no external assets
  btn.style.cssText = [
    'position:absolute',
    'width:50px',
    'height:50px',
    'min-width:50px',
    'min-height:50px',
    'z-index:2147483647',
    'cursor:pointer',
    'background:rgba(0,0,0,0.6)',
    'border-radius:50%',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-size:24px',
    'color:#fff',
    'line-height:1',
    'user-select:none',
    '-webkit-user-select:none',
    'pointer-events:auto',
    'box-sizing:border-box',
  ].join(';');

  // Apply publisher customization if provided
  if (this._closeButtonStyles) {
    Object.assign(btn.style, this._closeButtonStyles);
    // Enforce minimum size regardless of publisher customization
    if (parseInt(btn.style.width) < 50) btn.style.width = '50px';
    if (parseInt(btn.style.height) < 50) btn.style.height = '50px';
  }

  // Position relative to the iframe
  this._applyClosePosition(btn, position);

  // X glyph (Unicode multiplication sign — renders well cross-platform)
  btn.textContent = '\u00D7';

  // Click handler — behavior depends on current state
  const handleClose = () => {
    if (this._currentIntent === 'maximize' || this._currentIntent === 'fullscreen') {
      this._initiateClose();
    } else {
      // resize state: restore to original placement
      this._handleRequestPlacementChange({
        args: { intent: 'restore' },
        messageId: this._protocol._nextMessageId(),
        type: 'synthetic',
      });
    }
  };

  btn.addEventListener('click', handleClose);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClose();
    }
  });

  // Insert as sibling to iframe, within the container element
  this._containerEl.style.position = this._containerEl.style.position || 'relative';
  this._containerEl.appendChild(btn);
  this._closeButton = btn;
}

/**
 * Removes the container-owned close button.
 * Called on restore, close, and destroy.
 * @private
 */
_removeCloseButton() {
  if (this._closeButton && this._closeButton.parentNode) {
    this._closeButton.parentNode.removeChild(this._closeButton);
  }
  this._closeButton = null;
}

/**
 * Positions the close button relative to the iframe based on the
 * resolved position string.
 * @param {HTMLElement} btn - The close button element
 * @param {string} position - Position enum value
 * @private
 */
_applyClosePosition(btn, position) {
  // Reset all positioning
  btn.style.top = btn.style.bottom = btn.style.left = btn.style.right = 'auto';
  btn.style.transform = '';

  switch (position) {
    case 'top-left':      btn.style.top = '0'; btn.style.left = '0'; break;
    case 'top-center':    btn.style.top = '0'; btn.style.left = '50%';
                          btn.style.transform = 'translateX(-50%)'; break;
    case 'top-right':     btn.style.top = '0'; btn.style.right = '0'; break;
    case 'center-left':   btn.style.top = '50%'; btn.style.left = '0';
                          btn.style.transform = 'translateY(-50%)'; break;
    case 'center-right':  btn.style.top = '50%'; btn.style.right = '0';
                          btn.style.transform = 'translateY(-50%)'; break;
    case 'bottom-left':   btn.style.bottom = '0'; btn.style.left = '0'; break;
    case 'bottom-center': btn.style.bottom = '0'; btn.style.left = '50%';
                          btn.style.transform = 'translateX(-50%)'; break;
    case 'bottom-right':  btn.style.bottom = '0'; btn.style.right = '0'; break;
    default:              btn.style.top = '0'; btn.style.right = '0'; break;
  }
}
```

**Constructor option for publisher customization:**

```javascript
const container = new SHARCContainer({
  creativeUrl: '...',
  containerEl: document.getElementById('ad-slot'),
  closeButtonStyles: {                    // NEW — optional publisher customization
    background: 'rgba(0,0,0,0.8)',
    borderRadius: '4px',
    fontSize: '20px',
  },
});
```

The `closeButtonStyles` option is stored as `this._closeButtonStyles` and applied via `Object.assign` over the defaults. The container enforces a minimum size of 50 DIPs (per MRAID 3.0 spec) regardless of publisher customization -- if the publisher sets `width: '30px'`, the container overrides to `50px`.

**Lifecycle:**

| Event | Close button action |
|-------|-------------------|
| `resize` intent accepted | `_createCloseButton(resolvedPosition)` |
| `maximize` intent accepted | `_createCloseButton('top-right')` |
| `fullscreen` intent accepted | `_createCloseButton('top-right')` |
| `restore` intent accepted | `_removeCloseButton()` |
| `minimize` intent accepted | `_removeCloseButton()` |
| Container `destroy()` | `_removeCloseButton()` |
| Ad closed | `_removeCloseButton()` |

**Accessibility:**

- `role="button"` -- announces as a button to screen readers
- `aria-label="Close advertisement"` -- descriptive label for screen readers
- `tabindex="0"` -- keyboard focusable in tab order
- Enter and Space key handlers -- standard button keyboard interaction
- Minimum 50 DIP size -- meets WCAG 2.5.5 Target Size (Enhanced) at Level AAA

**Integration with animation (Section 6):** During a `transform: scale()` animation, the close button is already visible and correctly positioned because it is a sibling element, not a child of the scaled iframe. The close button does not scale with the iframe -- it remains at its native size throughout the animation.

---

## 5. Creative SDK Design

### 5.1 `getPlacementConstraints()` Method

Add to `SHARCCreativeSDK` class (after `getPlacementOptions()` at line 472):

```javascript
/**
 * Queries the container's placement constraints.
 * Returns what the container allows before the creative requests a change.
 * Use SHARC.hasFeature('com.iabtechlab.sharc.placement.constraints') to check availability.
 *
 * @returns {Promise<{maxWidth: number|null, maxHeight: number|null,
 *           allowedIntents: string[], requireCloseRegion: boolean, allowOffscreen: boolean}>}
 */
getPlacementConstraints() {
  if (this._dead) return Promise.reject(new Error('SDK is dead'));
  return this._proto.getPlacementConstraints();
}
```

Add to the `window.SHARC` exposure block (line 713-738):

```javascript
getPlacementConstraints: () => _sdkInstance.getPlacementConstraints(),
```

### 5.2 Dual-Mode Constraints: Synchronous Cache + Change Event

The PRD specifies `getPlacementConstraints()` as an async query. The frontend review correctly identifies that constraints can change mid-session (device rotation, browser resize, publisher page layout change). A creative that queries constraints once at init and caches them may make invalid requests after a rotation.

**Design:** Two access patterns, following the `hasFeature()` precedent (synchronous cached value from init data, updated asynchronously):

1. **`getPlacementConstraints()`** — Async round trip to the container. Always returns fresh data. Used at init time and after receiving a `constraintsChange` event.

2. **`SHARC.on('constraintsChange', callback)`** — Fired by the container when placement constraints change (rotation, viewport resize, publisher policy update). The callback receives the new constraints object.

**Container-side:** The container monitors for constraint-relevant changes and sends `Container:placementConstraintsChange` when they occur. This is a container-initiated notification, not a request/response.

```javascript
// New message type in ContainerMessages (sharc-protocol.js)
PLACEMENT_CONSTRAINTS_CHANGE: 'SHARC:Container:placementConstraintsChange'
```

**When the container fires this:**

- On `window.resize` / `orientationchange` if viewport-derived constraints (maxWidth, maxHeight) change — `reason: 'rotation'` or `reason: 'viewportResize'`
- On explicit `updatePlacementPolicy()` call from the publisher — `reason: 'policyUpdate'`

The container debounces resize/orientation events (200ms) to avoid flooding the creative during drag-resize.

**`constraintsChange` payload includes a `reason` field** so the creative knows WHY constraints changed and can decide whether to re-request a placement change or just update its UI:

| `reason` | Trigger | Creative should... |
|----------|---------|-------------------|
| `'rotation'` | Device orientation change | Re-check if current placement still fits |
| `'viewportResize'` | Browser/app window resize, iPad Split View | Re-check if current placement still fits |
| `'policyUpdate'` | Publisher changed policy mid-session | Re-query constraints, may need to restore |

**Creative SDK event wiring:**

```javascript
// In SHARCCreativeSDK, add to the protocol listener setup:
this._proto.addListener('SHARC:Container:placementConstraintsChange', (msg) => {
  this._cachedConstraints = msg.args.constraints;
  this._emit('constraintsChange', msg.args);  // { constraints, reason }
  this._proto._resolve(msg, {});
});
```

**Synchronous cached access (convenience method):**

```javascript
/**
 * Returns the last known placement constraints.
 * Synchronous — uses cached data from the last getPlacementConstraints()
 * call or the last constraintsChange event. Before any query or event,
 * returns unconstrained defaults (never null).
 * @returns {Object}
 */
getCachedConstraints() {
  return this._cachedConstraints || {
    maxWidth: null,
    maxHeight: null,
    allowedIntents: ['resize', 'maximize', 'fullscreen', 'minimize', 'restore'],
    requireCloseRegion: false,
    allowOffscreen: true,
  };
}
```

Add to `window.SHARC`:

```javascript
getCachedConstraints: () => _sdkInstance.getCachedConstraints(),
```

### 5.3 Transition End Event

Creatives need to know when a container-side animation completes, so they can synchronize their own internal rendering (e.g., delaying asset reveal until the container has finished expanding).

**One event only: `placementTransitionEnd`.** There is no `placementTransitionStart` event.

| Event | Fired When | Payload |
|-------|-----------|---------|
| `placementTransitionEnd` | Container completes (or skips) an animated placement change | `{ finalDimensions }` |

**Why no start event?** The creative already knows when a transition begins — it is the moment `requestPlacementChange()` resolves. A separate start event is redundant and fragile: if the container sends a `placementChange` with a `transition` field but ultimately does not animate (e.g., `prefers-reduced-motion`, publisher policy, or the app backgrounds mid-animation), the creative receives a start event with no corresponding end. This creates a hanging state that is difficult to recover from — analogous to the iOS pattern where developers key on `viewDidAppear` (settled state) rather than `viewWillAppear` (transitional). An app-background event during animation would leave the creative in an unknown "transitioning" state with no resolution.

**Container-side flow:**

```
Container                                    Creative
   |── Container:placementChange ──────────▶  |  (immediate — includes transition hint)
   |                                           |
   |   [container animation runs]              |
   |                                           |
   |── Container:placementTransitionEnd ───▶   |
   |                                           |  SDK emits 'placementTransitionEnd'
```

```javascript
// New message type in ContainerMessages (sharc-protocol.js)
PLACEMENT_TRANSITION_END: 'SHARC:Container:placementTransitionEnd'
```

**The container MUST fire `placementTransitionEnd` even when animation is skipped** (e.g., `prefers-reduced-motion`, duration clamped to 0). In that case, `finalDimensions` reflects the instantly-applied dimensions. This guarantees that every placement change with a `transition` field in the request produces exactly one `placementTransitionEnd` event — no hanging states.

**Why not reuse `placementChange` for the end event?** The `placementChange` notification fires immediately when the container decides to apply the change (before animation starts). The end event fires when the animation completes. These are temporally distinct moments with different semantics — collapsing them would force creatives to guess when the visual transition actually finished.

---

## 6. Animation Strategy

### 6.1 The Problem with CSS `width`/`height` Transitions

The PRD's Section 6.5 specifies CSS transitions on `width` and `height` properties:

```javascript
iframe.style.transition = `width ${duration}ms ${easing}, height ${duration}ms ${easing}`;
```

The frontend review correctly identifies this as problematic. Transitioning `width`/`height` triggers layout recalculation on every animation frame. In Safari WKWebView, this is synchronous and blocks the main thread. The iframe's internal document also receives continuous `resize` events during the transition, causing the creative's own layout to thrash.

### 6.2 Recommended Strategy: `transform: scale()` with Snap

The container should animate using `transform: scale()` for the visual transition, then snap to the final `width`/`height` values on `transitionend`. This approach composites on the GPU and does not trigger layout recalculation during the animation.

**Implementation in `_applyAnimatedDimensions`:**

```javascript
/**
 * Applies an animated dimension change using transform: scale().
 * The visual transition runs on the GPU compositor. On completion,
 * snaps to final width/height and removes the transform.
 *
 * @param {Object} fromDims - { width, height } current dimensions
 * @param {Object} toDims - { width, height } target dimensions
 * @param {Object} transition - { duration, easing }
 * @private
 */
_applyAnimatedDimensions(fromDims, toDims, transition) {
  if (!this._iframe) return;

  const duration = this._clampDuration(transition.duration);
  const easing = this._sanitizeEasing(transition.easing || 'ease-out');

  const scaleX = toDims.width / fromDims.width;
  const scaleY = toDims.height / fromDims.height;

  // Set transform-origin based on anchor point (default: top-left)
  this._iframe.style.transformOrigin = 'top left';
  this._iframe.style.transition = `transform ${duration}ms ${easing}`;
  this._iframe.style.transform = `scale(${scaleX}, ${scaleY})`;

  const cleanup = () => {
    this._iframe.removeEventListener('transitionend', onEnd);
    // Snap to final dimensions — single layout recalc
    this._iframe.style.transition = '';
    this._iframe.style.transform = '';
    this._applyIframeDimensions(toDims);

    // Notify creative that transition completed
    this._protocol.sendMessage(ContainerMessages.PLACEMENT_TRANSITION_END, {
      finalDimensions: toDims,
    });
  };

  const onEnd = (e) => {
    if (e.propertyName === 'transform') cleanup();
  };

  this._iframe.addEventListener('transitionend', onEnd);

  // Safety timeout: if transitionend never fires (tab hidden, etc.), snap anyway
  setTimeout(cleanup, duration + 100);
}
```

### 6.3 Why `transform: scale()` Instead of `width`/`height`

| Concern | `width`/`height` transition | `transform: scale()` + snap |
|---------|---------------------------|----------------------------|
| Layout recalc during animation | Every frame (synchronous in WebKit) | None — composited on GPU |
| Creative internal resize events | Continuous during transition | One event at snap point |
| Visual quality | Pixel-perfect throughout | Slightly blurry during scale, pixel-perfect at snap |
| Complexity | Simple CSS | Moderate — requires scale calc, cleanup, safety timeout |
| Safari WKWebView perf | Poor — main thread blocked | Good — compositor thread |

**Trade-off acknowledged:** During the `scale()` animation, the iframe content appears slightly scaled (bitmap upscale/downscale) rather than reflowed. This is a 100-500ms visual artifact. At typical ad animation durations (200-300ms), this is imperceptible to users. The snap to final dimensions at `transitionend` ensures pixel-perfect rendering for the steady state.

**OMID bridge interaction:** During the `transform: scale()` animation, the iframe's `getBoundingClientRect()` reports continuously changing dimensions that reflect the visual transform, not the layout dimensions. The OMID bridge (`sharc-omid-bridge.js`) must suppress viewability geometry reporting during the transition and only report the final snapped dimensions after `placementTransitionEnd`. Otherwise, OMID measurement sessions may record incorrect geometry data during the animation. The OMID bridge should listen for `placementTransitionEnd` and resume geometry reporting at that point.

Additionally, the container-rendered close button must be registered as a friendly obstruction with the OM SDK via `addFriendlyObstruction()`. The `closeButtonPosition` field in `Container:placementChange` provides the coordinates needed for this registration. The OMID bridge should update the obstruction registration whenever `closeButtonPosition` changes (e.g., on resize, maximize, or close position override).

### 6.4 `transform-origin` and Anchor Point

The `transform-origin` must align with the creative's `anchorPoint` (if provided) so the animation expands from the correct corner:

| `anchorPoint` | `transform-origin` |
|--------------|-------------------|
| `top-left` (default) | `top left` |
| `top-right` | `top right` |
| `bottom-left` | `bottom left` |
| `bottom-right` | `bottom right` |

### 6.5 Duration Capping

The container caps `transition.duration` to prevent creatives from using excessively long animations that block close button access.

**Decision:** Maximum duration is 500ms. The container silently clamps values above 500 to 500. Values below 0 are treated as 0 (instant). This answers PRD Open Question 4.

```javascript
_clampDuration(duration) {
  if (typeof duration !== 'number' || duration < 0) return 0;
  return Math.min(duration, 500);
}
```

### 6.6 Easing Validation

Only the five CSS keyword values are accepted: `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`. Custom `cubic-bezier()` values are rejected (silently replaced with `ease-out`). This answers PRD Open Question 3 — the validation burden of arbitrary cubic-bezier strings is not worth the marginal creative flexibility.

---

## 7. Close Region Ownership Model

The container owns the close button in ALL placement change states. This is the defining design change in v0.3 and follows SHARC's core principle: the container has authority over the trust boundary.

### 7.1 Design Principle: Close is a Safety Mechanism

The close affordance is not a UI element -- it is a **safety mechanism** that guarantees users can always dismiss an ad. Safety mechanisms must live outside the sandbox. A creative running inside a sandboxed iframe (with `allow-scripts` but not `allow-same-origin`) can manipulate its own DOM arbitrarily: it can set `z-index: 2147483647`, overlay opaque elements, intercept click events, or apply CSS transforms that visually hide injected elements. Any close button rendered inside the creative's iframe is vulnerable to accidental or deliberate interference.

The container's close button is a DOM element on the **publisher page**, positioned as a sibling to the iframe. It is immune to creative CSS, creative JavaScript, and creative DOM manipulation. This is the same trust model used by browser-native UI (e.g., the Fullscreen API's "Press Escape to exit" overlay, or iOS WKWebView's navigation chrome).

### 7.2 Ownership Rules by Intent

| Intent | Who renders close | Close position source | Notes |
|--------|------------------|----------------------|-------|
| `resize` | **Container** renders close button as iframe sibling | Creative's `closeRegion` hint, or default `top-right` | Changed in v0.3 -- was creative-rendered |
| `maximize` | **Container** renders close button as iframe sibling | Container default (`top-right`) | Unchanged |
| `fullscreen` | **Container** renders close button as iframe sibling | Container default (`top-right`) | Unchanged |
| `minimize`/`restore` | N/A -- close button removed | N/A | Returns to default; no close button needed |

### 7.3 The `closeRegion` Field is a Hint

When a creative sends `requestPlacementChange` with a `closeRegion` field, it is expressing a **preference** for where the container should position the close button. The container evaluates the hint:

- If the hinted position is onscreen: the container honors it.
- If the hinted position is offscreen: the container silently overrides to `top-right` and accepts the resize.
- If no `closeRegion` is provided: the container uses `top-right` by default.

The creative never renders the close button. The creative never needs to know whether its hint was honored -- the close button is always visible and functional regardless.

### 7.4 Why This Changed from v0.2

In v0.2, the resize intent placed close button responsibility on the creative (or the MRAID bridge injecting into creative DOM). This created three problems:

1. **Trust boundary violation.** A creative could claim to have a close button at a declared `closeRegion` but render nothing there, or render a transparent element that intercepts clicks without actually closing.

2. **Bridge complexity.** The MRAID bridge had to inject DOM elements (`_injectCloseIndicator`) into the creative's document, manage their lifecycle, and hope creative CSS did not interfere. This added ~60 LOC of fragile DOM manipulation to the bridge.

3. **Inconsistency.** Maximize and fullscreen already used container-rendered close. Having resize use creative-rendered close meant two different trust models for the same safety mechanism. This is confusing for implementers and creates a security gap for the most common placement change intent.

---

## 8. MRAID Bridge Changes

### 8.1 `resize()` Wiring Update

The existing `resize()` function (line 721 of `sharc-mraid-bridge.js`) already sends `intent: 'resize'` with `targetDimensions` and `targetPosition`. The changes are:

1. **Add `closeRegion` hint field:**

```javascript
// In mraid.resize(), replace the SHARC.requestPlacementChange call:
SHARC.requestPlacementChange({
  intent: 'resize',
  targetDimensions: {
    width: _s._resizeProps.width,
    height: _s._resizeProps.height,
  },
  targetPosition: {
    x: pos.x + (_s._resizeProps.offsetX || 0),
    y: pos.y + (_s._resizeProps.offsetY || 0),
  },
  closeRegion: {                                    // NEW — hint only
    position: _s._resizeProps.customClosePosition,
    size: 50,
  },
  allowOffscreen: _s._resizeProps.allowOffscreen || false,
}).then(function () {
  _s._placementMode = 'resized';
  // No close indicator injection — container renders the close button
  _emit('stateChange', mraid.getState());
  _emit('sizeChange', _s._resizeProps.width, _s._resizeProps.height);
}).catch(function (err) {
  _emit('error', 'resize failed: ' + (err && err.message), 'resize');
});
```

The bridge sends `closeRegion` as a hint so the container knows the creative's preferred close button position. The bridge does **not** inject any DOM elements into the creative -- the container renders the close button on the publisher page (see Section 4.7).

2. **Update `mraid.supports('resize')`:**

The bridge should check the feature string to determine resize support:

```javascript
// In the supports() function:
if (feature === 'resize') {
  return SHARC.hasFeature('com.iabtechlab.sharc.placement.resize');
}
```

3. **`close()` and `collapse()` -- simplified:**

With container-owned close, the bridge's `close()` and `collapse()` no longer need to clean up injected DOM elements:

```javascript
close: function () {
  if (_s._placementMode === 'expanded' || _s._placementMode === 'resized') {
    mraid.collapse();
  } else {
    SHARC.requestClose().catch(function () {});
  }
},
```

### 8.2 Size Budget Impact

The v0.3 close button ownership change **reduces** the MRAID bridge size by approximately 60 LOC (removal of `_injectCloseIndicator`, `_removeCloseIndicator`, `_closePositionCSS` helpers and their call sites). This is a net simplification of the bridge.

### 8.3 `useCustomClose` Semantics Under Container-Owned Close

MRAID 3.0 deprecated `useCustomClose()` but still requires it to function. With the container now owning the close button in all states, `useCustomClose` no longer controls whether a close button is rendered -- one is ALWAYS rendered by the container.

The `useCustomClose` value now only affects what the bridge **reports** to the creative:

- `useCustomClose: false` (default): The bridge can report to the creative (via MRAID state queries) that a close button exists. The container renders it.
- `useCustomClose: true`: The bridge reports that the creative is providing its own close UI. The container STILL renders its close button -- both may be visible. This is intentional: the container's close button is a safety mechanism, not a UI preference.

In practice, most MRAID creatives that set `useCustomClose: true` position their own close button in the same region as the container's. The visual overlap is acceptable because the container's close button is a small element (50 DIPs) and the creative's custom close is typically in the same corner.

### 8.4 Removed Helpers

The following bridge helpers from v0.2 are **removed** in v0.3:

- `_injectCloseIndicator(position)` -- No longer needed. The container renders close.
- `_removeCloseIndicator()` -- No longer needed. No injected element to remove.
- `_closePositionCSS(position)` -- No longer needed. Close button positioning is container-side.

The bridge no longer mutates the creative's DOM for close button purposes. This eliminates the class of bugs where creative CSS interferes with an injected close indicator.

---

## 9. Wire Protocol Additions

### 9.1 `Creative:getPlacementConstraints`

**Direction:** Creative -> Container (request/resolve)

**Request:**
```javascript
{
  sessionId: string,
  messageId: number,
  timestamp: number,
  type: 'SHARC:Creative:getPlacementConstraints',
  args: {}
}
```

**Resolve:**
```javascript
{
  sessionId: string,
  messageId: number,
  timestamp: number,
  type: 'resolve',
  args: {
    messageId: number,  // original request messageId
    value: {
      maxWidth: number | null,       // null = unconstrained
      maxHeight: number | null,
      allowedIntents: string[],
      requireCloseRegion: boolean,
      allowOffscreen: boolean
    }
  }
}
```

### 9.2 `Container:placementConstraintsChange`

**Direction:** Container -> Creative (notification, requires resolve)

**Message:**
```javascript
{
  sessionId: string,
  messageId: number,
  timestamp: number,
  type: 'SHARC:Container:placementConstraintsChange',
  args: {
    maxWidth: number | null,
    maxHeight: number | null,
    allowedIntents: string[],
    requireCloseRegion: boolean,
    allowOffscreen: boolean
  }
}
```

### 9.3 `Container:placementTransitionEnd`

**Direction:** Container -> Creative (notification, requires resolve)

**Message:**
```javascript
{
  sessionId: string,
  messageId: number,
  timestamp: number,
  type: 'SHARC:Container:placementTransitionEnd',
  args: {
    finalDimensions: { width: number, height: number }
  }
}
```

### 9.4 Updated `Creative:requestPlacementChange` Args

```javascript
{
  intent: 'resize' | 'maximize' | 'fullscreen' | 'minimize' | 'restore',
  targetDimensions?: { width: number, height: number },
  targetPosition?: { x: number, y: number },
  anchorPoint?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
  closeRegion?: {                          // NEW — positioning hint, not a declaration
    position: string,                      // See PRD Appendix C for enum
    size?: number                          // Default 50, minimum 50 (informational — container enforces its own minimum)
  },
  allowOffscreen?: boolean,                // NEW — now enforced
  transition?: {                           // NEW
    duration: number,                      // ms, capped at 500
    easing?: string                        // CSS keyword, default 'ease-out'
  }
}
```

### 9.5 Updated `Container:placementChange` Args

```javascript
{
  placementUpdate: {
    width: number,
    height: number,
    position?: { x: number, y: number, width: number, height: number }
  },
  closeButtonPosition?: {                  // NEW — actual rendered close button coordinates
    position: string,                      // enum: top-left|top-center|top-right|...
    x: number,                             // absolute x coordinate on publisher page
    y: number,                             // absolute y coordinate on publisher page
    width: number,                         // rendered width (≥50 DIP)
    height: number                         // rendered height (≥50 DIP)
  },
  transition?: {                           // NEW — actual timing applied
    duration: number,
    easing: string
  }
}
```

**`closeButtonPosition` semantics:** Always present when the container renders a close button (resize, maximize, fullscreen intents). Absent on restore/minimize. The creative uses this to avoid rendering content behind the close button. The OMID bridge uses it to register the close button as a friendly obstruction via `addFriendlyObstruction()` so it does not count against viewability measurement.
```

### 9.6 Protocol Message Registry Additions

Add to `CreativeMessages` in `sharc-protocol.js`:

```javascript
GET_PLACEMENT_CONSTRAINTS: 'SHARC:Creative:getPlacementConstraints',
```

Add to `ContainerMessages` in `sharc-protocol.js`:

```javascript
PLACEMENT_CONSTRAINTS_CHANGE: 'SHARC:Container:placementConstraintsChange',
PLACEMENT_TRANSITION_END: 'SHARC:Container:placementTransitionEnd',
```

---

## 10. Decisions and Trade-offs

### Web Standards Alignment

SHARC's design principle — "Don't invent new patterns when the platform already has them" — extends to the placement change system. The state machine aligns with the Chrome/WebKit Page Lifecycle API; the placement change system follows these web platform patterns:

| SHARC Concept | Web Standard Precedent | What We Adopt | What We Do Not |
|---|---|---|---|
| `requestPlacementChange` reject semantics | **Fullscreen API** | Promise-based request; container (UA) can reject | `fullscreenchange`/`fullscreenerror` event pair (we use resolve/reject + `placementChange`) |
| `getPlacementConstraints()` + `constraintsChange` | **Permissions API** + **ResizeObserver** | Query-before-request pattern; debounced change notification | Frame-aligned batching (impossible cross-MessageChannel); `PermissionStatus` shape |
| `transition: { duration, easing }` | **Web Animations API** | `duration` (ms), `easing` (CSS keyword) vocabulary | `fill`, `delay`, `iterations`, `KeyframeEffect` |
| `getCachedConstraints()` sync read | **Visual Viewport API** | Sync cached access updated by async events | True sync property (impossible cross-process; cache may be stale) |

**Framing:** These are design influences, not compliance claims. SHARC is "informed by" these patterns, not "implementing" these APIs. The distinction matters for standards body positioning — SHARC consistently follows web platform idioms, which lowers the learning curve for implementers and differentiates it from MRAID's proprietary API surface.

**Not referenced in this spec** (useful for positioning materials only): CSS Containment / Container Queries, Popover API, Fenced Frames, CSS Anchor Positioning. These are either too abstract, too nascent, or architecturally opposed to be useful as technical design references.

---

### ADR-PC-001: Close Region Geometry — Container-Only Validation

**Status:** Accepted (revised in v0.3 — supersedes v0.2 dual-copy approach)

**Context:** In v0.2, the close region geometry algorithm was duplicated in both the MRAID bridge (client-side pre-validation) and the container (server-side enforcement). The rationale was that bridge-side pre-validation prevented wasted round trips. With v0.3's design change (container owns the close button in all states), the bridge no longer renders close indicators and the close region is a hint, not a declaration.

**Decision:** The close region geometry algorithm lives only in the container (`_resolveClosePosition`, `_computeCloseRegionRect`). The MRAID bridge sends the creative's `customClosePosition` as a `closeRegion` hint but does not validate it. The bridge still validates resize **dimensions** client-side (width/height bounds), but close region positioning is entirely the container's responsibility.

**Consequences:**
- *Easier:* Single source of truth for close region geometry. No risk of bridge and container copies diverging. The bridge is simpler -- ~60 fewer LOC. The container never rejects based on close position (it overrides to a visible default), so there are no wasted round trips to prevent.
- *Harder:* If a creative's close position hint is offscreen, it does not find out until after the resize succeeds and the close button appears in a different position than requested. In practice this is a non-issue -- the creative does not render the close button and has no reason to care about its exact position.

---

### ADR-PC-002: `transform: scale()` Animation Instead of CSS `width`/`height`

**Status:** Accepted

**Context:** The PRD specifies CSS transitions on `width`/`height`. The frontend review identified that this causes layout thrash in Safari WKWebView, where layout recalculation during transitions is synchronous.

**Decision:** Animate using `transform: scale()` for the visual transition. Snap to final `width`/`height` on `transitionend`. This composites on the GPU and avoids layout recalc during animation.

**Consequences:**
- *Easier:* Performance is dramatically better on Safari/WKWebView. No layout thrash. Creative does not receive continuous resize events during animation.
- *Harder:* Slight visual blur during the scale animation (bitmap scaling). Requires cleanup logic (`transitionend` listener + safety timeout). Requires `transform-origin` calculation to align with anchor point.
- *Risk:* If the creative uses CSS that is sensitive to its own `transform` property (unlikely for ad creatives), the scale animation could interfere. The snap at `transitionend` clears the transform, limiting exposure.

---

### ADR-PC-003: `customValidator` Is Synchronous

**Status:** Accepted

**Context:** PRD Open Question 1 asks whether `customValidator` should be async (return a Promise) to allow publishers to call external policy services.

**Decision:** `customValidator` is synchronous. It returns `{ allowed: boolean, reason?: string }`, not a Promise.

**Consequences:**
- *Easier:* Placement change validation completes in a single synchronous pass. No async coordination, no timeout management for the validator call. The 50ms latency target for `getPlacementConstraints` is trivially met.
- *Harder:* Publishers cannot call external services in the validator. If a publisher needs server-side policy evaluation, they must pre-fetch the policy and configure `placementPolicy` with the results at container construction time.
- *Rationale:* Async validators would add unpredictable latency to every placement change request. Ad creatives are latency-sensitive — a 200ms policy service call would be unacceptable. The synchronous model forces publishers to resolve policy before the ad session starts, which is the right time to do it.

---

### ADR-PC-004: `getPlacementConstraints` Returns Constraints Separately from Current Placement

**Status:** Accepted

**Context:** PRD Open Question 2 asks whether `getPlacementConstraints` should also return `currentPlacement`, combining the `getPlacementOptions` and `getPlacementConstraints` queries.

**Decision:** Keep them separate. `getPlacementConstraints` returns only the policy constraints. `getPlacementOptions` returns only the current placement state.

**Consequences:**
- *Easier:* Each message has a single responsibility. The constraint response is small and cacheable. `getPlacementOptions` is unchanged — no backward compatibility risk.
- *Harder:* A creative that needs both must make two round trips. In practice, `getPlacementConstraints` is called once at init (and cached), while `getPlacementOptions` is called on demand. The two-call pattern is tolerable.
- *Rationale:* Constraints are static (they change only on rotation/resize events). Current placement is dynamic (changes on every placement mutation). Combining them would force the creative to make a full round trip to read constraints that haven't changed.

---

### ADR-PC-005: Easing Restricted to CSS Keywords, No Custom `cubic-bezier()`

**Status:** Accepted

**Context:** PRD Open Question 3 asks whether animation hints should support custom `cubic-bezier()` values.

**Decision:** Only the five CSS easing keywords are accepted: `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`. Custom `cubic-bezier()` values are silently replaced with `ease-out`.

**Consequences:**
- *Easier:* No CSS injection risk from malformed cubic-bezier strings. Validation is a simple set membership check. The five keywords cover all practical ad animation use cases.
- *Harder:* Creative developers who want precise easing curves cannot specify them via the SHARC protocol. They can still apply custom easing to their own internal animations — the `transition` hint only governs the container's iframe resize animation.

---

### ADR-PC-006: Container Owns Close Button Rendering in All States

**Status:** Accepted (reversed from v0.2 — replaces bridge-injected close indicator)

**Context:** In v0.2, the MRAID bridge injected a DOM close indicator into the creative's document when `useCustomClose: false` and the creative was in resized state. This was necessary because SHARC's v0.2 design had the creative responsible for its own close UI on resize. The bridge had to reconcile the MRAID expectation (SDK renders close) with the SHARC model (creative renders close).

The v0.2 approach had three problems: (1) the injected close element lived inside the sandbox and was vulnerable to creative CSS/DOM interference, (2) the bridge was mutating the creative's DOM -- a responsibility that added complexity and fragility, and (3) resize used a different trust model than maximize/fullscreen, creating an inconsistency in the security boundary.

**Decision:** The container renders the close button in ALL placement change states (resize, maximize, fullscreen). The close button is a DOM element on the publisher page, positioned as a sibling to the iframe. The MRAID bridge does not inject any close indicators. The `closeRegion` on `requestPlacementChange` is a positioning hint, not a rendering directive.

**Consequences:**
- *Easier:* The close affordance is immune to creative interference -- it lives outside the sandbox. The MRAID bridge is simpler (no `_injectCloseIndicator`, `_removeCloseIndicator`, `_closePositionCSS`). Consistent trust model across all placement change intents. No risk of creative CSS hiding the close button.
- *Harder:* The container must manage close button DOM lifecycle (create on resize/maximize, remove on restore/close). The close button is visually "on top of" the iframe content, which could overlap creative content in the close region corner. Publishers need a `closeButtonStyles` customization option if they want to adjust the appearance.
- *Rationale:* The close button is a safety mechanism, not a UI preference. Safety mechanisms must live outside the trust boundary they protect. This follows the same pattern as the Fullscreen API's browser-controlled exit affordance and iOS WKWebView's navigation chrome.

---

### ADR-PC-007: No `placementTransitionStart` Event — End-Only Transition Lifecycle

**Status:** Accepted

**Context:** The initial design included both `placementTransitionStart` and `placementTransitionEnd` events. The frontend review identified that `placementTransitionStart` is fragile: if the container sends a `placementChange` with a `transition` field but does not animate (e.g., `prefers-reduced-motion`, app backgrounded mid-animation, publisher policy), the creative receives a start with no corresponding end — a hanging state.

**Decision:** Only `placementTransitionEnd` is emitted. The creative infers "start" from its own `requestPlacementChange()` resolving. The container MUST fire `placementTransitionEnd` even when animation is skipped (with the instantly-applied `finalDimensions`).

**Consequences:**
- *Easier:* No hanging states. Every placement change with a `transition` hint produces exactly one `placementTransitionEnd`. Simpler SDK surface (one event, not two). Follows the iOS `viewDidAppear` pattern where developers key on the settled state, not the transitional one.
- *Harder:* If a creative needs to hide content during the scale animation to avoid visual tearing, it must do so optimistically when `requestPlacementChange()` resolves, not in response to a discrete start event. In practice, the 100-500ms animation window is short enough that this is a non-issue.
- *Rationale:* An app-background event during animation would prevent `transitionend` from firing, leaving a dangling start with no resolution. The end-only model eliminates this class of bug entirely.

---

### ADR-PC-008: `getCachedConstraints()` Returns Unconstrained Defaults, Never Null

**Status:** Accepted

**Context:** The frontend review recommended dropping `getCachedConstraints()` entirely, arguing it's a footgun that returns null before the first query. The PM and architect recommended keeping it for sync access in tight code paths (e.g., inside a `placementChange` handler).

**Decision:** Keep `getCachedConstraints()` but return unconstrained defaults (not null) before any query or `constraintsChange` event populates the cache. The unconstrained default is permissive: `{ maxWidth: null, maxHeight: null, allowedIntents: [...all...], requireCloseRegion: false, allowOffscreen: true }`.

**Consequences:**
- *Easier:* No null-check required. A creative that calls `getCachedConstraints()` before init gets a safe permissive default. The Visual Viewport API analogy holds — `visualViewport.width` always returns a value.
- *Harder:* A creative may act on stale/default constraints before the first `constraintsChange` event arrives. Mitigated by documentation: "Values are stale until the first `constraintsChange` event or `getPlacementConstraints()` response."

---

## Appendix: Files to Modify

| File | Changes | Section Reference |
|------|---------|-------------------|
| `examples/sharc-protocol.js` | Add `GET_PLACEMENT_CONSTRAINTS` to `CreativeMessages`; add `PLACEMENT_CONSTRAINTS_CHANGE` and `PLACEMENT_TRANSITION_END` to `ContainerMessages` | Section 9.6 |
| `examples/sharc-container.js` | Add `placementPolicy` and `closeButtonStyles` constructor options; add `_originalPlacement`, `_preResizeCSSState`, `_closeButton`, `_closeButtonStyles`, `_currentIntent` fields; rewrite `_handleRequestPlacementChange` with validation pipeline; add `_validatePlacementRequest`, `_resolveClosePosition`, `_computeCloseRegionRect`, `_snapshotPreResizeState`, `_restorePreResizeState`, `_applyAnimatedDimensions`, `_clampDuration`, `_sanitizeEasing` helpers; add `_createCloseButton`, `_removeCloseButton`, `_applyClosePosition` close button rendering methods; add `getPlacementConstraints` handler; add `placementConstraintsChange` notification on resize/orientation; call `_createCloseButton` on resize/maximize/fullscreen, `_removeCloseButton` on restore/minimize/close/destroy | Sections 4.1-4.7, 6.2-6.5 |
| `examples/sharc-creative.js` | Add `getPlacementConstraints()` method; add `getCachedConstraints()` method (returns unconstrained defaults before first population); add `getSupportedFeatures` to `window.SHARC` exposure block (bug fix); add `getPlacementConstraints` and `getCachedConstraints` to `window.SHARC` exposure block; add `constraintsChange` (with `reason` field) and `placementTransitionEnd` event wiring | Sections 2.1, 5.1-5.3 |
| `examples/sharc-mraid-bridge.js` | Add `closeRegion` hint to `resize()` request; **remove** `_injectCloseIndicator`, `_removeCloseIndicator`, `_closePositionCSS` helpers; simplify `close()`/`collapse()` (no close indicator cleanup needed); update `supports('resize')` to check feature string; update `useCustomClose` semantics (reporting-only, no rendering) | Sections 8.1-8.4 |
| `docs/api-reference.md` | Document `getPlacementConstraints` message; document `closeRegion` as a hint field (not a declaration); document `allowOffscreen`, `transition` fields; document `placementConstraintsChange` notification; document `placementTransitionEnd` notification; update `requestPlacementChange` to document rejection semantics (note: close region position no longer causes rejection); document `closeButtonStyles` constructor option; add new feature strings | Sections 3, 4.7, 9 |
| `CHANGELOG.md` | MINOR version bump | N/A |
