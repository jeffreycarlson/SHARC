<!-- SHARC-DOC-STATUS: NORMATIVE -->

# SHARC Registries

**SHARC Specification 1.0 (Draft)**

| Field | Value |
|---|---|
| Spec version | **1.0-draft**, shared with the three SHARC Specification documents (L1 [Versioning policy](container-runtime.md)) |
| Document | Citable registries for L1 [Container Runtime](container-runtime.md), L2 [Creative API](creative-api.md), and the Compat Profile |
| Status | **DRAFT** |

## About these registries

Each registry lists the values that the SHARC Specification assigns: codes, names and identifiers that other documents, implementations and external registrations cite. A registry entry assigns an identifier and states its meaning. The behavior attached to an identifier is specified in the section that the entry cites, and that section carries the requirement and its pinning gate.

Every registry names:

- its **source of record**, the estate document or source constant it was extracted from; and
- its **pinning gate**, the test that pins the table as a whole. Where none exists, it says so.

Stability: after 1.0, entries are append-only, and removing one requires a spec-version bump (L1 Versioning policy). Before 1.0, the pre-1.0 posture applies: breaking changes ship clean.

Registry index:

| # | Registry | Layer |
|---|---|---|
| R1 | Creative error codes (21xx) | L1 / L2 |
| R2 | Container error codes (22xx) | L1 / L2 |
| R3 | Message types | L1 / L2 |
| R4 | Cross-frame protocol prefixes, nonce derivation labels, and router phases | L1 |
| R5 | Security-event variants and the OMID reasons mapping | L1 |
| R6 | Compatibility-bridge identifiers | Compat |
| R7 | AdCOM `APIFramework` mappings | L1 / Compat |
| R8 | Feature names | L2 |
| R9 | Validator verdict buckets | Acceptance (L1 §1.3.3) |
| R10 | `reportInteraction` tracker macros | L2 |

<!-- trace: source=skeleton §D (citable registries) | gate=per registry, below -->

---

## R1 — Creative error codes (21xx)

Codes raised by, or attributed to, the creative and its load path, including the Creative Markup renderer path. Error-code semantics, the two wire positions, and the rule that the position rather than the code sets severity are in L1 §1.18. The creative-side view is L2 §2.13.

| Code | Name (reference `ErrorCodes`) | Meaning | Status |
|---|---|---|---|
| 2100 | `UNSPECIFIED_CREATIVE` | Unspecified creative error. A catch-all: prefer a more specific code. | Assigned |
| 2101 | `CANNOT_LOAD_RESOURCES` | The creative could not load its resources. | Assigned |
| 2102 | (not defined in the reference) | The container's dimensions do not suit the creative. | Assigned (spec only) |
| 2103 | `WRONG_SHARC_VERSION_CREATIVE` | The creative cannot support the container's SHARC version. | Assigned |
| 2104 | `CANNOT_EXECUTE_CREATIVE` | Unspecified technical failure to execute the creative. Also the container's fallback code when a creative's init reject carries no code (L2 §2.5). | Assigned |
| 2105 | (none) | Legacy meaning: "Resize request not honored". | **Reserved. Never reused** (Ruling 1, 2026-10-03) |
| 2106, 2107 | (none) | — | Unassigned (also unassigned in the legacy draft) |
| 2108 | `AD_INTERNAL_ERROR` | Internal creative error, unrelated to external dependencies. | Assigned |
| 2109 | `DEVICE_NOT_SUPPORTED` | Rendering or execution is not possible on this device. | Assigned |
| 2110 | `CONTAINER_NOT_SENDING` | The container's messages are malformed, mislabeled or out of spec. | Assigned |
| 2111 | `CONTAINER_NOT_RESPONDING` | The container's responses are late or missing expected data. | Assigned |
| 2112, 2113 | (none) | — | Unassigned (held for future creative-side codes) |
| 2114 | `RENDERER_TIMEOUT` | The renderer iframe did not load, or did not reply `:rendered`/`:failed`, in time. Markup variant only. | Assigned |
| 2115 | `RENDERER_FAILED` | The renderer reported `SHARC:Renderer:failed`. Shared by two security-event variants (R5); the event `type` tells them apart. Markup variant only. | Assigned |
| 2116 | `RENDERER_ORIGIN_MISMATCH` | The renderer's reported origin differs from the construction-time renderer origin (L1 §1.7.2). Markup variant only. | Assigned |
| 2117 | `RENDERER_PROTOCOL_ERROR` | An envelope-valid renderer reply has a malformed payload (L1 §1.7.2). Markup variant only. | Assigned |
| 2118 | `RENDERER_UNAUTHORIZED_NAVIGATION` | The iframe navigated outside the SHARC protocol path after render, and SHARC lost control (L1 §1.10). Both variants. | Assigned |
| 2119 | `RENDERER_POST_FAILED` | Posting `SHARC:Renderer:render` threw synchronously. Markup variant only. | Assigned |
| 2120 | `RENDERER_INTEGRITY_FAIL` | The optional `creativeRendererIntegrity` preflight failed before the renderer loaded. Markup variant only. | Assigned |
| 2121 | `RENDERER_LOAD_OBSERVED` | Non-terminating diagnostic: a post-render renderer load was observed and the channel was re-authenticated. Carried only in security-event `details.code`. | Assigned (diagnostic only) |
| 2122 | `RENDERER_NAVIGATION_BLOCKED` | Non-terminating diagnostic: a navigation was classified and blocked while SHARC kept the channel. Carried only in security-event `details.code`. | Assigned (diagnostic only) |

Codes `2121` and `2122` never reach the fatal-error channel and never appear on the creative wire (L1 §1.18).

> Supersession diff against the SHARC-legacy draft (L1 §1.4): the draft assigned 2100–2105 and 2108–2111 with the meanings above, except that `2105` meant "Resize request not honored". The estate later re-used `2105` for the navigation handoff without ratification. Ruling 1 reverses that reuse: the handoff is `2214` (R2), and `2105` is reserved. `2114`–`2122` are new.
>
> Reference implementation (informative): the reference `ErrorCodes` registry (`src/sharc-protocol.js`) defines every assigned code above except `2102`. It does not define `2105`, which is correct for a reserved code.

<!-- trace: source=api-reference.md §11 (Creative Errors) + src/sharc-protocol.js ErrorCodes (names; 2112/2113 and 2121/2122 comments) + Legacy §Error Codes (supersession diff) + Ruling 1 (2026-10-03) | gate=GATE-DESIRED: no test compares this table with src ErrorCodes. Per-code behavior pins live at the behavior's section (for example 2116/2117 precedence: test:creative-sources-load; 2212: test:non-sharc-loading §1) -->

## R2 — Container error codes (22xx)

Codes raised by, or attributed to, the container. The 22xx numbering follows the SIMID lineage: SHARC 22xx corresponds to SIMID 12xx + 1000.

| Code | Name (reference `ErrorCodes`) | Meaning | Status |
|---|---|---|---|
| 2200 | `UNSPECIFIED_CONTAINER` | Unspecified container error. A catch-all. The protocol also rejects every pending request with `2200` on reset and terminate. | Assigned |
| 2201 | `WRONG_SHARC_VERSION_CONTAINER` | The container cannot support the creative's SHARC version. | Assigned |
| 2202 | (none) | — | Unassigned (also unassigned in the legacy draft) |
| 2203 | `UNSUPPORTED_FEATURE` | A feature or intent the container does not support, or that policy disallows (L2 §2.6). | Assigned |
| 2204 | (not defined in the reference) | A known feature whose execution failed (L2 §2.6 `request[FeatureName]`). | Assigned (spec only; meaning changed from the legacy draft, see note) |
| 2205 | `OVERLOADING_CHANNEL` | Too many messages from the creative. Defined for the inbound rate limit, which the reference does not emit it for (L1 §1.11.9). | Assigned |
| 2206, 2207 | (none) | — | Unassigned (also unassigned in the legacy draft) |
| 2208 | `RESOLVE_TIMEOUT` | The creative did not resolve or reject in time; used for the `Container:init` window (L1 §1.19). | Assigned |
| 2209 | `CREATIVE_NOT_SUPPORTED` | This creative cannot be rendered on this device. | Assigned |
| 2210 | `INIT_SPEC_VIOLATION` | The creative did not follow the spec during initialization, for example a malformed session ID (L1 §1.11.9). | Assigned |
| 2211 | `MESSAGE_SPEC_VIOLATION` | The creative's message is out of spec: malformed, or a disallowed URL scheme (L2 §2.6). | Assigned |
| 2212 | `NO_CREATE_SESSION` | The creative did not send `createSession` within the armed window (L1 §1.19; L2 §2.4). | Assigned |
| 2213 | `NO_START_REPLY` | The creative did not resolve `Container:startCreative` in time (L1 §1.19). | Assigned |
| 2214 | (not yet defined in the reference) | `NAVIGATION_NOT_HANDLED`. The container declines a `requestNavigation`, and the creative should open the URL itself. A handoff, not an error (L2 §2.6). | **Assigned, ratified 2026-10-03 (Ruling 1); implementation pending, #464** |

> DIVERGENCE (implementation bug, #464; GATE-DESIRED): the reference container still sends the navigation handoff as `2200`, and its `ErrorCodes` registry has no `2214` (L2 §2.6).
>
> Residual (ruling required): `2204`'s meaning changed from the legacy draft (the creative executing actions the container does not support) to a known feature whose execution failed. No ruling records the change (L1 §1.4).

<!-- trace: source=api-reference.md §11 (Container Errors) + src/sharc-protocol.js ErrorCodes + Legacy §Error Codes (supersession diff) + Ruling 1 (2026-10-03; 2214, SIMID lineage) | gate=GATE-DESIRED: no test compares this table with src ErrorCodes; 2214 implementation pending (#464). Per-code behavior pins live at the behavior's section -->

## R3 — Message types

**Session-port messages.** The registry of record is L2 [Appendix A](creative-api.md) (Container → Creative and Creative → Container), which is cited here rather than copied. It lists each type's direction, its response requirement, and when it is sent, and each type's payload is specified at its L2 section. The response types `resolve` and `reject` are L2 §2.3.

**Message types outside L2 Appendix A.** These types are part of the protocol but travel outside the session dictionary, or are instances of a pattern:

| Type | Direction | Channel | Specified in | Note |
|---|---|---|---|---|
| `SHARC:Container:handshake` | container → creative window | `window.postMessage`, carrying the transferred port | L2 §2.4 | The bootstrap. The only message sent outside the port; re-posted only to relink after a back/forward-cache restore. |
| `SHARC:Renderer:render` | container → renderer | `window.postMessage` | L1 §1.7.1 | Renderer protocol (R4 prefix `SHARC:Renderer:`). |
| `SHARC:Renderer:rendered` | renderer → container | `window.postMessage` | L1 §1.7.1 | Renderer protocol. |
| `SHARC:Renderer:failed` | renderer → container | `window.postMessage` | L1 §1.7.1 | Renderer protocol. The `reason` vocabulary is L1 §1.7.1. |
| `SHARC:Container:loadProbe` | container → renderer | the bootstrap `MessageChannel` | L1 §1.7.4 (prose RESERVED in part); §1.12 (RESERVED) | Post-render load re-authentication. |
| `SHARC:Creative:loadAck` | renderer → container | the bootstrap `MessageChannel` | L1 §1.7.4 (prose RESERVED in part); §1.12 (RESERVED) | Answers `loadProbe`. Possession of the port authenticates it. |
| `SHARC:Omid:Register` | OMID shim → container | Markup: router envelope; Creative URL tier T2: the session port | L1 §1.14 (RESERVED); L2 §2.12 | OMID protocol (R4 prefix `SHARC:Omid:`). Listed in L2 Appendix A for the T2 path. |
| `SHARC:Omid:Event` | container → OMID shim | router envelope | L1 §1.14 (RESERVED) | OMID protocol. |
| `SHARC:Creative:requestMessage` | creative → container | session port | L2 §2.6 `request[FeatureName]` | An instance of `request[FeatureName]` for `com.iabtechlab.sharc.safeframe.message` (R8): the SafeFrame `$sf.ext.message` relay. The only instance the reference container implements. |

> Registry omission (flagged, not resolved): `SHARC:Container:loadProbe` and `SHARC:Creative:loadAck` are shipped protocol messages (`src/sharc-container.js` `SHARC:Container:loadProbe` ~:5659; the `loadAck` listener ~:3309–3329) that no spec section yet specifies in full. Their home is L1 §1.7.4 / §1.12, both partly RESERVED.

<!-- trace: source=creative-api.md Appendix A (registry of record, cited) + src/sharc-protocol.js ContainerMessages / CreativeMessages + src/sharc-container.js (handshake, loadProbe/loadAck, requestMessage listener ~:3985) + src/sharc-omid-bridge.js OMID router registration (Register/Event) | gate=GATE-DESIRED: no test compares the registry with src constants; per-message pins live at each message's section -->

## R4 — Cross-frame protocol prefixes, nonce derivation labels, and router phases

Cross-frame protocols are multiplexed over one `window` `message` chokepoint, the protocol router. Each registered prefix gets its own per-protocol nonce (L1 §1.11.3).

| Prefix | Types (direction; valid phases) | Nonce derivation label | Specified in |
|---|---|---|---|
| `SHARC:Renderer:` | `render` (outbound; `attaching-renderer`), `rendered` (inbound; `attaching-renderer`, `rendered`, `creative-active`, `omid-active`, `omid-finishing`), `failed` (inbound; `attaching-renderer`) | `SHARC:Renderer:` + `:` + `placementSessionId` | L1 §1.7, §1.11.3 |
| `SHARC:Omid:` | `Register` (inbound; `omid-active`), `Event` (outbound; `omid-active`, `omid-finishing`) | `SHARC:Omid:` + `:` + `placementSessionId` | L1 §1.11.3, §1.14 (RESERVED) |

The derivation label is the HMAC message in L1 §1.11.3: the registered prefix, then `":"`, then the `placementSessionId`. Because every prefix ends in `:`, the label contains a double colon, for example `SHARC:Renderer::<placementSessionId>`.

**Router phases:** `init`, `attaching-renderer`, `rendered`, `creative-active`, `omid-active`, `omid-finishing`, `terminated`. A phase is a router-internal window during which given envelope types are valid. It is not a container lifecycle state.

> Editorial note (drift flagged): api-reference.md §10 describes the `unauthorized_protocol` event's `details.phase` as one of six phases, without `omid-finishing`. The router accepts any phase string, and the reference registers `omid-finishing` memberships (`src/sharc-container.js` renderer registration; `src/sharc-omid-bridge.js` OMID registration), so the event can carry it.

<!-- trace: source=design/0.7.7-cross-frame-protocol-router.md §4 (phases) and §5 (derivation; HISTORICAL source) + src/sharc-container.js (SHARC:Renderer: registration ~:1563–1593) + src/sharc-omid-bridge.js (SHARC:Omid: registration ~:1829–1834) | gate=test:protocol-router; test:protocol-router-nonce-derivation (derivation label and byte-level vector) -->

## R5 — Security-event variants and the OMID reasons mapping

**`onSecurityEvent` variants.** Every event carries `type`, `severity`, `timestamp`, `placementSessionId`, `message` and a `details` payload discriminated by `type`. Terminating variants also carry `errorCode`, and fire before the generic error callback (L1 §1.11.8).

| `type` | `severity` | Code | Terminating |
|---|---|---|---|
| `wrapper_top_frame_inaccessible` | `warning`; `error` under `wrapperPolicy: 'block'` | — | No (`'warn'`) / yes, construction throws (`'block'`) |
| `renderer_origin_mismatch` | `error` | `2116` | Yes |
| `renderer_protocol_error` | `error` | `2114`, `2117`, `2119` or `2120`, told apart by `details.subtype` (`timeout`, `malformed_payload`, `post_failed`, `integrity_failed`) | Yes |
| `renderer_failed` | `error` | `2115` | Yes |
| `bridge_load_failed` | `error` | `2115` | Yes |
| `unauthorized_navigation` | `error` | `2118` | Yes |
| `renderer_load_observed` | `info` | `details.code: 2121` | No |
| `renderer_navigation_blocked` | `warning` | `details.code: 2122` | No |
| `feature_load_failed` | `error` | — | No |
| `omid_resource_cap` | `warning` | — | No |
| `unauthorized_protocol` | `error` | — | No (the envelope is dropped) |

The `details` schema of each variant is in api-reference.md §10 (`onSecurityEvent` surface), which is the source of record until L1 §1.13 (RESERVED) is extracted. The renderer `:failed` `reason` vocabulary is L1 §1.7.1.

**OMID reasons boundary mapping.** The effective-visibility channel carries raw SHARC reason tokens (L2 §2.5). They are mapped to the OM SDK `adView.reasons` vocabulary only where a value crosses into OMID:

| SHARC effective-visibility reason | OM SDK `adView.reasons` |
|---|---|
| `offscreen` | `clipped` |
| `notAttached` | `notFound` |
| `frozen` | `backgrounded` |
| `backgrounded` | `backgrounded` |

<!-- trace: source=api-reference.md §10 (onSecurityEvent surface; 11 variants) + L1 §1.11.8 + L2 §2.5 (EV reason tokens and the OMID mapping) | gate=test:creative-sources §9/§9a/§9b (wrapper_top_frame_inaccessible); test:protocol-router (unauthorized_protocol); test:omid-verification-resource-cap (omid_resource_cap); test:renderer-postrender-load-policy and test:renderer-probe-cycle-ceiling (2121/2122 diagnostics); test:omid-reasons-vocab (reasons boundary mapping); the renderer_* terminating emissions are witnessed piecewise by the renderer suites and have no dedicated security-event-surface gate (GATE-DESIRED, L1 §1.11.8) -->

## R6 — Compatibility-bridge identifiers

The `bridges` vocabulary names the renderer-loaded compatibility bridges. It is Compat Profile material, registered here so that L1 (the renderer envelope, L1 §1.7.1) and the Compat Profile cite one list.

| Identifier | Bridge | Feature name advertised (R8) |
|---|---|---|
| `mraid` | MRAID compatibility bridge | `com.iabtechlab.sharc.mraid` |
| `safeframe` | SafeFrame compatibility bridge | `com.iabtechlab.sharc.safeframe` |

- `omid` is **not** a bridge identifier. OMID is measurement, not API translation, and installs as a container extension (L1 §1.14). A container rejects `bridges: ['omid']` at construction.
- A renderer filters the inbound `bridges` list against its own allowlist. Unknown identifiers are logged and skipped (L1 §1.7.1).
- `bridges` is Creative Markup only. Passing it with `creativeUrl` is a construction-time misconfiguration (the Rule 3b exclusion).

<!-- trace: source=design/0.7.1-bridges-field.md (HISTORICAL source) + README §Bridge Detection and the OMID-is-not-a-bridge paragraph + L1 §1.7.1 | gate=test:bridges-detection (identifier set; bridges: ['omid'] rejected; Rule 3b); test:creative-sources (Rule 3b) -->

## R7 — AdCOM `APIFramework` mappings

SHARC reads AdCOM v1.0 `APIFramework` integer codes from bid metadata (`creativeMeta.apis`) to select bridges and to report the declared container runtime (`container.apiFramework`). AdCOM is the spec anchor; SHARC does not depend on an OpenRTB version.

| Code | AdCOM meaning | Bridge (R6) | `apiFramework` picker priority | Note |
|---|---|---|---|---|
| 3 | MRAID 1.0 | `mraid` | 2.2 | |
| 5 | MRAID 2.0 | `mraid` | 2.1 | |
| 6 | MRAID 3.0 | `mraid` | 2 | Within the MRAID family, the higher version wins. |
| 7 | OMID 1.0 | none | not a picker target | A measurement declaration. Never adds a bridge. With `omidAutoInstall` and an OMID measurement sidecar it can auto-install OMID measurement (L1 §1.14). |
| 9001 | SHARC (placeholder) | none | 1 | SHARC is a runtime, not a bridge. When present with an MRAID or SafeFrame code, it suppresses those bridges; OMID (7) is never suppressed. |
| 9002 | SafeFrame (placeholder) | `safeframe` | 3 | |
| any other code (VPAID 1–2, ORMMA 4, SIMID 8–9, vendor codes ≥ 500, unknown) | — | none | not a picker target | Ignored. Never a "load nothing" signal: an explicit `bridges: []` is that signal. |

- `9001` and `9002` are **placeholders**, pending upstream registration of SHARC and SafeFrame in AdCOM's `APIFramework` list. They are not citable outside this specification. At publication the published codes replace them.
- On the Creative URL variant, `creativeMeta` never produces bridges, and `container.apiFramework` is always `null` (Rule 3b).
- A non-integer `creativeMeta.apis` element throws `TypeError` at construction.

> Editorial note (erratum in the skeleton, corrected): skeleton row 3.8 gave the mapping as "3=MRAID3, 5/6 legacy MRAID handling". AdCOM v1.0 assigns 3 = MRAID 1.0, 5 = MRAID 2.0 and 6 = MRAID 3.0, and all three map to `mraid`. The pins are in `test:bridges-detection` (§3, the §5 truth table, and §14 `container.apiFramework === 6` for MRAID 3.0). The skeleton row carries a correction note.

<!-- trace: source=README §creativeMeta / §apiFramework + src/sharc-container.js ADCOM_API_TO_BRIDGE, _mapAdComApisToBridges (G12 supersession), _resolveApiFramework (picker priorities) + src/sharc-protocol.js SHARC_API_CODE / SAFEFRAME_API_CODE (placeholders) + AdCOM-as-spec-anchor decision | gate=test:bridges-detection (§3 apis→bridges; §5 truth table; §8 integer validation; §8.5 Rule 3b; §14 apiFramework accessor; OMID 7 never a bridge) -->

## R8 — Feature names

Namespaces (L2 §2.10): `com.iabtechlab.sharc.*` for IAB Tech Lab features; `com.*` reverse-domain names for third-party features.

| Feature name | Meaning | When the reference container advertises it |
|---|---|---|
| `com.iabtechlab.sharc.placement.resize` | Validated resize with close-region enforcement | Always |
| `com.iabtechlab.sharc.placement.constraints` | The creative can query constraints with `getPlacementConstraints` | Always |
| `com.iabtechlab.sharc.placement.animate` | Animated placement transitions | Always |
| `com.iabtechlab.sharc.creative-injector` | The container injected the creative SDK into the markup | Only when it actually injected |
| `com.iabtechlab.sharc.omid` | Container-owned OMID measurement | Only when the OMID extension is configured to measure |
| `com.iabtechlab.sharc.mraid` | The MRAID compatibility bridge is installed | When the operator passes the bridge as a container extension |
| `com.iabtechlab.sharc.safeframe` | The SafeFrame compatibility bridge is installed | When the operator passes the bridge as a container extension |
| `com.iabtechlab.sharc.safeframe.message` | Invoked by the SafeFrame bridge as `SHARC:Creative:requestMessage` (R3) | Not advertised separately |

`com.iabtechlab.sharc.audio` and `com.iabtechlab.sharc.location` appear in L2 §2.10 as examples. No feature specification for them exists in this document set, so they are not registered.

<!-- trace: source=api-reference.md §9 (Namespacing) + L2 §2.10 (reference feature merge order) + src/sharc-container.js feature merge (~:4081–4125) + src/sharc-safeframe-bridge.js (safeframe.message) | gate=partial: test:creative-sdk-injection 5d/8b (creative-injector advertised only when injected); test:omid-container-lifecycle (OMID name when configured, null when inert); rest GATE-DESIRED (L2 §2.10: no negotiation suite) -->

## R9 — Validator verdict buckets

The creative validator classifies each case into one bucket. The buckets and their attribution polarity are the vocabulary of the acceptance suites (L1 §1.3.3). A case in a SHARC-attributable bucket is a SHARC failure; a creative- or operator-attributable bucket means the container did its job.

| Bucket | Attribution | Ratified in |
|---|---|---|
| `passed` | — (pass) | — |
| `renderer-timeout`, `renderer-protocol`, `renderer-origin` | SHARC-attributable | DoD §G2 |
| `bridge-missing`, `bridge-api-error` | SHARC-attributable | DoD §G2 |
| `sharc-runner-error` | SHARC-attributable | DoD §G2 |
| `measurement-omid` | SHARC-attributable for cases that declared API 7 | DoD §G2 |
| `inconclusive` | SHARC-attributable (an unclassifiable outcome is an observability failure) | DoD §G2 |
| `navigation-policy` | SHARC-attributable when legitimate ad behavior is misclassified (false positive); creative-attributable for a real escape (true positive). On the URL variant, the `2118` backstop is the verdict: creative-attributable. | DoD §G2; G5 ADR |
| `creative-broken`, `network-cors`, `vendor-fetch-failed` | Creative- or vendor-attributable | DoD §G2 |
| `unsupported-input` | Out of the denominator (VAST, native) | DoD §G2 |
| `url-load-failed`, `url-load-timeout` | Operator or network; not SHARC | G5 ADR |
| `url-declared-api-unsupported` | Creative or operator (bid mis-declaration); not SHARC | G5 ADR |
| `declared-sharc-no-handshake` | Creative-attributable | G5 ADR |
| `renderer-integrity`, `mraid-lifecycle-gate` | Not stated in a ratified partition | — |

> Open (ruling required): the attribution of `renderer-integrity` and `mraid-lifecycle-gate` is not stated in the DoD §G2 partition or the G5 ADR. Both buckets are emitted by `tools/creative-validator/src/diagnose.js`.

<!-- trace: source=SHARC 1.0 Definition of Done §G2 partition table (2026-06-10, Obsidian) + G5 URL-mode ADR bucket table (2026-07-05, Obsidian; attribution polarity) + tools/creative-validator/src/diagnose.js (bucket set) | gate=test:creative-validator-diagnose; test:creative-validator-mraid-lifecycle-gates; test:creative-validator-url-lifecycle-gates; test:g5-url-contracts (R2 gates/buckets) -->

## R10 — `reportInteraction` tracker macros

With the IAB VAST 4 macro registry as the dataspec, the container substitutes these macros in each `reportInteraction` tracking URI and leaves every other macro byte-identical (L2 §2.6, Ruling 2).

| Macro | Value | Scope |
|---|---|---|
| `[CACHEBUSTING]` | A random 8-digit integer | One value per `reportInteraction` call |
| `[TIMESTAMP]` | The current time in ISO 8601, with milliseconds and a time-zone offset, percent-encoded | One value per `reportInteraction` call |

> DIVERGENCE (implementation bug, #465; GATE-DESIRED): the reference container performs no macro substitution (L2 §2.6).

<!-- trace: source=Ruling 2 (2026-10-03; VAST 4 macro registry, macros marked Required for all tracking pixels) + L2 §2.6 | gate=GATE-DESIRED (no test; implementation pending, #465) -->
