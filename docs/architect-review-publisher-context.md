# Architect Review — Publisher Context in `Container:init`

> **Reviewer:** Software Architect (via OpenClaw subagent)
> **Date:** 2026-04-06
> **SHARC Version:** 0.2.1
> **Request Author:** Jeffrey (VP PM)
> **Document Reviewed:** `docs/publisher-context-recommendations.md`

---

## Executive Summary

This is a **high-value, low-risk addition** that should ship in the v0.3 release (treating it as a minor protocol revision, not a major version bump). The flat `publisherContext` object under `environmentData` is the right structure. The trust model concern is real but acceptable given the defense-in-depth approach already in the stack (OMID cross-validation). Implementation complexity is **low for web, moderate for in-app**.

---

## Design Question Responses

### 1. Nesting: `environmentData.publisherContext` vs. top-level fields

**Recommendation: Nested under `environmentData` as a single `publisherContext` object.**

Rationale:

- `environmentData` already has coherent meaning — it describes the runtime environment. Publisher context *is* environment data. Top-level fields would break this conceptual grouping.
- A flat object (`Option A`) beats `siteContext`/`appContext` split (`Option B`) for creative authors: a creative has one place to look regardless of platform. Null fields are cheap; branching logic for two separate keys is not.
- `Option C` (separate top-level fields matching OpenRTB naming) optimizes for OpenRTB proximity at the cost of protocol cleanliness. SHARC is not OpenRTB. Don't inherit its verbosity.

Final proposed structure:

```json
{
  "environmentData": {
    "currentPlacement": { ... },
    "sfMeta": { ... },
    "publisherContext": {
      "pageUrl": "https://example.com/article/sports",
      "domain": "example.com",
      "package": null,
      "platform": "web"
    }
  }
}
```

**One refinement:** Rename `package` → `bundleId`. "Package" is vague; `bundleId` is unambiguous and consistent with OMID, MRAID, and AdCOM terminology. This also prevents confusion with npm/Maven package concepts.

```json
"publisherContext": {
  "pageUrl": "https://example.com/article/sports",
  "domain": "example.com",
  "bundleId": null,
  "platform": "web"
}
```

---

### 2. Fallback when URL is undeterminable (`about:blank`, `file://`, sandboxed iframes)

**Recommendation: Explicit `null` with a documented resolution order.**

Do **not** return an empty string `""`. Empty string is ambiguous (is it missing, or did the container read an empty URL?). `null` is semantically clear: the field was not determinable.

**Resolution order for `pageUrl` (web):**

1. `window.top.location.href` — if accessible (same-origin)
2. `document.referrer` — if `window.top` is cross-origin (cross-origin iframe scenario)
3. `document.URL` — if referrer is also empty (e.g., direct navigation)
4. `null` — if all of the above are `about:blank`, `file://`, or inaccessible

**Why not just `document.URL`?** In a SafeFrame or cross-origin iframe, `document.URL` returns the *iframe's* URL, not the page URL. `window.top.location.href` is what we actually want — and it's blocked by the browser in cross-origin contexts. This is exactly why `document.referrer` is the fallback: it reflects the embedding page.

**`domain` derivation:** Parse from `pageUrl`. If `pageUrl` is null, `domain` is also null. Don't try to derive it separately — it must be consistent with `pageUrl`.

**`$sf.ext.hostURL()` alignment:** The spec says return `""` when unknown. SHARC's internal representation should use `null`; the SafeFrame bridge adapter translates `null → ""` at the bridge layer. Keep the protocol clean and let the bridge handle the spec's quirks.

---

### 3. Interaction with OMID adapter's publisher page context

**Recommendation: Independent collection, convergence as a validation signal.**

OMID's publisher page context is collected by the OMID verification script running *on the publisher page* — entirely different trust domain than the container. This is actually the feature, not a conflict.

Architecture relationship:

```
Publisher Page
├── OMID publisher script → reports publisherUrl independently
└── SHARC container
    └── Container:init → reports publisherContext.pageUrl

Measurement/verification bridge:
└── Cross-reference OMID.publisherUrl vs SHARC.publisherContext.pageUrl
    → Match: high confidence
    → Mismatch: fraud signal
```

**Design principle:** These should be *complementary and independent*, not synchronized. Do NOT have the SHARC container fetch or echo OMID's publisher URL. If they agree, that's convergent evidence. If they disagree, that's an integrity alert. Coordination between them would defeat the purpose.

**Protocol implication:** `publisherContext` in SHARC should be documented as "container-reported" and explicitly distinguished from bid-request-side `site.page` / OMID-side publisher URL. Three independent signals, same fact — that's supply chain integrity.

---

### 4. Trust model: what if the container is compromised?

**Assessment: Acceptable risk, not a blocker.**

The concern is valid but not unique to this feature. A compromised container can already lie about viewport dimensions, placement mode, and SafeFrame metadata — all fields currently in `environmentData`. `publisherContext` doesn't materially change the threat surface; it extends an already-trusted object.

**Why the risk is acceptable:**

1. **Harder to spoof than bid requests.** `pageUrl` is read from browser APIs at runtime, not passed through an ad server. A fraudster spoofing the container would need to compromise the SHARC SDK itself (a higher bar than faking a bid request field).

2. **Defense in depth already exists.** As noted in the recommendations doc: OMID reads the same browser APIs independently. A mismatch between OMID's publisher URL and SHARC's `pageUrl` is a detectable fraud signal at the verification layer. A malicious container that also wants to fool OMID would need to compromise two separate code paths.

3. **This is better than the status quo.** Currently creatives have *zero* container-reported context. Any signal is better than none.

**What we should NOT do:** Add a cryptographic signing mechanism for `publisherContext` in v0.3. It would be over-engineered for current adoption levels and would require key management infrastructure that doesn't exist. Flag it as a v1.0 (post-1.0) consideration if fraud in container reporting becomes a measured problem.

**Documented caveat:** Add a spec note that `publisherContext` is container-reported and should be treated as a *strong hint, not a cryptographic proof*. Recommend verifiers cross-reference with OMID publisher page context for high-stakes verification use cases.

---

### 5. v0.3 vs. v1.0 — when does this ship?

**Recommendation: v0.3 (minor protocol revision), not gated to v1.0.**

Classification rationale:

| Criterion | Assessment |
|---|---|
| Breaking change? | No — additive field, `publisherContext` is optional |
| Requires container modification? | Yes — containers must populate the new field |
| Requires creative modification? | No — creatives that don't use it are unaffected |
| Fixes an existing compliance gap? | Yes — resolves SafeFrame `$sf.ext.hostURL()` (10→11/12) |
| Implementation risk? | Low (web), Moderate (in-app SDK plumbing) |

This is a backward-compatible, additive protocol change. Containers that don't implement it yet omit the field (or send `publisherContext: null`); creatives that don't use it ignore it. No one breaks.

Gating this to v1.0 would mean delaying a SafeFrame compliance fix that's already partially implemented (the recommendations doc exists, the `$sf.ext.hostURL()` gap is identified). That's a cost without benefit.

---

## Implementation Complexity Assessment

### Web (Low Complexity)

The container already runs in a browser context and has access to the APIs needed:

```javascript
function resolvePublisherContext() {
  let pageUrl = null;
  try {
    pageUrl = window.top.location.href;
  } catch (e) {
    // Cross-origin — try referrer
    pageUrl = document.referrer || document.URL || null;
  }
  // Reject non-http(s) schemes
  if (pageUrl && !/^https?:\/\//.test(pageUrl)) {
    pageUrl = null;
  }
  const domain = pageUrl ? new URL(pageUrl).hostname : null;
  return {
    pageUrl,
    domain,
    bundleId: null,
    platform: 'web'
  };
}
```

This is ~15 lines of code + error handling. Low risk.

### In-App (Moderate Complexity)

The native SDK must surface `bundleId` to the SHARC WebView layer. This requires:

1. Native SDK (iOS/Android) reads bundle ID from app context (trivial — it's always available)
2. SDK injects it into the WebView via a JavaScript bridge call or config object before `Container:init` fires
3. SHARC container reads from that injected config

The tricky part is the injection timing — the bundle ID must be available before `Container:init` is sent. If the SDK initializes asynchronously, this needs sequencing. Estimate: **1–2 days of SDK work per platform**, plus protocol documentation.

### SafeFrame Bridge (Trivial)

`$sf.ext.hostURL()` implementation:

```javascript
hostURL() {
  return this.environmentData?.publisherContext?.pageUrl ?? '';
}
```

One line. Already architecturally accounted for in the gap analysis.

---

## Risks and Open Items

| Risk | Severity | Mitigation |
|---|---|---|
| Cross-origin iframe: `window.top` blocked, `document.referrer` empty | Medium | Document null fallback behavior; creatives must handle null |
| In-app SDK injection timing race | Low-Medium | Define SDK initialization contract; require bundleId before container init |
| `about:blank` intermediary frames (common in some ad stacks) | Medium | Referrer chain traversal is complex — null is acceptable, don't over-engineer |
| Field name `package` collision risk | Low | Rename to `bundleId` now, before it ships |
| Ecosystem confusion: SHARC `pageUrl` vs OMID `publisherUrl` vs bid `site.page` | Medium | Spec language must clearly label each as independently sourced |

---

## Recommendations Summary

1. **Ship in v0.3** as an additive protocol change. Do not gate to v1.0.

2. **Use `environmentData.publisherContext`** (flat object, nested under `environmentData`). Reject top-level fields and the `siteContext`/`appContext` split.

3. **Rename `package` → `bundleId`** before shipping. Small change, avoids long-term confusion.

4. **Use `null` (not `""`)** for undeterminable fields. Let the SafeFrame bridge adapter translate `null → ""` at the bridge boundary.

5. **Document the resolution order** for `pageUrl` (top.href → referrer → document.URL → null) in the spec.

6. **Do not synchronize with OMID.** Independence between SHARC and OMID publisher context is a feature — it enables cross-validation as a fraud signal.

7. **Add a spec note** on the container-reported trust model. It's not a cryptographic proof; recommend cross-referencing with OMID for high-stakes verification.

8. **Defer cryptographic signing** of `publisherContext` to post-1.0. Not warranted yet.

9. **Compliance impact:** This resolves `$sf.ext.hostURL()`, moving SafeFrame compliance from 10/12 → 11/12. Document the remaining gap separately.

---

## Conclusion

This is exactly the kind of feature that demonstrates SHARC's value as a trust layer — not just an ad display container, but a supply chain integrity primitive. The implementation is straightforward on web and manageable on in-app. The trust model is honest about its limits while being meaningfully better than the status quo.

Ship it.
