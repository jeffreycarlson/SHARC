# PRD: Enhanced Placement Change System

**Status**: Draft
**Author**: Alex (Product Manager)
**Last Updated**: 2026-04-12
**Version**: 1.2
**Stakeholders**: SHARC Protocol Lead, MRAID Bridge Maintainer, SafeFrame Bridge Maintainer, Test Harness Owner

### Revision History

| Version | Date | Change Summary |
|---------|------|---------------|
| 1.0 | 2026-04-12 | Initial draft |
| 1.1 | 2026-04-12 | Added Phase 2 test plan: test matrix (31 cases across 4 surfaces), test creative specs, harness updates, success criteria |
| 1.2 | 2026-04-12 | Design change: container renders close button in ALL cases (not just maximize/fullscreen). `closeRegion` becomes a placement hint. MRAID bridge no longer injects close indicators. Updated Sections 6.2, 6.3, 7.4, Stories 2/3, test cases TC-MR-006/TC-MR-007, and open questions. |

---

## 1. Problem Statement

SHARC's placement change system has a fundamental trust gap: the container blindly accepts every `Creative:requestPlacementChange` message. A creative can request any size, any position, and any intent — and the container will honor it without validation. This is architecturally unsound for a secure ad container standard.

**Three concrete problems exist today:**

1. **No publisher control over placement changes.** Publishers cannot constrain what creatives are allowed to do. A creative can maximize to fullscreen, resize to arbitrary dimensions, or request placement changes the publisher's page layout cannot accommodate. There is no policy layer between the creative's request and the container's execution.

2. **MRAID `resize()` is broken.** The MRAID bridge's `resize()` method wires through to `requestPlacementChange` with intent `resize`, but the container has no concept of close regions, offset validation, or max-size enforcement at the protocol level. This blocks approximately 30-40% of expandable mobile creatives that use MRAID resize rather than expand. The bridge performs client-side validation (close button positioning, max size checks), but the container itself applies no server-side enforcement.

3. **Creatives cannot discover constraints before requesting.** The current `getPlacementOptions` message returns the current placement state, not what the container allows. A creative that wants to resize has no way to ask "What are my limits?" before firing a request. The result is a try-fail-retry pattern that produces flickering, wasted round trips, and poor user experience.

**Who is affected:**

- **Publishers / SSPs**: Cannot enforce brand safety, layout integrity, or UX standards on ad placement behavior. A rogue creative can break page layout.
- **Creative developers**: Cannot build adaptive resize logic because they have no way to discover container constraints. Must hardcode dimensions or accept rejection blindly.
- **MRAID creative vendors**: ~30-40% of expandable mobile creatives use `mraid.resize()` which currently fires `COMMAND_NOT_SUPPORTED` through the SHARC bridge.

**Cost of not solving:**

- SHARC cannot claim MRAID 3.0 resize compliance. Blocks adoption by mobile-first DSPs and creative studios.
- Publishers who evaluate SHARC will reject it for lacking basic placement governance — a capability that both MRAID (via SDK-level enforcement) and SafeFrame (via host-side geometry management) provide today.
- Creative developers default to MRAID expand (fullscreen) when resize is broken, producing worse user experiences.

**Evidence:**

- MRAID bridge code: `resize()` is implemented but the container lacks close region validation, making the end-to-end flow incomplete.
- `_handleRequestPlacementChange` in `sharc-container.js` (line 977): no validation, no policy check — every intent is accepted.
- SafeFrame `$sf.ext.expand()` with directional offsets already maps to SHARC resize intent correctly, but the container-side enforcement gap applies equally.

---

## 2. Goals & Success Metrics

| Goal | Metric | Current Baseline | Target | Measurement Window |
|------|--------|-----------------|--------|--------------------|
| Enable publisher placement governance | % of requestPlacementChange messages validated against policy | 0% | 100% | Immediate on implementation |
| Unblock MRAID resize() | MRAID 3.0 compliance test pass rate for resize operations | 0% (fires error) | 100% pass | 30 days post-implementation |
| Eliminate try-fail-retry pattern | Creative round trips per successful placement change | Unmeasured (no constraint query exists) | 1 round trip (query then request) | 60 days post-implementation |
| Maintain backward compatibility | Existing creatives that do not use resize continue to function | 100% | 100% | Immediate — regression gate |
| Creative SDK stays under size budget | sharc-creative.js minified size | ~4.2KB | <5KB | Per-release check |

---

## 3. Non-Goals

Explicitly out of scope for this initiative:

- **SafeFrame push expand (`exp-push`).** Requires publisher page reflow, which is architecturally blocked by the `allow-scripts`-only sandbox. Deferred to a future `com.iabtechlab.sharc.layout` extension with a publisher callback model. Revisit when publisher demand materializes.
- **MRAID two-part expand (URL argument to `expand()`).** Dead pattern from 2012 with near-zero production usage. The bridge already fires an error event when a URL is passed. Migration path: responsive markup with lazy asset loading.
- **Responsive negotiation (`preferredDimensions` + `minimumDimensions`).** A forward-looking native capability where the container responds with what it actually granted. Deferred to v2 — requires protocol-level negotiation semantics that are out of scope here.
- **Viewport-aware auto-restore (`autoRestore: 'onScrollOut'`).** Container would automatically restore placement when the ad scrolls out of view. Requires scroll context awareness that is not yet in the protocol. Deferred to v2.
- **Publisher page reflow coordination.** When a creative resizes, the publisher page may need to reflow content around the new dimensions. This is publisher-side implementation and is not governed by the SHARC protocol.
- **Animation rendering.** Animation hints (Section 7.5) tell the container *what* transition to perform. How the container renders the animation (CSS transitions, Web Animations API, native platform animation) is implementation-specific and out of scope for the protocol.

---

## 4. Scope Summary: What Changes Where

Before diving into detailed requirements, this table clarifies what is a protocol change (affects `api-reference.md` and wire format) versus what stays container-local.

| Change | Protocol Wire Change | Container-Only | Creative SDK Change | Bridge Change |
|--------|---------------------|----------------|--------------------|----|
| Placement policy (maxWidth, maxHeight, allowedIntents, etc.) | No | Yes — constructor option | No | No |
| Close region hint on placement requests | Yes — new optional field in `requestPlacementChange` args | Close button rendering + hint interpretation | SDK passes through | MRAID bridge populates from `customClosePosition` |
| Close button rendering (all intents) | No — container-side DOM rendering | Yes — renders close button as sibling to iframe | No | No — bridge no longer injects close indicators |
| `getPlacementConstraints()` query | Yes — new Creative message type | Resolve handler | New SDK method | Bridge can use internally |
| Animation hints | Yes — new optional field on placement messages | Container interprets | SDK passes through | Bridge can populate |
| MRAID `resize()` bridge wiring | No — uses existing `requestPlacementChange` | Policy enforcement | No | Yes — already partially wired |
| Feature strings for new capabilities | Yes — advertised in `Container:init` | Registered per policy | `hasFeature()` check | `supports()` mapping |

---

## 5. User Personas & Stories

### Persona 1: Publisher Ad Ops Engineer (Primary)

Mid-market publisher running 50M+ monthly ad impressions. Integrates SHARC container into their page. Needs to control what ad creatives can do to the page layout without reviewing every creative.

### Persona 2: Creative Developer at a DSP

Builds expandable rich media units for mobile and web. Uses MRAID resize() for non-fullscreen expansion. Needs reliable, predictable placement change behavior across containers.

### Persona 3: SSP Integration Engineer

Integrates SHARC into an SSP's ad serving stack. Needs to configure placement policies per publisher and trust that the container enforces them.

---

**Story 1 (Publisher Policy):** As a publisher ad ops engineer, I want to configure maximum dimensions and allowed placement intents for each ad slot so that no creative can break my page layout regardless of what it requests.

**Acceptance Criteria:**
- [ ] Given a `SHARCContainer` constructed with `placementPolicy: { maxWidth: 728, maxHeight: 480, allowedIntents: ['resize', 'restore'] }`, when a creative sends `requestPlacementChange({ intent: 'maximize' })`, then the container rejects with error code `2203` and message indicating the intent is not allowed.
- [ ] Given a placement policy with `maxWidth: 400`, when a creative sends `requestPlacementChange({ intent: 'resize', targetDimensions: { width: 500, height: 250 } })`, then the container rejects with error code `2203` and message indicating dimensions exceed policy.
- [ ] Given no `placementPolicy` option is provided, when a creative sends any valid `requestPlacementChange`, then the container behaves exactly as it does today (full backward compatibility).

**Story 2 (Close Region Hint):** As a creative developer, I want to suggest where the container should position its close button on a resized ad so that the close affordance does not obscure my creative content.

**Acceptance Criteria:**
- [ ] Given a creative sends `requestPlacementChange({ intent: 'resize', targetDimensions: { width: 320, height: 480 }, closeRegion: { position: 'top-right', size: 50 } })`, then the container renders its close button as a DOM element on the publisher page (sibling to the iframe, outside the sandbox), positioned at the hinted location relative to the iframe bounds.
- [ ] Given a creative sends `requestPlacementChange({ intent: 'resize' })` without a `closeRegion` field, then the container renders its close button at the default position (top-right) — the close button is always present regardless of whether a hint is provided.
- [ ] Given a creative sends a `closeRegion` hint that would place the close button offscreen, then the container accepts the resize but overrides the close button position to the default (top-right), ensuring the close affordance is always visible and accessible.
- [ ] Given any placement change intent (resize, maximize, fullscreen), the container always renders a close button outside the sandbox. The creative cannot suppress, hide, or interfere with this affordance.

**Story 3 (MRAID resize):** As a creative developer using MRAID, I want `mraid.resize()` to work correctly inside a SHARC container so that my existing expandable creatives run without modification.

**Acceptance Criteria:**
- [ ] Given an MRAID creative calls `mraid.setResizeProperties({ width: 320, height: 480, offsetX: 0, offsetY: -100, customClosePosition: 'top-right', allowOffscreen: false })` then `mraid.resize()`, when the MRAID bridge translates this to `SHARC.requestPlacementChange({ intent: 'resize', targetDimensions: { width: 320, height: 480 }, targetPosition: { x: <computed>, y: <computed> }, closeRegion: { position: 'top-right', size: 50 }, allowOffscreen: false })`, then the container validates and resolves, the container renders a close button at the hinted position outside the sandbox, and `mraid.getState()` returns `'resized'`.
- [ ] Given the container's placement policy rejects the resize request, when the bridge receives the rejection, then `mraid.addEventListener('error', fn)` fires with an appropriate error message and `mraid.getState()` remains `'default'`.
- [ ] Given a creative calls `mraid.close()` while in `'resized'` state, then the bridge sends `requestPlacementChange({ intent: 'restore' })` and `mraid.getState()` returns `'default'`.
- [ ] The MRAID bridge does NOT inject any close indicator into the creative DOM. The container's close button (rendered outside the sandbox) is the sole close affordance. `useCustomClose` has no effect on the container's close button — it is always present.

**Story 4 (Constraint Discovery):** As a creative developer, I want to query the container's placement constraints before requesting a change so that I can adapt my resize behavior to what is actually allowed.

**Acceptance Criteria:**
- [ ] Given a creative calls `SHARC.getPlacementConstraints()`, when the container has a placement policy configured, then the promise resolves with `{ maxWidth, maxHeight, allowedIntents, requireCloseRegionHint, allowOffscreen }` reflecting the active policy.
- [ ] Given a creative calls `SHARC.getPlacementConstraints()` and the container has no placement policy, then the promise resolves with `{ maxWidth: Infinity, maxHeight: Infinity, allowedIntents: ['resize', 'maximize', 'fullscreen', 'minimize', 'restore'], requireCloseRegionHint: false, allowOffscreen: true }` (unconstrained defaults).
- [ ] `getPlacementConstraints()` completes in a single round trip with no side effects.

**Story 5 (Animation Hints):** As a creative developer, I want to declare animation intent on placement changes so that the container can coordinate smooth transitions rather than jarring instant resizes.

**Acceptance Criteria:**
- [ ] Given a creative sends `requestPlacementChange({ intent: 'resize', targetDimensions: { width: 320, height: 480 }, transition: { duration: 300, easing: 'ease-out' } })`, when the container supports the `com.iabtechlab.sharc.placement.animate` feature, then the container applies the transition timing to the iframe resize.
- [ ] Given the container does not support `com.iabtechlab.sharc.placement.animate`, when a creative includes `transition` in the request, then the field is silently ignored and the placement change executes immediately. No error is fired.
- [ ] The `transition` field is additive and optional on all placement change requests. Its absence never causes a rejection.

---

## 6. Functional Requirements

### 6.1 Placement Policy (Container-Only — No Wire Change)

The `SHARCContainer` constructor accepts a new optional `placementPolicy` option. This is **never sent over the wire** — it is a container-local enforcement layer.

```typescript
interface PlacementPolicy {
  maxWidth?: number;           // Maximum allowed width in DIPs. Default: Infinity (unconstrained)
  maxHeight?: number;          // Maximum allowed height in DIPs. Default: Infinity
  allowedIntents?: string[];   // Subset of ['resize', 'maximize', 'fullscreen', 'minimize', 'restore']
                               // Default: all intents allowed
  requireCloseRegionHint?: boolean; // If true, reject resize requests without a closeRegion hint. Default: false
                               // When false (default), the container uses top-right as the default close button position.
  allowOffscreen?: boolean;    // If true, allow resized ad to extend beyond viewport. Default: true
  customValidator?: (request: RequestPlacementChangeArgs) => { allowed: boolean, reason?: string };
                               // Escape hatch: publisher-defined validation function.
                               // Called AFTER built-in policy checks pass. Return { allowed: false, reason: '...' } to reject.
                               // Default: null (no custom validation)
}
```

**Constructor usage:**

```javascript
const container = new SHARCContainer({
  creativeUrl: '...',
  containerEl: document.getElementById('ad-slot'),
  environmentData: { ... },
  placementPolicy: {
    maxWidth: 728,
    maxHeight: 480,
    allowedIntents: ['resize', 'restore'],
    requireCloseRegion: true,
    allowOffscreen: false,
  },
});
```

**Enforcement order in `_handleRequestPlacementChange`:**

1. Validate `intent` is in `allowedIntents` (if configured). Reject with `2203` if not.
2. Validate `targetDimensions.width <= maxWidth` and `targetDimensions.height <= maxHeight` (if configured). Reject with `2203` if exceeded.
3. If `closeRegion` is present, validate `closeRegion.size >= 50`. Reject with `2211` if below minimum.
4. If `closeRegion` is present, compute the close button position. If the hinted position would be offscreen, override to the default position (top-right) — do NOT reject the placement change.
5. If `allowOffscreen === false` and `intent === 'resize'`, validate the entire resized ad fits within viewport bounds. Reject with `2203` if it would extend offscreen.
6. If `customValidator` is defined, call it with the full request args. Reject with `2203` and the validator's reason string if it returns `{ allowed: false }`.
7. If all checks pass, execute the placement change as today.

**Backward compatibility:** When `placementPolicy` is not provided (or is `undefined`), the container behaves exactly as it does today — every request is accepted. This is the zero-change default path.

### 6.2 Close Region Field — Placement Hint (Protocol Wire Change)

Add an optional `closeRegion` field to `Creative:requestPlacementChange` args. This is a **protocol change** that must be documented in `api-reference.md`.

```typescript
interface RequestPlacementChangeArgs {
  intent: 'resize' | 'maximize' | 'fullscreen' | 'minimize' | 'restore';
  targetDimensions?: { width: number; height: number };
  targetPosition?: { x: number; y: number };
  anchorPoint?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  closeRegion?: CloseRegion;       // NEW — v1 (placement hint)
  allowOffscreen?: boolean;        // NEW — v1
  transition?: TransitionHint;     // NEW — v1 (see §6.5)
}

interface CloseRegion {
  position: 'top-left' | 'top-center' | 'top-right'
          | 'center-left' | 'center-right'
          | 'bottom-left' | 'bottom-center' | 'bottom-right';
  size?: number;  // Minimum 50 DIPs. Default: 50. Container MUST reject values below 50.
}
```

**Semantics:**

- `closeRegion` is a **placement hint**, not a declaration that the creative rendered a close button. The creative is saying "put the close button here" — the container decides whether to honor the hint.
- The **container always renders the close button** as a DOM element on the publisher page, positioned as a sibling to the sandboxed iframe. The close affordance lives outside the sandbox where the creative cannot hide, obscure, or interfere with it. This applies to ALL intents: resize, maximize, and fullscreen.
- When `closeRegion` is provided, the container SHOULD honor the hinted position if it would be fully onscreen and accessible. The container MAY override the hint if the position would be offscreen, inaccessible, or conflicts with publisher policy.
- When `closeRegion` is omitted, the container renders the close button at the default position (top-right). The close button is always present — omitting the hint never suppresses it.
- `size` defaults to 50 DIPs if omitted. The container MUST reject any explicit `size` value below 50.
- `closeRegion` is **optional for all intents**, including resize. The container has a sensible default (top-right) when no hint is provided.

**Container-side close button rendering:**

The container renders the close button as a positioned DOM element on the publisher page. The rendering process:

1. On any accepted placement change (resize, maximize, fullscreen), the container creates or repositions a close button element as a sibling to the ad iframe.
2. The close button is positioned using the `closeRegion` hint (if provided and valid) or the default position (top-right of the iframe bounds).
3. The close button has a minimum tap target of 50x50 DIPs and uses a z-index above the iframe.
4. Clicking/tapping the close button triggers `requestPlacementChange({ intent: 'restore' })` on behalf of the creative.

**Close button position validation:**

If the creative provides a `closeRegion` hint that would place the close button offscreen (e.g., the iframe is near a viewport edge and the hinted position extends beyond it), the container does NOT reject the placement change. Instead, the container accepts the resize and overrides the close button position to the default (top-right) or the nearest onscreen position. The placement change itself succeeds — only the close button position is adjusted.

This is a deliberate departure from the previous design where an offscreen close region caused rejection with error `2211`. The new model separates placement validation (can the ad resize to these dimensions?) from close button positioning (where should the close affordance appear?). The container resolves both independently.

### 6.3 MRAID `resize()` Bridge Wiring (Bridge Change)

The MRAID bridge `resize()` method is already implemented and maps resize properties to `SHARC.requestPlacementChange()`. The bridge already:
- Validates resize properties via `setResizeProperties()` (min 50x50, max size check)
- Computes `targetPosition` from `_initialPosition` + offset
- Sends `intent: 'resize'` with `targetDimensions` and `targetPosition`
- Transitions `_placementMode` to `'resized'` on success

**What needs to change in the bridge:**

1. **Add `closeRegion` as a placement hint.** Map `_s._resizeProps.customClosePosition` to `closeRegion.position`. This tells the container where the creative would prefer the close button, not where the creative rendered one:

```javascript
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
  closeRegion: {                                    // NEW — placement hint
    position: _s._resizeProps.customClosePosition,  // Already validated by setResizeProperties
    size: 50,
  },
  allowOffscreen: _s._resizeProps.allowOffscreen || false,  // Already exists
});
```

2. **Remove close indicator injection logic.** The bridge NO LONGER needs to inject close indicators into the creative DOM for `useCustomClose: false`. The container renders the close button outside the sandbox in all cases. This eliminates the `_injectCloseIndicator` / `_removeCloseIndicator` code path and the associated DOM manipulation inside the sandboxed iframe.

3. **Simplify `useCustomClose` semantics.** In the MRAID bridge context:
   - `useCustomClose: false` (default) — the creative does not render its own close visual. The container's close button (always present outside the sandbox) is the sole close affordance. No bridge action needed.
   - `useCustomClose: true` — the creative renders its own close visual in addition to the container's close button. The container's close affordance is still present. The bridge simply passes `customClosePosition` as the `closeRegion` hint.
   - In both cases, the container's close button is always rendered. The `useCustomClose` flag only affects whether the creative provides a redundant visual cue within its own content.

4. **Remove bridge-side close button onscreen validation.** Since the container owns close button rendering and positioning (including fallback to default position when the hint is offscreen), the bridge no longer needs to validate close button screen position in `setResizeProperties()`. The bridge should still validate min 50x50 dimensions and max size constraints.

### 6.4 `getPlacementConstraints()` Query (Protocol Wire Change)

Add a new creative-to-container message type for constraint discovery.

**New message type in `CreativeMessages`:**

```javascript
const CreativeMessages = Object.freeze({
  // ...existing entries...
  GET_PLACEMENT_CONSTRAINTS: 'SHARC:Creative:getPlacementConstraints',
});
```

**Wire format:**

```
Creative → Container:
{
  type: "SHARC:Creative:getPlacementConstraints",
  args: {}
}

Container → Creative (resolve):
{
  type: "resolve",
  args: {
    messageId: <original>,
    value: {
      maxWidth: number | null,         // null = unconstrained
      maxHeight: number | null,        // null = unconstrained
      allowedIntents: string[],        // e.g. ['resize', 'maximize', 'restore']
      requireCloseRegionHint: boolean,
      allowOffscreen: boolean
    }
  }
}
```

**Container implementation:**

The handler reads from the configured `placementPolicy` (or returns unconstrained defaults). The `customValidator` escape hatch is NOT exposed to the creative — it is opaque server-side logic.

**Creative SDK method:**

```javascript
/**
 * Queries the container's placement constraints.
 * Returns what the container allows before the creative requests a change.
 * Requires: com.iabtechlab.sharc.placement.constraints feature.
 *
 * @returns {Promise<PlacementConstraints>}
 */
SHARC.getPlacementConstraints = function() {
  if (this._dead) return Promise.reject(new Error('SDK is dead'));
  return this._proto.getPlacementConstraints()
    .then(function(value) { return value; });
};
```

**Feature string:** `com.iabtechlab.sharc.placement.constraints`

The container advertises this feature in `supportedFeatures` when a `placementPolicy` is configured. When no policy is configured, the feature is still advertised (the response will be unconstrained defaults). Creatives use `SHARC.hasFeature('com.iabtechlab.sharc.placement.constraints')` to check availability before calling.

### 6.5 Animation Hints (Protocol Wire Change — Additive)

Add an optional `transition` field to `requestPlacementChange` args and to `Container:placementChange` notifications.

```typescript
interface TransitionHint {
  duration: number;    // Milliseconds. Recommended range: 100–500ms. Container MAY cap.
  easing?: string;     // CSS easing keyword: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out'
                       // Default: 'ease-out'
}
```

**On the request (Creative → Container):**

The creative includes `transition` to declare its preferred animation timing. The container MAY honor, modify, or ignore the hint. The container has final authority over animation behavior.

**On the notification (Container → Creative):**

When the container applies an animated transition, it includes the actual `transition` used in the `Container:placementChange` message so the creative can synchronize its own internal animations:

```javascript
// Container:placementChange args
{
  placementUpdate: { width: 320, height: 480, ... },
  transition: { duration: 300, easing: 'ease-out' }  // Actual timing applied
}
```

**Feature string:** `com.iabtechlab.sharc.placement.animate`

This feature is opt-in. Containers that do not support animation simply do not advertise the feature and ignore the `transition` field. No error is fired when a creative includes `transition` and the container does not support it — the field is silently dropped.

**Container implementation:**

When the container supports animation and receives a `transition` hint:

1. Apply CSS transition to the iframe: `iframe.style.transition = 'width ${duration}ms ${easing}, height ${duration}ms ${easing}'`
2. Apply the new dimensions (which triggers the CSS transition)
3. After the transition completes, remove the transition property to avoid interfering with future instant changes
4. Include the actual applied `transition` in the `Container:placementChange` notification

### 6.6 Feature String: `com.iabtechlab.sharc.placement.resize`

This feature string signals that the container supports validated resize operations with close region enforcement. Containers SHOULD advertise this when:

- The container has a functioning placement change handler for `intent: 'resize'`
- The container validates `closeRegion` when present
- The container enforces `placementPolicy` constraints

The MRAID bridge uses this feature to determine whether `mraid.resize()` should attempt the SHARC path or fire `COMMAND_NOT_SUPPORTED`. Update the bridge's `supports('resize')` check:

```javascript
// In mraid.supports():
if (feature === 'resize') {
  return SHARC.hasFeature('com.iabtechlab.sharc.placement.resize');
}
```

---

## 7. Non-Functional Requirements

### 7.1 Backward Compatibility

- **Existing creatives MUST NOT break.** When `placementPolicy` is not configured, placement change behavior is identical to today. The absence of `closeRegion`, `allowOffscreen`, or `transition` fields in a request MUST NOT cause rejection.
- **Existing container instantiations MUST NOT break.** The `placementPolicy` option defaults to `undefined`, which means no enforcement.
- **New fields are additive.** `closeRegion`, `allowOffscreen`, and `transition` are optional on the wire. Containers that do not understand them ignore them (Structured Clone passes unknown fields through without error).

### 7.2 Creative SDK Size Budget

`sharc-creative.js` must remain under 5KB minified with zero dependencies. The `getPlacementConstraints()` method adds approximately 150 bytes minified. The `transition` pass-through adds zero bytes (it is already part of the `args` object forwarded by `requestPlacementChange`).

### 7.3 Performance

- `getPlacementConstraints()` MUST resolve within 50ms (single MessageChannel round trip, no I/O).
- Placement policy validation in `_handleRequestPlacementChange` MUST add less than 1ms to request processing (all checks are in-memory comparisons).
- Animation hints MUST NOT block the resolve of the placement change request. The container resolves the request immediately; the animation is applied asynchronously.

### 7.4 Security

- **The close affordance is container-rendered, outside the sandbox, and immune to creative manipulation.** The close button is a DOM element on the publisher page (sibling to the iframe), not injected into the sandboxed iframe. The creative cannot hide, reposition, overlay, or apply CSS to the close button because it exists in a separate DOM tree outside the sandbox boundary. This is the strongest possible guarantee that users can always close an ad — it follows SHARC's core pattern where the container has authority over the trust boundary.
- **`placementPolicy` is never sent to the creative.** The creative learns constraints only via `getPlacementConstraints()`, which returns the policy values but not the `customValidator` function.
- **`customValidator` runs in the container's execution context**, not in the sandboxed iframe. Publishers can use it to enforce business rules without exposing logic to creatives.
- **`closeRegion` is a hint, not an instruction.** The container decides close button placement. Even if a creative sends a misleading hint (e.g., `position: 'bottom-left'` to push the close button to a less visible location), the container/publisher can override to a standard position. The creative has no mechanism to suppress or relocate the close affordance.
- **`closeRegion.size` minimum of 50 DIPs is enforced container-side.** Even if a creative sends `size: 10`, the container rejects it. This prevents creatives from requesting an impractically small close target.
- **Existing security invariants are preserved:** sandbox attributes unchanged, Structured Clone serialization, rate limiting, URL validation.

---

## 8. Technical Design Details

### 8.1 New Error Semantics for Placement Rejection

Today, `_handleRequestPlacementChange` always resolves. With placement policy, it must be able to reject. The api-reference.md currently states:

> "The container always resolves (never rejects) this message, but the resulting dimensions may not match the request."

This must be updated. The new behavior:

- **resolve**: Placement change was accepted. The resolve value contains the actual resulting placement (which may differ from the request if the container applied its own constraints).
- **reject**: Placement change was denied by policy. Error codes:
  - `2203` (Feature not supported) — intent not allowed, dimensions exceed policy, or offscreen violation
  - `2211` (Creative sending malformed messages) — missing required `closeRegion`, `closeRegion.size < 50`, or close region offscreen

This is a **behavioral change** to the protocol contract. It must be clearly documented in the api-reference.md update.

### 8.2 Protocol Message Additions Summary

| Change | Message | Direction | Type |
|--------|---------|-----------|------|
| New message type | `SHARC:Creative:getPlacementConstraints` | Creative -> Container | Request/resolve |
| New optional field | `closeRegion` on `requestPlacementChange` args | Creative -> Container | Additive |
| New optional field | `allowOffscreen` on `requestPlacementChange` args | Creative -> Container | Additive |
| New optional field | `transition` on `requestPlacementChange` args | Creative -> Container | Additive |
| New optional field | `transition` on `Container:placementChange` args | Container -> Creative | Additive |
| New feature strings | `com.iabtechlab.sharc.placement.resize`, `.constraints`, `.animate` | In `Container:init` | Feature advertisement |

### 8.3 Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `examples/sharc-protocol.js` | Add `GET_PLACEMENT_CONSTRAINTS` to `CreativeMessages` | Protocol |
| `examples/sharc-container.js` | Add `placementPolicy` option to constructor; rewrite `_handleRequestPlacementChange` with validation pipeline; add `_handleGetPlacementConstraints` handler; add `_validateCloseRegion` helper; add animation hint application | Container |
| `examples/sharc-creative.js` | Add `getPlacementConstraints()` public method | Creative SDK |
| `examples/sharc-mraid-bridge.js` | Add `closeRegion` to `resize()` request args; update `mraid.supports('resize')` to check feature string | Bridge |
| `docs/api-reference.md` | Document new message type, new fields, updated rejection semantics, new feature strings | Documentation |
| `CHANGELOG.md` | MINOR version bump (backward-compatible feature addition) | Documentation |

### 8.4 Migration Path for Existing Integrations

**Publishers upgrading SHARC container:**
- No action required unless they want to enforce placement policies. Existing code continues to work unchanged.
- To enable governance: add `placementPolicy` to the `SHARCContainer` constructor options.

**Creative developers:**
- No action required. Existing creatives that send `requestPlacementChange` without `closeRegion` or `transition` continue to work. The container will render a close button at the default position (top-right).
- To use constraint discovery: check `SHARC.hasFeature('com.iabtechlab.sharc.placement.constraints')`, then call `SHARC.getPlacementConstraints()`.
- To hint close button position: add `closeRegion` to placement change requests. The container will attempt to honor the hint. Recommended when the creative has content in the top-right corner that would be obscured by the default close button position.

**MRAID creatives:**
- No action required. The bridge handles the mapping. `mraid.resize()` will start working for creatives that previously received `COMMAND_NOT_SUPPORTED`.
- **Behavioral change:** The bridge no longer injects a close indicator into the creative DOM for `useCustomClose: false`. The container's close button (rendered outside the sandbox) replaces this. Creatives that relied on the bridge-injected close indicator will now see the container's close button instead — same user-facing behavior, different rendering location.

---

## 9. Milestones & Implementation Order

Implementation is split into two phases. Phase 1 covers the core implementation, ordered to maximize incremental value and minimize risk. Phase 2 is a comprehensive test plan that validates Phase 1 across all four test surfaces. Each Phase 1 milestone is independently shippable; Phase 2 test development can begin in parallel once the first milestone lands.

### Phase 1: Implementation

Implementation milestones are ordered for incremental value. Each milestone is independently shippable and testable.

### Milestone 1: Placement Policy (Container-Only)

**Scope:** Add `placementPolicy` constructor option and validation pipeline to `_handleRequestPlacementChange`. No protocol wire changes. No creative SDK changes. No bridge changes.

**Deliverables:**
- [ ] `placementPolicy` option parsing and defaults in `SHARCContainer` constructor
- [ ] Validation pipeline in `_handleRequestPlacementChange` (intent check, dimension check, custom validator)
- [ ] Rejection path with appropriate error codes (`2203`, `2211`)
- [ ] Test harness UI: policy configuration panel (max width/height, allowed intents checkboxes)
- [ ] Update `api-reference.md` to document that `requestPlacementChange` can now reject

**Effort:** S (1-2 engineer-days)
**Risk:** Low — container-only change, no wire protocol impact

### Milestone 2: Container-Rendered Close Button + Close Region Hints

**Scope:** Container renders close button as a DOM element on the publisher page for ALL placement changes. Add `closeRegion` hint field to the protocol. Container interprets hints and falls back to default positioning. Requires Milestone 1 for the rejection path.

**Deliverables:**
- [ ] Close button DOM rendering in `sharc-container.js` — create/reposition a close button element as a sibling to the ad iframe on every accepted placement change
- [ ] Close button positioned using `closeRegion` hint when provided and valid, default top-right otherwise
- [ ] Close button click handler triggers `requestPlacementChange({ intent: 'restore' })`
- [ ] `closeRegion` hint field added to `requestPlacementChange` args (protocol documentation)
- [ ] `_resolveCloseButtonPosition` helper that interprets the hint and falls back to default when hint would be offscreen
- [ ] Integration with placement policy's `requireCloseRegionHint` flag
- [ ] Test harness: close button visible on publisher page after resize/maximize/fullscreen, with position reflecting hint or default

**Effort:** M (2-3 engineer-days)
**Risk:** Low-Medium — additive protocol field, backward compatible. Close button z-index and positioning relative to the iframe requires care across browser layout engines.

### Milestone 3: MRAID `resize()` End-to-End

**Scope:** Wire the MRAID bridge's `resize()` to include `closeRegion` hint in the SHARC request. Remove close indicator injection logic from the bridge. Validate with MRAID 3.0 compliance test vectors. Requires Milestone 2.

**Deliverables:**
- [ ] Add `closeRegion` hint mapping to `mraid.resize()` in `sharc-mraid-bridge.js` (map `customClosePosition` to `closeRegion.position`)
- [ ] Remove `_injectCloseIndicator` / `_removeCloseIndicator` code paths from the bridge (container handles close rendering)
- [ ] Simplify `useCustomClose` handling: no longer triggers bridge-side DOM injection
- [ ] Remove bridge-side close button onscreen validation from `setResizeProperties()` (container owns positioning)
- [ ] Update `mraid.supports('resize')` to return `true` when `com.iabtechlab.sharc.placement.resize` feature is present
- [ ] Run MRAID 3.0 compliance test suite resize tests (adapt from `compliance-ads/` vectors)
- [ ] Test harness: MRAID resize test creative that exercises `setResizeProperties` -> `resize()` -> `close()` cycle

**Effort:** M (2-3 engineer-days)
**Risk:** Medium — MRAID compliance edge cases; removing bridge-side close indicator injection is a behavioral change for existing MRAID creatives that relied on `useCustomClose: false`

### Milestone 4: `getPlacementConstraints()` Query

**Scope:** New protocol message and creative SDK method. Requires Milestone 1 (container has policy to report).

**Deliverables:**
- [ ] `GET_PLACEMENT_CONSTRAINTS` message type in `sharc-protocol.js`
- [ ] Handler in `sharc-container.js` that reads from `placementPolicy` config
- [ ] `getPlacementConstraints()` method on `SHARCCreativeSDK`
- [ ] `com.iabtechlab.sharc.placement.constraints` feature string registration
- [ ] Test harness: constraint display panel in creative that shows queried constraints
- [ ] Update `api-reference.md` with new message type documentation

**Effort:** S (1-2 engineer-days)
**Risk:** Low — straightforward request/resolve pattern

### Milestone 5: Animation Hints

**Scope:** Additive `transition` field on placement change requests and notifications. Opt-in feature. Can be implemented independently of Milestones 1-4.

**Deliverables:**
- [ ] `transition` field handling in `_handleRequestPlacementChange`
- [ ] CSS transition application and cleanup in `_applyIframeDimensions`
- [ ] `transition` field forwarded in `Container:placementChange` notification
- [ ] `com.iabtechlab.sharc.placement.animate` feature string registration
- [ ] Test harness: animation toggle with duration/easing controls
- [ ] Update `api-reference.md` with `TransitionHint` documentation

**Effort:** S (1-2 engineer-days)
**Risk:** Low — purely additive, no behavioral change when absent

### Phase 1 Estimated Effort

6-10 engineer-days across all 5 milestones. Recommended sprint plan: Milestones 1+2 in Sprint 1, Milestones 3+4 in Sprint 2, Milestone 5 in Sprint 3 (or parallel with Sprint 2).

---

### Phase 2: Test Plan

Phase 2 validates the Phase 1 implementation across all four test surfaces. There is no automated test runner -- all verification is browser-based, visual, and protocol-trace-driven. A human tester loads the test creative in the harness, interacts with UI controls, and reads the protocol trace in the log pane to verify expected behavior.

#### 9.1 Test Surfaces

| # | Surface | Entry Point | Loading Model | Notes |
|---|---------|------------|---------------|-------|
| 1 | SHARC Core Harness | `examples/test/index.html` | Direct `<script>` in creative HTML | Tests native SHARC placement change API. Creative loads `sharc-protocol.js` + `sharc-creative.js` directly. |
| 2 | MRAID Bridge Harness | `examples/test/mraid-test.html` | Wrapper model: `.html` (DOM) + `.js` (logic) split, `__SHARC_TEST_mraidCreativeInit` callback | Tests MRAID `resize()`/`expand()`/`close()` through the SHARC-MRAID bridge. Creative uses `window.mraid` API. |
| 3 | SafeFrame Bridge Harness | `examples/test/safeframe-test.html` | Wrapper model: `.html` (DOM) + `.js` (logic) split, `__SHARC_TEST_sfCreativeInit` callback | Tests SafeFrame `$sf.ext.expand()`/`collapse()` through the SHARC-SafeFrame bridge. Creative uses `window.$sf.ext` API. |
| 4 | MRAID Compliance Suite | `examples/test/mraid-3-compliance-runner.html` | Compliance runner loads self-contained HTML files directly (bypasses wrapper model) | Formal IAB MRAID 3.0 compliance vectors. Self-contained creatives with inline `<script>`. Uses `EventTester`/`SequentialRunner` pattern from existing negative tests. |

#### 9.2 Test Matrix

##### SHARC Core Harness Tests

| ID | Description | Preconditions | Steps | Expected Result | Validates |
|----|-------------|---------------|-------|-----------------|-----------|
| TC-PC-001 | Resize with targetDimensions | Container loaded, creative in `active` state | 1. Click "Resize 320x480" button 2. Observe iframe dimensions in harness | iframe changes to 320x480. Protocol log shows `requestPlacementChange` resolve with matching `placementUpdate`. `placementChange` event fires in creative log. | Milestone 1 -- basic resize intent |
| TC-PC-002 | Resize with targetPosition | Container loaded, creative active | 1. Click "Resize + Offset" button (sets targetPosition x:10, y:-50) 2. Observe iframe position in harness | iframe moves to specified position. Protocol log shows `targetPosition` in request args and correct position in resolve. | Milestone 1 -- position handling |
| TC-PC-003 | Resize with closeRegion hint | Container loaded, creative active | 1. Click "Resize with Close Region" button (sends closeRegion: top-right, size: 50) 2. Observe publisher page and protocol log | Request accepted. Protocol log shows `closeRegion` in request args. Container renders close button at hinted position (top-right of resized iframe). Close button is a DOM element on the publisher page, outside the sandbox. | Milestone 2 -- close region hint honored |
| TC-PC-004 | Maximize then restore | Container loaded, creative active | 1. Click "Maximize" button 2. Verify iframe fills available space 3. Click "Restore" button 4. Verify iframe returns to original dimensions AND original position | After maximize: iframe fills container area. After restore: iframe returns to exact original width, height, x, and y position. Protocol log shows two `requestPlacementChange` messages (maximize, restore) and two `placementChange` events. | Milestone 1 -- restore resets both size and position |
| TC-PC-005 | Resize with offset then restore | Container loaded, creative active | 1. Click "Resize + Offset" (moves iframe to non-default position) 2. Verify iframe moved 3. Click "Restore" button 4. Verify iframe returns to original position | After restore: iframe returns to the position it occupied before the resize, not just the original dimensions. This is the key regression test for the restore-resets-position fix. | Milestone 1 -- restore resets position after offset |
| TC-PC-006 | Policy rejection -- dimensions exceed max | Container loaded, policy panel set to maxWidth: 400, maxHeight: 300 | 1. Click "Resize 500x400" button 2. Observe protocol log | `requestPlacementChange` rejected with error code `2203`. Creative log shows rejection. Iframe dimensions unchanged. | Milestone 1 -- dimension policy enforcement |
| TC-PC-007 | Policy rejection -- intent not allowed | Container loaded, policy panel `allowedIntents` set to `['resize', 'restore']` only | 1. Click "Maximize" button 2. Observe protocol log | `requestPlacementChange` rejected with error code `2203` and message indicating maximize intent not allowed. Iframe unchanged. | Milestone 1 -- intent policy enforcement |
| TC-PC-008 | Resize without closeRegion hint -- default close button | Container loaded, creative active | 1. Click "Resize (no close region)" button (sends resize without closeRegion field) 2. Observe publisher page | Resize succeeds. Container renders close button at default position (top-right of iframe). Close button is a DOM element on the publisher page, outside the sandbox. Protocol log shows successful resolve. | Milestone 2 -- default close button rendering |
| TC-PC-009 | Resize with offscreen closeRegion hint -- close button overridden | Container loaded, creative active | 1. Click "Resize Offscreen Close" button (sends resize that hints close region beyond viewport edge) 2. Observe publisher page and protocol log | Resize succeeds (placement change is accepted). Container renders close button at default position (top-right) instead of the offscreen hint. Protocol log shows successful resolve. Close button is visible and functional. | Milestone 2 -- close hint override when offscreen |
| TC-PC-010 | getPlacementConstraints with policy | Container loaded, policy panel configured with maxWidth: 728, maxHeight: 480, allowedIntents: ['resize', 'restore'] | 1. Click "Get Constraints" button 2. Observe constraint display panel in creative | Promise resolves with `{ maxWidth: 728, maxHeight: 480, allowedIntents: ['resize', 'restore'], requireCloseRegionHint: false, allowOffscreen: true }`. Values displayed in creative's constraint panel. | Milestone 4 -- constraint query |
| TC-PC-011 | getPlacementConstraints with no policy | Container loaded, no placementPolicy configured | 1. Click "Get Constraints" button 2. Observe constraint display panel | Promise resolves with unconstrained defaults: `{ maxWidth: null, maxHeight: null, allowedIntents: ['resize', 'maximize', 'fullscreen', 'minimize', 'restore'], requireCloseRegionHint: false, allowOffscreen: true }`. | Milestone 4 -- unconstrained defaults |
| TC-PC-012 | Animation hint on resize | Container loaded, `com.iabtechlab.sharc.placement.animate` feature enabled | 1. Click "Resize Animated" button (sends transition: { duration: 300, easing: 'ease-out' }) 2. Observe iframe resize behavior visually | iframe resizes with a visible smooth transition (not instant snap). Protocol log shows `transition` in both the request args and the `placementChange` notification. | Milestone 5 -- animation hints |
| TC-PC-013 | constraintsChange event | Container loaded, creative active | 1. Resize the browser window (simulating viewport change) 2. Observe creative log | `constraintsChange` event fires in creative with updated constraint values. Protocol log shows the notification. | Milestone 4 -- dynamic constraint updates |
| TC-PC-014 | allowOffscreen=false rejection | Container loaded, policy `allowOffscreen: false` | 1. Click "Resize Offscreen" button (sends resize that would extend iframe beyond viewport bounds, with allowOffscreen: false) 2. Observe protocol log | Rejected with error code `2203`. Iframe unchanged. | Milestone 1 -- offscreen policy enforcement |

##### MRAID Bridge Harness Tests

| ID | Description | Preconditions | Steps | Expected Result | Validates |
|----|-------------|---------------|-------|-----------------|-----------|
| TC-MR-001 | setResizeProperties + resize() positive | MRAID creative loaded, state is `default` | 1. Click "Set Resize Props" (width:320, height:480, offsetX:0, offsetY:-100, customClosePosition:'top-right', allowOffscreen:false) 2. Click "resize()" 3. Observe state display and protocol log | State changes to `resized`. Protocol log shows `requestPlacementChange` with intent `resize`, `targetDimensions`, `targetPosition`, `closeRegion: { position: 'top-right', size: 50 }`. `sizeChange` event fires. `stateChange` event fires with 'resized'. `getCurrentPosition()` returns updated dimensions. | Milestone 3 -- MRAID resize end-to-end |
| TC-MR-002 | resize() with customClosePosition variations | MRAID creative loaded, state `default` | 1. For each of: top-left, top-center, top-right, center-left, center-right, bottom-left, bottom-center, bottom-right: set resize props with that position, call resize(), verify, call close() 2. Observe protocol log for each cycle | Each resize succeeds. Protocol log shows correct `closeRegion.position` value matching the MRAID `customClosePosition` for each iteration. State cycles: default -> resized -> default. | Milestone 3 -- close position enum mapping |
| TC-MR-003 | resize() then close() | MRAID creative loaded, state `resized` (from TC-MR-001) | 1. Click "close()" 2. Observe state display and protocol log | State returns to `default`. Protocol log shows `requestPlacementChange` with intent `restore`. `stateChange` fires with 'default'. `getCurrentPosition()` returns original default position dimensions. Iframe returns to original size AND position. | Milestone 3 -- resize close/restore cycle |
| TC-MR-004 | resize() with allowOffscreen=false rejection | MRAID creative loaded, state `default` | 1. Set resize props with large offsetX that would push ad offscreen, allowOffscreen: false 2. Call resize() 3. Observe log | `error` event fires with message indicating offscreen violation. State remains `default`. No `stateChange` or `sizeChange` event. | Milestone 3 -- bridge offscreen enforcement |
| TC-MR-005 | resize() exceeding maxSize | MRAID creative loaded, state `default` | 1. Set resize props with width and height exceeding `getMaxSize()` values 2. Call resize() or setResizeProperties() 3. Observe log | `error` event fires. State remains `default`. Bridge-side validation rejects before reaching container. | Milestone 3 -- bridge max size validation |
| TC-MR-006 | resize() with useCustomClose=false -- container close button present | MRAID creative loaded, state `default`, container supports resize feature | 1. Set resize props with useCustomClose: false 2. Call resize() 3. Observe resized ad and publisher page | Container renders a close button as a DOM element on the publisher page, positioned over the iframe at the hinted `customClosePosition`. No close indicator is injected into the creative DOM. Tapping the container's close button triggers restore. State is `resized`. | Milestone 3 -- container-rendered close button |
| TC-MR-007 | resize() with useCustomClose=true -- container close button still present | MRAID creative loaded, state `default` | 1. Set resize props with useCustomClose: true 2. Call resize() 3. Observe resized ad and publisher page | Container's close button is STILL rendered on the publisher page (always present). Creative may also render its own close visual inside the ad. Both close mechanisms work. State is `resized`. | Milestone 3 -- useCustomClose does not suppress container close |
| TC-MR-008 | expand() then resize() -- error | MRAID creative loaded, state `expanded` (call expand() first) | 1. Call expand() and wait for state `expanded` 2. Set resize props 3. Call resize() 4. Observe log | `error` event fires with message indicating resize is not allowed from expanded state. State remains `expanded`. | Milestone 3 -- state guard (matches existing negative test) |
| TC-MR-009 | supports('resize') returns true | MRAID creative loaded, container has `com.iabtechlab.sharc.placement.resize` feature | 1. Click "supports()" button 2. Observe log for `resize` entry | `mraid.supports('resize')` returns `true`. Log displays feature support list including resize. | Milestone 3 -- feature string mapping |

##### SafeFrame Bridge Harness Tests

| ID | Description | Preconditions | Steps | Expected Result | Validates |
|----|-------------|---------------|-------|-----------------|-----------|
| TC-SF-001 | expand() with directional offsets | SafeFrame creative loaded, registered | 1. Click "Expand Directional" button (calls `$sf.ext.expand({ t:50, l:0, r:100, b:0 })`) 2. Observe iframe dimensions and protocol log | Callback fires with status `expanded`. Iframe expands by 50px top and 100px right from original bounds. Protocol log shows `requestPlacementChange` with intent `resize`, `targetDimensions` reflecting original + offsets, and computed `targetPosition`. `$sf.ext.geom()` returns updated geometry. | Milestone 3 -- SafeFrame directional expand |
| TC-SF-002 | expand() default -- full maximize | SafeFrame creative loaded, registered | 1. Click "expand()" button (calls `$sf.ext.expand({})` or `$sf.ext.expand()` with no directional args) 2. Observe iframe | Callback fires with status `expanded`. Iframe maximizes to fill available space. Protocol log shows `requestPlacementChange` with intent `maximize`. | Milestone 1 -- SafeFrame expand-to-maximize mapping |
| TC-SF-003 | expand then collapse -- full reset | SafeFrame creative loaded, currently expanded (from TC-SF-001 or TC-SF-002) | 1. Click "collapse()" button 2. Observe iframe dimensions and position | Callback fires with status `collapsed`. Iframe returns to exact original size and position. Protocol log shows `requestPlacementChange` with intent `restore`. `$sf.ext.geom()` returns original geometry. | Milestone 1 -- SafeFrame collapse/restore |
| TC-SF-004 | expand with push:true -- fails | SafeFrame creative loaded, registered | 1. Click "expand({push:true})" button 2. Observe log | Callback fires with status `failed` and error message indicating push expand is not supported. No iframe dimension change. Protocol log shows no `requestPlacementChange` (bridge rejects before sending). | Non-goal validation -- push expand blocked |
| TC-SF-005 | status() during expand lifecycle | SafeFrame creative loaded, registered | 1. Call `$sf.ext.status()` before expand -- log result 2. Click expand 3. Call `$sf.ext.status()` during/after expand callback -- log result 4. Click collapse 5. Call `$sf.ext.status()` after collapse callback -- log result | Status sequence: `ready` (or equivalent) before expand, `expanded` (or `expanding` then `expanded`) after expand, `collapsed` (or `ready`) after collapse. Each call returns the correct current state string. | Milestone 3 -- SafeFrame status lifecycle |

##### MRAID Compliance Suite Tests

These are formal compliance vectors loaded through `mraid-3-compliance-runner.html`. They follow the `EventTester` + `SequentialRunner` pattern established by the existing `resize-negative` tests. Creatives are self-contained HTML files with inline scripts.

| ID | Description | Preconditions | Steps | Expected Result | Validates |
|----|-------------|---------------|-------|-----------------|-----------|
| TC-CP-001 | MRAID resize positive -- full cycle | Compliance runner loaded, container supports resize feature | Runner auto-executes: 1. `setResizeProperties(valid props)` 2. `resize()` 3. Wait for `stateChange` to `resized` 4. Verify `getCurrentPosition()` matches requested size 5. `close()` 6. Wait for `stateChange` to `default` 7. Verify `getCurrentPosition()` matches original | All event checks pass. Log shows PASSED for each step. `stateChange` fires twice (resized, default). `sizeChange` fires twice. Position values match at each step. | Milestone 3 -- MRAID 3.0 resize compliance |
| TC-CP-002 | MRAID resize with all 8 customClosePosition values | Compliance runner loaded | Runner auto-executes: for each of the 8 positions (top-left, top-center, top-right, center-left, center-right, bottom-left, bottom-center, bottom-right): 1. `setResizeProperties` with that position 2. `resize()` 3. Wait for `stateChange` to `resized` 4. `close()` 5. Wait for `stateChange` to `default` | All 8 iterations pass. Log shows PASSED for each position value. No errors fired. | Milestone 3 -- close position coverage |
| TC-CP-003 | MRAID resize + sizeChange event | Compliance runner loaded | Runner auto-executes: 1. Register `sizeChange` listener 2. `setResizeProperties({ width: 320, height: 480, ... })` 3. `resize()` 4. Wait for `sizeChange` event 5. Verify event args contain width: 320, height: 480 | `sizeChange` event fires with correct dimensions matching the resize request. Log shows PASSED. | Milestone 3 -- sizeChange event compliance |

#### 9.3 Test Creative Specifications

Each test surface requires new or updated test creatives. The following specifies what needs to be built.

##### Creative 1: SHARC Core Placement Test Creative

**Files:**
- `examples/test/test-placement-creative.html` -- self-contained creative (direct `<script>` loading, same pattern as `test-creative.html`)

**Harness:** SHARC Core (`examples/test/index.html`)

**What it tests:** Native SHARC placement change API -- resize, maximize, restore, close region, constraints query, animation hints, policy rejections.

**UI Controls (buttons):**
- "Resize 320x480" -- sends `requestPlacementChange({ intent: 'resize', targetDimensions: { width: 320, height: 480 } })`
- "Resize 500x400" -- sends oversized request to test policy rejection
- "Resize + Offset" -- sends resize with `targetPosition: { x: 10, y: -50 }`
- "Resize with Close Region" -- sends resize with `closeRegion: { position: 'top-right', size: 50 }`
- "Resize (no close region)" -- sends resize without closeRegion field
- "Resize Offscreen Close" -- sends resize with closeRegion hint that would be beyond viewport (tests hint override)
- "Resize Offscreen" -- sends resize where entire ad extends beyond viewport
- "Resize Animated" -- sends resize with `transition: { duration: 300, easing: 'ease-out' }`
- "Maximize" -- sends `requestPlacementChange({ intent: 'maximize' })`
- "Restore" -- sends `requestPlacementChange({ intent: 'restore' })`
- "Get Constraints" -- calls `SHARC.getPlacementConstraints()`
- "Clear Log"

**Status Displays:**
- Current state (from `stateChange` events)
- Current dimensions (from `placementChange` events)
- Current position (x, y from `placementChange`)
- Last constraints query result (formatted JSON)

**Protocol Trace Expectations:**
- Each button press produces a `requestPlacementChange` (or `getPlacementConstraints`) in the log
- Successful resizes show resolve with `placementUpdate`
- Rejections show reject with error code and message
- `placementChange` events appear for every successful change
- Animation resizes show `transition` in both request and notification

##### Creative 2: MRAID Resize Test Creative (updates to existing)

**Files:**
- `examples/test/test-mraid-creative.html` -- add resize controls to existing DOM
- `examples/test/test-mraid-creative.js` -- add resize functions to existing logic

**Harness:** MRAID Bridge (`examples/test/mraid-test.html`)

**What it tests:** MRAID `setResizeProperties()` + `resize()` + `close()` cycle through the SHARC-MRAID bridge.

**New UI Controls (add to existing `#ad-controls` div):**
- "Set Resize Props" -- calls `mraid.setResizeProperties()` with configurable values (default: width:320, height:480, offsetX:0, offsetY:-100, customClosePosition:'top-right', allowOffscreen:false)
- "resize()" -- calls `mraid.resize()`
- "supports('resize')" -- calls `mraid.supports('resize')` and logs result
- Update existing "resize()" button to use the new flow instead of the current stub

**New State Displays (add to existing `#ad-state` div):**
- `resizeProps:` -- shows currently set resize properties
- `customClose:` -- shows current customClosePosition value

**Protocol Trace Expectations:**
- `setResizeProperties` logs the validated properties
- `resize()` shows `requestPlacementChange` with intent `resize`, `closeRegion`, `targetDimensions`, `targetPosition`
- `stateChange` to `resized` appears after successful resize
- `sizeChange` event fires with new dimensions
- `close()` from resized state shows `requestPlacementChange` with intent `restore`

##### Creative 3: SafeFrame Directional Expand Test Creative (updates to existing)

**Files:**
- `examples/test/test-safeframe-creative.html` -- add directional expand controls to existing DOM
- `examples/test/test-safeframe-creative.js` -- add directional expand functions

**Harness:** SafeFrame Bridge (`examples/test/safeframe-test.html`)

**What it tests:** SafeFrame `$sf.ext.expand()` with directional offsets (t/l/r/b), and status tracking through the expand/collapse lifecycle.

**New UI Controls (add to existing `#ad-controls` div):**
- "Expand Directional" -- calls `$sf.ext.expand({ t:50, l:0, r:100, b:0 })`
- "status()" button is already present; verify it reports correct state during lifecycle

**New State Displays:**
- `expand-dir:` -- shows the last directional expand offsets used

**Protocol Trace Expectations:**
- Directional expand logs `requestPlacementChange` with intent `resize`, computed `targetDimensions` (original + offsets), and `targetPosition`
- Callback fires with status `expanded`
- `$sf.ext.geom()` returns geometry reflecting the expanded bounds
- Collapse resets to original bounds; callback fires with `collapsed`

##### Creative 4: MRAID Resize Positive Compliance Vector

**Files:**
- `examples/compliance-ads/resize-positive/resize-positive.html` -- self-contained creative with inline `<script>` (same model as `resize-negative/`)
- `examples/compliance-ads/resize-positive/resize-positive-tests.js` -- test logic using `EventTester`/`SequentialRunner` pattern

**Harness:** MRAID Compliance Suite (`examples/test/mraid-3-compliance-runner.html`)

**What it tests:** Formal MRAID 3.0 resize compliance -- positive cases. The mirror image of the existing `resize-negative` test vector.

**Test Sequence (automated, sequential):**
1. `setResizeProperties({ width: 320, height: 480, offsetX: 0, offsetY: 0, customClosePosition: 'top-right', allowOffscreen: false })` -- expect no error
2. `resize()` -- expect `stateChange` to `resized`
3. Verify `getCurrentPosition().width === 320` and `getCurrentPosition().height === 480`
4. `close()` -- expect `stateChange` to `default`
5. Verify `getCurrentPosition()` matches `getDefaultPosition()`
6. Iterate `customClosePosition` through all 8 values, each time: set props, resize, verify stateChange, close, verify stateChange
7. Verify `sizeChange` fires with correct dimensions on each resize

**UI:** Minimal -- log div for test results (same pattern as `resize-negative-tests.js`). Uses the `logInfoOnUi`/`logErrorOnUi` helpers and the `EventTester`/`SequentialRunner` infrastructure.

##### Creative 5: MRAID Resize sizeChange Compliance Vector

**Files:**
- `examples/compliance-ads/resize-sizechange/resize-sizechange.html`
- `examples/compliance-ads/resize-sizechange/resize-sizechange-tests.js`

**Harness:** MRAID Compliance Suite

**What it tests:** That `sizeChange` event fires with the correct width and height values after a successful `resize()` call.

**Test Sequence:**
1. Register `sizeChange` listener
2. `setResizeProperties({ width: 320, height: 480, offsetX: 0, offsetY: 0 })`
3. `resize()`
4. Wait for `sizeChange` event
5. Verify event arguments: `width === 320`, `height === 480`
6. Pass if correct, fail if event does not fire within timeout or values mismatch

#### 9.4 Test Harness Updates

The existing harness HTML files need modifications to support the new test creatives and policy configuration.

##### `examples/test/index.html` -- SHARC Core Harness

- **Policy Configuration Panel:** Add a collapsible panel to the harness (outside the ad iframe) with controls for configuring `placementPolicy` on the `SHARCContainer` constructor:
  - `maxWidth` number input (default: empty = unconstrained)
  - `maxHeight` number input (default: empty = unconstrained)
  - `allowedIntents` checkboxes: resize, maximize, fullscreen, minimize, restore (all checked by default)
  - `requireCloseRegionHint` checkbox (default: unchecked)
  - `allowOffscreen` checkbox (default: checked)
  - "Apply Policy" button -- recreates the container with the new policy
- **Creative Selector:** Add dropdown or input to select between `test-creative.html` (existing) and `test-placement-creative.html` (new)
- **Dimension/Position Readout:** Display the iframe's current computed dimensions and offset position below the ad slot, updated on every placement change

##### `examples/test/mraid-test.html` -- MRAID Bridge Harness

- **Feature Configuration:** Add a checkbox or toggle to enable/disable `com.iabtechlab.sharc.placement.resize` feature on the container (controls whether `mraid.supports('resize')` returns true)
- **Resize Properties Panel:** Add a collapsible panel with inputs for resize properties (width, height, offsetX, offsetY, customClosePosition dropdown, allowOffscreen checkbox, useCustomClose checkbox) so the tester can configure properties interactively rather than using hardcoded values. Note: `useCustomClose` no longer triggers bridge-side close indicator injection; it only controls whether the creative renders its own additional close visual.

##### `examples/test/safeframe-test.html` -- SafeFrame Bridge Harness

- **Directional Expand Panel:** Add a panel with number inputs for t, l, r, b offset values, pre-populated with reasonable defaults (e.g., t:50, l:0, r:100, b:0)
- No policy panel needed -- SafeFrame creatives do not configure container policy

##### `examples/test/mraid-3-compliance-runner.html` -- Compliance Runner

- **Add new test vectors to the runner's test list:** Register `resize-positive` and `resize-sizechange` alongside the existing `resize-negative` and other test sets
- No structural changes to the runner itself -- it already loads arbitrary compliance creatives

#### 9.5 Success Criteria

Phase 2 is complete when all of the following conditions are met:

**Test Coverage:**
- All 14 SHARC Core test cases (TC-PC-001 through TC-PC-014) have corresponding UI controls and are manually executable
- All 9 MRAID Bridge test cases (TC-MR-001 through TC-MR-009) are manually executable
- All 5 SafeFrame Bridge test cases (TC-SF-001 through TC-SF-005) are manually executable
- All 3 Compliance Suite test cases (TC-CP-001 through TC-CP-003) auto-execute and produce PASSED/FAILED output

**Pass Rate:**
- 100% of test cases pass on Chrome latest (primary browser)
- 100% of test cases pass on Safari latest (secondary -- validates WebKit WKWebView path)
- 0 test cases produce ambiguous results (every test clearly shows PASSED or FAILED in protocol trace)

**Regression Gate:**
- All existing test creatives (`test-creative.html`, `test-mraid-creative.html`, `test-safeframe-creative.html`) continue to function identically after harness updates
- All existing compliance vectors (`resize-negative`, `loadandevents`) continue to pass
- No new globals introduced on `window` beyond the `__SHARC_TEST_*` namespace

**Documentation:**
- Each new test creative file has a header comment explaining what it tests and which test cases it covers
- Test harness UI additions have tooltip or label text explaining each control's purpose
- `CHANGELOG.md` includes a MINOR entry documenting the new test creatives and harness updates

**Artifact Checklist:**

| Artifact | Status |
|----------|--------|
| `examples/test/test-placement-creative.html` | Created |
| `examples/test/test-mraid-creative.html` (updated) | Updated with resize controls |
| `examples/test/test-mraid-creative.js` (updated) | Updated with resize functions |
| `examples/test/test-safeframe-creative.html` (updated) | Updated with directional expand controls |
| `examples/test/test-safeframe-creative.js` (updated) | Updated with directional expand functions |
| `examples/test/index.html` (updated) | Updated with policy panel and creative selector |
| `examples/test/mraid-test.html` (updated) | Updated with feature toggle and resize props panel |
| `examples/test/safeframe-test.html` (updated) | Updated with directional expand panel |
| `examples/compliance-ads/resize-positive/resize-positive.html` | Created |
| `examples/compliance-ads/resize-positive/resize-positive-tests.js` | Created |
| `examples/compliance-ads/resize-sizechange/resize-sizechange.html` | Created |
| `examples/compliance-ads/resize-sizechange/resize-sizechange-tests.js` | Created |
| All 31 test cases executable and passing | Verified |

#### Phase 2 Estimated Effort

4-6 engineer-days. Recommended approach: build test creatives in parallel with Phase 1 milestones. Each milestone's test cases can be validated as soon as the implementation lands.

| Work Item | Effort | Dependency |
|-----------|--------|------------|
| SHARC Core test creative + harness policy panel | M (2-3 days) | Milestone 1 implementation |
| MRAID test creative updates + harness resize panel | S (1 day) | Milestone 3 implementation |
| SafeFrame test creative updates + directional expand panel | S (0.5 day) | Milestone 1 implementation |
| Compliance vectors (resize-positive, resize-sizechange) | S (1 day) | Milestone 3 implementation |
| Cross-browser verification (Chrome + Safari) | S (0.5 day) | All above complete |

---

## 10. Intentionally Deprecated

| Pattern | Status | Migration Path |
|---------|--------|----------------|
| MRAID two-part expand (`expand(url)`) | Deprecated — fires error event | Use responsive markup with lazy asset loading. The creative should load secondary assets via `fetch()` or `<img>` after the initial expand. |
| SafeFrame push expand (`exp-push`) | Deferred indefinitely | Not achievable within sandbox constraints. Future `com.iabtechlab.sharc.layout` extension if publisher demand materializes. |

---

## 11. Open Questions

| # | Question | Owner | Deadline | Status |
|---|----------|-------|----------|--------|
| 1 | Should `customValidator` be async (return a Promise)? | Protocol Lead | Before Milestone 1 dev start | **Resolved: Synchronous.** See ADR-PC-003. Async validators add unpredictable latency. Publishers pre-fetch policy at container construction time. |
| 2 | Should `getPlacementConstraints()` return `currentPlacement` alongside constraints? | Protocol Lead | Before Milestone 4 dev start | **Resolved: Separate queries.** See ADR-PC-004. Constraints are static (change on rotation); placement is dynamic (changes on every mutation). |
| 3 | Should animation hints support custom cubic-bezier values? | Creative SDK Owner | Before Milestone 5 dev start | **Resolved: CSS keywords only.** See ADR-PC-005. Five keywords (`linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`). No CSS injection risk. |
| 4 | Should the container enforce a maximum `transition.duration`? | Protocol Lead | Before Milestone 5 dev start | **Resolved: 500ms cap.** Container silently clamps values above 500ms. Prevents long animations blocking close button access. |
| 5 | Should `closeRegion` hint be required for resize intent, or should the container always have a sensible default position (e.g., top-right)? | Protocol Lead | Before Milestone 2 dev start | **Resolved: Optional.** Recommended but not required. Container defaults to top-right, 50 DIP. The `requireCloseRegionHint` policy flag exists for publishers who want creatives to be explicit, but defaults to `false`. Not a creative burden — documentation recommends providing it ("helps the container position the close button where it won't obscure your content") but never mandates it. |
| 6 | Should the container-rendered close button support publisher-configurable styling (e.g., icon, color, opacity), or should it use a fixed standard appearance? | Protocol Lead | Before Milestone 2 dev start | **Resolved: Defer to v2.** For v1, the container provides a default close button (X icon via CSS, no external assets). In v2, `closeButtonStyles` becomes configurable — either container default or publisher-controlled. Avoids scope creep on v1. |
| 7 | Should the `Container:placementChange` notification include the actual close button position used? | Protocol Lead | Before Milestone 2 dev start | **Resolved: Yes.** `placementChange` includes `closeButtonPosition: { position, x, y, width, height }` with actual rendered coordinates. Two purposes: (a) creative avoids rendering content behind the close button, (b) OMID bridge registers it as a friendly obstruction via `addFriendlyObstruction` so it doesn't count against viewability measurement. |

---

## 12. Appendix

### A. Current `_handleRequestPlacementChange` (No Validation)

```javascript
// sharc-container.js, line 977 — current implementation
_handleRequestPlacementChange(msg) {
  const { intent, targetDimensions, targetPosition, anchorPoint } = (msg.args || {});
  let updatedPlacement = { ...(this.environmentData.currentPlacement || {}) };

  switch (intent) {
    case 'resize':
      if (targetDimensions) {
        updatedPlacement = { ...updatedPlacement, ...targetDimensions };
        this._applyIframeDimensions(targetDimensions);
      }
      if (targetPosition) {
        this._applyIframePosition(targetPosition);
      }
      break;
    case 'maximize':
    case 'fullscreen':
      updatedPlacement = this._getMaxPlacement();
      this._applyIframeDimensions(updatedPlacement);
      break;
    case 'minimize':
    case 'restore':
      updatedPlacement = this.environmentData.currentPlacement || {};
      this._applyIframeDimensions(updatedPlacement);
      break;
    default:
      console.warn('[SHARCContainer] Unknown placement intent:', intent);
  }

  this.environmentData.currentPlacement = updatedPlacement;
  this._protocol._resolve(msg, { placementUpdate: updatedPlacement });
  this.notifyPlacementChange(updatedPlacement);
}
```

Note the complete absence of any validation, policy checking, or rejection path. Every request is resolved.

### B. MRAID Resize Properties → SHARC Request Mapping

| MRAID Property | SHARC Field | Notes |
|---------------|-------------|-------|
| `width` | `targetDimensions.width` | Direct map |
| `height` | `targetDimensions.height` | Direct map |
| `offsetX` | `targetPosition.x` (computed) | `initialPosition.x + offsetX` |
| `offsetY` | `targetPosition.y` (computed) | `initialPosition.y + offsetY` |
| `customClosePosition` | `closeRegion.position` | Direct map of enum values |
| `allowOffscreen` | `allowOffscreen` | Direct map |
| (implicit 50px) | `closeRegion.size` | Always 50 per MRAID spec |

### C. Close Region Position Enum Mapping

| Value | Close Button Anchor | Use Case |
|-------|-------------------|----------|
| `top-left` | Top-left corner of resized ad | Left-anchored expand |
| `top-center` | Top-center of resized ad | Centered banner expand |
| `top-right` | Top-right corner of resized ad | Standard (MRAID default) |
| `center-left` | Center-left of resized ad | Side panel |
| `center-right` | Center-right of resized ad | Side panel |
| `bottom-left` | Bottom-left corner of resized ad | Bottom-anchored expand |
| `bottom-center` | Bottom-center of resized ad | Footer expand |
| `bottom-right` | Bottom-right corner of resized ad | Bottom-right expand |

### D. Feature String Registry (Post-Implementation)

| Feature String | Capability | Advertised When |
|---------------|-----------|-----------------|
| `com.iabtechlab.sharc.placement.resize` | Container supports validated resize with close region | Container has resize intent handler with close region validation |
| `com.iabtechlab.sharc.placement.constraints` | Creative can query placement constraints | Always (returns unconstrained defaults if no policy) |
| `com.iabtechlab.sharc.placement.animate` | Container supports animated placement transitions | Container has CSS transition implementation |
