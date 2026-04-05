# SHARC: The Pitch
**IAB Tech Lab | Safe Ad Container Working Group**  
**Co-chairs: Jeffrey Carlson (Chartboost), Aron Schatz (DoubleVerify)**

---

## The Problem

You're running a display campaign in 2026. Your creative team built one ad. It runs on web or in-app — pick one, because you can't have both from the same creative.

Web publishers run SafeFrame. Mobile in-app publishers run MRAID. These standards are fundamentally incompatible: different state models, different APIs, different security assumptions, different container behaviors. You either maintain two separate ad builds, or you accept degraded behavior on one of the platforms, or you skip one entirely.

This is table stakes for the industry — and it has been broken for a decade.

---

## Why Existing Solutions Fail

**MRAID** was designed in 2011 for mobile in-app webviews. No security model. No standard SDK (every SDK vendor ships something slightly different). State machine that maps poorly to how modern mobile OSes actually work. Every publisher's container makes slightly different choices, so creative QA becomes an exercise in chasing down "it works on Android but not iOS" reports.

**SafeFrame** was designed for web. No mobile support. The $sf.ext API is a synchronous global that was bolted onto the existing browser environment. Resize and collapse work. Everything else is fragile. It never got meaningful adoption outside of a handful of large publishers.

Both standards predate modern web APIs like MessageChannel, Page Lifecycle, and Structured Clone. Both have ambiguities that have allowed implementations to diverge. Neither was designed with cross-platform intent.

Neither has a real successor. Until now.

---

## What SHARC Actually Does

SHARC (Secure HTML Ad Richmedia Container) is an IAB Tech Lab standard that replaces both MRAID and SafeFrame with a single API that runs identically across:

- **Web** — cross-origin iframes in browsers
- **iOS** — WKWebView in native apps
- **Android** — WebView in native apps

One creative. One API. Three environments.

**The core design choices that make this work:**

**MessageChannel as transport.** Not `window.postMessage` broadcast. SHARC uses a private `MessageChannel` port pair, one per creative session. No message collision across multiple ads on the page. No interception by third-party scripts. The security model is structural, not policy-based.

**Page Lifecycle API alignment.** The state machine maps directly to how browsers and mobile OSes actually manage app lifecycle: `ready`, `active`, `passive`, `hidden`, `frozen`. Not made-up states that container vendors have to interpret — standard platform events already fire these.

**Container owns all privileged operations.** The creative can only *request* actions. Close, navigation, resize — the container decides whether to honor them. The ad cannot touch publisher content. This is the SafeFrame security model, correctly generalized to work everywhere.

**Single Creative SDK, under 10KB.** No build tools required. Promise-based API. A creative developer can build a SHARC ad without knowing what a `sessionId` is. The SDK handles the protocol.

**Backwards compatible via bridge layers.** A MRAID 3.0 creative runs in a SHARC container without modification, via a JavaScript shim that translates MRAID calls to SHARC messages. Existing inventory works on day one.

---

## What You Need to Do

### If you're a Publisher or SSP

You implement the **container**. The reference implementation gives you a working web container library today. Drop it in, configure it with your placement parameters, and you're serving SHARC-enabled ads. The same container architecture runs in iOS WKWebView and Android WebView — same JS, thin native wrapper.

MRAID inventory works immediately via the compatibility bridge. You don't have to wait for creative supply to catch up.

**The reference implementation is at:** [github.com/IABTechLab/sharc-reference-implementation](https://github.com/IABTechLab/sharc-reference-implementation)

### If you're a DSP or Ad Network

You need to do two things:

1. Ensure your ad server can serve SHARC-enabled creatives (HTML, standard delivery, nothing exotic)
2. Pass the SHARC support signal in your bid requests so you can identify SHARC-capable inventory

The OpenRTB/AdCOM updates are in progress. In the interim, use the existing `api` field in Display Placement. The signal is simple — publishers need to know you'll act on it.

### If you're a Creative Tool or Studio

The Creative SDK is a single `<script>` include. `SHARC.onReady()` and `SHARC.onStart()` are the two hooks. Your existing HTML5 creative framework can add SHARC export with minimal changes. Reach out — we're actively working with toolchain partners to get native SHARC export into the build pipeline.

### If you're a Measurement Vendor (OM SDK)

SHARC has an extension framework designed specifically for this integration. The container exposes a message bus; OM listens to it. Done correctly, a publisher can implement SHARC with OM support out of the box — no separate integration step. The OM working group coordination is underway. Get involved now so the guidance reflects your requirements.

---

## What the Reference Implementation Gives You Today

| Deliverable | Status |
|---|---|
| Container library (`sharc-container.js`) | ✅ Production-ready |
| Creative SDK (`sharc-creative.js`) | ✅ Production-ready |
| Protocol core (`sharc-protocol.js`) | ✅ Production-ready |
| Interactive test harness | ✅ No server required |
| Sample creatives (basic, resize, clickthrough) | ✅ |
| Security model (origin validation, MessageChannel isolation) | ✅ |
| iOS / Android container wrappers | Phase 2 |
| MRAID 3.0 compatibility bridge | Phase 2 |
| Creative validation CLI | Phase 3 |
| OpenRTB/AdCOM signal | Phase 3 (WG process) |

---

## The Bottom Line

SHARC is the only standard that:
- Runs the same creative on web and mobile in-app
- Has a real security model (container owns all privileged operations)
- Is built on modern web platform APIs (MessageChannel, Page Lifecycle, Structured Clone)
- Has a working reference implementation you can fork and ship today
- Has a backwards-compatibility path for existing MRAID inventory

The spec is done. The code is done. The security review is done.

What's left is your decision about whether you implement this or keep shipping two different creatives for the next decade.

---

**To get involved:** Contact Jeffrey Carlson (Chartboost) or Aron Schatz (DoubleVerify) through the IAB Tech Lab.  
**Working group:** IAB Tech Lab Safe Ad Container Working Group — [iabtechlab.com/sharc](https://iabtechlab.com/sharc)  
**Reference implementation:** [github.com/IABTechLab/sharc-reference-implementation](https://github.com/IABTechLab/sharc-reference-implementation)
