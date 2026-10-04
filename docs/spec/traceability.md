<!-- SHARC-DOC-STATUS: INFORMATIVE -->

# SHARC Requirement Traceability Index

**SHARC Specification 1.0 (Draft)**: the MUST → gate index

This index lists every RFC-2119 requirement line (MUST, MUST NOT, SHALL, SHALL NOT, REQUIRED) in the normative SHARC documents, with its conformance class, its pinning gate, and its pin status. It is the index named by the class-determination rule (L1 §1.3.5), and it is the checklist for the 1.0 succession test (G4).

The index is informative. Each requirement, its class and its gate are stated in the requirement's own section, and that section is authoritative. The rows here are copied from the trace footers and the in-text `GATE-DESIRED` / `DIVERGENCE` flags of each section. Building the index did not re-adjudicate any pin.

`npm run test:spec-structure` (contract b) enforces membership: every keyword line of a NORMATIVE document has exactly one row here, matched by the row's anchor, and every row's anchor matches exactly one keyword line. Lines that are wholly an HTML comment (the banner and `<!-- trace: … -->` footers) are metadata and are not indexed.

## Legend

**Documents** (the check reads this table):

| Key | File | Document |
|---|---|---|
| L1 | `docs/spec/container-runtime.md` | Container Runtime Specification |
| L2 | `docs/spec/creative-api.md` | Creative API Specification |
| REG | `docs/spec/registries.md` | SHARC Registries (no keyword lines) |
| CP | `docs/spec/compat-profile.md` | Compat Profile Specification (slice 3b; rows reserved below) |

**Columns.**

- **ID**: a stable row identifier.
- **Doc §**: the document key and section.
- **Anchor**: a verbatim substring of the indexed line, unique among that document's keyword lines.
- **Requirement**: a short summary. The section text is authoritative.
- **Class**: set by the requirement's addressee (L1 §1.3.5, requirement classes by addressee, ratified 2026-10-04); a requirement with no other stated addressee takes the class of its document ([P3], ratified 2026-10-04). `Core-L1` / `Core-L2`: addressed to the container (SHARC Core). `Host integration`: addressed to the host app that integrates SHARC in-app; a named requirement set inside L1 that binds hosts, not containers. `Compat`: addressed to a compatibility bridge (Compat Profile). `Creative (wire)`: addressed to the creative or creative-side library (the optional class, [P1]). A line that addresses two parties names both classes, each with its leg. The check allows exactly one row per line, so such a row is not split. `Meta` marks a keyword line that is not an implementation requirement: the Conventions block, or an editorial note or flag that names a requirement stated elsewhere.
- **Gate(s)**: the pinning tests, as the section's footer and flags name them. `npm test` runs `test:all`. A gate marked "not in `npm test`" is not yet promoted.
- **Status**: `PINNED`: the section credits a gate that pins the requirement. `PARTIAL`: some legs are pinned and the rest are `GATE-DESIRED`. `GATE-DESIRED`: no gate pins it. `DIVERGENCE #n`: the reference implementation violates it, tracked by issue *n*. `N/A` for `Meta` rows.
- **‡** marks a row whose footer is ambiguous about the pin or the class. Each one is listed under [Ambiguities](#ambiguities).

## L1: Container Runtime

| ID | Doc § | Anchor | Requirement | Class | Gate(s) | Status |
|---|---|---|---|---|---|---|
| L1-001 | L1 §Conventions | `The keywords MUST, MUST NOT, REQUIRED, SHALL` | RFC 2119 / RFC 8174 keyword conventions | Meta | NO-GATE (definitional) | N/A |
| L1-002 | L1 §1.7.2 | `messages that fail any of these checks` | Ignore, and do not terminate on, `:rendered` / `:failed` messages that fail the envelope checks | Core-L1 | test:creative-sources-load (silent-ignore matrix §7b–7d2) | PINNED |
| L1-003 | L1 §1.7.2 | `On mismatch the container MUST terminate with` | Terminate with `2116` when the renderer's origin echo mismatches | Core-L1 | test:creative-sources-load (origin echo; 2116/2117 precedence) | PINNED |
| L1-004 | L1 §1.8.2 | `A conforming container MUST NOT perform a state transition not enumerated` | No state transition outside the enumerated table | Core-L1 | test:lifecycle-ordering-conformance; test:active-frozen-edge; test:restore-single-authority; test:restore-level-reassert; test:restore-transient-hidden; test:non-sharc-loading (`loading` → `active`); in-app pre-clamped edges: test:g6-red (not in `npm test`) | PARTIAL ‡ |
| L1-005 | L1 §1.11.3 | `The router MUST derive a per-protocol nonce` | Derive each per-protocol nonce as an HMAC over the root nonce | Core-L1 | test:protocol-router-nonce-derivation (byte-level vector); test:protocol-router | PINNED |
| L1-006 | L1 §1.11.3 | `The truncation MUST be applied to the` | Truncate the raw 32-byte HMAC before base64url encoding (128 bits kept) | Core-L1 | test:protocol-router-nonce-derivation (entropy vector) | PINNED |
| L1-007 | L1 §1.11.3 | `The derivation MUST be salted with` | Salt the derivation with `placementSessionId` | Core-L1 | test:protocol-router-nonce-derivation | PINNED |
| L1-008 | L1 §1.11.3 | `The derived per-protocol nonce MUST NOT be exposed` | Never expose a per-protocol nonce on a creative-reachable surface (renderer-bootstrap fragment carve-out) | Core-L1 | test:omid-v1-router-isolation; fragment self-removal: test:renderer-prelude-nonce-self-remove (§1.7) | PINNED |
| L1-009 | L1 §1.11.3 | `The renderer-protocol nonce MUST NOT be delivered to any iframe-side code` | Never deliver the renderer-protocol nonce to iframe-side code | Core-L1 | test:omid-v1-router-isolation (as credited by the §1.11.3 footer) | PINNED ‡ |
| L1-010 | L1 §1.11.5 | `The container MUST detect the rule-7 carve-out` | Detect the wrapper rule-7 carve-out at construction | Core-L1 | test:creative-sources §9 | PINNED |
| L1-011 | L1 §1.11.5 | `The container MUST signal the carve-out` | Signal `wrapper_top_frame_inaccessible` with the required fields, correlated to the instance | Core-L1 | test:creative-sources §9 | PINNED |
| L1-012 | L1 §1.11.5 | `the container MUST proceed with construction` | `wrapperPolicy: 'warn'`: proceed, and emit with `severity: 'warning'` | Core-L1 | test:creative-sources §9a | PINNED |
| L1-013 | L1 §1.11.5 | `the container MUST emit the event with` | `wrapperPolicy: 'block'`: emit with `severity: 'error'`, then throw at construction | Core-L1 | test:creative-sources §9b | PINNED |
| L1-014 | L1 §1.17 | `a non-enum value MUST throw` | `hostContext` outside `'web'` / `'app'` throws `TypeError` | Core-L1 | NO-GATE (G6 pending; red contracts test:g6-red, not in `npm test`) | GATE-DESIRED |
| L1-015 | L1 §1.17.1 | `a value outside the enum MUST throw` | `setHostLifecycle` rejects a non-enum value with `TypeError` | Core-L1 | NO-GATE (G6 pending; test:g6-red, not in `npm test`) | GATE-DESIRED |
| L1-016 | L1 §1.17.1 | `MUST re-evaluate` | A more permissive host assertion recomputes most-severe(host, page) and promotes (ruling U7) | Core-L1 | NO-GATE (G6 pending; test:g6-red, not in `npm test`) | GATE-DESIRED |
| L1-017 | L1 §1.17.1 | `the host MUST re-assert the current state on every` | The host re-asserts lifecycle on every foreground return | Host integration | NO-GATE (G6 pending) | GATE-DESIRED |
| L1-018 | L1 §1.17.2 | `the host integration MUST assert BOTH inputs` | Backgrounding or covering asserts both `setHostLifecycle('hidden')` and `setHostExposure(0)` | Host integration | NO-GATE (G6 pending) | GATE-DESIRED |
| L1-019 | L1 §1.17.3 | `the host app MUST hold a strong reference` | HOST-REQ-1: keep the WebView alive for at least 1.0 s after session finish | Host integration | NO-GATE (G6 pending) | GATE-DESIRED |
| L1-020 | L1 §1.17.3 | `it MUST be called only AFTER step` | Native `JavaScriptSessionService` teardown runs only after the JS-side finish | Host integration | NO-GATE (G6 pending) | GATE-DESIRED |
| L1-021 | L1 §1.17.4 | `the container MUST NOT boot` | In-app, the container does not boot `omweb-v1.js` | Core-L1 | NO-GATE (G6 pending; service-mode red contract in test:g6-red, not in `npm test`) | GATE-DESIRED |
| L1-022 | L1 §1.17.4 | `the extension MUST NOT inject any service script` | `serviceMode: 'native'` injects no service script | Core-L1 | NO-GATE (G6 pending; test:g6-red, not in `npm test`) | GATE-DESIRED |
| L1-023 | L1 §1.17.4 | `no silent default-on-garbage` | A `serviceMode` outside the enum throws `TypeError` at construction | Core-L1 | NO-GATE (G6 pending; test:g6-red, not in `npm test`) | GATE-DESIRED |
| L1-024 | L1 §1.17.4 | `combined with a configured service-script URL MUST throw` | `'native'` plus a service-script URL throws `TypeError` | Core-L1 | NO-GATE (G6 pending; test:g6-red, not in `npm test`) | GATE-DESIRED |
| L1-025 | L1 §1.17.4 | `MUST agree within rounding tolerance` | In-app, composer `effectivePercent` and OM SDK `percentageInView` agree at steady state | Core-L1 | NO-GATE (G6 conformance harness, pending) | GATE-DESIRED |
| L1-026 | L1 §1.19 | `window the container MUST fatal-error with` | Armed `createSession` timeout: fatal-error with `2212` and terminate (Ruling 3) | Core-L1 | test:non-sharc-loading §1 (`onError(2212)` only); validator gate-U2 | PARTIAL |
| L1-027 | L1 §1.19 | `GATE-DESIRED: the termination leg of the` | Flag on the `2212` termination leg (the requirement is L1-026) | Meta | — | N/A |

## L2: Creative API

| ID | Doc § | Anchor | Requirement | Class | Gate(s) | Status |
|---|---|---|---|---|---|---|
| L2-001 | L2 §Conventions | `The keywords MUST, MUST NOT, REQUIRED, SHALL` | RFC 2119 / RFC 8174 keyword conventions | Meta | NO-GATE (definitional) | N/A |
| L2-002 | L2 §Extraction status | `the standing rule is: descriptive prose is corrected` | The standing divergence rule (extraction practice) | Meta | — | N/A |
| L2-003 | L2 §Extraction status | `Three spec rulings, ratified 2026-10-03, are folded in` | Record of Rulings 1–3 | Meta | — | N/A |
| L2-004 | L2 §2.4 | `MUST fatal-error with` | Armed `createSession` timeout: fatal-error with `2212` and terminate (Ruling 3; same requirement as L1-026) | Core-L2 | test:non-sharc-loading §1 (`onError(2212)` only) | PARTIAL |
| L2-005 | L2 §2.4 | `stated this descriptively` | Editorial note on the Ruling 3 promotion | Meta | — | N/A |
| L2-006 | L2 §2.4 | `GATE-DESIRED: the strict-mode` | Flag on the `2212` termination leg | Meta | — | N/A |
| L2-007 | L2 §2.5 | `the creative cannot receive messages in those states` | Never send `stateChange` carrying `loading` or `terminated` | Core-L2 | test:state-dedup D-4; test:container-state-establish-push C3/C8; test:lifecycle-ordering-conformance | PINNED |
| L2-008 | L2 §2.5 | `had promoted it to a MUST` | Editorial note: the effective-visibility wire-honesty sentence stays lower-case | Meta | — | N/A |
| L2-009 | L2 §2.6 | `The container MUST:` | `reportInteraction`: fire valid URIs in parallel, HTTP GET, 5 s timeout per URI, no retry, resolve when all have settled | Core-L2 | — | GATE-DESIRED |
| L2-010 | L2 §2.6 | `source MUST restored; ratified 2026-10-03, Ruling 2` | Editorial note on Ruling 2 | Meta | — | N/A |
| L2-011 | L2 §2.6 | `The MUST list above, the 20-entry cap` | Flag: `reportInteraction` unpinned | Meta | — | N/A |
| L2-012 | L2 §2.6 | `the container MUST substitute` | Substitute `[CACHEBUSTING]` and `[TIMESTAMP]`, one value each per call, and leave other macros byte-identical (Ruling 2) | Core-L2 | — | DIVERGENCE #465 (GATE-DESIRED) |
| L2-013 | L2 §2.6 | `The container MUST validate` | `requestNavigation`: validate `url`; reject a non-http(s) scheme with `2211`; do not open it (Ruling 3) | Core-L2 | — (container-level tests come with #455 / #464) | DIVERGENCE #455 (empty `url`; GATE-DESIRED) |
| L2-014 | L2 §2.6 | `stated these three rules descriptively` | Editorial note on the Ruling 3 promotion | Meta | — | N/A |
| L2-015 | L2 §2.6 | `This contradicts` | DIVERGENCE note for #455 | Meta | — | N/A |
| L2-016 | L2 §2.8.2 | `INV-1 (Exactly-once consecutive)` | INV-1: no two identical consecutive `stateChange` values on a session | Core-L2 | test:state-dedup; test:container-state-establish-push | PINNED |
| L2-017 | L2 §2.8.2 | `INV-2 (Distinct values always flow)` | INV-2: the dedup suppresses only an identical consecutive value | Core-L2 | test:state-dedup; test:container-state-establish-push | PINNED |
| L2-018 | L2 §2.8.2 | `INV-3 (Symmetric single` | INV-3: `active` delivered exactly once on both establish paths | Core-L2 | test:state-dedup; test:container-state-establish-push | PINNED |
| L2-019 | L2 §2.8.2 | `Placement of the dedup is normative in effect` | Dedup placement: sees every send, incl. the establish push; per session; runs after refusal / no-session; establish push not made conditional | Core-L2 | §2.8 footer: test:state-dedup; test:container-state-establish-push (no gate named for this paragraph) | PINNED ‡ |
| L2-020 | L2 §2.8.2 | `source RFC strength restored` | Editorial note: MUST NOT restored | Meta | — | N/A |
| L2-021 | L2 §2.8.3 | `INV-4 (Establish completeness)` | INV-4: a late-establishing creative receives the current state; unconditional establish push | Core-L2 | test:container-state-establish-push | PINNED |
| L2-022 | L2 §2.8.3 | `INV-5 (Establish push ordering vs the session gate)` | INV-5: establish push only after the creative's `sessionId` is set | Core-L2 | test:container-state-establish-push | PINNED |
| L2-023 | L2 §2.8.3 | `INV-6 (Honest init seed)` | INV-6: init `currentState` is the real queryable state; `ready` when non-queryable | Core-L2 | test:container-state-establish-push C4 (real-state leg); test:creative-state-replay (creative seed) | PARTIAL (non-queryable fallback GATE-DESIRED) |
| L2-024 | L2 §2.8.4 | `INV-7 (` | INV-7: `ready` precedes `active` | Core-L2 | test:lifecycle-ordering-conformance L1; test:container-state-establish-push C5 | PINNED |
| L2-025 | L2 §2.8.4 | `INV-8 (No premature viewability)` | INV-8: a bridge signals no viewability before `active` is delivered | Compat | test:lifecycle-ordering-conformance L2 (channel side); test:mraid-visibility-channel T8 (MRAID burst ordering) | PARTIAL (EV-before-`active` leg GATE-DESIRED; suspected DIVERGENCE #467) |
| L2-026 | L2 §2.8.4 | `INV-9 (Queryable floor before` | INV-9: nothing at or above `ready` observed before `ready` | Core-L2 | test:lifecycle-ordering-conformance L1; test:container-state-establish-push | PINNED |
| L2-027 | L2 §2.8.4 | `INV-10 (Oscillation is non-latching and repeatable)` | INV-10: oscillating edges flow on every traversal | Core-L2 | test:lifecycle-ordering-conformance L3; test:container-state-establish-push; test:creative-state-replay | PINNED |
| L2-028 | L2 §2.8.4 | `which the extraction draft had dropped, is restored` | Editorial note: INV-10 edge list corrected | Meta | — | N/A |
| L2-029 | L2 §2.8.4 | `INV-11 (` | INV-11: no `stateChange` after the terminal signal | Core-L2 | test:lifecycle-ordering-conformance L4; test:container-state-establish-push | PINNED |
| L2-030 | L2 §2.8.4 | `INV-12 (Queryable-only on the wire)` | INV-12: only creative-queryable states on the wire; sessionless sends nothing | Core-L2 | test:state-dedup; test:container-state-establish-push; test:html-lifecycle-adapter | PINNED |
| L2-031 | L2 §2.8.4 | `INV-13 (` | INV-13: exactly one terminal signal (`hidden`) | Core-L2 | test:lifecycle-ordering-conformance L4; test:container-state-establish-push C8 | PINNED |
| L2-032 | L2 §2.8.5 | `INV-14 (Replay exactly once)` | INV-14: a late listener is replayed the current state once, synchronously | Creative (wire) | test:creative-state-replay | PINNED |
| L2-033 | L2 §2.8.5 | `INV-15 (Replay scope = lifecycle` | INV-15: replay only `stateChange`; one-shot events are not replayed | Creative (wire) | test:creative-state-replay N3 (error and log legs) | PARTIAL (close and placement-transition-end legs GATE-DESIRED) |
| L2-034 | L2 §2.8.5 | `INV-16 (Replay does not re-drive the live bus)` | INV-16: replay goes to the registering listener only | Creative (wire) | test:creative-state-replay | PINNED |
| L2-035 | L2 §2.8.5 | `INV-17 (Replay reflects the LAST value)` | INV-17: replay the last value, not the first | Creative (wire) | test:creative-state-replay | PINNED |
| L2-036 | L2 §2.8.5 | `INV-18 (Replay never precedes` | INV-18: no replay before the cache is seeded | Creative (wire) | test:creative-state-replay N2c (missing-seed leg) | PARTIAL (non-queryable-seed leg GATE-DESIRED) |
| L2-037 | L2 §2.8.5 | `INV-19 (No double-fire under interleaving)` | INV-19: exactly once under any interleaving | Creative (wire) | test:creative-state-replay | PINNED |
| L2-038 | L2 §2.8.5 | `The replay cache is per session` | The creative-side replay cache resets on session teardown | Creative (wire) | — | DIVERGENCE #454 (GATE-DESIRED) |
| L2-039 | L2 §2.8.7 | `INV-20 (Strict per-session state)` | INV-20: state delivery scoped to the owning session; the creative gate drops a foreign `sessionId` | Core-L2 (container legs); Creative (wire) (creative-side session gate) | test:container-state-establish-push C2 (`''` sessionId leg) | PARTIAL (mismatch leg GATE-DESIRED) |
| L2-040 | L2 §2.8.7 | `INV-21 (Per-session dedup and cache state)` | INV-21: the dedup value and replay cache are per session and reset | Core-L2 (container dedup half); Creative (wire) (creative replay-cache half) | test:state-dedup D-6 (container half) | DIVERGENCE #454 (creative half; GATE-DESIRED) |
| L2-041 | L2 §2.8.7 | `INV-22 (No cross-placement observability)` | INV-22: no path for one placement to observe another's state | Core-L2 | — (structural) | GATE-DESIRED |
| L2-042 | L2 §2.8.7 | `INV-22 is structural` | Flag on INV-22 | Meta | — | N/A |
| L2-043 | L2 §2.9 | `OR-1 (Multi-listener)` | OR-1: readiness supports N listeners; registration appends | Creative (wire) | test:onready-replay | PINNED |
| L2-044 | L2 §2.9 | `OR-2 (Replay-last-once)` | OR-2: each readiness listener invoked exactly once (live or replayed) | Creative (wire) | test:onready-replay | DIVERGENCE #458 (throw-abort leg; GATE-DESIRED) |
| L2-045 | L2 §2.9 | `OR-3 (Per-session)` | OR-3: readiness state is per session and reset on teardown | Creative (wire) | test:onready-replay | PINNED |
| L2-046 | L2 §2.9 | `OR-4 (Never precedes creative-rendered / load)` | OR-4: readiness never fires before the creative-rendered anchor | Creative (wire) | test:lifecycle-conjunction-gate; test:lifecycle-load-anchor; test:creative-validator-url-lifecycle-gates | PINNED |
| L2-047 | L2 §2.9 | `OR-5 (Environment honesty preserved)` | OR-5: a replayed readiness carries the same honest `currentState` | Creative (wire) | test:onready-replay | PINNED |
| L2-048 | L2 §2.9 | `a pre-init readiness listener that throws aborts` | DIVERGENCE note for #458 | Meta | — | N/A |
| L2-049 | L2 §2.9 | `Editorial note (OR-2, OR-4, OR-6 vs the ADR)` | Editorial note on OR-2 / OR-4 / OR-6 wording | Meta | — | N/A |

## REG: Registries

`docs/spec/registries.md` has no RFC-2119 keyword lines. Its entries assign identifiers; the behavior attached to each identifier is a requirement of the section the entry cites, and is indexed there. The table-level gate of each registry is stated in the registry. R1, R2 and R3 have no test that compares the table with the reference implementation's constants, and R10's implementation is pending (#465).

## CP: Compat Profile (reserved, slice 3b)

Rows for `docs/spec/compat-profile.md` are added when slice 3b lands it. The legend entry above already exists, so the check will require them as soon as that file carries a NORMATIVE banner and keyword lines. Requirements the extraction has already marked for the Compat Profile:

| Reserved for | Source | Note |
|---|---|---|
| Compat §3.1–§3.2 | skeleton §C | Posture and profile conformance |
| Compat §3.3 | 0.7.1-bridges-field; README §Bridge Detection | Bridge selection; identifiers are registries.md R6 / R7 |
| Compat §3.4–§3.5 | mraid-bridge-design.md | MRAID bridge; INV-8 MRAID clause (L2-025) is a candidate to move |
| Compat §3.6 | safeframe-bridge-design.md | SafeFrame bridge; INV-8 SafeFrame clause; #459–#462 |
| Compat §3.7–§3.9 | G5 ADR; Legacy §Compatibility Modes | URL-variant structural exclusion; legacy compatibility statement |

## Clause-level flags outside the keyword index

These flags sit on lower-case or descriptive prose, so the keyword index does not reach them. They are listed so that G4 sees every open divergence.

| Doc § | Flag | Note |
|---|---|---|
| L1 §1.4 | Residual (ruling required) | SSAI zero-timeout sentence in §1.19; the `2204` change of meaning |
| L1 §1.18; L2 §2.6, §2.13; registries.md R2 | DIVERGENCE #464 | Navigation handoff sent as `2200`, not `2214` |
| L2 §2.5 `placementTransitionEnd` | DIVERGENCE #456 | Not sent for `fullscreen` / `collapse` with a `transition` |
| L2 §2.5 `audioVolumeChange` | DIVERGENCE #468 | Buffered values not flushed on the adapter-driven return to `active` (NHI C7) |
| L2 §2.6 `requestPlacementChange` | DIVERGENCE #457 | `resize` without `targetDimensions` is not rejected |
| L2 §2.6 `request[FeatureName]` | DIVERGENCE (ruling required) | Response correlation |
| registries.md R9 | Open (ruling required) | Attribution of `renderer-integrity` and `mraid-lifecycle-gate` |

## Ambiguities

Rows marked ‡, with what makes them ambiguous. None is resolved here.

1. **L1-004**: the §1.8 footer lists gates for the section as a whole. It does not say which test asserts that a non-enumerated transition is refused.
2. **L1-009**: the §1.11.3 footer credits `test:omid-v1-router-isolation` with "nonce never crosses into the iframe". That suite is OMID-side, and the footer names no renderer-nonce-specific assertion.
3. **L2-019**: the dedup-placement paragraph's MUSTs have no gate of their own. Its PINNED status follows the §2.8 section status, which flags no leg of it as GATE-DESIRED.

Resolved by the requirement classes by addressee (L1 §1.3.5, ratified 2026-10-04), and no longer marked ‡: L1-017 … L1-020 bind the host integration, so they are `Host integration`; L2-025 (INV-8) binds compatibility bridges, so it is `Compat`. INV-8's SafeFrame clause is still slated to move to the Compat Profile (L2 §2.8.4 note).

## Statistics

| | L1 | L2 | Total |
|---|---|---|---|
| Rows (keyword lines indexed) | 27 | 49 | **76** |
| `Meta` rows | 2 | 15 | 17 |
| Requirement rows | 25 | 34 | **59** |
| PINNED | 11 | 21 | **32** |
| PARTIAL | 2 | 6 | **8** |
| GATE-DESIRED | 12 | 2 | **14** |
| DIVERGENCE | 0 | 5 | **5** (#454 ×2, #455, #458, #465) |
| ‡ ambiguous | 2 | 1 | **3** |

Requirement rows by class:

| Class | Rows | PINNED | PARTIAL | GATE-DESIRED | DIVERGENCE |
|---|---|---|---|---|---|
| `Core-L1` | 21 | 11 | 2 | 8 | 0 |
| `Host integration` | 4 | 0 | 0 | 4 | 0 |
| `Core-L2` | 19 | 13 | 2 | 2 | 2 |
| `Compat` | 1 | 0 | 1 | 0 | 0 |
| `Creative (wire)` | 12 | 8 | 2 | 0 | 2 |
| `Core-L2` + `Creative (wire)` (one line, two addressees: L2-039, L2-040) | 2 | 0 | 1 | 0 | 1 |
| **Total** | **59** | **32** | **8** | **14** | **5** |

All twelve of L1's GATE-DESIRED rows are §1.17 in-app requirements waiting on the G6 gate: eight `Core-L1` and the four `Host integration` rows.
