# Web Privacy, Cookies, and Third-Party Tracking — State of Play (2026)

> **Date:** 2026-04-06
> **Scope:** Web (not in-app). Focus on what's changed, what's gone, what's left.
> **Sources:** Google Privacy Sandbox blog, AdExchanger, Adweek, Martech.org, eMarketer, WebKit

---

## 1. Third-Party Cookie Deprecation — The Reversal

### Timeline

| Date | Event |
|---|---|
| 2019 | Google announces Privacy Sandbox — replace 3PC with new APIs |
| 2020–2024 | Repeated delays; CMA regulatory scrutiny; multiple trial periods |
| Jan 2024 | Chrome begins 1% 3PC phaseout trials |
| **Apr 22, 2025** | **Google reverses course.** Announces no mandatory prompt to remove 3PC. Keeps 3PC behavior behind user choice settings. |
| **Oct 17, 2025** | **Google announces retirement of 10 remaining Privacy Sandbox APIs.** "We'll continue to improve privacy across Chrome and the web, but moving away from the Privacy Sandbox branding." — Anthony Chavez, VP Privacy Sandbox. |
| **Oct 17, 2025** | **CMA officially releases Google from its Sandbox commitments**, citing changed threat model and regulatory context. |

### What Actually Happened

You were right. Google backed off. The reversal came in two phases:

1. **April 2025 — no more forced deprecation.** Instead of removing 3P cookies entirely, Google now offers user choice in Chrome Settings. This is the same mechanism Apple and Firefox provide — opt-out, not forced removal.

2. **October 2025 — the Sandbox dies.** Google retired 10 APIs (Topics, Protected Audience, Attribution Reporting, IP Protection, etc.) citing "low levels of adoption" and ecosystem feedback. The Privacy Sandbox branding is retired as a program.

### What's Left

| API | Status | Why |
|---|---|---|
| **3rd-party cookies** | **Still available, behind user choice** | No forced deprecation. Ad tech continues to rely on them where user hasn't opted out. |
| **CHIPS** | Supported | Cookie partitioning — prevents a 3P service from correlating across sites. Broad adoption, support from other browsers. |
| **FedCM** | Supported | Privacy-friendly identity/sign-in — lets users authenticate without 3PC tracking. Firefox implementing. |
| **Private State Tokens** | Supported | Anti-fraud tokens — prove legitimacy without revealing identity. |
| Everything else | Retired | Low adoption, regulatory pressure, technical complexity |

**Source:** [Chrome Blog — Update on Plans for Privacy Sandbox Technologies](https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies) (Oct 17, 2025)
**Source:** [AdExchanger — Google Pulls the Plug on Topics, PAAPI](https://www.adexchanger.com/privacy/google-pulls-the-plug-on-topics-paapi-and-other-major-privacy-sandbox-apis-as-the-cma-says-cheerio/) (Oct 17, 2025)
**Source:** [Adweek — Google's Privacy Sandbox Is Officially Dead](https://www.adweek.com/media/googles-privacy-sandbox-is-officially-dead/) (Oct 17, 2025)

---

## 2. Other Browser Tracking Prevention

### Safari (Apple ITP) — Still the Strictest

Apple has never wavered. ITP has been blocking 3P cookies since 2017 and continues to tighten. As of Safari 18 / iOS 18:

- **Full 3P cookie blocking** — no exceptions. Third-party domains can't see or set cookies unless granted Storage Access API.
- **7-day cap on all script-writeable storage** — cookies set via `document.cookie`, LocalStorage, IndexedDB all expire after 7 days of no user interaction.
- **24-hour cap with link-decoration** — if a classified tracker arrives via decorated link, storage is capped to 24 hours.
- **CNAME cloaking defense** — detects and caps cookies from cloaked third-party domains at 7 days.
- **Private Browsing enhancements** — trackers are completely prevented from loading (not just blocked from accessing storage). Locks automatically when idle.
- **Profiles (iOS 17+)** — separate browsing contexts isolate user data across work/personal.

**Key point:** Safari represents ~18–20% of desktop share, ~60% of mobile. In Safari, 3P cookies were never an option. The ad industry learned to work around this via CNAME cloaking, server-side tagging, and Storage Access API — all of which ITP has actively defended against.

**Source:** [WebKit Tracking Prevention](https://webkit.org/tracking-prevention/)
**Source:** [Avenga — Timeline of Apple's Safari Privacy Changes](https://www.avenga.com/magazine/timeline-apple-privacy-changes/) (2025-06-24)

### Firefox (ETP — Enhanced Tracking Protection)

- **Full 3P cookie blocking by default** since 2019 (Firefox 69, "Total Cookie Protection" in 2021).
- Uses cookie jar partitioning by default — each site sees an isolated cookie store for third parties.
- ETP Strict mode blocks social trackers, cryptominers, fingerprinters.
- Working on FedCM prototype — Mozilla has expressed interest in implementing private federated sign-in.
- As of ETP, Firefox doesn't distinguish between ITP's ML classifier and blanket blocking — ETotal Cookie Protection partitions all third-party storage by default.

---

## 3. Privacy Sandbox API Status — What Died, What Lived

### Retired (Oct 17, 2025)

| API | What It Did | Why It Died |
|---|---|---|
| **Topics API** | Interest-based targeting — replaces cross-site tracking with on-device interest classification | Low adoption; publishers didn't enable it; DSPs found it too coarse |
| **Protected Audience API (PAAPI)** | Retargeting — on-device auction for remarketing audiences (formerly FLEDGE) | Complex implementation; low adoption; ecosystem resistance |
| **Attribution Reporting API** | Privacy-safe conversion measurement with aggregatable reports | Superseded by work on W3C Attribution standard; low adoption |
| **IP Protection** | Proxy-based routing to hide user IP from trackers | Technical complexity; privacy concerns about Google as proxy |
| **On-Device Personalization** | ML models run on-device for personalized ad targeting | No meaningful adoption |
| **Private Aggregation** | Differential privacy for aggregated cross-site analytics | Low adoption; complexity |
| **Protected App Signals** | Android equivalent of PAAPI | Died with the Protected Audience program |
| **Related Website Sets** | Define relationships between first-party domains for cookie sharing | Privacy concerns about cross-site tracking loopholes |
| **SelectURL** | Privacy-preserving URL selection for shared state | No adoption |
| **SDK Runtime** | Android privacy sandbox for SDK isolation | Died with Android Privacy Sandbox |

### Still Supported

| API | What It Does | Adoption |
|---|---|---|
| **CHIPS** | Partitioned cookies — `Set-Cookie: Partitioned` isolates cookies per top-level site | Broad adoption; Firefox and Safari support |
| **FedCM** | Federated Credential Management — privacy-preserving sign-in without 3PC | Chrome 108+; Firefox prototyping; Apple interested |
| **Private State Tokens** | Cryptographic trust signals — prove legitimacy without revealing identity | Supported but limited adoption |

### Emerging: Attribution Standard

Google is now supporting the **W3C Attribution standard** (formerly "Privacy-Preserving Attribution API") through the Private Advertising Technology Working Group. This is an open standard, not a Chrome-specific API. Key difference: other browsers (Safari, Firefox) can participate in the standard.

**Source:** [W3C Attribution Working Group](https://github.com/w3c/attribution)

---

## 4. Industry Response to the Reversal

### First-Party Data Strategies Became the Priority

- **62% of brand marketers** say first-party data will become more important over the next two years (Econsultancy, Oct 2024)
- Publishers are investing in authenticated experiences — login walls, newsletters, registered user programs — to generate persistent identifiers

### Identity Solutions: The Multi-ID Reality

The "universal ID" dream is dead. Instead, multiple identity frameworks coexist:

| Solution | Approach | Key Users |
|---|---|---|
| **UID2.0 (The Trade Desk)** | Encrypted email (EUID), phone, device ID | Major DSPs, publishers, CTV platforms |
| **ID5 ID** | Hashed email + page URL + IP address | European publishers, DSPs |
| **RampID (LiveRamp)** | Transforms PII into persistent IDs | Enterprise advertisers |
| **Panorama ID (Lotame)** | Cross-platform linking — web, mobile, CTV | Publicis Groupe (acquired Lotame Mar 2025) |
| **Core ID (Epsilon)** | Epsilon's identity graph | Omnicom |

**M&A Activity:**
- **WPP acquired InfoSum** (data clean room provider) — April 2025
- **Publicis acquired Lotame** — March 2025, combining identity assets reaching ~4B global profiles

### Clean Rooms

Cloud platforms (Google BigQuery, Snowflake, Databricks) now offer native clean room capabilities. Identity vendors are building clean room functionality directly into their platforms.

**Source:** [Martech.org — 5 Trends Reshaping Identity Resolution in 2026](https://martech.org/the-5-trends-reshaping-identity-resolution-in-2026/)
**Source:** [eMarketer — FAQ on Identity Resolution, 2026](https://www.emarketer.com/content/faq-on-identity-resolution-navigating-privacy-cookies-cross-channel-fragmentation-2026)

---

## 5. Regulatory Landscape

### GDPR (EU)
- **No major structural changes** in 2025–2026. Enforcement continues to focus on data transfers (Schrems III implications still playing out) and consent mechanics.
- IAB Europe's TCF 2.2 continues to be the de facto standard for consent strings in programmatic.

### CCPA/CPRA (California)
- **New state-level privacy laws** following the California model: Colorado, Connecticut, Virginia, Utah, and others have operational frameworks.
- **Opt-out of sale** and **opt-out of sharing** remain compliance requirements for ad tech.
- Global Privacy Control (GPC) gaining adoption as a browser-based opt-out signal.

### DMA (EU Digital Markets Act)
- **January 2024 (EU only):** Apple must allow non-WebKit browsers in the EU — Chrome/Firefox can use their own engines.
- This matters because Chrome on iOS was previously forced to use WebKit's privacy restrictions. Now Chrome on iOS in the EU can diverge — though Google hasn't yet shipped a separate cookie policy for iOS EU.

### ePrivacy Regulation
- **Still stalled.** The EU's ePrivacy regulation has been in limbo for years. The 2024–2025 cycle saw no movement toward passage.
- In practice, the **Cookie Banner** landscape is unchanged: IAB CMPs handle consent; publishers manage preferences; enforcement varies by country.

---

## 6. Impact on Measurement and Attribution

### Without 3P Cookies, Cross-Site Measurement Is Fragmented

**What's working:**
- **UID2-based measurement:** DSPs using hashed email to tie impressions to conversions across sites (30% lower CPCV reported by Unilever vs. 3P cookie targeting)
- **Server-side measurement:** First-party pixels firing to server endpoints, then modeling the rest
- **Clean room analysis:** Aggregate-level joins between publisher and advertiser data
- **Contextual targeting:** No identity needed — match ad to page content

**What's broken:**
- **Cross-site frequency capping** — can't count unique users across sites without shared identity
- **Last-touch attribution across domains** — broken in Safari (7-day cap), degrading everywhere
- **View-through attribution** — requires correlating impression events with conversion events, which requires user-level matching
- **MFA/fraud detection** — harder to detect suspicious traffic patterns without cross-site identity signals

### Verification Vendors (IAS, DoubleVerify, MOAT)

These vendors operate in the iframe/creative context and don't rely on 3P cookies for their core function (measuring viewability, invalid traffic). What they need is:
- Access to the ad creative (iframe access)
- DOM geometry measurement
- Network latency signals

**This is where SHARC's `publisherContext` becomes critical.** Without 3P cookies, verification vendors need other ways to correlate their measurement with the actual running environment. The container-reported `pageUrl`, `domain`, and `bundleId` gives them an independent data point to cross-validate against the bid request.

---

## 7. What This Means for SHARC

### SHARC's Position Is Stronger Than Before

**The reversal doesn't eliminate privacy pressure** — it redistributes it. Google is letting 3P cookies continue behind user choice, but:
1. Safari (20%+ desktop, ~60% mobile) still fully blocks 3P cookies
2. Firefox (5–10%) still fully partitions
3. EU DMA forces Apple to allow separate engines — but Apple hasn't yet diverged Safari's policy
4. Regulatory compliance (GDPR, CCPA) still requires consent management regardless of browser behavior

**The net effect:** The ad tech ecosystem is in a *fragmented identity* world. No single replacement for 3P cookies emerged. Instead:
- UID2 for authenticated audiences
- CHIPS for partitioned cookies
- Server-side tagging for first-party data
- Clean rooms for aggregate analysis
- Contextual for identity-free targeting

### SHARC's `publisherContext` Is Now More Valuable

Before the reversal, one could argue "3P cookies are going away, so publisher context won't matter." That argument is dead.

Here's what actually matters in the current environment:

1. **Domain spoofing detection** — Bid request claims `site.page: "nytimes.com"` but the tag is on `malware-site.example`. Without 3P cookies, this is harder to detect cross-site. `publisherContext.pageUrl` gives the container an independent assertion.

2. **Verification vendor cross-validation** — IAS/DV read the `pageUrl` from the container (SHARC) and compare it to their own publisher page context. Agreement = convergent legitimacy. Disagreement = fraud signal.

3. **Bundle ID for in-app** — Neither SafeFrame nor MRAID ever provided bundle ID to the creative. SHARC does. This lets measurement and verification SDKs confirm they're running in the claimed app, not a fake SDK.

4. **OMID relationship** — OMID collects publisher page context from the publisher's script (first-party). SHARC collects from the container (inside the ad slot). These are **independent by design** — when they agree, it's strong evidence. When they disagree, it's a supply chain flag.

### SafeFrame Bridge and Cookie Exclusion

Our SafeFrame bridge permanently excludes `$sf.ext.cookie()` — this is the right call given the current landscape:
- **Safari already blocks 3P cookies entirely**
- **CHIPS** is the forward-looking path for partitioned cookies
- **FedCM** handles identity without cookies
- **No ad tech company should be relying on `document.cookie` for cross-site tracking in 2026**

The exclusion is not a gap — it's forward-compatibility.

### v1 Positioning for the IAB Working Group

Frame SHARC as the **supply chain integrity layer** for a post-Sandbox world:
- "The Privacy Sandbox is dead, but supply chain transparency is more important than ever"
- "SHARC `publisherContext` gives every creative an independent, container-asserted view of where it's running — no 3P cookies needed"
- "Cross-validated with OMID for convergent evidence"

---

## Appendix: Key Dates

| Date | Event |
|---|---|
| 2019 | Google Privacy Sandbox announced |
| Sep 2017 | Apple ITP ships with Safari 12 / iOS 11 |
| Feb 2019 | Safari blocks 3P cookies by default |
| 2021 | Firefox Total Cookie Protection ships |
| Jan 2024 | Chrome begins 1% 3PC phaseout |
| Jan 2024 | Apple allows non-WebKit browsers in EU (DMA compliance) |
| Apr 22, 2025 | **Google reverses 3PC deprecation** — keeps user choice |
| Jun 2025 | CMA begins release of Google from Sandbox commitments |
| Oct 17, 2025 | **Google retires 10 Privacy Sandbox APIs** |
| Oct 17, 2025 | **CMA officially releases Google from Sandbox commitments** |
| Apr 2026 | SHARC ships with `publisherContext` (v0.3+) |
