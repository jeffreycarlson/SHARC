# ADR 0001: SHARC Container Size Budget

## Status

Accepted for 0.7.9.

## Context

SHARC uses `size-limit` budgets as release gates. These budgets are limits, not
optimization targets: their job is to catch unbounded growth while leaving enough
headroom for ordinary maintenance and planned features.

The 0.7.8 release left the two user-facing bundle entry points with very little
headroom under their existing limits:

| Bundle | Path | 0.7.8 size | 0.7.8 limit | Headroom |
|---|---|---:|---:|---:|
| sharc-protocol | `dist/sharc-protocol.js` | 3,264 B | 15,000 B | 11,736 B / 78.2% |
| sharc-container | `dist/sharc-container.js` | 24,697 B | 25,000 B | 303 B / 1.2% |
| sharc-creative | `dist/sharc-creative.js` | 5,640 B | 6,000 B | 360 B / 6.0% |
| sharc-mraid-bridge | `dist/sharc-mraid-bridge.js` | 3,135 B | 30,000 B | 26,865 B / 89.6% |
| sharc-safeframe-bridge | `dist/sharc-safeframe-bridge.js` | 2,140 B | 30,000 B | 27,860 B / 92.9% |
| sharc-omid-bridge | `dist/sharc-omid-bridge.js` | 4,742 B | 25,000 B | 20,258 B / 81.0% |
| sharc-omid-shim | `dist/sharc-omid-shim.js` | 1,400 B | 4,000 B | 2,600 B / 65.0% |
| sharc-navigation-bridge | `dist/sharc-navigation-bridge.js` | 1,132 B | 10,000 B | 8,868 B / 88.7% |

The recent growth is concentrated in the OMID path. The committed
`docs/size-history/0.7.7.json` and `docs/size-history/0.7.8.json` snapshots show
the container moving from 23,339 B to 24,697 B (+1,358 B) and the OMID bridge
from 3,401 B to 4,742 B (+1,341 B). Between `v0.7.7` and `v0.7.8`,
`src/sharc-container.js`, `src/sharc-omid-bridge.js`, and the new
`src/sharc-omid-shim.js` gained 1,125 net source lines across the core OMID
bridge and geometry work, including:

- `feat: 0.7.8 OMID bridge -- core + Markup variant (producer) (#250)`
- `fix: emit OMID geometry viewability data (#289)`

The 0.7.9 pre-release snapshot currently has the same bundle byte sizes as
0.7.8, but without a budget decision the next meaningful container or creative
change is likely to fail CI for budget reasons before there is a product-level
reason to refactor.

## Decision

Raise the `sharc-container` size limit from 25 KB to 30 KB and the
`sharc-creative` size limit from 6 KB to 8 KB in 0.7.9.

The 30 KB container limit creates 5,303 B of headroom, enough for roughly two
more changes on the scale of the `fix: emit OMID geometry viewability data`
work before the gate re-fires, without jumping to a 35 KB ceiling that would
mute size review through 1.0. The 8 KB creative limit gives the renderer similar
short-term room for OMID markup and validation work while keeping it well below
the bridge budgets.

This buys explicit release-engineering headroom for the next several minors
while preserving size as a hard gate. The new limits still keep the container
and creative bundles small, but avoid turning the size gate into a forcing
function for premature refactoring during the 0.7.9 hardening cycle. The bridge
budgets stay unchanged because they retain substantial headroom.

## Options Considered

### Option A: Raise the near-exhausted budgets

Raise `sharc-container` to 30 KB and `sharc-creative` to 8 KB. This keeps the
gate meaningful while recognizing that both bundles are already within a few
hundred bytes of their prior ceilings.

This is the selected option.

### Option B: Refactor for headroom now

Refactor `sharc-container.js` to move more OMID geometry or adapter-selection
work out of the container bundle. For example, moving the geometry-translation
table and associated normalization helpers behind an OMID-specific entry point
could plausibly recover roughly 2-4 KB based on file inspection. That is a
product-code change with API-adjacent risk and should not be bundled into the
release-engineering hardening cycle without a dedicated design pass.

### Option C: Hold the line

Keep the 25 KB and 6 KB limits and let the next red size-budget check force a
decision. This maximizes pressure on bundle discipline, but at the current
headroom level it would likely make routine 0.7.10 work fight the gate rather
than the design.

## Consequences

The size gate remains active, but the new budget signal shifts from "any
non-trivial change fails" to "unexpected growth still fails." After this change,
the current 0.7.9 pre-release sizes have:

| Bundle | Size | New limit | Headroom |
|---|---:|---:|---:|
| sharc-container | 24,697 B | 30,000 B | 5,303 B / 17.7% |
| sharc-creative | 5,640 B | 8,000 B | 2,360 B / 29.5% |

The decision does not change runtime behavior, package exports, or public APIs.
It also does not remove the need for a future container-size refactor if growth
continues.

The trade-off is that unexpected growth must now clear a higher noise floor.
For 1.0, size policy should separate aspirational targets from hard release
limits so budget increases do not become implicit optimization goals.

## Reversibility

This is reversible by lowering `.size-limit.json` once a refactor creates real
headroom or once 1.0 planning defines separate size targets and hard limits. The
committed snapshots in `docs/size-history/` provide the starting baseline for a
future release-over-release growth guard.
