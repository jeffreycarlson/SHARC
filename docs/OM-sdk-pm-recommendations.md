# OM SDK + SHARC: Product Management Recommendations

**Author:** Product Management (PM review of Ad Tech Team research)
**Date:** 2026-04-05
**Status:** PM recommendations for SHARC Working Group consideration
**Input:** `docs/OM-sdk-research.md` (Ad Tech Team, 2026-04-05)

---

## Executive Summary

The Ad Tech Team's OM SDK research is thorough and actionable. The integration path is technically clear: expose `com.iabtechlab.sharc.omid` as a SHARC-supported feature extension, let the container own the OM session lifecycle, and bridge SHARC state/event signals into the OM SDK JS API.

**PM recommendation: Pursue OM SDK integration as a v1 extension — not deferred, not buried in core spec.** The extension mechanism in SHARC's current design is precisely built for this. Shipping v1 without any OM SDK story leaves a critical measurement gap that will become a blocker for real-world adoption by publishers and SSPs.

The integration does not require a spec rewrite. It does require a deliberate WG narrative, a compliance path, and a reference implementation before anyone will ship it.

---

## 1. Priority: v1 or Deferred?

### Recommendation: v1 Extension — Ship Alongside Core, Not After

**Don't defer. Don't bloat core. Use the extension mechanism.**

The SHARC spec already acknowledges OM SDK integration by name under its "Extensions (Supported Features)" section. The WG and IAB Tech Lab have tacitly blessed this direction. Deferring it to v2 creates an adoption problem:

- **Publishers won't adopt a container standard they can't measure.** Viewability is a contractual commitment for premium inventory. If SHARC-enabled ads can't fire OM SDK sessions, publishers running brand-safe, measured inventory will reject SHARC at the SSP/ad server level.
- **Buyers and DSPs will flag the gap.** Programmatic buyers increasingly require OMID signals in bid requests (OpenRTB `api` field value 7). Containers that don't surface OM SDK support won't win PMPs or preferred deals.
- **The SIMID precedent is instructive.** SIMID shipped its OM SDK integration alongside its core spec. SHARC should do the same — we're following a proven pattern, not pioneering one.

### What "v1 Extension" Means in Practice

- `com.iabtechlab.sharc.omid` is documented in SHARC's **Extension Guide** (not core spec)
- The container reference implementation ships an optional but functional OM SDK integration module
- Creatives can detect support via `getFeatures()` before attempting any OM SDK operations
- Containers that don't support OM SDK simply omit the feature — no breaking changes

### What Would Justify Deferral

Defer only if the WG determines that the OM SDK partner registration requirement (containers need IAB-assigned partner names) creates a process bottleneck that can't be resolved in time. That's a solvable problem, not a reason to abandon the feature.

---

## 2. WG Positioning: The "Why This Matters" Narrative

### The Core Pitch: SHARC Doesn't Exist Without Measurement

The Safe Ad Container WG should hear this framing:

> "SHARC replaces SafeFrame and MRAID. Both of those standards have established OM SDK integration patterns. If we ship SHARC without a measurement story, we're asking publishers to take a step backward on accountability. That's not a viable ask."

### Four Narratives, Prioritized by Audience

**For publishers and SSPs (adoption decision-makers):**
> SHARC containers that implement `com.iabtechlab.sharc.omid` will carry OMID signals on every impression. That means your premium inventory remains measurable, your OM SDK-certified relationships stay intact, and you don't need to carve out SHARC inventory from your viewability guarantees.

**For the WG technical audience:**
> The integration follows the SIMID pattern exactly. The container owns the OM session. The creative signals events through the SHARC message bus. The OM SDK Service Script loads in its own execution context — just like a video player does in SIMID. We're not inventing anything new here; we're applying a proven pattern to a new container type.

**For IAB Tech Lab leadership:**
> SHARC and OM SDK are both IAB Tech Lab standards. Shipping them as complementary, interoperable specs is a stronger story than two silos. A joint "SHARC + Open Measurement" announcement positions IAB Tech Lab as the coherent steward of the modern ad container stack.

**For the OM Working Group (Jill Wittkopp's team):**
> SHARC's extension model gives the OMWG an official integration point for a new container type without needing to revise the OM SDK spec itself. SHARC containers become first-class OM SDK integrators, just like video players are today.

### The Headline for Any WG Slide

**"SHARC + OM SDK: One container, one measurement standard, everywhere ads run."**

---

## 3. Stakeholder Alignment: The Path to a WG Vote

The research → decision → vote → spec → implementation sequence has clear owners and dependencies. Here's the map:

### Phase 1: Internal Alignment (Weeks 1–3)

| Action | Owner | Output |
|--------|-------|--------|
| PM review of research doc | Product (this doc) | Go/no-go recommendation |
| Eng feasibility sign-off | Ad Tech Team lead | Confidence on implementation scope |
| Legal/compliance check | IAB Tech Lab staff | Partner name registration process confirmed |
| Internal go/no-go decision | Product + Eng leads | Decision memo to bring to WG |

**Gate:** Do we have internal alignment that v1 extension is the right scope? If yes, proceed.

### Phase 2: WG Preparation (Weeks 3–6)

| Action | Owner | Output |
|--------|-------|--------|
| Draft extension spec language | Ad Tech Team | `com.iabtechlab.sharc.omid` spec section |
| Prepare WG deck | Product | 10-slide narrative for WG presentation |
| Pre-socialize with OMWG | Product + IAB liaison | OMWG awareness, early feedback |
| Identify WG champions | Product | 2–3 WG members who will co-present/sponsor |

**Gate:** Is the OMWG aware and not blocking? Are WG champions identified?

### Phase 3: WG Proposal and Vote (Weeks 6–10)

| Action | Owner | Output |
|--------|-------|--------|
| Present to Safe Ad Container WG | Product + Ad Tech Team | Working group discussion |
| Incorporate feedback | Ad Tech Team | Revised extension spec draft |
| Call for WG vote | WG chair | Formal vote on including OM SDK extension in v1 |

**Note:** IAB Tech Lab WG votes typically require a two-week comment period before a vote can be called. Plan accordingly — don't schedule the vote the same week as the presentation.

**Gate:** Vote passes. Extension formally included in SHARC v1 scope.

### Phase 4: Spec Update and Reference Implementation (Weeks 10–18)

| Action | Owner | Output |
|--------|-------|--------|
| Finalize extension spec language | Ad Tech Team | PR to SHARC spec repo |
| Build reference implementation | Ad Tech Team | OM SDK module in `examples/` |
| Integration validation | QA / Ad Tech Team | Tested against OM SDK validation script |
| Public comment period | IAB Tech Lab | Community review of extension spec |

**Gate:** Spec merged, reference implementation passes OM SDK validation.

### Key External Dependencies to Track

1. **IAB Tech Lab OM SDK partner name registration** — Containers need an IAB-assigned partner name to call `new Partner(name, version)`. The team should request this now (or clarify whether the SHARC reference implementation uses a generic partner name during development). This is a process dependency, not a technical one.
2. **OMWG coordination** — The extension approach doesn't require OMWG to change the OM SDK spec, but they should be kept informed. A surprise proposal at the WG level will slow things down.
3. **AdCOM `adVerifications` field** — The research correctly flags that VAST 4.1's `adVerifications` node needs to be expressible in AdCOM for the container to populate `VerificationScriptResource` objects. This may require a coordination touchpoint with the AdCOM WG or OpenRTB WG.

---

## 4. Risk Assessment

### Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| WG votes to defer to v2 | Medium | High | Pre-socialize with champions; frame as extension (low-risk to core spec) |
| OMWG resists without co-authorship | Low | Medium | Engage OMWG early; offer to contribute SHARC patterns back to OM SDK docs |
| OM SDK partner name process blocks timeline | Medium | Medium | Start IAB Tech Lab registration process now, in parallel with WG work |
| `allow-same-origin` sandbox constraint breaks OM SDK Service Script | High | High | This is a known issue — see below |
| AdCOM doesn't have clean `adVerifications` mapping | Medium | Medium | Document gap; ship workaround for v1 (custom extension field), formalize in v2 |
| CTV scope creep | Low | Medium | Explicitly call CTV out of scope for v1 in spec language |
| Reference implementation quality delays ship | Medium | Low | Scope reference impl narrowly: web display only, `limited` access mode only |

### The Sandbox Constraint Is the Top Technical Risk

This is the one issue the research flags but doesn't fully resolve, and it deserves PM-level attention:

**The problem:** `sharc-container.js` deliberately omits `allow-same-origin` from the iframe sandbox (security note SEC-001). This is correct and necessary — adding `allow-same-origin` + `allow-scripts` would allow sandbox escape. However, the OM SDK Web Video Service Script (`omweb-v1.js`) has constraints about how it can be loaded — it cannot be concatenated into other scripts and must run in its own execution context.

**What this means for the integration architecture:** The OM SDK Service Script cannot run inside the SHARC creative's sandboxed iframe in `full` access mode without `allow-same-origin`. This means:
- `limited` access mode is the safe default for v1 (verification scripts load in a sandboxed iframe, events are bridged via the OMID API)
- `full` access mode requires explicit security analysis before being offered as a container option
- The PM recommendation is to **ship v1 with `limited` access mode only** and explicitly document this as a v1 constraint

This should be called out in the WG proposal so the technical audience can weigh in. Don't hide it.

### What Could Sink This

1. **The WG rejects the extension model** in favor of waiting for a "proper" OM SDK SHARC integration spec that's jointly authored with the OMWG. This would add 6–12 months. Mitigation: Get OMWG buy-in before the WG vote.
2. **The reference implementation surfaces unexpected browser/iframe incompatibilities** with how the OM SDK Service Script expects to be loaded. Mitigation: Start a proof-of-concept implementation before the WG vote, so the team can speak to technical confidence in the proposal.
3. **Nobody registers as an OM SDK integration partner** because the certification process requires production deployments. Mitigation: Clarify with IAB Tech Lab whether the SHARC open-source reference implementation qualifies for a "development" partner name.

---

## 5. Scope Recommendation

### Recommendation: Supported Feature (not simple extension, not parallel workstream)

There are three ways to frame the scope of this work:

| Option | Description | Verdict |
|--------|-------------|---------|
| **Simple extension** | Undocumented, community-contributed, "here's how you could do it" | ❌ Too weak — buyers and publishers won't trust it |
| **Supported feature** | Documented in SHARC Extension Guide, reference impl in official repo, IAB Tech Lab-blessed namespace | ✅ Right level |
| **Parallel workstream** | Separate spec, separate WG, full co-authorship with OMWG | ❌ Too heavy — adds 12+ months, risks fragmentation |

**A "supported feature" is the correct level.** It means:
- The namespace `com.iabtechlab.sharc.omid` is officially registered and documented
- IAB Tech Lab publishes guidance on implementation in the SHARC Extension Guide
- The reference implementation in `examples/` includes a functional OM SDK integration module
- Containers are not *required* to implement it (it's an extension), but containers that do implement it use a standardized API
- IAB Tech Lab and the OMWG jointly endorse the integration pattern

**What this is NOT:**
- It is not a core spec requirement (containers without OM SDK support remain SHARC-compliant)
- It is not a separate standard — it lives entirely within SHARC's extension framework
- It is not a full SIMID-style co-authored joint spec (though that may be the right v2 destination if adoption warrants it)

### Scope for v1 Reference Implementation

Keep the v1 reference implementation narrow and shippable:

**In scope:**
- Web environment only (no CTV, no native app)
- Display ads (no native video player integration — that's a separate surface)
- `limited` access mode for verification scripts
- Ad lifecycle events: `loaded`, `impressionOccurred`
- Session lifecycle: `sessionStart`, `sessionFinish`, `sessionError`
- SHARC state → OM SDK session mapping (`active` → impression, `terminated`/`close` → finish)
- `AdVerifications` from VAST 4.1 (or AdCOM equivalent) → `VerificationScriptResource` objects

**Explicitly out of scope for v1:**
- `full` access mode (security analysis required)
- `MediaEvents` (video quartile tracking — requires container-side media event tracking)
- CTV environment (different OM SDK variant, different device signals)
- iOS/Android native SDK integration (separate platform layer)
- OM SDK compliance certification (that comes after the reference impl is stable)

---

## 6. Timeline

### Realistic End-to-End Timeline: ~18 Weeks

This assumes no showstoppers at the WG vote and that the partner name registration process starts immediately.

```
Week 1–3:   Internal alignment
             - PM review complete (this doc)
             - Eng feasibility confirmed
             - Partner name registration initiated with IAB Tech Lab
             - Go/no-go decision made

Week 3–5:   Proof of concept
             - Ad Tech Team builds minimal PoC (not production-ready)
             - Validates that OM SDK Service Script can load correctly
             - Resolves sandbox constraint question in `limited` mode
             - PoC gives the team technical confidence before the WG vote

Week 5–7:   WG preparation
             - Extension spec language drafted
             - WG deck prepared
             - OMWG pre-socialization meeting held
             - WG champions identified

Week 7–9:   WG proposal and discussion
             - Formal presentation to Safe Ad Container WG
             - Two-week comment/feedback period
             - Feedback incorporated into spec draft

Week 9–10:  WG vote
             - Formal vote called and held
             - Assumed: vote passes

Week 10–16: Reference implementation
             - Full OM SDK extension module built in examples/ repo
             - Tested against OM SDK validation verification script
             - Integration docs written for SHARC Extension Guide

Week 16–18: Public comment
             - Extension spec and reference impl published for public comment
             - Feedback period (typically 30 days per IAB Tech Lab process)
             - Final revisions based on public comment

Week 18+:   v1 ship
             - Extension spec merged to SHARC spec
             - Reference implementation tagged as v1
             - Joint IAB Tech Lab announcement (SHARC + Open Measurement)
```

### Timeline Risks

| Risk | Effect on Timeline |
|------|--------------------|
| WG requests major revisions | +2–4 weeks |
| OMWG requires co-authorship process | +6–12 weeks |
| Partner name registration bottleneck | +2–4 weeks if not started early |
| Sandbox constraint requires spec-level solution | +4–6 weeks |
| Public comment generates significant changes | +4–8 weeks |

**Bottom line:** Start the partner name registration process and the proof of concept in parallel with WG preparation. Don't wait for WG approval to begin technical exploration — the PoC de-risks the vote.

---

## 7. Summary of Recommendations

| # | Recommendation | Priority | Owner |
|---|---------------|----------|-------|
| 1 | Include OM SDK as a v1 supported feature extension, not deferred | 🔴 Critical | Product + WG chair |
| 2 | Start IAB Tech Lab partner name registration process immediately | 🔴 Critical | Ad Tech Team |
| 3 | Build a PoC before the WG vote to validate technical approach | 🔴 Critical | Ad Tech Team |
| 4 | Pre-socialize with OMWG before formal WG presentation | 🟠 High | Product + IAB liaison |
| 5 | Scope v1 reference impl to web + display + `limited` access mode only | 🟠 High | Ad Tech Team |
| 6 | Explicitly resolve the `allow-same-origin` sandbox constraint in the spec | 🟠 High | Ad Tech Team + WG |
| 7 | Identify 2–3 WG champions to co-sponsor the proposal | 🟡 Medium | Product |
| 8 | Document AdCOM `adVerifications` gap and ship v1 workaround | 🟡 Medium | Ad Tech Team |
| 9 | Reserve CTV and native video MediaEvents for v2 scope | 🟡 Medium | Product |
| 10 | Plan a joint IAB Tech Lab announcement (SHARC + Open Measurement) | 🟢 Nice-to-have | IAB Tech Lab comms |

---

## Appendix: Key Questions Still Open

These need answers before the WG presentation can be finalized:

1. **Partner name registration:** What is the IAB Tech Lab's process for assigning a partner name to an open-source reference implementation? Does the SHARC project need to be a production deployment, or can a reference implementation qualify?

2. **Sandbox + OM SDK:** Has the Ad Tech Team confirmed that OM SDK's Service Script (`omweb-v1.js`) can load and function correctly inside a SHARC creative iframe with `limited` access mode and without `allow-same-origin`? The PoC should answer this definitively.

3. **OMWG relationship:** Is Jill Wittkopp's OMWG team aware of SHARC's plans? Have they been consulted on whether the `com.iabtechlab.sharc.omid` namespace and extension pattern needs OMWG blessing before it goes into the SHARC spec?

4. **AdCOM version:** Which version of AdCOM will SHARC v1 target? Does that version include an `adVerifications` analog, or does the team need to define a SHARC-specific extension field for verification script resources?

5. **Access mode decision:** Is the WG comfortable shipping v1 with `limited` access mode only? Or will there be pushback from measurement providers (IAS, DoubleVerify, Moat) who require `full` access mode for certification?

---

*This document represents PM-level recommendations only. No code changes have been made. The research doc (`OM-sdk-research.md`) and all source files remain unmodified.*

*Next step: Schedule a team review of this doc, resolve the open questions in the Appendix, and set a date for the PoC sprint.*
