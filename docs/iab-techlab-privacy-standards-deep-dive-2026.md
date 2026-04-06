# IAB Tech Lab — Privacy, Cookies & Standards Deep Dive (2026)

> **Date:** 2026-04-06
> **Scope:** IAB Tech Lab specifications, working groups, and regulatory responses to the post-Privacy Sandbox landscape.
> **Companion to:** `web-privacy-cookies-research-2026.md`
> **Primary sources:** iabtechlab.com, w3.org, prnewswire.com

---

## Overview

When Google killed the Privacy Sandbox in October 2025, IAB Tech Lab didn't stand still. In the 18 months leading up to and following the reversal, the Tech Lab shipped or launched public comment on 8+ major initiatives directly relevant to the cookie/privacy/supply-chain landscape. This document maps each one with technical depth.

The initiatives cluster into four themes:
1. **Identity & Measurement** — OpenRTB EID provenance, ECAPI, W3C PAT WG
2. **Privacy Compliance Infrastructure** — GPP, DDRF
3. **AI/Agentic RTB Infrastructure** — ARTF, CoMP
4. **The Fit Gap Analysis and Its Legacy** — what Tech Lab said about Privacy Sandbox before it died

---

## 1. OpenRTB 2.6 — ID Provenance (EID Transparency)

**Status:** In Production as of September 2024
**Spec:** [OpenRTB 2.6 GitHub](https://github.com/InteractiveAdvertisingBureau/openrtb)
**Primary author:** Hillary Slattery, Sr. Director Programmatic Product, IAB Tech Lab

### Background

In 2024, the industry discovered a practice called **ID bridging**: when a direct identifier (cookie sync, device ID) isn't available, a third party infers who the user is using probabilistic means — then injects that inferred ID into `user.buyeruid` or `device.ifa`. These are fields DSP bid models treat as highly trusted, first-party-quality signals. The mismatch caused downstream mispricing, fraud, and erosion of buy-side trust.

A workstream of 80+ participants across 40+ companies spent months updating OpenRTB 2.6.

### What Changed in the Spec

| Object | Field | What It Does |
|---|---|---|
| `user.eids[]` | `source` | Updated: now specifies the **canonical domain of the party that created** the EID (not who transmitted it) |
| `user.eids[]` | `inserter` (new) | Who **inserted** the EID into the bid stream (SSP, exchange, publisher SDK) |
| `user.eids[]` | `matcher` (new) | Who performed the **ID bridging or graph match** |
| `user.eids[]` | `mm` (new) | **Match method** — enumerated in AdCOM: `native`, `cookie_sync`, `graph`, `inference`, etc. |
| `user.buyeruid` | (clarified) | Redefined to be cookie-sync only; non-cookie IDs must not live here |
| `device.ifa` | (clarified) | Platform advertising ID only (IDFA/AAID/OAID); everything else belongs in `user.eids[]` |

Also included: a 3-page canonical definition of "Cookie Syncing" to remove any ambiguity, plus extensive implementation guidance for different bridging scenarios.

### Why This Matters for SHARC

`publisherContext.domain` and `publisherContext.pageUrl` in SHARC are the **creative-side equivalent** of what ID provenance does on the bid-request side. Both are about:
- Making the source of a signal explicit
- Providing buy-side/verification-side the telemetry to evaluate trust

SHARC's `publisherContext` could be framed in WG materials as the **in-creative complement to EID provenance**: where EID provenance tells you where the user identifier came from in the bid request, `publisherContext` tells you where the ad is actually running from the creative's perspective.

**Source:** [ID Provenance Added to OpenRTB](https://iabtechlab.com/id-provenance-added-to-openrtb/) — IAB Tech Lab, Sep 23, 2024
**Source:** [OpenRTB Updates for 2025](https://iabtechlab.com/the-openrtb-updates-you-should-adopt-in-2025-courtesy-of-iab-tech-lab/) — IAB Tech Lab, Jan 21, 2025

---

## 2. ECAPI — Event and Conversion API

**Status:** Public Comment closed February 20, 2026; finalization pending
**Spec page:** [iabtechlab.com/standards/ecapi/](https://iabtechlab.com/standards/ecapi/)
**Announced:** January 20, 2026

### What Is It

ECAPI standardizes how **advertisers send full-funnel marketing events to ad platforms server-to-server**. Today every platform (Meta CAPI, TikTok Events API, Google Enhanced Conversions, LinkedIn Insight) has its own proprietary schema. An advertiser integrating with 5 platforms builds 5 custom integrations.

ECAPI defines:
- A common event taxonomy — from upper-funnel (pageview, content view, add-to-cart) to lower-funnel (purchase, lead, subscription)
- A standardized server-to-server wire format
- A flexible extension mechanism for platform-specific needs

Key quote from Anthony Katsur: *"Advertisers and platforms are already doing this in parallel. ECAPI gives everyone a shared foundation so teams can focus on results, not endless integrations."*

### The Post-Cookie Connection

ECAPI is explicitly a **post-3PC measurement solution**. It routes around the browser entirely:
- Events fire server-to-server from advertiser infrastructure → ad platform
- No browser cookie dependency
- Works regardless of Safari ITP, Firefox ETP, or Chrome user choice settings
- Compatible with any identity layer (UID2, hashed email, phone, etc.)

ECAPI is also wired into the Tech Lab's **agentic roadmap** — AI agents optimizing outcomes-based buying need standardized event signals. ECAPI is the input layer for that.

### Industry Context

ECAPI is the IAB's standardized answer to what Meta called "Conversions API" and what Google calls "Enhanced Conversions." Those proprietary APIs exist because there's no standard. ECAPI could eliminate the proprietary lock-in if broadly adopted.

**Source:** [IAB Tech Lab ECAPI announcement](https://iabtechlab.com/press-releases/iab-tech-lab-announces-event-and-conversion-api-ecapi-for-public-comment/) — Jan 20, 2026
**Source:** [Martech.org ECAPI coverage](https://martech.org/iab-launches-event-and-conversion-api-to-standardize-advertisers-shared-data/) — Jan 20, 2026

---

## 3. W3C Private Advertising Technology Working Group (PATWG)

**Status:** Active. Chartered November 12, 2024 through November 30, 2026.
**Chairs:** Aram Zucker-Scharff (Washington Post), Sean Turner (Invited Expert)
**Primary deliverable:** Private Attribution Measurement (PAM) — expected Q3 2025 first draft; now in progress
**GitHub:** [w3c/patwg](https://github.com/w3c/patwg) | [w3c/ppa](https://github.com/w3c/ppa)

### What Is It

The PATWG is the **formalized standards body** for privacy-preserving advertising technology. It replaced the informal PATCG (Community Group). Key difference: Working Groups produce W3C Recommendations; Community Groups produce incubation proposals.

The group's charter explicitly states it will draw on:
- **Interoperable Private Attribution (IPA)** — the Meta/Mozilla proposal using encrypted browser-held match keys
- **Private Click Measurement** — Apple's proposal for Safari
- **Attribution Reporting API** — Google's now-retired Sandbox API
- **Private Aggregation API** — Google's aggregate reporting approach

The synthesis of all of these is the **Private Attribution Measurement (PAM)** spec — a genuinely interoperable standard that could work across Chrome, Safari, and Firefox.

### Why This Is More Important Now That Sandbox Is Dead

With the Attribution Reporting API retired, there's **no browser-native attribution mechanism in Chrome**. The PATWG's PAM is the only active path to a cross-browser standard. Google has explicitly committed to supporting this W3C process rather than continuing Chrome-specific APIs.

Participants include: Google, Apple, Mozilla, Meta, Microsoft, Washington Post, IAB Tech Lab members.

Key unsettled design dimensions:
- **On-device vs. multiparty computation** — IPA uses distributed MPC (no single party sees the match). Apple PCM does on-device. Each has different trust and performance tradeoffs.
- **Event-based vs. aggregate** — event-level attribution is more useful for optimization; aggregate is more privacy-preserving. Where to draw the line?
- **Epsilon/noise levels** — differential privacy requires adding noise. What level is acceptable to advertisers while protecting users?

### Timeline

| Date | Milestone |
|---|---|
| Nov 12, 2024 | PATWG formally chartered |
| Q1 2025 | First face-to-face at W3C TPAC |
| Q2 2025 | Requirements and use cases for Private Measurement established |
| Q2 2025 | First public working draft of PAM |
| Nov 30, 2026 | Charter expires (expected renewal) |

**Source:** [W3C PATWG Charter](https://www.w3.org/2024/11/wg-pat-charter.html) — Nov 2024

---

## 4. Global Privacy Protocol (GPP) — H2 2025 Update

**Status:** Finalized December 2025
**Spec:** [iabtechlab.com/gpp/](https://iabtechlab.com/gpp/)
**Previously called:** Global Privacy Platform

### What Changed

The GPP got a significant H2 2025 update:

**1. New US state sections added:**
| State | Effective Date |
|---|---|
| Maryland | October 1, 2025 |
| Indiana | January 1, 2026 |
| Kentucky | January 1, 2026 |
| Rhode Island | January 1, 2026 |

(Minnesota was added earlier in 2025.)

This brings the total supported US state privacy sections to 10+ (California, Colorado, Connecticut, Virginia, Florida, Utah, Texas, Oregon, Montana, Iowa, Maryland, Indiana, Kentucky, Rhode Island, and the MSPA national string).

**2. Bi-annual release cycle established for 2026:**
Starting 2026, GPP updates will follow a predictable H1/H2 cadence. This is a direct response to industry feedback that ad tech companies need 6–12 months to integrate new privacy signals, and surprise regulatory additions create compliance chaos.

**3. Server-side "applicable sections" signaling:**
A long-standing gap: CMP API has `PingReturn.supportedAPIs` for client-side but no equivalent server-side signal. Two proposed solutions are in public comment — one using the bid request, one using a new endpoint. Not yet finalized.

**4. Core architecture rework:**
The underlying GPP encoding is being "rearchitected" for forward compatibility — the current Fibonacci encoding scheme has limitations for new jurisdiction requirements. The rework preserves backward compatibility while enabling new state sections to be added without spec breaks.

### Google's GPP Support (Key for Publishers)

As of September 2025, Google Ad Manager supports GPP National v2. However:
- **EEA/UK still requires direct TCF 2.2** — GPP strings are NOT accepted for ads served in EU
- Only these sections are accepted in Ad Manager: US National, California, Colorado, Connecticut, Florida, Virginia
- MSPA certification covers the national string without publishers needing to sign the MSPA directly

**Source:** [IAB Tech Lab GPP page](https://iabtechlab.com/gpp/) — updated Dec 17, 2025
**Source:** [GPP H2 2025 announcement](https://iabtechlab.com/press-releases/iab-tech-lab-expands-global-privacy-frameworks-with-gpp-updates-and-ddrf-v2-release/) — Oct 23, 2025

---

## 5. Data Deletion Request Framework (DDRF) v2

**Status:** Finalized December 2025
**Companion to:** GPP H2 2025 update

### What Is It

DDRF standardizes how **consumer data deletion requests flow through the advertising supply chain**. When a California consumer submits a CCPA "Delete My Data" request to a publisher, that request must propagate downstream to every vendor, DSP, DMP, and data broker that holds the user's data. Before DDRF, every company had a custom integration.

DDRF v2 updates:
- **Clearer object formats** — new JSON schema for deletion requests, standardized field names
- **Standardized encoding** — consistent base64 and hashing conventions
- **Enhanced safeguards** — encryption requirements for PII in transit
- Recognized by the UK Information Commissioner's Office (ICO) as a valid framework

### Connection to SHARC

DDRF is not directly in SHARC's scope, but it's context: if a creative container receives a user deletion request, how does that signal reach the creative? Currently no standard for this. SHARC could eventually extend `publisherContext` or a new `privacySignals` field to pass consent/deletion signals to creatives — analogous to OMID's privacy signal pass-through.

**Source:** [GPP + DDRF v2 announcement](https://iabtechlab.com/press-releases/iab-tech-lab-expands-global-privacy-frameworks-with-gpp-updates-and-ddrf-v2-release/) — Oct 23, 2025

---

## 6. Agentic Real Time Framework (ARTF) v1.0

**Status:** Public comment closed January 15, 2026; finalization in progress. v2.0 underway.
**Spec:** [iabtechlab.com/standards/artf/](https://iabtechlab.com/standards/artf/)
**Announced:** November 13, 2025
**Working group participants:** Index Exchange, OpenX, The Trade Desk, Chalice, Amazon Ads, Netflix, Yahoo, Paramount, Optable, HUMAN Security, Magnite, PubMatic, WPP Media, Basis Technologies

### What Is It

ARTF defines a **containerized agent framework for real-time bidding**. The core concept: instead of a DSP making HTTP round trips across the internet to enrich or modify a bid request, a containerized service (docker/OCI) is deployed directly into the SSP/exchange's infrastructure. Communication happens in-process or over local network.

**Performance claim:** Reduces bid request-response latency from 600–800ms to ~100ms — up to 80% reduction.

### Technical Architecture

| Requirement | Detail |
|---|---|
| Container runtime | OCI-compliant (Docker, Kubernetes, Amazon ECS) |
| Communication protocol | gRPC with protobuf serialization |
| External network access | **Prohibited** — no ingress/egress except to orchestrator |
| Mutation model | Semantic OpenRTB mutations (not raw JSON paths) |
| Security model | Host platform controls all data; agent declares intents; host accepts/rejects |
| Monitoring | OpenTelemetry built in |
| Languages | Rust, Go, or Java (performance requirement) |

The framework also establishes foundations for **Model Context Protocol (MCP)** and **Agent-to-Agent (A2A)** communication — enabling AI model-to-service interactions for autonomous bidding.

### Use Cases

- Identity resolution by third-party agent (no external call needed)
- Real-time deal/segment activation inside the SSP
- Fraud detection pre-impression (HUMAN Security style)
- Bid optimization / real-time valuation adjustment
- Supply path optimization within the auction

### Early Validation

Zillow piloted containerized RTB with Chalice and Index Exchange in August 2025 — embedding DSP intelligence directly into SSP infrastructure. This is ARTF in practice before the spec was published.

### ARTF vs. SHARC: Two Sides of the Same Coin

| | ARTF | SHARC |
|---|---|---|
| **Layer** | Bidstream / server-side | Creative execution / client-side |
| **Container** | OCI/Docker deployed in data center | JavaScript/WebView deployed in publisher page |
| **Problem** | Latency in bid enrichment; data isolation | Creative runtime fragmentation (SafeFrame, MRAID, SIMID) |
| **Isolation** | No external network access | Sandboxed iframe/WebView |
| **API surface** | gRPC + protobuf to orchestrator | SHARC protocol messages to container |
| **Context passing** | Bid request enrichment | `publisherContext`, placement data |

Both are containerization standards at different layers of the stack. ARTF is server-side and focused on bidstream speed and isolation. SHARC is client-side and focused on creative runtime unification.

**In WG positioning:** SHARC is the **creative-execution complement to ARTF**. ARTF standardizes how agents operate in the bidstream. SHARC standardizes how creatives operate in the publisher page. Together they complete the loop.

**Source:** [ARTF v1.0 announcement](https://iabtechlab.com/press-releases/iab-tech-lab-announces-agentic-rtb-framework-artf-v1-0-for-public-comment/) — Nov 13, 2025
**Source:** [ARTF spec page](https://iabtechlab.com/standards/artf/) — updated Feb 18, 2026
**Source:** [PPC Land ARTF deep dive](https://ppc.land/iab-tech-lab-opens-agentic-rtb-framework-for-container-based-advertising/) — Nov 15, 2025

---

## 7. AI Content Monetization Protocols (CoMP)

**Status:** v1.0 in Public Comment until **April 9, 2026**
**Spec:** [iabtechlab.com/comp/](https://iabtechlab.com/comp/)
**Working group formed:** August 2025 (as "LLM Content Ingest API", renamed CoMP Aug 19, 2025)
**v1.0 released for comment:** March 10, 2026

### What Is It

CoMP is IAB Tech Lab's response to AI-driven search eating publisher traffic. Publishers are seeing **50%+ declines in search referral traffic** as Google AI Overviews, ChatGPT, and Perplexity answer queries without sending users to publisher pages.

CoMP defines a standardized framework for:
1. **Bot blocking with a lock** — standard mechanism for publishers to block AI crawlers at the CDN/edge level
2. **LLM-friendly content discovery** — how publishers signal to AI systems what content is available and at what terms
3. **LLM Ingest API** — server-to-server protocol for AI systems to request content access with agreed commercial terms in place

### Business Models CoMP Supports

| Model | Description |
|---|---|
| Pay-per-crawl | AI system pays per page crawl |
| Aggregation / pay-per-use | Flat or metered access to content library |
| Outcome-based | AI pays based on traffic, citations, or revenue driven |

This is the **ad industry's first formal attempt to build a marketplace for content in the AI era** — equivalent to what DoubleClick did for display ads in 1996.

### Why This Connects to Privacy and Cookies

CoMP is happening because AI killed publisher traffic that ad revenue depended on. If publishers have no traffic, they have no ad inventory. This is the **supply-side collapse** that privacy changes accelerated but AI turbocharged. The cookie/privacy/AI crises are all hitting publishers at once.

**Source:** [CoMP v1.0 announcement](https://www.prnewswire.com/news-releases/iab-tech-lab-announces-comp-framework-to-ensure-llms-have-commercial-agreements-with-publishers-before-content-crawling-302709558.html) — Mar 10, 2026
**Source:** [CoMP Working Group formation](https://iabtechlab.com/press-releases/iab-tech-lab-forms-ai-content-monetization-protocols-comp-working-group-to-set-ai-era-publisher-monetization-standards/) — Aug 19, 2025

---

## 8. Privacy Sandbox Fit Gap Analysis — Legacy and Impact

**Final published:** June 27, 2024
**Task force:** 65+ companies, 44 critical advertising use cases evaluated
**Report:** 106 pages

### What Tech Lab Found

IAB Tech Lab's Privacy Sandbox Task Force spent 6 months evaluating whether Privacy Sandbox APIs could support core ad tech use cases. The verdict was damning.

Key findings by category:

**Audience Management:**
- Exclusion targeting: degraded (improved from "not supported" after Google pushed back)
- Look-alike modeling: impractical
- Interest group management for competing entities: unsupported
- Multi-touch attribution: impractical

**Auction Dynamics:**
- Frequency capping: degraded
- Budget pacing: challenges
- Competitive separation: unsupported
- No-bid response tracking: inadequate

**Creative & Rendering:**
- Video advertising: significant challenges with fenced frames
- Malware/quality protection: degraded in sandboxed creative contexts
- Creative-to-publisher page communication: severely limited

**Reporting:**
- Bid loss reporting: unsupported
- Revenue accrual validation: downgraded from "temporarily supported" to "not supported"
- Detailed attribution reports: severely limited by noise/delay/aggregation requirements

**Overall Tech Lab conclusion:** *"The Privacy Sandbox falls well short of what is needed to support a robust open web... It will restrict the digital media industry's ability to deliver relevant, effective advertising, placing smaller media companies and brands at significant risk."*

### What Happened Next

The Fit Gap Analysis directly contributed to:
1. The CMA's hesitation to fully approve Google's Sandbox plans
2. The ad industry's pivot away from Sandbox investment toward alternative ID solutions
3. Google's eventual reversal — the analysis gave the ecosystem permission to stop waiting
4. The renamed **Private Ad Systems Task Force** — widened scope to cover ALL proprietary ad systems (not just Chrome Sandbox), publishing [Digital Advertising Industry Requirements for Proprietary Ad Systems](https://iabtechlab.com/) on October 31, 2024

### The "Creative & Rendering" Finding Is Directly Relevant to SHARC

The Fit Gap Analysis specifically called out limitations in "Creative & Rendering" — fenced frames, communication between ad creative and publisher page, malware protection. These are exactly the problems SHARC solves:

| Gap Identified in Fit Gap Analysis | SHARC's Solution |
|---|---|
| Limited creative-to-publisher communication | SHARC protocol message layer (`requestFeature`, `onMessage`) |
| Degraded malware/quality protection in sandboxed contexts | SHARC container isolates creative while maintaining controlled API surface |
| Video advertising challenges in fenced frames | SHARC provides unified runtime for display + video + rich media |
| Fragmented cross-runtime support | SHARC bridges MRAID (in-app), SafeFrame (web), SIMID (video) |

**SHARC is a direct answer to the gaps the industry told Google about in 2024.** This is a legitimate WG narrative.

**Source:** [Final Fit Gap Analysis](https://iabtechlab.com/iab-tech-lab-releases-final-privacy-sandbox-fit-analysis/) — June 27, 2024
**Source:** [Privacy Sandbox Task Force page](https://iabtechlab.com/standards/privacysandbox/)

---

## Summary: IAB Standards Landscape 2024–2026

| Initiative | Category | Status | SHARC Relevance |
|---|---|---|---|
| OpenRTB 2.6 EID Provenance | Identity transparency | ✅ Production (Sep 2024) | `publisherContext` is the creative-side equivalent |
| Privacy Sandbox Fit Gap Analysis | Regulatory/research | ✅ Final (Jun 2024) | SHARC solves "Creative & Rendering" gaps directly |
| Private Ad Systems Requirements | Policy | ✅ Published (Oct 2024) | Framework for evaluating proprietary ad systems |
| DDRF v2 | Privacy compliance | ✅ Final (Dec 2025) | Future: privacySignals in SHARC? |
| GPP H2 2025 | Privacy compliance | ✅ Final (Dec 2025) | SHARC container could pass GPP string to creatives |
| ARTF v1.0 | Agentic RTB | 🔄 Finalizing (Jan 2026) | Server-side counterpart to SHARC's client-side container |
| ECAPI | Measurement | 🔄 Finalizing (Feb 2026) | No direct overlap; SHARC can trigger ECAPI events |
| W3C PATWG / PAM | Attribution standard | 🔄 Active (thru Nov 2026) | Post-cookie attribution; SHARC `publisherContext` as input signal |
| CoMP | Publisher monetization | 🔄 Public comment (Apr 9, 2026) | AI-era publisher revenue; adjacent to SHARC's open web mandate |

---

## Key Themes for SHARC WG Positioning

### 1. "Supply Chain Transparency" Is the New North Star
With 3P cookies not gone but identity fragmented, the industry's focus has shifted from "identity replacement" to **verifiable supply chain signals**. EID provenance, GPP, DDRF, and `publisherContext` are all part of the same thesis: *every signal in the bidstream should have auditable provenance.*

### 2. Containerization Is the Architecture of the Post-Sandbox Era
ARTF at the server layer, SHARC at the creative layer — both use container-based isolation and controlled API surfaces. IAB Tech Lab has bet on containers as the answer. SHARC fits this narrative perfectly.

### 3. Creative-Publisher Communication Was the Sandbox's Biggest Gap
The Fit Gap Analysis explicitly identified it. Fenced frames tried to address it and failed. SHARC's protocol layer — `requestFeature()`, `publisherContext`, `onMessage()` — is the direct technical answer.

### 4. The ECAPI-SHARC Connection
ECAPI standardizes full-funnel event reporting from advertiser → platform. SHARC could become an upstream **event source** — rich media interactions, viewability signals, engagement events — that feed into ECAPI-compatible measurement pipelines. This is a product opportunity.

### 5. CoMP Is the Long Tail Problem; SHARC Is the Ad Unit Problem
Both are about the post-AI, post-cookie publisher. CoMP tackles the content monetization layer (who can crawl, at what price). SHARC tackles the ad unit layer (how creatives run, verified and sandboxed). They're not competing; they're complementary infrastructure for the publisher in 2026.
