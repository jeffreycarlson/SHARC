# SHARC — Agentic Future

**Status:** Forward-looking design consideration  
**Date:** 2026-04-04  
**Author:** Jeffrey Carlson, VP Product, IAB Tech Lab (SHARC WG)

---

## Why This Matters

SHARC is being designed for today's browser-driven world — human users, Chrome/Safari/WebView environments. But the industry is rapidly shifting toward **agentic workflows**: AI agents that negotiate, serve, and interact with ads without human presence.

A SHARC implementation built *today* should be designed to be **agentic-friendly** from the ground up, not retrofitted later.

---

## Three-Horizon Strategy

| Horizon | Theme | Purpose |
|---|---|-|
| **Past** | Backward compatibility | Bridge to existing MRAID + SafeFrame creatives |
| **Current** | Cross-platform + security | One standard, better communication between publisher, container, and creative |
| **Future** | Agentic-ready | AI agents inside and outside the container |

**Through-line:** Privacy-by-design + verifiable measurement — consistent across all three horizons.

Privacy and measurement aren't future concerns — they're *why* the industry needed SHARC in the first place. Third-party cookie deprecation is happening *now*, and SHARC's design (MessageChannel isolation, sandboxed iframe, no cookie relay) is the right answer. Standardized, auditable impression/interaction signals bridge current → future and feed the agentic attestation angle.

---

## Design Principles for Agentic SHARC

### 1. **Headless Environment Support**
AI agents may run containers without a real browser, DOM, or viewport.

**What SHARC needs:**
- Graceful degradation when `SHARC.getGeometry()` would require a viewport
- Headless-aware lifecycle states (e.g., "headless-ready" vs "visible")
- No implicit dependency on `window.innerHeight`, `document.body`, etc.

**Design note:** Consider extending the Page Lifecycle with headless-aware variants where human visual behavior doesn't apply but programmatic behavior does.

---

### 2. **Machine-Readable Ad Capabilities**
Human-readable specs (PDFs) aren't enough for agents.

**What SHARC needs:**
- Structured capability manifests (JSON Schema) that agents can parse
- Programmatic discovery: "what can this container do?" without reading docs
- Version-aware capability negotiation (v1.0 supports X, v2.0 adds Y)

**Example manifest:**
```json
{
  "schema": "sharc-agentic-capabilities.v1",
  "container": {
    "minVersion": "1.0",
    "maxVersion": "1.x",
    "features": {
      "resize": { "intent": "maximize", "maxWidth": 1920, "maxHeight": 1080 },
      "collapse": true,
      "close": true,
      "meta": { "supportedKeys": ["dealId", "advertiserId", "campaignId"] }
    },
    "agenticFeatures": {
      "structuredManifest": true,
      "stateExport": "json",
      "behaviorVerification": ["viewability", "interaction", "time-in-ad"]
    }
  }
}
```

---

### 3. **Programmatic Metadata via Bootstrap**
Human creatives read metadata via `$sf.ext.meta()` or SHARC's `bootstrap.payload`. For agents, this needs to be **discoverable** and **structured**.

**What SHARC needs:**
- Agent-accessible metadata channel at bootstrap (not hidden in `environmentData`)
- Standardized schema for ad metadata (schema.org / OpenGraph extension)
- Consent-gated data channels: "what metadata can an AI agent access without user consent?"

**Design note:** Consider a dedicated `Container:agentReady` event that signals "the agent can now introspect capabilities and metadata" before `Container:startCreative`.

---

### 4. **Verifiable Behavior**
An AI agent needs to **trust** what a creative claims it did.

**What SHARC needs:**
- Immutable behavior logs (signed, time-stamped) that an agent can audit
- Machine-verifiable claims: "this creative reported 100% viewability for 30s"
- Cryptographic attestation of ad behavior (optional but useful for high-value campaigns)

**Use case:** An ad agency's agent wants to verify a creative's performance claim before releasing payment. The creative provides a signed log; the buyer's agent verifies it against container logs.

**Design note:** Consider a `Container:behaviorLog` event stream (not just events — the **provenance** of those events).

---

### 5. **AI-Generated Creatives at Bid Time**
Future: an AI assembles an ad in real-time based on user context, publisher slot, and campaign goals.

**What SHARC needs:**
- Runtime adaptability: creative can change content/behavior dynamically without reload
- Machine-readable intent: "this creative will respond to `intent:personalize` with user segmentation rules"
- Safe sandboxing: AI-generated code must be validated before injection

**Design note:** Consider a `SHARC.requestBehaviorChange()` that allows the creative to express "I want to adapt to user segment X based on rules Y" — container validates, approves, executes.

---

### 6. **Agent-in-the-Container vs Agent-in-the-Container-Host**
Two archetypes of agentic SHARC:

**Agent inside the creative:**
- The creative *is* an agent (or agent-powered)
- It can autonomously decide to expand, collapse, or interact based on user behavior
- Needs: full `SHARC.*` API, access to user context (with consent), ability to negotiate state changes

**Agent in the container (host side):**
- An agent mediates between the creative and the environment
- Decides whether to approve `SHARC.request('resize')`, logs behavior, enforces policy
- Needs: access to container configuration, ability to intercept/approve requests, audit trail

**SHARC should be neutral** — designed to support both without assuming which pattern is used.

---

### 7. **AI-Friendly Bootstrap Payload**
Today: `environmentData` is structured for human-readable metadata. For agents, it should also be **machine-discoverable**.

**What SHARC needs:**
- Agent-specific extension of bootstrap payload (e.g., `environmentData.agentMetadata`)
- Structured capability declaration: "what can an agent do here?"
- Schema versioning: backward compatible but forward-extensible

**Design note:** Consider adding a `SHARC_AGENT_VERSION` header in the `Container:init` message that signals "the agent API surface includes X features" — agents can query this before attempting agentic behavior.

---

### 8. **Cross-Platform Agent Orchestration**
An AI agent might run:
- On the **publisher side** (container host)
- On the **buyer side** (negotiation platform)
- On the **creator side** (generating ads at bid time)

SHARC's agentic design should work **regardless of agent location**.

**What SHARC needs:**
- Agent-agnostic API surface (same for agent in browser, in cloud, or on-device)
- No implicit assumptions about agent capabilities based on environment
- Clear boundary: what is container-specific vs environment-specific

---

## Implementation Roadmap

### v1.x (current)
- Foundation: ensure SHARC is **agnostic to agent presence**
- Design for extensibility, not assumptions
- No hard dependencies on browser-specific behaviors

### v2.0 (future workstream)
- Add **structured capability manifests**
- Add **behavior logging/attestation**
- Add **agent-specific bootstrap extension**
- Define **SHARC Agent Protocol** (new spec)

### v3.0 (long-term vision)
- **Headless-ready** SHARC (no DOM, no viewport required)
- **AI-generated creative** runtime (validated code injection)
- **Cross-agent negotiation** (buy-side agent talks to sell-side agent via SHARC handshake)

---

## Open Questions for WG Discussion

1. **What metadata can an AI agent access without user consent?** Define baseline agentic data channel.
2. **Should SHARC have a separate "agentic mode"** (flagged at bootstrap) vs "human mode"?
3. **Who verifies AI-generated creatives?** Container host? Third party? Registry?
4. **How do we structure behavior logs** so they're both human-auditable and machine-verifiable?
5. **What's the minimal agentic SHARC manifest** that would enable 80% of use cases?

---

## References

- **IAB Privacy Sandbox:** Topics API, Protected Audience, Storage Access API — what lessons for agentic SHARC?
- **W3C Verifiable Credentials:** Can we use this pattern for ad behavior attestation?
- **OpenRTB 4.0:** How does OpenRTB signal agentic ad capabilities?

---

*This document is a starting point for WG discussion. The goal is not to build agentic SHARC today, but to build SHARC *for* agentic tomorrow.*
