# SHARC Container Lifecycle Decision

**Author:** Software Architect (Research Subagent)  
**For:** Jeffrey Carlson, SHARC Working Group  
**Date:** 2026-04-14  
**Status:** Final decision adopted for SHARC v1 terminology

---

## Decision Summary

SHARC v1 uses a Page Lifecycle aligned model with two container-internal bookends:

```text
loading → ready → active ↔ passive ↔ hidden → frozen → terminated
```

This is the canonical lifecycle terminology for docs, comments, examples, and future spec text.

### Canonical rules

- `loading` and `terminated` are **container-internal bookends only**
- Creative-queryable states are **`ready`, `active`, `passive`, `hidden`, `frozen`**
- `closing` is **not** a lifecycle state in SHARC v1
- Close handling uses the **`Container:close` message flow**
- `frozen` is a real reported state, but it is **not** a safe phase for work
- Creatives should pause, persist, and release resources when entering **`hidden`**

---

## Canonical Lifecycle

| State | Creative-queryable? | Meaning | Implementation guidance |
|---|---:|---|---|
| `loading` | No | Container created the iframe/WebView and is establishing SHARC | Internal only, never sent via `stateChange` |
| `ready` | Yes | Init completed, creative can prepare but is not yet running visibly | Safe place for setup work |
| `active` | Yes | Visible, focused, interactive | Normal running state |
| `passive` | Yes | Visible but not focused | Reduce activity if focus matters |
| `hidden` | Yes | Not visible, but JS still runs | **Pause, save state, and release non-essential resources here** |
| `frozen` | Yes (as last known state) | OS/browser has suspended work or is about to | Informational/reporting state, **not** a work phase |
| `terminated` | No | Container torn down, no further communication possible | Internal only, never sent via `stateChange` |

### Canonical transition model

```text
loading → ready → active ↔ passive ↔ hidden → frozen → terminated
```

Notes:
- `ready`, `active`, `passive`, `hidden`, and `frozen` are the only states a creative should reason about.
- A resumed container may move from `frozen` back to `hidden`, `passive`, or `active`, depending on platform visibility and focus.
- Termination is container-owned. Once the container reaches `terminated`, the creative is gone.

---

## Why this model won

This terminology is the cleanest match to browser and mobile platform lifecycle semantics:

- `active`, `passive`, `hidden`, and `frozen` align with Page Lifecycle vocabulary developers already understand
- `loading` and `terminated` clearly describe the non-queryable container bookends
- The model separates **lifecycle** from **placement**
- The model avoids inventing a synthetic lifecycle state for close handling when `Container:close` already exists

This gives SHARC one lifecycle vocabulary across web iframes, iOS WKWebView, and Android WebView.

---

## Historical term replacements

Use these replacements consistently:

| Historical term | Replace with | Why |
|---|---|---|
| `created` | `loading` | Better describes pre-init work |
| `inactive` | `passive` | Matches Page Lifecycle terminology |
| `destroyed` / `unloaded` | `terminated` | Canonical terminal name |
| `closing` state | `Container:close` flow | Close is a message flow, not a lifecycle state |

Short version: **`terminated` replaces `unloaded`, and `closing` is no longer a state name.**

---

## Lifecycle vs. placement

SHARC lifecycle answers: "Can the creative run, is it visible, and does it have focus?"

Placement answers: "What size and position is the container using?"

That means:
- `expanded` is a placement condition, not a lifecycle state
- `resized` is a placement condition, not a lifecycle state
- lifecycle transitions do not imply placement changes, and placement changes do not create new lifecycle states

---

## Close handling

SHARC v1 does not define a `closing` lifecycle state.

Instead, the close path is:
1. Container or creative initiates close
2. `Container:close` is sent
3. The creative gets a brief chance to finish trackers or UI wind-down work
4. The container tears down the execution context
5. The container reaches `terminated`

This keeps lifecycle reporting simple while preserving graceful close behavior.

---

## Platform mapping reference

| SHARC state | Web | iOS WKWebView | Android WebView |
|---|---|---|---|
| `loading` | iframe created, handshake starting | WebView allocated, content loading | WebView created, content loading |
| `ready` | `Container:init` resolved | init complete | init complete |
| `active` | visible + focused | app active, view visible | `onResume()` + visible |
| `passive` | visible + not focused | interruption or split-screen inactive phase | paused but still visible / multi-window |
| `hidden` | tab/page hidden | app backgrounded | `onStop()` |
| `frozen` | page freeze / suspended execution | content process suspended or about to be killed | timers/process work suspended |
| `terminated` | iframe removed | view/process torn down | `onDestroy()` or process removal |

---

## Implementation guidance for docs and examples

When describing creative behavior:

- tell developers to do pause/save work in **`hidden`**
- describe **`frozen`** as informational and possibly non-executable
- refer to close as the **`Container:close` flow**, not a `closing` state
- refer to the terminal bookend as **`terminated`**, not `unloaded`

That terminology is final for SHARC v1.
