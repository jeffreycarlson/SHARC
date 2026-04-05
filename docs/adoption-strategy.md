# SHARC Adoption Strategy
**Author:** Jeffrey Carlson, Co-Chair, IAB Tech Lab Safe Ad Container WG  
**Date:** April 2026  
**Status:** Working Document

---

## The Situation

The reference implementation is done. We have a working container library, a working Creative SDK, a test harness, and sample creatives. The protocol is specified. The security model is sound.

Now comes the hard part: getting the industry to actually use it.

This document is the plan.

---

## 1. Who Needs to Adopt SHARC (and in What Order)

SHARC requires a two-sided market to function. Creatives need containers to run in. Containers need creatives to serve. Neither side will invest without confidence the other side exists.

The right order isn't "convince everyone at once." It's: **create inevitability before you create adoption.**

### Tier 1 — Foundation (Months 0–3)
These are the parties whose early movement de-risks adoption for everyone else.

| Party | What they do | Why they go first |
|---|---|---|
| **IAB Tech Lab Working Group members** | Validate the spec via the reference implementation | They're already engaged. Get them on record that Phase 1 is spec-conformant. |
| **1–2 early-adopter publishers/SSPs** | Ship a production SHARC container | Proof that it deploys. Even one real publisher unlocks "you can test this in prod." |
| **Flashtalking / creative tool vendors** | Add SHARC export to their tooling | Laura Evans and Sarah Kirtcheff are already contributors. They can move fast. |
| **OM SDK working group** | Map OM integration to SHARC event bus | Unblocks every publisher that has "we need OM first" as a blocker. |

### Tier 2 — Scale (Months 3–6)
Once Tier 1 has momentum, these parties can move with lower risk.

| Party | What they do |
|---|---|
| **Major SSPs** (Magnite, PubMatic, Index Exchange) | Container in their managed web SDK; signal in bid response |
| **Ad networks / DSPs** | Accept SHARC creatives; pass SHARC signal in bid request |
| **Prebid community** | OpenRTB signal for SHARC support in bid requests |
| **AdCOM/OpenRTB WG** | Formalize SHARC in the bid request spec |

### Tier 3 — Ecosystem Default (Month 6+)
These happen when SHARC is real enough that ignoring it is a deliberate choice.

| Party | What they do |
|---|---|
| **Google (GAM / AdMob)** | SHARC container in GAM web tags and AdMob SDK |
| **Meta Audience Network** | SHARC container in mobile SDK |
| **Native mobile SDK vendors** | MRAID → SHARC migration path for existing inventory |
| **Creative studios** | Default to SHARC output for new builds |

---

## 2. The Chicken-and-Egg Problem

This is the real obstacle. Every major MRAID adoption cycle failed the same way:

> *"We'll implement when creatives exist."*  
> *"We'll build creatives when containers exist."*  
> *[nothing happens for two years]*

SHARC has structural advantages MRAID never had. Use them.

### Why This Time Is Different

**1. The MRAID compatibility bridge neutralizes the cold-start problem.**

A SHARC container that ships a MRAID 3.0 bridge runs existing MRAID inventory *immediately*. No new creatives required to go live. Publishers can adopt SHARC today and get compatibility with the existing creative supply. This completely sidesteps the "no creatives" objection.

Similarly, an SSP can tell creative buyers: "Serve your existing MRAID creatives into our SHARC containers — they just work."

This is the most important adoption unlock we have. Lead with it in every conversation.

**2. The Creative SDK removes the "SHARC is complicated" objection.**

The SDK is a single `<script>` include, under 10KB, Promise-based, no build tools. A creative developer can instrument an existing HTML5 banner for SHARC in under an hour. The sample creatives are copy-paste onboarding.

Compare to MRAID: no standard SDK, every SDK vendor shipped something slightly different, integration required knowing the MRAID state machine in detail.

**3. The reference implementation is normative.**

Ambiguity was MRAID's death by a thousand implementations. Container vendors made different choices, creative QA became a nightmare. SHARC's reference implementation is the authoritative answer for any behavior not spelled out in the spec. Implementers converge by default.

### How to Break the Stalemate

**Move both sides simultaneously, not sequentially.**

The move is to find a publisher-SSP pair that will commit to running a SHARC integration test with at least one creative tool partner — not in a lab, in production. That's the unlock event. Everything before it is setup.

The Creative SDK is ready. The container is ready. The test harness is ready. What's missing is a committed pair of counterparties who will actually run it.

**Identify "SHARC beta" participants in the first 30 days.** 2 publishers. 1 SSP. 1 creative tool. That's the pilot. Get them to a working integration and document it publicly.

---

## 3. Key Organizations to Engage First

### Priority 1 — Already Inside the Tent

- **Flashtalking by MediaOcean** — Laura Evans and Sarah Kirtcheff are named contributors. They build creative tooling for major agencies. If Flashtalking exports SHARC natively, every campaign they touch becomes a potential SHARC creative. First call.

- **DoubleVerify** — Aron Schatz is co-chair. DV's OM SDK integration guidance will unblock every publisher with a verification dependency. Get the OM extension guidance in writing.

- **Chartboost** — Jeffrey's own organization. Can be the first production mobile container. Demonstrates SHARC isn't just theoretical.

### Priority 2 — Critical Path

- **Prebid** — Header bidding signals how demand flows. SHARC needs an `api` field signal in the bid request so DSPs can identify SHARC-capable inventory. Prebid can implement this without waiting for a formal OpenRTB update. Invite them to scope it; the guidance doc is ready.

- **IAB Tech Lab OpenRTB/AdCOM WG** — The AdCOM `Placement > Display Placement > API` field needs a SHARC item. This is a standards process, not a code change — start it now. The "Support Beyond the Container" doc has the proposal already drafted.

- **Magnite / PubMatic / Index Exchange** — The three SSPs most likely to move on open standards. Each of them has existing MRAID/SafeFrame containers. A SHARC container replaces both. Frame it as technical debt reduction, not new work.

- **Google** — Won't be first. Needs to see adoption signal before they commit. But they need to be briefed early so they're not caught flat-footed when the rest of the market moves.

### Priority 3 — Amplifiers

- **IAS / Integral Ad Science** — Measurement credibility. Get their input on the OM integration path before they're asked about it by publishers.

- **The Trade Desk** — DSP that's actively involved in open standards. If they can consume SHARC creatives, that's a meaningful demand signal.

- **International IAB partners** — UK, India, Australia (per the "Support Beyond the Container" doc). SHARC's "build once, serve everywhere" pitch lands differently in markets where mobile-first web is dominant.

---

## 4. What the Reference Implementation Unlocks vs. What Still Needs to Happen

### What It Unlocks Right Now

| Capability | Status |
|---|---|
| Any developer can implement a spec-conformant SHARC container | ✅ |
| Any developer can build a SHARC-enabled creative from scratch | ✅ |
| Creative validation: does this creative speak SHARC? | ✅ (test harness) |
| Normative answer to every "what does the spec mean here?" question | ✅ |
| MRAID 3.0 compatibility bridge (Phase 2) | Architecture defined |
| iOS WKWebView + Android WebView container | Architecture defined |

### What Still Has to Happen

| Gap | Who Has to Do It | Blocking What |
|---|---|---|
| OM extension guidance | OM SDK WG + DV (Aron) | Every publisher that won't move without verification |
| OpenRTB/AdCOM SHARC signal | IAB Tech Lab OpenRTB/AdCOM WG | DSPs knowing which inventory supports SHARC |
| Prebid adapter (or signal) | Prebid community | Header bidding supply chain |
| Native iOS SDK (WKWebView wrapper) | Chartboost / reference implementation | In-app adoption |
| Native Android SDK (WebView wrapper) | Chartboost / reference implementation | In-app adoption |
| MRAID compatibility bridge (shipped) | Reference implementation | Existing creative supply working in SHARC containers |
| Creative validation CLI (`sharc-validate`) | Reference implementation | Automated creative QA at scale |
| At least one public production deployment | Publisher + SSP pilot | "Is this real?" objection |

---

## 5. 90-Day Launch Plan

### Days 1–30: Make It Real

The goal of this phase is to go from "we have code" to "we have working integrations."

**Week 1–2:**
- [ ] Publish the reference implementation to GitHub under IABTechLab (sharc-reference-implementation)
- [ ] Write and publish the README: what this is, what's in it, how to run the test harness in 5 minutes
- [ ] Share with all Safe Ad Container WG members; request working group review and signoff on Phase 1 conformance
- [ ] Internal demo at Chartboost: SHARC container running a Chartboost ad in production webview context

**Week 3–4:**
- [ ] Direct outreach to Flashtalking: "Here's the Creative SDK. What does it take to add SHARC export to your toolchain?"
- [ ] Direct outreach to 2–3 SSP contacts (start with ones you have relationships with, not cold calls)
- [ ] Draft the OpenRTB/AdCOM SHARC signal proposal and post it to the OpenRTB/AdCOM WG mailing list
- [ ] Reach out to Prebid.org Slack/GitHub: "We have a working reference implementation; who wants to scope the adapter?"
- [ ] Email to OM SDK working group: request a working session on the OM extension guidance

### Days 30–60: Create Evidence

The goal of this phase is to produce artifacts that lower risk for hesitant adopters.

**Month 2:**
- [ ] Run an integration test with at least one publisher and one creative from the SHARC Creative SDK
- [ ] Document the integration: what worked, what didn't, what we learned — publish this publicly
- [ ] Ship Phase 2 (iOS WKWebView + Android WebView + MRAID compatibility bridge) to GitHub
- [ ] Publish integration guide: "How to add SHARC to your iOS app in a day"
- [ ] Present at an IAB Tech Lab working group session: "SHARC reference implementation — status and roadmap"
- [ ] First public talk at an industry conference (AdMonsters, MMA Global, IAB AnnualEdge, or ad tech focused DevRel event)

### Days 60–90: Build Momentum

The goal of this phase is to create enough visible adoption that the question shifts from "should we adopt SHARC?" to "when are you adopting SHARC?"

**Month 3:**
- [ ] OpenRTB/AdCOM SHARC PR submitted to IABTechLab GitHub
- [ ] Prebid: confirmed scoping or working PR for SHARC signal
- [ ] At least 2 SSPs confirmed as "actively evaluating" or in integration
- [ ] At least 1 published "How we implemented SHARC" case study from an early adopter (co-author or editorial support)
- [ ] Creative validation tool (CLI): first working version published
- [ ] Blog post on IAB Tech Lab site: "SHARC reference implementation released — here's what it means for your stack"
- [ ] OM integration guidance draft: circulated within OM WG for comment

### What to Track

| Metric | 90-Day Target |
|---|---|
| GitHub stars / forks on reference impl | 50+ |
| Working group members who have run the test harness | 10+ |
| SSPs in active evaluation | 3+ |
| Creative tool vendors with SHARC on roadmap | 2+ |
| OpenRTB/AdCOM PR submitted | ✅ |
| OM extension guidance in draft | ✅ |

---

## The One Thing That Matters Most

Everything in this plan can slip except one thing: **getting a real publisher-SSP integration running in production within 90 days.**

Not a demo. Not a proof of concept. A real ad, in a real app or site, running through a SHARC container, serving real inventory.

That's the proof that the spec is implementable in the real world — not just in a test harness. Once that exists, every "we're not sure if this is real" conversation ends.

The reference implementation makes that first production integration achievable. That's what it's for.
