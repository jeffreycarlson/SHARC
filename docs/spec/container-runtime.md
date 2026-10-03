<!-- SHARC-DOC-STATUS: NORMATIVE -->

# SHARC Container Runtime Specification

**SHARC Specification 1.0 (Draft)**

| Field | Value |
|---|---|
| Spec version | **1.0-draft** — one spec version shared by the three SHARC Specification documents. Independent of the npm package version; bumps **only on normative change**. Editorial and informative changes bump a document revision, not the spec version. |
| Document | L1 — Container Runtime (mandatory conformance class) |
| Status | **DRAFT** |

## Conventions

The keywords MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) **when, and only when, they appear in all capitals**. Lower-case "must" / "should" / "may" are non-normative prose.

<!-- trace: source=docs/proposals/creative-sources.md §Conventions (promoted per skeleton L1 §1.2 row) | gate=NO-GATE (definitional) -->

## Versioning policy

This policy is stated once, here, for all three SHARC Specification documents.

- **Spec identity.** L1 Container Runtime (this document), L2 [Creative API](creative-api.md), and the Compat Profile together form the **SHARC Specification**, now at **1.0 (Draft)**. The three documents share one spec version. External artifacts cite the spec version: the AdCOM `APIFramework` registration for SHARC, and artifacts prepared for the IAB Tech Lab Open Measurement working group.
- **Independent of the package version.** The spec version is independent of the reference implementation's npm package version. It changes only on a normative change. An editorial or informative change bumps the affected document's revision, not the spec version.
- **Pre-1.0 posture.** Until 1.0, breaking changes ship clean: legacy input throws, with no alias and no deprecation period. At 1.0 the spec version becomes the compatibility promise.
- **The `version` field on the wire.** The `version` field of `Container:init` `EnvironmentData` (L2 §2.7) reports the spec version, so that a creative can take compatibility action.
- **Registry stability.** After 1.0, the entries of the [SHARC registries](registries.md) are append-only. Removing an entry requires a spec-version bump. Code `2105` is stricter still: it is reserved and never reused (Ruling 1, 2026-10-03; registries.md R1).
- **Draft to Final.** The specification leaves Draft when the six SHARC 1.0 Definition-of-Done gates hold at the same time: G1 (the spec reorganized into the three layers), G2 (zero SHARC-attributable failures on the executable markup corpus), G3 (real verification vendors confirmed end-to-end), G4 (the succession test: runtime conformance can be implemented from the public documents alone), G5 (the Creative URL variant proven), and G6 (in-app embedding proven on iOS WKWebView and Android WebView).

> DIVERGENCE (ruling required; GATE-DESIRED): the wire form of the spec version is not yet fixed. The front matter of each document writes it `1.0-draft`. The reference implementation sends its package version (`SHARC_VERSION`, currently `'0.7.13'`) in `EnvironmentData.version`, in the handshake bootstrap and in `createSession` (`src/sharc-protocol.js` `SHARC_VERSION` :30). No test pins the field's value. The SHARC-legacy WG draft defined the field as the version of the SHARC implementation, and that definition is superseded here (§1.4).
>
> Editorial note: the documents do not yet carry a separate document-revision field. Until one exists, the spec version in each front-matter table is the only version shown.

<!-- trace: source=NEW-PROSE per skeleton §G (NEW-PROSE inventory item 2) + pre-1.0 breaking-change posture (ratified) + SHARC 1.0 Definition of Done (2026-06-10, Obsidian; gate names only) + Ruling 1 (2026-10-03, 2105 reserved) | gate=NO-GATE (policy); the version-field wire form is DIVERGENCE (ruling required), GATE-DESIRED -->

## Extraction status (informative)

This document is being assembled by editorial extraction from the existing normative-of-record estate, per the ratified traceability skeleton (`docs/design/0.8.0-g1-spec-traceability-skeleton.md`). Sections marked RESERVED name their source and land in later extraction slices. Filled sections carry a traceability footer (`<!-- trace: source=… | gate=… -->`) naming the estate source and the pinning test gate, matching the skeleton's `section → source → gate` rows. The wire-format prose that slice 1 carried here as Part 2 was re-homed to the L2 [Creative API Specification](creative-api.md) in slice 3; the protocol-layer enforcement bounds from that Part stayed in L1 (§1.11.9). Slice 4 adds the governance and front-matter sections (the versioning policy, §§1.1–1.4, and the Appendix B seam census), the citable [registries](registries.md), and the requirement index [traceability.md](traceability.md), which lists every RFC-2119 line of the normative documents with its class, gate and status.

---

## Part 1 — Container Runtime (L1)

### 1.1 Scope, audience, and goals

SHARC (Secure HTML Ad Rich-media Container) is a secure container that runs a served ad creative inside a host, a web page or a mobile app, and manages every exchange between the two. The goal is one creative, served anywhere: a creative is built once and runs unchanged on every platform that implements SHARC, on the web and in-app. That replaces the split between SafeFrame, built for the web, and MRAID, built for in-app WebViews, which forced a campaign to build two creatives.

**Layering.** SHARC is organized in three layers, each specified in its own document:

- **L1, Container Runtime** (this document; mandatory). What a container operator implements. It works with **any** HTML creative and needs no cooperation from the creative. A plain HTML creative is the permanent baseline, not a degraded case. L1 covers sandbox construction, creative loading (the Creative URL and Creative Markup variants), lifecycle derived from observation, navigation policy, the security model and its event taxonomy, and measurement provisioning through OMID.
- **L2, Creative API** ([creative-api.md](creative-api.md); an optional conformance class). The wire protocol that a cooperating creative opts into for rich capability: session establishment, state delivery, placement changes, interaction reporting, and the extension surface. L1 delivers value without it.
- **Compat Profile** (an optional add-on profile; separate document). Bridges that run legacy MRAID and SafeFrame creatives, held to a corpus-validated bar with a stated sunset posture.

The conformance classes and the claims built on them are defined in §1.3.

**Secure by default.** The container is in control. The creative asks for actions, and the container resolves or rejects each request. A creative never reaches the publisher's origin (§1.11.1), and a creative cannot impose an experience the container has not allowed.

**Audience.** Container operators and runtime implementers (L1); authors of creative-side libraries, compatibility bridges, and creatives that speak the protocol directly (L2); bridge implementers (Compat Profile); measurement vendors, who integrate through the OMID surface the container provisions (§1.14); and auditors, who verify the trust model at the wire and behavior level (§1.11).

**Guiding principles.** Performance. Interoperability with existing industry standards. Protection for the consumer, and safety and security for the publisher. A low barrier to entry, through simplicity and ubiquity. Minimal disruption to the parties already in the supply chain. A specification precise enough to implement without guesswork. Extensibility, so that new capability can be tried before it is standardized. Graceful degradation when a capability is absent.

**In scope.** Rich-media interaction for display placements: creative loading, the creative's lifecycle, placement changes, navigation, the creative ↔ container wire protocol, and the provisioning of OMID measurement to the creative. Platform scope for this version is web iframes, iOS WKWebView and Android WebView (L2 §2.2; §1.17 for in-app embedding).

**Out of scope.**

- Ad request, auction and delivery. SHARC begins once a creative has been matched to a placement. Placement, creative and context data arrive through a dataspec, AdCOM by default; SHARC itself supplies only the runtime data that changes during the session, such as state, size and volume (L2 §2.7).
- Measurement methodology, ad tracking and reporting. SHARC provisions the measurement surface (§1.14) and relays interaction trackers (L2 §2.6), but does not define what is measured or reported.
- Video playback controls and video tracking. A creative may contain video, but interactive video ads are SIMID's domain.
- Page-level orchestration across several containers, such as a shared OM SDK instance, a page resource budget or lazy-load priority. That is a separate layer above the runtime and stays outside this specification. The container's only duty is to stay orchestratable: addressable instances, observable state, and accepted policy.

> Editorial note (supersession): this section paraphrases and supersedes the SHARC-legacy WG Technical Spec's Introduction, Guiding principles, Scope, Out of Scope and Goals. Two deltas are recorded in §1.4: measurement provisioning has moved into scope as an L1 capability, and page-level orchestration is now named as out of scope.

<!-- trace: source=Legacy Technical Spec §Introduction/§Guiding principles/§Scope/§Out of Scope/§Goals (harvested and paraphrased; nothing quoted) + runtime-layering reframe (2026-06-10 ADR, Obsidian: three layers, plain HTML as permanent baseline, OMID as an L1 capability, page orchestration above the runtime) + DoD G6 (in-app platform scope) | gate=NO-GATE (definitional) -->

### 1.2 Terminology

Requirement keywords are defined in the Conventions block at the top of this document.

| Term | Definition |
|---|---|
| **Device** | The hardware the ad is shown on, such as a phone, tablet or computer. |
| **Platform** | The software environment of the device: its operating system or window manager (for example iOS, Android, macOS). |
| **Host** | The page or app view that carries the main content: the publisher's page on the web, or the app's own view in-app. |
| **Publisher content** | The document or app content in which the ad slot sits. |
| **Viewport** | What the user can currently see of the publisher content. It is often smaller than the rendered page, which the user scrolls to reach. |
| **Container** | The iframe or WebView that implements SHARC and renders the creative's HTML; in the reference implementation, an instance of `SHARCContainer`. |
| **Container viewport** | The region of the creative's document that the container shows. |
| **Displayed** | Present in a container, within the container viewport. Displayed content is not necessarily visible: visibility is the effective-visibility measure (§1.9). |
| **Navigation event** | A creative-initiated request to navigate to a URL, which opens a new page or app and leaves the ad's content (L2 §2.6 `requestNavigation`; §1.10). |
| **Interaction event** | A user action that the creative handles itself, without leaving the ad. |
| **Container operator** (also **operator**) | The entity that constructs the container on the page. It is not necessarily the publisher: ad servers, header-bidding wrappers, SSP-managed wrappers and publisher ad-ops teams are all operators. |
| **Container origin** | `window.location.origin` of the page on which the container is constructed. It differs from the publisher origin when SHARC runs inside a wrapper iframe that is cross-origin to the publisher top frame (§1.11.5). |
| **Embedder** | The frame that embeds the container's iframe: the publisher top frame, or a wrapper iframe one or more levels deep. |
| **Creative URL** | The load variant in which the creative is fetched by URL (`creativeUrl`); the iframe `src` is that URL (§1.6). |
| **Creative Markup** | The load variant in which the operator supplies HTML markup (`creativeHtml`) and an operator-hosted renderer URL (`creativeRendererUrl`). The container loads the renderer page and posts the markup to it over the renderer protocol (§1.6, §1.7). |
| **Renderer page** | The operator-hosted HTTPS page at `creativeRendererUrl`. It receives `creativeHtml` and writes it into its own document. |
| **Renderer iframe** | The iframe element in the container's DOM that loads the renderer page. |
| **Renderer protocol** | The `SHARC:Renderer:render` / `:rendered` / `:failed` exchange between the container and the renderer page (§1.7). |
| **`rendererProtocolVersion`** | The renderer protocol's version. It is independent of the SHARC package version and of the spec version: it changes only when the renderer protocol breaks. |
| **`placementSessionId`** | The container's per-impression identifier, a UUID (§1.7.1, §1.11.3). |
| **Session** | An established L2 protocol session between one container and one creative, identified by the creative-minted `sessionId` (L2 §2.4, §2.8.1). |
| **Creative-queryable state** | A lifecycle state a creative may observe: `ready`, `active`, `passive`, `hidden`, `frozen` (§1.8.1; L2 §2.8.1). |
| **Compatibility bridge** (also **bridge**) | A Compat Profile module that presents a legacy creative API (MRAID or SafeFrame) on top of the SHARC runtime. Identifiers are in [registries.md](registries.md) R6. |
| **Native Host Interface** | The L1 surface through which a native app integrates with the container: host-fulfilled actions and host-provided inputs (§1.16). |
| **Conformance class**, **SHARC Core**, **Compat Profile** | Defined in §1.3. |

**Legacy state names.** The SHARC-legacy WG drafts used lifecycle names that this specification replaces. Read a legacy term through its replacement:

| Legacy term | Canonical term | Notes |
|---|---|---|
| `inactive` | `passive` | Visible, without input focus. In plain English, "inactive" suggests "not running". |
| `created` | `loading` or `ready` | `loading` is container bootstrap before the creative's handshake; `ready` is after init, before `startCreative`. |
| `destroyed`, `unloaded` | `terminated` | The terminal state, aligned with the Page Lifecycle API. |
| `closing` | none (internal) | The close sequence is `Container:close` plus the creative's `resolve` (L2 §2.5). There is no creative-visible closing state. |

> Editorial note (sources): the first ten terms paraphrase the SHARC-legacy WG Technical Spec's Terminology section; nothing is quoted. Its unfinished entry contrasting rendering with rendering on screen is not carried. The operator, origin, variant and renderer terms are moved from `docs/proposals/creative-sources.md` §Glossary. The legacy state mapping follows the mapping table kept with the legacy draft, plus `unloaded`, which the draft's `currentState` list also used.

<!-- trace: source=Legacy Technical Spec §Terminology (paraphrased) + legacy→canonical state-name mapping (kept with the legacy draft; paraphrased) + creative-sources.md §Glossary (moved) | gate=NO-GATE (definitional) -->

### 1.3 Conformance clause

This clause defines what an implementation can claim, against which documents, and how a claim relates to the reference implementation and its tests. Requirement keywords are defined in the Conventions block. Sentences marked **[Pn]** go beyond the bullets ratified in the traceability skeleton (§F) and are pending ratification; the note at the end of this section lists them.

#### 1.3.1 Conformance classes

| Class | Specified in | Kind |
|---|---|---|
| **Container Runtime** | L1, this document | Mandatory |
| **Creative (wire)** | L2, [Creative API](creative-api.md) | Optional class |
| **Compat Profile** | Compat Profile Specification | Optional add-on profile |

The reference creative SDK (`sharc-creative.js`) is not a conformance class. It is one implementation of the Creative (wire) class (L2 §2.1).

#### 1.3.2 Conformance claims

- **SHARC Core conforming** means satisfying L1 and L2.
- Compat Profile conformance is claimed separately, as **SHARC Core + Compat Profile**.
- **[P1]** For a container implementation, SHARC Core covers L1 together with the L2 requirements addressed to the container. Creative (wire) is optional for creatives: a creative that does not speak the protocol, plain HTML, is still loadable by a SHARC Core container (L2 §2.1). A creative-side library or creative claims the Creative (wire) class by satisfying the L2 requirements addressed to the creative side.

**Profile-governance rule** (normative and permanent; RATIFIED 2026-07-08): *no optional class or add-on profile may ever be required to claim SHARC Core conformance.* The rule guards against an optional surface becoming mandatory in practice, which is the failure mode of MRAID's `supports()`. A future feature that wants a requirement in Core has to clear the complexity-budget bar. Otherwise it ships as a named, versioned, optional profile.

#### 1.3.3 Acceptance suites

The named acceptance suites are:

- **The reference-implementation gate:** `npm run test:all`, and `npm run check:ci`.
- **The creative-validator staged gate ladders:** the MRAID markup lifecycle gates (#419; `test:creative-validator-mraid-lifecycle-gates`), and the Creative URL gates U1–U3 with the ratified bucket vocabulary (`test:creative-validator-url-lifecycle-gates`; `test:g5-url-contracts`). The bucket vocabulary and its attribution polarity are [registries.md](registries.md) R9.
- **Corpus practice,** under the 1.0 Definition-of-Done G2 posture: ongoing vigilance rather than a one-time pass. New corpus pulls are run and triaged by the attribution partition; the refresh cadence is opportunistic and is not itself gated.

#### 1.3.4 Authority order

**Normative prose > reference implementation > test suite.** When two of them disagree, the divergence is a bug in the lower authority. **[P2]** A divergence is filed as an issue against the specification repository, and the clause is flagged in-section as `DIVERGENCE`, with the issue number, under the standing rule stated in the L2 front matter.

#### 1.3.5 Class determination

Every requirement carries its class in its own section. [traceability.md](traceability.md) is the index: it lists every RFC-2119 line of the normative documents with its class, gate and status. **[P3]** A requirement's class is the class of the document it appears in, unless its section states otherwise.

#### 1.3.6 Markings and conformance claims

- **[P4]** `GATE-DESIRED` marks a requirement that binds, but that no test in the named acceptance suites pins. The requirement is in force. Passing the acceptance suites is not evidence of conformance to it.
- **[P5]** `DIVERGENCE (implementation bug)` marks a clause the reference implementation violates. Under the authority order, the normative text stands, and the reference implementation does not conform to that clause until the cited issue is fixed.
- `DIVERGENCE (ruling required)` marks a clause the specification has not yet settled. A suspected divergence whose red test is still pending is not yet a `DIVERGENCE`. How these two markings bear on a conformance claim is open (see the note below).

> Editorial note (pending ratification): §F of the traceability skeleton ratified the conformance classes, the SHARC Core and Compat Profile claims, the acceptance suites, the authority order, the class-determination rule, and the profile-governance rule. Sentences beyond those bullets are marked: **[P1]** the container-side / creative-side reading of "L1 + L2"; **[P2]** the filing path; **[P3]** the document-default class; **[P4]** the effect of `GATE-DESIRED` on a claim; **[P5]** the effect of `DIVERGENCE (implementation bug)` on the reference implementation's conformance. Left open, and not decided here: how `DIVERGENCE (ruling required)` and suspected divergences bear on a claim; whether a claim names the spec version it is made against; and how an implementation other than the reference uses the acceptance suites, since `npm run test:all` exercises the reference implementation and the corpus is private.
>
> Editorial note (keyword case): the profile-governance rule keeps its ratified lower-case wording ("may ever be required"). The Conventions block makes lower-case keywords non-normative, so this clause labels the rule normative explicitly. Restating it with an RFC-2119 keyword is a ratification question.

<!-- trace: source=NEW-PROSE per skeleton §F (NEW-PROSE inventory item 1), including the profile-governance rule RATIFIED 2026-07-08 + L2 §2.1 (Creative (wire) optional; reference SDK not a class) + 1.0 Definition of Done §G2 (corpus vigilance posture) + standing divergence rule (L2 front matter) | gate=test:spec-structure (phase b: every RFC-2119 line of a NORMATIVE document indexed in traceability.md); G4 succession check (pending) -->

### 1.4 Supersession of the SHARC-legacy WG drafts

The SHARC Specification 1.0 documents (L1, L2 and the Compat Profile) formally supersede the SHARC-legacy working-group drafts: the SHARC Technical Spec, the SHARC Functions worksheet, and the SHARC Support Beyond the Container notes. The drafts are not reproduced here and remain outside this repository. Their content survives only where these documents restate it, and a restated rule is cited from these documents, not from the drafts.

**Delta register.** One row per change of substance. L2 already records some of its own deltas inline, and those rows point there rather than repeating them.

| Legacy source | What changed | Recorded in |
|---|---|---|
| Technical Spec: Introduction, Scope, Out of Scope, Goals | Harvested and paraphrased. Measurement *provisioning* (OMID) moves into scope as an L1 capability; the draft listed measurement as out of scope. Page-level orchestration is named as out of scope. | §1.1 |
| Technical Spec: Terminology | Paraphrased and extended with the creative-sources glossary. | §1.2 |
| Lifecycle state names | Renamed: `inactive` → `passive`; `created` → `loading` / `ready`; `destroyed` and `unloaded` → `terminated`; `closing` dropped as a creative-visible state. The draft's `currentState` list included `closing` and `unloaded`; the init seed now carries only creative-queryable states. | §1.2; L2 §2.7, §2.8.1 |
| Messaging Protocol: transport and session | JSON strings over `window.postMessage` are replaced by a `MessageChannel` port with structured clone. Several concurrent sessions per container are replaced by one session per container instance. | L2 §2.2 (editorial note) |
| Messaging Protocol: data structure | Carried. The `messageId` increment rule is restated from the reference implementation. | L2 §2.3 |
| Establishing a New Session | Recovery after a missed `createSession` window is no longer the default. The strict default terminates with `2212`, and recovery survives only as the operator-selected permissive mode. The VAST error-tracker prose and the SSAI/live zero-timeout prose are dropped: video is out of scope. | L2 §2.4 (editorial note) |
| `Container:init` `version` | The draft defined it as the version of the SHARC implementation. It now reports the spec version. | Versioning policy (DIVERGENCE, ruling required) |
| `Feature` object | `{ name, version, functions }` is replaced by a feature-name string or a descriptor object `{ name, version?, … }`. | L2 §2.10 (editorial note) |
| AdCOM-facing `Placement` object | Renamed `ContainerPlacement`, so that it is not confused with the AdCOM `Placement` object. This follows the draft's own supply-chain notes. | L2 §2.7 |
| Messages from the container and from the creative | The message dictionary is re-specified, and the response-required column is corrected against the reference protocol. Messages added since the draft: `placementConstraintsChange`, `placementTransitionEnd`, `effectiveVisibilityChange`, `audioVolumeChange`, `omidShimInit`, `getPlacementConstraints` and `setOrientationProperties`. | L2 §2.5, §2.6, Appendix A |
| Error Codes | No code is renumbered. Deltas: `2105` ("Resize request not honored") is reserved and never reused, and the navigation handoff is the new `2214` (Ruling 1). `2204` changes meaning, from the creative executing unsupported actions to a known feature whose execution failed. `2203` is broadened to a feature or intent that is unsupported or disallowed by policy. `2114`–`2122` (renderer protocol and diagnostics) are added. `2106`, `2107`, `2202`, `2206` and `2207` stay unassigned, as they were in the draft. | [registries.md](registries.md) R1, R2; L2 §2.13 |
| Compatibility Modes | The draft's position is carried forward: SHARC itself implements neither MRAID nor SafeFrame. Adoption runs through bridges, now specified as the optional Compat Profile. | Compat Profile (slice 3b, skeleton row 3.9) |
| Functions worksheet | A working table of container and creative functions. Superseded in full by the L2 message dictionary. | L2 §2.5, §2.6 |
| Support Beyond the Container | Supply-chain workstream notes (AdCOM, OpenRTB, header bidding, Open Measurement). Not specification text. The AdCOM registration work continues as the `APIFramework` mapping and the pending upstream registration. | [registries.md](registries.md) R7 |

> Residual (ruling required): L1 §1.19 still says that SSAI/live environments may set the `createSession` timeout to 0. That sentence comes from the estate (api-reference.md §Appendix: Timeout Summary), not from the legacy draft, but it carries the SSAI zero-timeout idea that L2 §2.4 drops. Whether to drop it as well, and how a zero timeout interacts with the armed `2212` requirement, is not decided here.
>
> Residual (ruling required): the `2204` change of meaning has no ratification record. It parallels the `2105` reuse that Ruling 1 reversed. The reference `ErrorCodes` registry does not define `2204`.

<!-- trace: source=NEW-PROSE per skeleton row 1.4 (NEW-PROSE inventory item 3), from a comparison of the SHARC-legacy WG drafts (private; nothing quoted) with L1, L2, api-reference.md §11 and src/sharc-protocol.js ErrorCodes; L2's inline supersession notes (§2.2, §2.4, §2.10, §2.13) are cross-referenced, not repeated | gate=NO-GATE -->

### 1.5 Container model: slot, construction, DOM stamping, isolation guard

> RESERVED — extraction slice N (source: api-reference.md §1 (Constructor Options, Instance Properties, DOM Stamping, Isolation Guard) + README §Container Constructor Options)

### 1.6 Creative sources

> RESERVED — extraction slice N (source: creative-sources.md §Renderer Ownership Model/§Constructor Changes/§Load Path Matrix/§Injection Across Variants + G5 close record §The ratified contract)

### 1.7 Renderer protocol

The Renderer Protocol is a `window.postMessage` exchange between the container (publisher page) and an operator-hosted renderer iframe, used on the Creative Markup variant to deliver `creativeHtml` to a cross-origin renderer that writes the markup into its own document via `document.open() / document.write() / document.close()`. Once the renderer reports `:rendered`, the standard SHARC `MessageChannel` handshake (L2 [§2.4](creative-api.md)) takes over inside the renderer's `contentWindow`.

#### 1.7.1 Message envelope

Three protocol message types flow over `window.postMessage` between the renderer iframe and `window.parent`:

| Message | Direction | When |
|---|---|---|
| `SHARC:Renderer:render` | Container → Renderer | Once, after iframe `load` event |
| `SHARC:Renderer:rendered` | Renderer → Container | Once, after `DOMContentLoaded` on the inner document |
| `SHARC:Renderer:failed` | Renderer → Container | On any renderer-side validation or render failure |

**`SHARC:Renderer:render` (container → renderer):**

```typescript
{
  type: 'SHARC:Renderer:render',
  bridges: string[],              // compat bridges the renderer should load (0.7.1+)
  creativeHtml: string,           // Markup to write into the renderer document
  placementSessionId: string,     // Container's placementSessionId (UUID)
  sharcNonce: string,             // CSPRNG UUID — must match URL fragment
  sharcVersion: string,           // SHARC SDK version
  rendererProtocolVersion: '1',   // Bumps when the protocol breaks
  containerOrigin: string,        // Publisher-page origin (window.location.origin)
}
```

Posted with `targetOrigin = <construction-time creativeRendererUrl origin>` — never `'*'`.

> GATE-DESIRED: the never-`'*'` targetOrigin rule on `:render` is corpus-unpinned — asserted by code reading, not by a test.

The `bridges` field is a sorted, deduplicated array of compatibility-bridge identifiers the renderer should dynamically load before writing `creativeHtml`. An empty array means "load no bridges." The renderer filters the inbound list against its own allowlist; unknown identifiers are logged and skipped, NOT loaded. A container omitting the field is treated identically to `bridges: []` (forward/backward compatible). Bridge selection and the identifier registry are Compat Profile material (see the Compat Profile Specification).

**`SHARC:Renderer:rendered` (renderer → container):**

```typescript
{
  type: 'SHARC:Renderer:rendered',
  placementSessionId: string,    // Echo of the container's placementSessionId
  rendererOrigin: string,        // window.location.origin AT THE TIME
                                 // OF REPLY — post-redirect canonical
}
```

The renderer-supplied `rendererOrigin` is the trust anchor for redirect detection (§1.7.2).

**`SHARC:Renderer:failed` (renderer → container):**

```typescript
{
  type: 'SHARC:Renderer:failed',
  placementSessionId: string,
  reason: string,                 // Human-readable failure reason
}
```

Reserved `reason` strings the reference renderer emits:

| `reason` | When |
|---|---|
| `service_worker_detected` | A Service Worker is registered or controlling the renderer origin |
| `container_origin_mismatch` | `event.origin` doesn't equal `event.data.containerOrigin` |
| `nonce_mismatch` | `event.data.sharcNonce` doesn't equal the URL-fragment nonce |
| `unsupported_renderer_protocol_version` | Container's `rendererProtocolVersion` is not supported by this renderer |
| `missing_placement_session_id` | `event.data.placementSessionId` is missing or non-string |
| `missing_creative_html` | `event.data.creativeHtml` is missing or non-string |
| `invalid_bridges_field` | `event.data.bridges` is present but not an array of strings |
| `bridge_load_failed` | Dynamic import of a compatibility bridge module rejected. Payload includes a `bridge` field with the failed identifier |
| `omid_shim_inject_failed` | Outer (pre-`document.write`): the renderer could not build the OMID shim prelude. Fatal: the render is aborted before any creative markup is written |
| `omid_shim_install_failed` | Inner (during `document.write`): the prelude ran but `installOmidShim()` threw (a half-install), surfaced from the prelude's catch |
| `document_write_failed: <message>` | `document.write` threw |

Operator forks may extend the vocabulary; the container surfaces the renderer-supplied `reason` raw on the structured event channel and sanitized in dev-channel logs.

#### 1.7.2 Container-side validation rules

Two distinct validation passes — envelope and payload-shape — with different failure semantics.

**Envelope checks (silent ignore on mismatch).** The container MUST ignore — and MUST NOT terminate on — `:rendered` and `:failed` messages that fail any of these checks. Any frame on the page can `postMessage`; mismatches are noise, not protocol errors:

- `event.source === iframe.contentWindow`
- `event.origin === <construction-time rendererOrigin>`
- `event.data` is a non-null object
- `event.data.type` is a string
- `event.data.placementSessionId` equals the container's `placementSessionId`

**Payload-shape checks (terminate with `RENDERER_PROTOCOL_ERROR` 2117).** Once envelope checks pass, the container validates payload shape. Failure terminates the container. For `:rendered`: `data.rendererOrigin` is a non-empty string. For `:failed`: `data.reason` is a non-empty string.

**Origin echo (terminate with `RENDERER_ORIGIN_MISMATCH` 2116).** After payload shape passes, the container compares `data.rendererOrigin` against its construction-time renderer origin (parsed from `creativeRendererUrl`). On mismatch the container MUST terminate with `RENDERER_ORIGIN_MISMATCH (2116)` — a mismatch indicates a redirect collapsed the cross-origin sandbox guarantee.

The order is shape → echo. A malformed payload that ALSO fails the echo comparison surfaces as `RENDERER_PROTOCOL_ERROR (2117)`, not `2116` — protocol-shape is the more accurate diagnosis for the operator.

#### 1.7.3 `close()` mid-render contract

If the container is closed between iframe `load` and receipt of `:rendered`/`:failed`:

- The rendered/failed reply timeout is cancelled
- The renderer message listener is detached
- The iframe is removed from the DOM (terminating renderer script execution)
- The placement element is restored to its pre-load state
- Late `:rendered` / `:failed` messages arriving after close are silently ignored (listener has been removed)

#### 1.7.4 Post-render probe-cycle ceiling

Post-render renderer-frame loads are re-authenticated via a probe/acknowledge round-trip over the held channel. Answered probe cycles are rate-bounded: exceeding the ceiling emits the non-terminating `renderer_navigation_blocked` diagnostic (`navKind: 'answered_probe_cycle_ceiling'`) while the ad is kept alive. The security-event registry that carries this diagnostic is §1.13 material.

> RESERVED (within this section) — renderer implementation contract and container-side message-validation prose held in creative-sources.md §Renderer implementation contract/§Container-side message validation joins in a later extraction slice. The load-event navigation backstop is §1.10 material; the `onSecurityEvent` registry is §1.13 material.

<!-- trace: source=api-reference.md §10 (Message envelope, validation rules, close() mid-render, probe-cycle ceiling) + creative-sources.md §Renderer implementation contract (RESERVED) | gate=test:renderer-protocol-retrofit; test:renderer-out-of-phase; test:renderer-load-reentry; test:renderer-probe-cycle-ceiling; test:renderer-prelude-nonce-self-remove; test:renderer-prelude-script-escaping; test:renderer-fallback; test:creative-sources-load (silent-ignore matrix §7b–7d2 + origin-echo/2116/2117 precedence pins; renderer-protocol-retrofit defers those to it) -->

### 1.8 Container state machine and unified lifecycle ordering

#### 1.8.1 States

SHARC states are aligned with the **Chrome/WebKit Page Lifecycle API**. Creative developers already understand this model from web development.

| State | Creative-Queryable | Visible | JS Active | Focus/Input |
|-------|-------------------|---------|-----------|-------------|
| `loading` | ❌ Internal | ❌ | Partial | ❌ |
| `ready` | ✅ | ❌ | ✅ | ❌ |
| `active` | ✅ | ✅ | ✅ | ✅ |
| `passive` | ✅ | ✅ | ✅ | ❌ |
| `hidden` | ✅ | ❌ | ✅ | ❌ |
| `frozen` | ✅ | ❌ | ❌ | ❌ |
| `terminated` | ❌ Internal | ❌ | ❌ | ❌ |

`loading` and `terminated` are container-internal bookends. The creative never receives a `stateChange` message with these values — by definition, the creative cannot receive messages before init or after termination.

**`loading`** (internal)
> The container has created the WebView and is loading the creative. The SHARC handshake has not started. The creative may post `createSession` during this phase, which transitions the container to the init sequence.

**`ready`**
> `Container:init` has been resolved by the creative. The container is about to send `Container:startCreative`. The creative is initialized but not yet visible.

**`active`**
> The container is visible and the app/tab is in the foreground with user focus. The creative should be running normally. Maps to: Page Lifecycle `active`, iOS `UIApplicationState.active`, Android `Activity.onResume()`.

**`passive`**
> The container is visible but the app has lost input focus. Common causes: split-screen multitasking, phone call interruption (iOS), a dialog overlay. The creative is still rendering but user interaction may be limited. Maps to: Page Lifecycle `passive`, iOS `applicationWillResignActive`, Android `Activity.onPause()` in multi-window.

**`hidden`**
> The container is not visible. The app is in the background, the tab is hidden, or the screen is off. JavaScript continues to run but creatives should release non-essential resources and pause animations. Maps to: Page Lifecycle `hidden`, iOS `applicationDidEnterBackground`, Android `Activity.onStop()`.

**`frozen`**
> The OS has suspended JavaScript execution. This happens when the OS needs to reclaim CPU or memory. The creative should have saved state when entering `hidden`. From the creative's perspective, `frozen` and OS process termination look identical (JS stops). Maps to: Page Lifecycle `frozen`, iOS WebContent process suspended, Android `WebView.pauseTimers()`.

**`terminated`** (internal)
> The container has terminated and the WebView has been removed. No further communication is possible.

#### 1.8.2 Valid transitions

A conforming container MUST NOT perform a state transition not enumerated in this table. Any state may additionally transition to `terminated` (close, fatal error, or OS kill); `terminated` is terminal.

| From | To | Trigger |
|------|----|---------|
| `loading` | `ready` | `createSession` received → init resolved |
| `loading` | `active` | Non-handshake (HTML lifecycle adapter) route: creative loads without a SHARC handshake; no synthetic `ready` is emitted |
| `loading` | `passive` \| `hidden` | In-app pre-clamped host-lifecycle ceiling: the container comes up under a latched host-lifecycle assertion and lands directly at the clamped destination (unreachable in stock web embeds) |
| `loading` | `terminated` | createSession timeout (default 5s); fatal error |
| `ready` | `active` | `startCreative` resolved |
| `ready` | `passive` \| `hidden` \| `frozen` | In-app pre-clamped host-lifecycle ceiling (as above): the `active` the creative never experienced is not emitted |
| `ready` | `terminated` | startCreative rejected; timeout (default 2s) |
| `active` | `passive` | App/tab loses focus |
| `active` | `hidden` | App backgrounded / tab hidden directly (no prior blur on some platforms) |
| `active` | `frozen` | Direct freeze of a visible creative (bfcache entry / OS suspension); no phantom `hidden` is emitted |
| `active` | `terminated` | Close or fatal error |
| `passive` | `active` | App/tab regains focus |
| `passive` | `hidden` | App goes to background |
| `passive` | `frozen` | Direct freeze of a visible creative (as above) |
| `passive` | `terminated` | Close or fatal error |
| `hidden` | `passive` | App returns to foreground (no focus yet) |
| `hidden` | `frozen` | OS suspends JS |
| `hidden` | `terminated` | Close or OS kills process |
| `frozen` | `active` | OS resumes → focus |
| `frozen` | `passive` | OS resumes → visible, no focus |
| `frozen` | `hidden` | OS resumes → still hidden |
| `frozen` | `terminated` | OS kills process (no event to creative) |

> Editorial note (extraction fidelity): the source table in api-reference.md §5 predates the direct visible-freeze edges (`active`/`passive` → `frozen`), the non-handshake `loading` → `active` route, and the in-app pre-clamped edges. This table is corrected against the reference implementation's `STATE_TRANSITIONS` registry (src/sharc-protocol.js), whose behavior the named gates pin.

#### 1.8.3 Unified lifecycle ordering (load-anchored cascade)

> RESERVED — extraction slice N (source: unified lifecycle ordering ADR (2026-06-13, Obsidian) — NEW-PROSE-from-ADR where no repo sentence exists). The creative-facing **delivery** ordering invariants from state-delivery-contract.md §5 (INV-7…INV-11) moved with the rest of that contract to L2 [§2.8.4](creative-api.md) in slice 3; this section carries the container-side load-anchored cascade timeline.

<!-- trace: source=api-reference.md §5 (corrected against src/sharc-protocol.js STATE_TRANSITIONS) | gate=test:lifecycle-ordering-conformance; test:lifecycle-conjunction-gate; test:lifecycle-load-anchor; test:active-frozen-edge; test:restore-single-authority; test:restore-level-reassert; test:restore-transient-hidden; test:non-sharc-loading (loading→active); test:g6-red (in-app pre-clamped edges, G6, pending gate promotion) -->

### 1.9 Effective-visibility model

> RESERVED — extraction slice N (source: api-reference.md §7 `effectiveVisibilityChange` + README §OMID "one viewability number" + Slice C composer ADR (2026-06-20, Obsidian)). The wire-message dictionary entry for `effectiveVisibilityChange` is in L2 [§2.5](creative-api.md).

### 1.10 Navigation policy

> RESERVED — extraction slice N (source: api-reference.md §10 (Load-event navigation backstop) + creative-sources.md §Security Model (click-through audit; sandbox top-frame navigation) + design/0.7.10-post-render-nav-policy-omid-phase.md (harvest ratified rules only))

### 1.11 Consolidated security model

This section is the normative home for the SHARC container's trust model. It is auditable at the wire/behavior level: an implementer can verify every claim here by observing sandbox attributes, iframe origins, `postMessage` envelopes, HTTP response headers, and structured security events — without reading the reference implementation's JavaScript. Protocol-layer enforcement bounds (rate limits, pending-response cap, URL-scheme validation, and the variant-specific sandbox-token composition) are stated once in §1.11.9 and referenced, not restated, elsewhere in this section.

#### 1.11.1 Trust boundary: the creative cannot reach the publisher origin

The core SHARC security guarantee — **the creative cannot reach the publisher's origin** — holds across both creative-source variants:

- **Creative URL** withholds `allow-same-origin` (SEC-001, see §1.11.9): the creative's own origin is the trust boundary, and a document delivered without `allow-same-origin` can never script its way out of the sandbox. This no-`allow-same-origin` invariant is the load-bearing rule for the URL path.
- **Creative Markup** grants `allow-same-origin` to the renderer iframe. This is safe because the renderer is served from an origin **cross-origin to the publisher**, and only when **all** of the following hold:
  - Construction-time guards prove the iframe will be configured with a cross-origin HTTPS URL with no userinfo (validation rules 4–7).
  - Post-load origin echo proves the iframe actually loaded at the expected origin (defeats 30x redirect attacks) — see §1.7.2, which terminates with `RENDERER_ORIGIN_MISMATCH` (2116).
  - Renderer-side message validation rejects forged render requests from neighbor frames (URL-fragment nonce + parent-origin check).
  - Iframe-level CSP closes plugin-content and `<base href>` injection vectors (§1.11.5).

This is a **stricter** trust model than today's MRAID/SafeFrame deployment, where the SDK runtime runs in the publisher's own page context. A compromised SHARC renderer affects only the renderer's origin; the publisher stays isolated. A compromised MRAID SDK or SafeFrame host runtime exposes the publisher's origin directly.

| Concern | Creative URL | Creative Markup |
|---------|--------------|-----------------|
| Creative origin isolation | Cross-origin `src` | Renderer origin (cross-origin to publisher) |
| `allow-same-origin` | Absent | Present (safe — renderer is cross-origin, redirect-validated) |
| Creative can access publisher DOM | No | No |
| Creative can access renderer's storage | N/A | Yes — this is the point |
| Publisher can read creative content | No | No |
| `creativeRendererUrl` must be HTTPS | N/A | Enforced at construction |
| `creativeRendererUrl` must be cross-origin | N/A | Enforced at construction (vs. `window.location` and `window.top.location`) |
| Plugin content (`<object>`, `<embed>`) | N/A | Blocked by iframe `csp` (`object-src 'none'`) |
| `<base href>` injection | N/A | Blocked by iframe `csp` (`base-uri 'none'`) |
| Form-based exfiltration | Not blocked by default | Not blocked by default; opt-in `form-action` available |
| Referrer leak to renderer network | N/A | Blocked (`referrerpolicy="no-referrer"`) |
| 30x redirect to same-origin | N/A | Detected and terminated (post-load origin echo) |
| Neighbor-frame forgery | N/A | Defeated (URL-fragment nonce + parent-origin check) |

> Pinned (correcting the earlier GATE-DESIRED flag): the sandbox-token composition that underpins this guarantee is pinned by `test:creative-sources-load` §1/§2 (Markup renderer tokens, including that the unsafe `allow-top-navigation` is absent at default options) and §10 (the Creative URL sandbox omits `allow-same-origin`, SEC-001). See §1.11.9.

#### 1.11.2 Threat model

**Malicious renderer.** The renderer is operator-controlled and part of the same supply chain as the container. If the renderer origin is compromised, the creative runs in that compromised origin — equivalent to the operator's own supply-chain risk, not a new SHARC-introduced attack surface, and strictly less severe than the equivalent MRAID/SafeFrame failure mode (where a compromised SDK host runtime exposes the publisher's origin directly). The protocol's job is isolation between *creative and publisher*, not between operator and operator's own renderer. Container operators that fork the reference renderer accept responsibility for its security posture.

**Untrusted creative markup.** Operators stitching markup from many DSPs cannot reliably verify bid sources beyond TLS and contract. Creative Markup gives the markup a real origin (the renderer's), which may increase capability versus a null-origin `srcdoc` (e.g. `localStorage` access). The iframe-level CSP baseline (`object-src 'none'; base-uri 'none'`) provides defense-in-depth against the highest-impact injection patterns even when the markup is hostile.

**Cross-impression amplification via shared renderer storage.** Creative Markup gives creatives served by the same renderer access to shared origin storage — `localStorage`, `sessionStorage`, IndexedDB, Cache API, and non-HttpOnly cookies. An attacker briefly controlling a creative could plant persistent payloads visible to future creatives via the same renderer. The renderer implementation contract requires one of three isolation strategies: **(A)** `Clear-Site-Data` HTTP header (recommended baseline — server-side `Clear-Site-Data: "storage"` covers all storage types, including HttpOnly cookies JS cannot reach); **(B)** JS-side clearing (leaves HttpOnly-cookie and `BroadcastChannel` residue); **(C)** ephemeral/per-tenant origins (strongest — per-origin browser separation is structural, and the only strategy that fully isolates `BroadcastChannel`). `BroadcastChannel` is origin-scoped and is not cleared by Strategy A or B; operators with strict cross-advertiser isolation requirements adopt Strategy C or document the gap to measurement and brand-safety stakeholders. Measurement vendors that still rely on iframe storage should migrate to first-party (server-side, impression-keyed) verification, which is unaffected by per-render clearing.

> GATE-DESIRED: the renderer storage-isolation strategies (A/B/C) and the `BroadcastChannel` residue are renderer-operator deployment obligations — not pinnable by the reference-implementation suite. Documented for auditability; enforced by the renderer implementation contract, not by SHARC container code.

#### 1.11.3 Cross-frame protocol trust: per-protocol nonce derivation

SHARC multiplexes several cross-frame protocols (`SHARC:Renderer:*`, `SHARC:Omid:*`, future extensions) over one `window.message` chokepoint. Each registered protocol prefix gets its **own** nonce, derived so that leaking one protocol's nonce cannot forge another's.

The router MUST derive a per-protocol nonce as an HMAC over the root nonce, keyed to the per-impression session:

```
rawNonce      = HMAC-SHA-256(key = rootNonce, message = prefix || ":" || placementSessionId)   // 32 bytes
protocolNonce = base64url( rawNonce.slice(0, 16) )                                              // 16 bytes = 128-bit entropy, 22 chars
```

- The truncation MUST be applied to the **raw 32-byte HMAC output before base64url encoding**, preserving 128 bits of entropy. Encoding first and slicing the string would silently drop entropy to 96 bits.
- The derivation MUST be salted with `placementSessionId` (the per-impression identifier), so a new creative load mints new per-protocol nonces by construction and a nonce is bound to the session it claims to serve. `placementSessionId` appears on the wire; its role in the salt is session-binding, not secrecy — non-invertibility comes from `rootNonce` (the HMAC key), which never appears on the wire.
- The derived per-protocol nonce MUST NOT be exposed on any **creative-reachable** surface: it MUST NOT appear in any observer callback, resolve value, or event `data` payload, nor in any query string, DOM attribute, or markup readable by creative code. The single carve-out is the renderer-bootstrap URL fragment — the renderer-protocol nonce is written to the renderer iframe `src` as `#sharcNonce=<nonce>` solely so the renderer prelude can read it from `location.hash` and echo it back. That fragment is not creative-reachable: the prelude strips the nonce from `location.hash` and self-removes its own `<script>` before any creative markup is parsed (§1.7; #254), which is the invariant MUST-5 relies on. The nonce is otherwise delivered only to the registering publisher-page extension (via `onReady({protocolNonce})`).
- The renderer-protocol nonce MUST NOT be delivered to any iframe-side code. It is used only to build the renderer-URL fragment and to validate inbound `SHARC:Renderer:*` envelopes on the publisher page.

**The corrected trust basis: nonce isolation, not port secrecy.** SHARC uses a transferred `MessageChannel` `port` for the steady-state creative channel and, in-app, for OMID nonce delivery. A transferred port's *channel* is point-to-point once wired, but the port-*transfer message* is an ordinary `window` message: it reaches **every** `window.addEventListener('message')` listener in the receiving iframe, with the port readable as `event.ports[0]`. Any script inside the creative iframe (hostile creative code, or a co-tenant vendor tag) that registers a `message` listener before the SDK's bootstrap handler consumes the transfer **can** observe the port — and any per-protocol nonce delivered alongside it. This does **not** breach the trust model. Trust rests on **per-protocol nonce non-invertibility, not on port secrecy**: observing one per-protocol secret inside the iframe yields neither the renderer-protocol nonce nor the root nonce (independent, non-invertible HMAC derivations), and the renderer nonce never enters the creative iframe. Hostile code observing its own frame's transport is in-scope and bounded; only the renderer/root-nonce protection is load-bearing for the trust-model boundary. (This supersedes the earlier "the port cannot be intercepted" framing; the historical design records at `docs/architecture-design.md` §5.2 and `docs/design/0.7.8-omid-spec-compliant-bridge.md` §4.3 carry the correction.)

**Cross-protocol impersonation is structurally prevented.** A creative shim that can `window.parent.postMessage` cannot forge a `SHARC:Renderer:rendered` envelope: doing so requires the renderer-protocol nonce, which never enters the iframe (layer 1). Even if it leaked, phase enforcement rejects the envelope — `:rendered` is valid only in the `attaching-renderer` phase, long past by the time any creative shim runs (layer 2, defense-in-depth). Forged inbound envelopes that fail any trust anchor are dropped silently before any state change.

**Inbound trust anchors** (the router validates all six before dispatching an envelope):

| Anchor | Source | Unforgeable because |
|--------|--------|---------------------|
| `event.source === iframe.contentWindow` | Browser-set | `contentWindow` identity is browser-controlled; opaque origin does not affect it |
| `event.origin === expectedRendererOrigin` | Browser-set | Publisher-side gate is opaque-origin-safe via `contentWindow` identity |
| `event.data.sharcNonce === protocolNonce` | Container-derived HMAC | Root nonce (HMAC key) never on the wire |
| `event.data.placementSessionId === container.placementSessionId` | Container-derived UUID | Per-impression boundary |
| Type prefix registered + type declared | Container-controlled registration | Prefix-collision registration throws |
| Current phase ∈ type's declared phases | Container-controlled transitions | `transitionTo` is container-internal only |

<!-- trace: source=design/0.7.7-cross-frame-protocol-router.md §5.2/§7.1/§7.5 + design/0.7.8-omid-spec-compliant-bridge.md §4.3 (corrected port-transfer prose) + architecture-design.md §5.2 (corrected MessageChannel prose). Spec now carries the normative version; the design docs are HISTORICAL records of the same decisions. | gate=test:protocol-router; test:protocol-router-nonce-derivation (byte-level entropy vector); test:omid-v1-router-isolation (nonce never crosses into the iframe / observer surface; §D forged/absent-nonce SHARC:Omid envelope silent-drop); test:omid-postclose-adversarial (post-close / out-of-phase silent drop + D-7 flood throttle) -->

#### 1.11.4 CSP enforcement layering

The renderer's **HTTP-response CSP is the portable enforcement layer**; the iframe `csp` attribute (CSP Embedded Enforcement) is a Chromium-only belt on the suspenders. The renderer implementation contract requires the renderer page's HTTP response to carry:

```
Content-Security-Policy: object-src 'none'; base-uri 'none'
```

This is enforced consistently by all major browsers (Chromium, Firefox, Safari, mobile WebKit). Iframe `csp` is layered on top where supported (Chromium enforces both; Firefox and Safari enforce only the HTTP-response layer). When both are present the effective policy is their intersection. An operator that omits the HTTP-response CSP gets a security model that works only in Chromium — **not a supported deployment** for the SHARC security guarantee.

> GATE-DESIRED: the CSP layering is a renderer-hosting (server-config) obligation — not pinnable by the reference-implementation suite. Auditable at the wire level by inspecting the renderer's HTTP response headers. (The container-set iframe `csp` attribute layer — exactly `object-src 'none'; base-uri 'none'` — is pinned by `test:creative-sources-load` §1b.)

#### 1.11.5 Wrapper iframe cross-origin to publisher top

When SHARC runs inside a wrapper iframe at origin X while the publisher top frame is at origin Y (X ≠ Y), validation rule 7 cannot read `window.top.location` (cross-origin throws). The carve-out skips the top-frame check and validates only against the wrapper's origin X. The browser still enforces the wrapper-iframe boundary — a renderer iframe cannot reach the publisher DOM regardless of origin. **However**, if `creativeRendererUrl` happens to share origin with the publisher top (Y), the renderer's origin-keyed storage and non-HttpOnly cookies become reachable by the creative (origin-keyed storage does not respect the frame-tree barrier the way DOM access does). The creative still cannot reach publisher DOM, and cannot programmatically navigate the publisher top (the unsafe `allow-top-navigation` token is never present — §1.11.6).

This collision requires a specific operator misconfiguration and does not happen on competently-configured deployments, but it is unverifiable from inside the wrapper context. **SHARC running inside a cross-origin wrapper with a `creativeRendererUrl` that may share origin with the publisher top is an unsupported deployment**; operators in this configuration are responsible for guaranteeing the renderer origin is distinct from any publisher top their wrapper is embedded into.

The container-side response is normative:

- The container MUST detect the rule-7 carve-out at construction (the point at which `window.top.location` throws).
- The container MUST signal the carve-out on the structured `onSecurityEvent` channel with `type: 'wrapper_top_frame_inaccessible'`, a numeric `timestamp`, the constructed instance's `placementSessionId` (the event MUST correlate to that instance, not a throwaway id), and `details.wrapperOrigin` (the wrapper's `window.location.origin`) + `details.creativeRendererUrl`. It also signals on a developer channel (`console`), which prod bundles MAY strip.
- Under the default `wrapperPolicy: 'warn'`, the container MUST proceed with construction and emit the event with `severity: 'warning'`.
- Under `wrapperPolicy: 'block'` (for security-strict deployments), the container MUST emit the event with `severity: 'error'` and then throw synchronously at construction.

> The container-side carve-out detection and `wrapperPolicy` behavior above are pinned by `test:creative-sources` §9 (in `test:all:built`): construction-time rule-7 detection (§9), the `wrapper_top_frame_inaccessible` event shape and `placementSessionId` correlation, `wrapperPolicy: 'warn'` proceeding (§9a), and `wrapperPolicy: 'block'` throwing with `severity: 'error'` (§9b).
>
> GATE-DESIRED: only the *unsupported deployment topology itself* — a cross-origin wrapper whose `creativeRendererUrl` shares origin with the publisher top — remains corpus-unpinned. It is unverifiable from inside the wrapper context and is an operator obligation, not container-pinned behavior.

#### 1.11.6 Navigation, top-frame safety, and click-jacking

Full navigation policy (routing matrix, `requestNavigation` authority, the load-event backstop) is specified in §1.10. The security-critical invariants are:

- The unsafe `allow-top-navigation` token (programmatic top-nav with **no** user gesture — the click-jacking-friendly variant) is **never** present in the renderer iframe sandbox, at any configuration level. Auto-redirect / programmatic top-nav from creative HTML is not supported. (GATE-DESIRED: the test pins default options only; see the §1.11.9 pin note.)
- The safer `allow-top-navigation-by-user-activation` token (top-nav requires a real user gesture) is present by default (SafeFrame parity) and configurable via `allowTopNavigationByUserActivation`; strict deployments strip it via `false`.
- A container-side load-event backstop terminates the session on any unauthorized iframe re-navigation (`RENDERER_UNAUTHORIZED_NAVIGATION` 2118; structured event `unauthorized_navigation`). This is browser-observable and JS-bypass-resistant — the load event fires regardless of what the creative HTML did (§1.10).

**Click-jacking / tap-jacking** is not new to Creative Markup, but the increased capability via `allow-same-origin` makes timing attacks easier. The user-activation requirement is the floor against pure programmatic redirects; it is **not** a complete click-jacking defense (UI redress over a transparent overlay still produces a real activation token). Defense-in-depth here is publisher-side (iframe positioning, transparency policy, overlay detection) — outside SHARC's protocol scope, documented for completeness.

#### 1.11.7 Side channels and out-of-scope adversaries

- **`SharedArrayBuffer` is not exposed.** The renderer protocol does not require cross-origin isolation; `SharedArrayBuffer` is unavailable to both renderer and creative (its use requires COOP+COEP, which SHARC does not adopt). No Spectre-class side channel is exposed by the protocol.
- **Privacy Sandbox (Fenced Frames) compatibility.** The Creative Markup variant does not run *as* a fenced frame but composes cleanly *inside* one (Protected Audience): the fenced-frame boundary isolates the SHARC stack from the publisher, and the SHARC renderer-iframe boundary isolates the creative from the container. Fenced-frame restrictions apply at the fenced-frame boundary, not all the way down; SHARC does not adopt fenced frames as the renderer primitive.
- **Browser extensions are out of scope.** The SHARC security model assumes a non-adversarial user agent. Extensions with broad host permissions can read `postMessage` traffic, inject content scripts, and forge cross-frame messages, bypassing any in-page boundary — equally true for SHARC, MRAID, SafeFrame, PUC, and OMID. The fragment-nonce, origin-echo, and message-validation defenses target adversaries operating *within* the page's normal frame model (sibling/neighbor frames, malicious creatives), not extension-level adversaries.

> GATE-DESIRED: the side-channel posture (`SharedArrayBuffer` unavailability, Fenced Frames composition, extension out-of-scope) is architectural — asserted by code reading and design intent, not by a dedicated test.

#### 1.11.8 Security-event signal surface

Security-relevant conditions surface on the structured `onSecurityEvent` channel (the full observability surface — log channel, accessors — is §1.13). The security-model-relevant reserved event types:

| `type` | Severity | Fired when | Terminating |
|--------|----------|-----------|-------------|
| `wrapper_top_frame_inaccessible` | `warning` (or `error` under `wrapperPolicy: 'block'`) | Construction; `window.top.location` throws (§1.11.5) | No (`'warn'`) / Yes (`'block'`) |
| `renderer_origin_mismatch` | `error` | Post-load origin echo ≠ construction-time origin (§1.7.2) | Yes — fires before terminate |
| `renderer_protocol_error` | `error` | Renderer sends malformed or wrong-version reply (§1.7.2) | Yes — fires before terminate |
| `renderer_failed` | `error` | Renderer sends explicit `SHARC:Renderer:failed` (§1.7.1) | Yes — fires before terminate |
| `unauthorized_navigation` | `error` | Iframe navigated outside the SHARC protocol path (§1.10) | Yes — fires before terminate |
| `unauthorized_protocol` | `error` | Envelope well-formed by every trust anchor but arrived in the wrong phase (§1.11.3) | No — dropped, not fatal |

For terminating events, `onSecurityEvent` fires **before** the generic error callback so observability tooling sees the structured security context first. Event payloads are deliberately minimized to enumerated, attacker-uncontrolled fields — no raw `event.data.*` string is ever interpolated into an event or log line.

> The `wrapper_top_frame_inaccessible` event surface — type, `severity` (both `'warning'` and `'error'`), numeric `timestamp`, `placementSessionId` correlation, and `details.wrapperOrigin` / `details.creativeRendererUrl` — is pinned end-to-end by `test:creative-sources` §9/§9a/§9b (§1.11.5). `unauthorized_protocol` is pinned by `test:protocol-router`.
>
> GATE-DESIRED: the renderer `*` event emissions (`renderer_origin_mismatch`, `renderer_protocol_error`, `renderer_failed`, `unauthorized_navigation`) are witnessed piecewise by the renderer suites (§1.7) but have no dedicated security-event-surface gate.

#### 1.11.9 Protocol-layer enforcement bounds and creative-iframe sandbox

The container enforces the following at the protocol layer:

- **Rate limiting:** incoming messages are limited to **50 per second** per session. Excess messages are dropped with a developer-channel (console) warning. No reject or fatal error is sent: `2205` (message channel overloaded) is defined for this condition, but the reference implementation does not currently emit it.
- **Pending response cap:** no more than **100 in-flight requests** are allowed simultaneously. A request beyond that cap fails at the sender: the reference implementation rejects the local send and posts nothing.
- **Session ID validation:** `createSession` must supply a valid UUID v4. A malformed session ID is rejected (the reference container rejects with `2210`), no session is established, and the init sequence does not run.
- **URL validation:** `requestNavigation` and `reportInteraction` tracker URIs accept only `https:` and `http:`. All other schemes are rejected or dropped (L2 §2.6).
- **Feature name validation:** `request[FeatureName]` validates the feature name format before constructing a message type string, preventing message-type injection. This check runs sender-side in the creative-side library (L2 §2.6).
- **Sandboxed iframe:** the container sandboxes the creative iframe, and the token composition is variant-specific:
  - **Creative URL** creatives run with `allow-scripts allow-forms allow-popups` and **`allow-same-origin` intentionally omitted** (SEC-001) — the creative's own origin is the trust boundary, so it can never remove its sandbox. This no-`allow-same-origin` invariant is the load-bearing rule for the URL path.
  - **Creative Markup** creatives are delivered through a distinct, cross-origin, redirect-validated renderer, whose sandbox **includes `allow-same-origin`** (plus conditional operator-gated tokens: `allow-popups`, `allow-popups-to-escape-sandbox`, `allow-top-navigation-by-user-activation`, storage-access, modals, downloads). This is safe precisely because the renderer origin is not the publisher's — see §1.6 (Creative sources) and §1.7 (Renderer protocol) for the renderer-ownership model. The Markup renderer sandbox is a separate sandbox from the URL-path invariant above.

> GATE-DESIRED: the 50/s rate-limit figure is corpus-unpinned — no test drives the limiter to its threshold.

> GATE-DESIRED: the 100 pending-response cap is corpus-unpinned — no test fills the in-flight window.

> GATE-DESIRED: sender-side feature-name validation is corpus-unpinned — no test submits a malformed feature name.

> GATE-DESIRED: the UUID-v4 session-ID format check and its `2210` reject are corpus-unpinned. No test submits a malformed `sessionId` to the real `acceptSession`. Only the fail-closed leg is pinned (see below).

> Pinned (correcting the slice-1/slice-2 "corpus-unpinned" flag): the sandbox composition **is** pinned by `test:creative-sources-load`. Its §1 asserts the Markup renderer tokens: `allow-scripts`, `allow-same-origin`, `allow-forms`, the default-on `allow-popups` / `allow-popups-to-escape-sandbox` / `allow-top-navigation-by-user-activation` / `allow-storage-access-by-user-activation`, the default-off `allow-modals` / `allow-downloads`, and the unsafe `allow-top-navigation` token absent at default options (`test/node/test-creative-sources-load.js` ~:281). Its §2 asserts each operator override flowing through to the attribute; no test asserts the unsafe token's absence under non-default options, so the "at any configuration level" clause of §1.11.6 is GATE-DESIRED. Its §10 asserts that the Creative URL sandbox does **not** include `allow-same-origin` (SEC-001). The URL path's full token list (`allow-scripts allow-forms allow-popups`) is asserted only for `allow-same-origin` being absent, which is the security-critical part. For session-ID validation, `test:non-sharc-loading` §7d pins only the fail-closed leg. It stubs `acceptSession` to leave no session, then asserts that the container does not continue to the init flow. It does not exercise the UUID-v4 check or the `2210` reject.

> Note (`2210` is not observable by the creative): the reference container sends the `2210` reject before any session exists, so the reject carries the container's empty `sessionId` (`''`) (`src/sharc-protocol.js` `acceptSession` ~:1031, `_reject` ~:515–526). The creative-side session gate drops any inbound message whose `sessionId` is empty or differs from its own (~:569–574), so the creative never observes the reject. Its `createSession` stays unanswered.

> Editorial note (over-promotion corrected): the slice-3 draft of this note claimed that §7d pins session-ID validation. It pins only fail-closed. Source: `test/node/test-non-sharc-loading.js` §7d (stubbed `acceptSession`); `src/sharc-protocol.js` `acceptSession` / `_isValidUUID` (SEC-006, `INIT_SPEC_VIOLATION` 2210).

> Editorial note (moved; stale claims corrected): this block was carried in Part 2 §2.2 by slice 1 and moves here in slice 3, per skeleton row 1.11 (source: api-reference.md §2 Security Guarantees). Two clauses are made precise against the reference implementation (`src/sharc-protocol.js` `_onPortMessage` / `_sendMessage` / `acceptSession`). The rate-limit drop emits no `2205`; the source's parenthetical implied that it did. A send over the pending-response cap fails locally, and is not "rejected" by the peer.

<!-- trace: source=api-reference.md §2 Security Guarantees (via slice-1 Part 2 §2.2) | gate=test:creative-sources-load §1/§2/§10 (sandbox composition; SEC-001); test:non-sharc-loading §7d (session-ID fail-closed leg only); rate limit / pending cap / feature-name validation / UUID-v4 format check + 2210 reject GATE-DESIRED -->

<!-- trace: source=creative-sources.md §Security Model (whole block: trust boundary/matrix, malicious-renderer/untrusted-markup/cross-impression-amplification threats, wrapper-iframe topology, CSP layering, click-jacking, top-nav user-activation, Fenced Frames, SharedArrayBuffer, onSecurityEvent type table) + design/0.7.7-cross-frame-protocol-router.md §5/§7 + design/0.7.8-omid-spec-compliant-bridge.md §4.3 + architecture-design.md §5.2 (both HISTORICAL; spec now carries the normative version) + api-reference.md §2 Security Guarantees (enforcement bounds in §1.11.9, moved from Part 2 §2.2 in slice 3). Consolidation glue is NEW-PROSE per skeleton §E item 4. | gate=test:protocol-router; test:protocol-router-nonce-derivation; test:omid-v1-router-isolation; test:omid-postclose-adversarial; test:omid-verification-resource-cap (amplification cap); test:creative-sources §9/§9a/§9b (wrapper rule-7 carve-out detection + wrapperPolicy warn/block + wrapper_top_frame_inaccessible event surface, §1.11.5/§1.11.8); renderer-suite witnesses per §1.7; test:creative-sources-load §1/§1b/§2/§10 (sandbox composition + iframe csp attribute, §1.11.1/§1.11.4/§1.11.9); storage/HTTP-CSP/side-channel claims flagged GATE-DESIRED above -->

> **Extraction note (fidelity):** the source `## Security Model` block in `docs/proposals/creative-sources.md` was filed as a "proposal" but is the largest single block of L1 security prose. Its normative content is consolidated here; that section is demoted in place with a supersession pointer. The corrected port-transfer trust basis ("nonce isolation, not port secrecy", §1.11.3) is carried from the slice-D-era corrections in `architecture-design.md` §5.2 and the 0.7.8 OMID design §4.3 — this section matches that accepted framing rather than the pre-correction "port cannot be intercepted" claim.

### 1.12 document.open / self-rewrite policy

> RESERVED — extraction slice N (source: docopen ADRs (2026-06-13 / 2026-06-15, Obsidian); harvest test-file contracts, NEW-PROSE-from-ADR for the policy statement)

### 1.13 Observability

> RESERVED — extraction slice N (source: api-reference.md §10 (`onSecurityEvent`) + §7 (`SHARC:Container:log`) + README §Observability Accessors)

### 1.14 OMID provisioning

> RESERVED — extraction slice N (source: README §Open Measurement (embedded mini-spec) + api-reference.md §9 `OmidCompatBridge` + design/0.7.8/0.7.11 (ratified behavior only))

### 1.15 OMID on the URL variant

> RESERVED — extraction slice N (source: G5 close record §The ratified contract + G5 ADR (2026-07-05) Decision §T2)

### 1.16 Native Host Interface

> RESERVED — extraction slice N (source: NHI ADR (2026-07-03, Obsidian) + api-reference.md §1 (`onOrientationProperties`, `hostOwnsClamping`, `setHostExposure`) + api-reference.md §`setAudioState` + HISTORICAL sources docs/design/{arch,prd}-audio-volume-change.md). The `setHostLifecycle` INPUT member added by the G6 amendment is specified in §1.17 below.

### 1.17 In-App Integration (WKWebView / Android WebView)

The same JavaScript container runs inside the WebView — never a native port. Native integrates through the L1 Native Host Interface (§1.16: ACTIONS and INPUTS) and the app lifecycle adapter. The embedding is operator-declared, never sniffed: the container constructor option `hostContext: 'web' | 'app'` (default `'web'`; a non-enum value MUST throw `TypeError` at construction) selects the app lifecycle adapter for in-app embeds.

#### 1.17.1 Host-lifecycle INPUT: `setHostLifecycle(state)`

In-app, the page's own lifecycle signals are mostly blind: the WebView never fires the WICG `freeze`/`resume` events, so **the host INPUT is the ONLY source of `frozen` in-app**. The host asserts container lifecycle via the HOST-PROVIDED INPUT `setHostLifecycle(state)`:

- **Enum:** `'active' | 'passive' | 'hidden' | 'frozen'` — deliberately the page-lifecycle vocabulary, so one enum serves both platforms and the web semantics stay the reference. No `'terminated'` (an engine-process death leaves no realm to deliver into — that is a host-side disposal event, not an INPUT value); no `null`-to-clear (a lifecycle always has a value; the host simply stops calling and the last assertion stands).
- **Validation (strict):** a value outside the enum MUST throw `TypeError`. A silently dropped `'frozen'` would leave the container measuring a suspended app — the worst silent failure this surface can produce.
- **Precedence (two-axis rule):** `SHARC state = most-severe( host-asserted state, page-derived state )` on `active < passive < hidden < frozen`. The in-page signals remain a defensive floor, not the authority.
- **Host-axis rise recomputes the most-severe function (ruling U7).** The two-axis rule is a function of both axes in **both** directions. A host assertion **more permissive** than the previous one (e.g. a foreground-return `frozen → passive → active` tail) MUST re-evaluate `most-severe( host, page )` and promote the container to the composed target through the same pre-clamped promotion chokepoint that governs demotion — not only demote. In-app this is load-bearing: the WebView fires no `freeze`/`resume` and no visibility/intersection edge on a background→foreground round-trip, so without a rise trigger the container strands at the last clamped state (e.g. `PASSIVE`) with the mandatory host re-asserts (§1.17.1, delivery-before-suspension) deduping to no-ops. Constraints on the recompute: (a) a page-held freeze still holds `FROZEN` — per-axis latches compose under most-severe, the rise never overrides a page-asserted freeze; (b) a pre-ready container never jumps — the recompute acts only on the visibility axis, and the handshake-race rules own `loading`/`ready`; (c) when the page axis has never asserted (no IntersectionObserver sample yet) it contributes `'active'` — a non-asserting page axis does not constrain, so the host assertion governs alone (failing closed would re-create the strand).
- **Trust boundary of the rise (normative).** Host-axis rise moves only the container **state enum** — never a measurement value. The OMID impression is one-shot (`impressionFired` latch: a re-promotion after a demote cannot re-fire it), and viewability (`percentageInView`, MRAID `viewableChange`) is sourced from the composed effective-visibility axis (`setHostExposure` / the composer, §1.17.2), not from the lifecycle enum. Host-rise therefore adds **no inflation power** beyond `setHostExposure`. A host that asserts lifecycle `'active'` while backgrounded without the dual `setHostExposure(0)` is a dual-assert-contract violator (§1.17.2) — governed by the same trusted-host boundary that already governs the exposure axis, unchanged here.
- **Declared consumer:** the app lifecycle adapter — NEVER a compat bridge. Exposure feeds the composer, lifecycle feeds the adapter; nothing host-provided ever touches a compat bridge directly.
- **Dedup:** consecutive-identical values are no-ops, so mandatory host re-assertion is free.
- **Replay:** last-value-latched — a value asserted before the adapter attaches (preload) is retained and applied at attach; on each ACTIVE transition the adapter re-evaluates against the latched host value.
- **Delivery-before-suspension:** JS evaluation from a backgrounding callback is asynchronous and may not complete before suspension. The INPUT is best-effort at freeze-entry, and the host MUST re-assert the current state on every foreground return (dedup makes re-assertion idempotent).
- **Web inertness:** the surface ships in the bundle; with no host wired it is never called and stock web embeds are byte-identical.

#### 1.17.2 Host-integration dual assert (normative)

When the app backgrounds or the container's view is covered/off-screen, the host integration MUST assert BOTH inputs:

> `setHostLifecycle('hidden')` **AND** `setHostExposure(0)`

The two surfaces feed deliberately disjoint consumers: **lifecycle feeds state** (the adapter's two-axis most-severe rule → container state, MRAID `stateChange`, OMID session gating), while **exposure feeds measured visibility** (the effective-visibility composer → the wire's `effectiveVisibilityChange`, MRAID `exposureChange`/`viewableChange`, SafeFrame geometry, the OMID relay). A host that asserts only the lifecycle leaves the composer reporting the last on-screen exposure percent for a hidden container — measurement lies while state tells the truth; a host that asserts only the exposure leaves the container's state axis believing the page is interactive. Neither input derives the other by design. The symmetric foreground return re-asserts both (`setHostLifecycle(<current>)` and `setHostExposure(<current pct>)`).

#### 1.17.3 In-app teardown sequence and HOST-REQ-1

1. The host initiates dismissal by asking the *container* to close (invoke `destroy()`/`close()` on the container via the host page — never by deallocating the WebView first).
2. The container's termination sequence runs unchanged: the terminal OMID `sessionFinish` is relayed during the `omid-finishing` phase, BEFORE the transition to `terminated` and destroy (pinned ordering).
3. **HOST-REQ-1 (normative):** the host app MUST hold a strong reference to the WKWebView / Android WebView — and MUST NOT suspend, navigate, or deallocate it — for at least **1.0 s** after session finish (the OM SDK documented minimum). SHARC RECOMMENDS **1.5 s** to cover the container's own `omid-finishing` grace with a single figure. Only then may the host remove the WebView from the hierarchy and release it. On iOS, dismissal-driven teardown must not ride `deinit` ordering; schedule the release.
4. If the host uses the native `JavaScriptSessionService` teardown API — whose documented semantics finish all active ad sessions and may itself require up to one second — it MUST be called only AFTER step 2's JS-side finish has run, or the host accepts that native force-finishes the session out from under the container.
5. Crash-path exception: WebView engine-process death (`webViewWebContentProcessDidTerminate` / `onRenderProcessGone`) means the JS realm is already gone — the grace is forfeit by construction, no `sessionFinish` can be delivered, and the host's only duty is disposal.

#### 1.17.4 OMID In-App

**Service-script mode.** The OM SDK has two service-script builds with different authority models: the in-app JS service (`omsdk-v1.js`, provided/injected by the host's native integration) and the web service (`omweb-v1.js`, a standalone JS binary). In-app, the WebView runs the NATIVE SDK's service script, provided by the host integration — the container MUST NOT boot `omweb-v1.js` in that environment, and the two services do not coexist (one detection point, two claimants is a misconfiguration, not an option). The session client (`omid-session-client-v1.js`) is the same library in both worlds, and the container-side OMID extension retains AdSession ownership (start/finish via the session client) in both modes — the documented `JavaScriptSessionService` division of labor.

The mode is operator-declared via the OMID extension option `serviceMode: 'web' | 'native'` (default `'web'`), never platform-sniffed — a misdetection would silently fork measurement authority, the one failure the switch exists to prevent:

- `'web'` (default) — the web behavior, byte-identical: the extension injects the web service script then the session client.
- `'native'` — the extension MUST NOT inject any service script. It injects only the session client, then waits (bounded by the standard script timeout) for the native-provided service to become reachable via the session client's public `AdSession.isSupported()` probe. Feature advertisement requires only the session-client URL.
- A `serviceMode` value outside the enum MUST throw `TypeError` at construction (no coercion, no silent default-on-garbage).
- `serviceMode: 'native'` combined with a configured service-script URL MUST throw `TypeError` at construction — a contradictory authority declaration ("native provides the service" + "here is a service to inject") is a configuration bug, and injecting the web service next to the native one is the harmful act itself.
- Misconfiguration behavior: `'native'` declared with no native service actually present fails honestly after the bounded wait — the structured `feature_load_failed` event fires with reason `native-service-missing`; the ad still renders and measurement honestly fails. `'web'` left defaulted where the host injected the native service does not stack a second service (the existing service-already-present idempotence check holds); the extension emits a one-time dev-channel warning nudging toward the explicit declaration.

**Single geometry authority.** The single authority in-app is the WebView's on-screen geometry as measured by the host, fed to BOTH consumers from that one physical source: (1) host → SHARC composer, via the existing `setHostExposure(pct)` INPUT (axis-3, host-wins) — everything SHARC emits (the wire's `effectiveVisibilityChange`, MRAID `exposureChange`/`viewableChange`, SafeFrame geometry, and the OMID relay) continues to read the ONE composer; (2) host → OM SDK native, the same WebView registered as the ad view (`isHtmlAdView: true` makes the WebView frame the ad view).

> In-app, `wire == MRAID == SafeFrame == OMID-relay` continues to hold by construction (one composer). The OM SDK's native geometry stream is an *independent measurement of the same WebView frame*, not a SHARC emission; conformance therefore additionally requires **agreement**: at visibility steady state, the composer's `effectivePercent` and the OM SDK's `percentageInView` for the registered WebView MUST agree within rounding tolerance.

The agreement check is asserted by the G6 conformance harness at driven plateaus (fully visible, partially occluded, app-backgrounded). PASS = |composer `effectivePercent` − native `percentageInView`| ≤ 1 at each driven plateau AND the visible/notVisible boolean flips agree in both directions. Note the in-app effective-visibility reason vocabulary: `'frozen'` is structurally unreachable in-app (only the page-lifecycle `freeze` event sets the composer's freeze sub-state, and the host-lifecycle INPUT never touches the composer); `'backgrounded'` is the honest in-app token.

<!-- trace: source=docs/design/0.8.0-g6-omid-in-app-design.md (Decisions 1–4 condensed to the normative rulings; the host-axis-rise recompute + trust-boundary clauses in §1.17.1 fold ruling U7 from §4.4 (added 2026-07-12 per #438) + the SE trust-boundary note from §4.4/§4.5 per #441) | gate=NO-GATE (G6 gate, pending; red contracts: test:g6-red, not in test:all) -->

### 1.18 Error codes

SHARC error codes occupy two namespaces:

- **21xx — creative-side errors**, raised by or attributed to the creative and its load path (including the Creative Markup renderer path, codes 2114–2120).
- **22xx — container errors**, raised by or attributed to the container.

Error codes travel in two wire positions: the `args.value.errorCode` of a `reject` message (scoped to the single message being rejected; the session continues), and the `args.errorCode` of a `fatalError` message or termination path (the session ends). The same code can appear in either position; the position, not the code, determines severity.

Semantics that implementations rely on:

- **A reject is not always a failure.** Code `2214` (`NAVIGATION_NOT_HANDLED`) on a `requestNavigation` reject means "the container declines the navigation; the creative should open the URL itself" — a handoff, not an error (ratified 2026-10-03, Ruling 1). Code `2105` is reserved with its legacy meaning ("Resize request not honored") and is never reused. (DIVERGENCE, implementation bug, #464: the reference container sends this handoff as `2200`, and its `ErrorCodes` registry has no `2214`; see L2 [§2.6](creative-api.md) `requestNavigation`.)
- **Timeout-driven terminations** carry dedicated codes: `2212` (creative did not send `createSession` in time), `2208` (creative did not resolve `Container:init` in time), `2213` (creative did not resolve `Container:startCreative` in time). See §1.19 for the windows.
- **Validation rejects:** `2211` (message spec violation — malformed messages, disallowed URL schemes), `2203` (feature or intent not supported / policy-disallowed), `2204` (feature known but execution failed), `2205` (message channel overloaded).
- **Renderer-protocol codes** (Creative Markup variant): `2114` timeout, `2115` renderer failed, `2116` origin mismatch, `2117` protocol error, `2119` post failed, `2120` integrity failed. `2118` (unauthorized navigation) applies to both variants. Code `2115` is shared by two structured security-event variants (generic renderer failure and bridge-module load failure); the structured event's `type` field, not the code, is the triage discriminator.
- Codes `2121`/`2122` are **non-terminating diagnostics** carried only in structured security-event details — they never reach the fatal-error channel.

The citable code ↔ name tables, 21xx and 22xx, are [registries.md](registries.md) R1 and R2. They include the reserved and unassigned codes and the supersession diff against the SHARC-legacy draft (§1.4).

<!-- trace: source=api-reference.md §11 (semantics prose) + Legacy §Error Codes (supersession diff now in registries.md R1/R2 and §1.4) | gate=test:non-sharc-loading (exercises 2212; corrected 2026-07-12 per #440 review); registry ↔ src ErrorCodes cross-check GATE-DESIRED (test:spec-structure phase b indexes RFC-2119 lines only; it does not compare registries with src — corrected in slice 4) -->

### 1.19 Timeouts

| Event | Default Timeout | On Expiry | Error Code |
|-------|-----------------|-----------|------------|
| `createSession` | 5 seconds | Terminate | 2212 |
| `Container:init` resolve | 2 seconds | Terminate | 2208 |
| `Container:startCreative` resolve | 2 seconds | Terminate | 2213 |
| Close sequence (after `Container:close`) | 2 seconds | Force terminate | — |
| Tracker firing (`reportInteraction`) | 5 seconds per URI | Mark failed, continue | — |
| Renderer iframe `load` (Markup variant) | 5 seconds | Terminate | 2114 |
| Renderer `:rendered`/`:failed` reply (Markup variant) | 2 seconds | Terminate | 2114 |

When the `createSession` timeout is armed (`requireSharcInit: true`, the default), on expiry of the `createSession` window the container MUST fatal-error with `2212` and terminate (MUST promotion ratified 2026-10-03, Ruling 3; with `requireSharcInit: false` the timeout is not armed and no `2212` is raised). On expiry of the `Container:init` or `Container:startCreative` windows the container terminates with the listed error code (`2208` / `2213`).

> GATE-DESIRED: 2208/2213 expiry behavior is corpus-unpinned — tracked for a dedicated test before G4.

All timeouts have configurable defaults. SSAI/live environments may set the `createSession` timeout to 0. A container configured with `requireSharcInit: false` skips the `createSession` fatal timeout so non-SHARC creatives load to a stable container instance.

> GATE-DESIRED: the termination leg of the `2212` MUST is unpinned. `test:non-sharc-loading` §1 (`test/node/test-non-sharc-loading.js` ~:153) asserts only that `onError(2212)` fires, not that the container sends `fatalError` and terminates. L2 [§2.4](creative-api.md) states the ratified, armed-timeout-scoped form of this MUST (ratified 2026-10-03, Ruling 3).

<!-- trace: source=api-reference.md §Appendix: Timeout Summary (+ §1 timeouts option, renderer rows from §10) | gate=test:non-sharc-loading §1 (onError(2212) only — the termination leg of the 2212 MUST is GATE-DESIRED, corrected per the slice-3a review); validator gate-U2 (test-url-lifecycle-gates) -->

### 1.20 Distribution and artifact identity

> RESERVED — extraction slice N (source: distribution-design.md (current-guidance parts) + adr/0001 (rationale, INFORMATIVE))

---

## Part 2 — Creative wire protocol (moved)

> The creative wire protocol (skeleton §B rows 2.1–2.14) is specified in the **[SHARC Creative API Specification](creative-api.md)** (L2). Extraction slice 1 carried §§2.2–2.7 here as Part 2, pending the L2 document; slice 3 re-homed them to `creative-api.md` with the same section numbers. References of the form "L2 §2.x" in this document point there. The protocol-layer enforcement bounds that Part 2 §2.2 carried stayed in L1 and now live in §1.11.9.

## Appendix A — Message type reference (moved)

> Moved to the [SHARC Creative API Specification](creative-api.md), Appendix A, in extraction slice 3. Per skeleton §D, [registries.md](registries.md) R3 cites L2 Appendix A as the registry of record for session-port messages, and adds the message types that travel outside the session port.

## Appendix B — Seam census

Every cross-party handoff in a SHARC deployment has a named row here: seam → parties → owner and governing contract → governing rule → gate. If a handoff is not in this table, it is not allowed to exist informally. The census is normative once the specification ships (RATIFIED 2026-07-08). The rows below are the ratified seed rows, with the governing rule and gate columns completed from the extracted sections. Rows whose governing section is still RESERVED name the source that section will carry.

| Seam | Parties | Owner / governing contract | Governing rule | Gate |
|---|---|---|---|---|
| Native Host Interface: ACTIONS | creative → container → host (fire-and-forget relay) | NHI contract C1–C9 | §1.16 (RESERVED; source: NHI ADR, 2026-07-03); L2 §2.6 `requestNavigation`, `setOrientationProperties` | test:mraid-orientation-properties O8–O10 (orientation relay); test:host-placement-integration (placement change) |
| Native Host Interface: INPUTS (exposure, screen offset, audio, host lifecycle) | host → container → named consumer | NHI S1–S3; the consumer is never a compat bridge | §1.16 (RESERVED); §1.17.1 `setHostLifecycle`; §1.17.2 dual assert | test:mraid-exposure-change; test:host-placement-integration §5/§11; test:mraid-bridge-correctness-e2 (audio, bridge consumption only); `setHostLifecycle`: test:g6-red (not in `npm test`; G6 pending) |
| Creative protocol / `MessageChannel` port | container ↔ creative-side library | wire-format spec (L2); trust basis is per-protocol nonce isolation, not port secrecy | L2 §2.2–§2.4, §2.8; §1.11.3 | test:container-state-establish-push; test:protocol-attachport-idempotent; test:creative-sdk-singleton |
| Renderer protocol | container ↔ operator renderer | `SHARC:Renderer:*` envelope and nonce rules | §1.7; §1.11.3 | test:renderer-protocol-retrofit; test:renderer-out-of-phase; test:creative-sources-load; test:protocol-router-nonce-derivation |
| OMID measurement | container ↔ OM SDK service (web: `omweb-v1`; in-app: the native service) | `OmidCompatBridge` service-mode contract; finish-before-teardown host requirement | §1.14 (RESERVED); §1.17.3 HOST-REQ-1; §1.17.4 | test:omid-container-lifecycle; test:terminate-omid-order; native mode: test:g6-red (G6 pending) |
| Vendor scripts | creative ↔ `omid3p` shim / service-injected copies | shim surface + per-protocol nonce isolation | §1.11.3; §1.14 (RESERVED); L2 §2.12 (URL variant, tier T2) | test:omid-shim; test:omid-shim-transport; test:omid-v1-router-isolation; test:g5-url-contracts R3 (partial) |
| Bid metadata | operator pipeline → container | `creativeMeta` / AdCOM `APIFramework` registry | [registries.md](registries.md) R6, R7 | test:bridges-detection; test:creative-sources (Rule 3b) |
| Test-result egress (in-app) | WebView → harness app → compare tool | G6 spike contract schema | §1.17 (G6 design) | test:g6-ios-walking-skeleton; test:g6-android-webview (neither in `npm test`) |

> Editorial note (seed row corrected): the ratified seed row for Native Host Interface ACTIONS gave the parties as "host → container → creative relay". The NHI ADR (2026-07-03) defines an ACTION as creative → container → host, a fire-and-forget relay in which the creative asks and the host acts (template: `onNavigation`). The row follows the ADR. The seed's INPUTS row listed "exposure, screen offset, orientation, placement; host-lifecycle pending G6". The ADR's roster classifies orientation and placement change as ACTIONS, so they move to the ACTIONS row. Audio (`setAudioState`, an INPUT in the ADR roster) is added, and host lifecycle is now specified (`setHostLifecycle`, §1.17.1).

<!-- trace: source=skeleton §F2 seam census (RATIFIED 2026-07-08; seed rows) + NHI ADR (2026-07-03, Obsidian; ACTION/INPUT direction) + the governing sections cited per row | gate=per row; the census itself is NO-GATE (governance) -->
