# SHARC OpenRTB Supply Chain Signaling

**Author:** Software Architect  
**Audience:** Jeffrey Carlson (SHARC co-chair), IAB Tech Lab OpenRTB/AdCOM WG  
**Status:** Research draft — input for formal WG proposal  

---

## 1. The Question

How does the OpenRTB supply chain signal (a) that a placement supports SHARC, and (b) that a buyer's creative uses SHARC? Which specific fields in OpenRTB 2.x / AdCOM 1.0 carry these signals, and what needs to change?

---

## 2. How SIMID Is Currently Signaled (Reference Model)

SIMID is the closest precedent — a secure interactive container for video, registered in AdCOM and signaled via OpenRTB's `api` integer array.

### 2.1 AdCOM API Frameworks List (current)

| Value | Framework |
|-------|-----------|
| 1 | VPAID 1.0 |
| 2 | VPAID 2.0 |
| 3 | MRAID 1.0 |
| 4 | ORMMA |
| 5 | MRAID 2.0 |
| 6 | MRAID 3.0 |
| 7 | OMID 1.0 |
| 8 | SIMID 1.0 |
| 9 | SIMID 1.1 |
| 500+ | Vendor-specific |

**Source:** AdCOM v1.0 FINAL, §List: API Frameworks.

### 2.2 SIMID Bid Request — Container Declares Support

In OpenRTB 2.x, the container declares which API frameworks it supports in the impression-level `api` field on the relevant placement subtype object:

| Object | Field | Notes |
|--------|-------|-------|
| `BidRequest.Imp.Banner.api` | `integer array` | For display placements with SIMID companion support |
| `BidRequest.Imp.Video.api` | `integer array` | Primary location for SIMID; video player signals SIMID support |
| `BidRequest.Imp.Audio.api` | `integer array` | For audio with interactive companion |

The SSP/publisher sets `"api": [8]` (SIMID 1.0) or `"api": [9]` (SIMID 1.1) to tell buyers: *this placement can run SIMID interactive ads.*

In AdCOM 1.0 (OpenRTB 3.0), the equivalent field is `Placement.VideoPlacement.api` or `Placement.DisplayPlacement.api`.

### 2.3 SIMID Bid Response — Buyer Declares Usage

The buyer echoes the API requirement back in the bid response:

| Object | Field | Notes |
|--------|-------|-------|
| `BidResponse.SeatBid.Bid.apis` | `integer array` | **OpenRTB 2.6+** — preferred; buyer states which APIs the markup requires |
| `BidResponse.SeatBid.Bid.api` | `integer` (DEPRECATED) | OpenRTB 2.4–2.5 equivalent |

The buyer sets `"apis": [8]` to declare: *this creative requires SIMID 1.0 support.*

**Important note on `bidrequest.imp.video`:** SIMID is signaled on `Imp.Video.api`, not via `Imp.Video.protocols`. `protocols` carries VAST version enums (1=VAST 1.0 … 8=VAST 4.0, etc.). SIMID is an interactive overlay layer on top of VAST, not a VAST protocol itself. The `api` field is the correct vehicle.

### 2.4 OMSDK as the Other Precedent

The OMSDK advisory (IAB Tech Lab, 2018) established the same pattern for OMID:
- Bid request: `Banner/Video/Native.api = [7]` → placement supports OMID measurement
- Bid response: `Bid.apis = [7]` → markup requires OMID

This is the established IAB Tech Lab playbook for registering a new API framework.

---

## 3. Where SHARC Fits (and Where SIMID Doesn't Apply)

SHARC is a **display** container, not a video container. The signal path is therefore:

- **Not** `Imp.Video.api` — SHARC is not a video framework  
- **Yes** `Imp.Banner.api` — the correct home for display-context API support in OpenRTB 2.x  
- **Yes** `Placement.DisplayPlacement.api` — the correct home in AdCOM 1.0 / OpenRTB 3.0  

SHARC can appear alongside SIMID in the same impression (e.g., SIMID interactive video + SHARC companion end-card), but each framework is declared separately on its respective placement type.

---

## 4. Required Changes to Formally Register SHARC

### 4.1 AdCOM: Add SHARC to API Frameworks List

**File:** AdCOM v1.0, §List: API Frameworks  
**Change:** Add two new values:

| Value | Framework |
|-------|-----------|
| 10 | SHARC 1.0 |
| (11) | SHARC 1.1 *(reserve for next version)* |

Values 8 and 9 (SIMID) set the precedent for version-granular entries. SHARC should follow the same pattern.

**Rationale:** The `api` field uses closed-world semantics — if a value is absent, the framework is assumed unsupported. SHARC must be in the registered list for interoperability.

### 4.2 AdCOM: Add "Structured SHARC" to Creative Subtypes — Display

**File:** AdCOM v1.0, §List: Creative Subtypes — Display  
**Current values:**

| Value | Definition |
|-------|-----------|
| 1 | HTML |
| 2 | AMPHTML |
| 3 | Structured Image Object |
| 4 | Structured Native Object |

**Change:** Add:

| Value | Definition |
|-------|-----------|
| 5 | Structured SHARC |

This allows `DisplayPlacement.ctype` (placement declares acceptable creative subtypes) and `Ad.Display.ctype` (buyer declares what they're delivering) to carry SHARC identity independently of the `api` field.

**When both are used:** `api` signals *runtime capability* (the container supports the SHARC API); `ctype=5` signals *creative format* (the markup is a structured SHARC creative). Both should be present.

### 4.3 AdCOM: No Changes Required to `DisplayPlacement` Object Structure

The `DisplayPlacement` object already has `api` (integer array) and `ctype` (integer array) fields. Adding SHARC requires only the enum list updates above — no new fields on the object itself.

### 4.4 OpenRTB 2.x: No Structural Changes Required

`Banner.api`, `Video.api`, `Audio.api`, `Native.api` all exist and reference the AdCOM API Frameworks list by pointer. Once SHARC is registered in that list, `"api": [10]` is valid in any of these objects without any OpenRTB 2.x spec changes.

`Bid.apis` similarly requires no structural change — buyers set `"apis": [10]` to declare SHARC creative.

---

## 5. Bid Request / Response Flow

### 5.1 Placement Declares SHARC Support (Bid Request)

**OpenRTB 2.x path:**

```json
{
  "imp": [{
    "id": "1",
    "banner": {
      "w": 320,
      "h": 480,
      "api": [10],
      "ctype_permitted": [1, 5]
    }
  }]
}
```

> Note: `ctype_permitted` is illustrative — in OpenRTB 2.x, the display creative subtype filter lives in `DisplayPlacement.ctype` (AdCOM/OpenRTB 3.0). OpenRTB 2.x `Banner` has no `ctype` field; the API signal alone is sufficient.

**AdCOM 1.0 / OpenRTB 3.0 path (cleaner):**

```json
{
  "placement": {
    "display": {
      "api": [10],
      "ctype": [1, 5]
    }
  }
}
```

Both `api: [10]` (SHARC runtime available) and `ctype: [5]` (Structured SHARC creative accepted) should be set.

### 5.2 Buyer Declares SHARC Creative (Bid Response)

**OpenRTB 2.x:**

```json
{
  "seatbid": [{
    "bid": [{
      "impid": "1",
      "price": 2.50,
      "mtype": 1,
      "apis": [10],
      "adm": "<!-- SHARC creative HTML -->",
      "attr": []
    }]
  }]
}
```

Key fields:
- `mtype: 1` → Banner (display) markup
- `apis: [10]` → markup requires SHARC 1.0 runtime

**AdCOM 1.0 (under the `Ad` object):**

```json
{
  "ad": {
    "display": {
      "api": [10],
      "ctype": 5,
      "adm": "<!-- SHARC creative HTML -->"
    }
  }
}
```

### 5.3 Full Supply Chain Sequence

```
Publisher / SSP                    Exchange / DSP
─────────────────────────────────────────────────────────────
Container renders with SHARC
  → imp.banner.api = [10]       ──────────────────────────→
                                    DSP sees SHARC-capable slot
                                    DSP has SHARC creative
                                  ←──────────────────────────
                                    bid.apis = [10]
                                    bid.mtype = 1
                                    bid.adm = SHARC HTML
Exchange validates bid:
  - bid.apis ⊆ imp.banner.api?  ✅ [10] ⊆ [10]
  - mtype matches? ✅ Banner
Container instantiates SHARC
  creative via MessageChannel
```

---

## 6. Interim Convention (Pre-Standardization)

Per the SHARC pitch doc and product scope:

> "The OpenRTB/AdCOM updates are in progress. In the interim, use the existing `api` field in Display Placement."

**Interim approach:** Use a vendor-specific code (500+) or coordinate a provisional value with trading partners. Example: `"api": [500]` with out-of-band agreement that 500 = SHARC 1.0. This is the same pattern used before OMID and SIMID were formally registered.

**Recommended interim code:** Do not use 500 generically — it will collide. File a request with IAB Tech Lab for a reserved provisional value while the WG process runs.

---

## 7. What the WG Proposal Needs to Include

For the formal IAB Tech Lab OpenRTB/AdCOM WG submission:

1. **AdCOM PR:** Add values 10 (SHARC 1.0) and 11 (SHARC 1.1) to §List: API Frameworks
2. **AdCOM PR:** Add value 5 (Structured SHARC) to §List: Creative Subtypes — Display
3. **AdCOM PR (optional):** Add a `sharc` object to `Ad.Display` mirroring the `omidpn`/`omidpv` pattern from OMSDK — containing `version` and optional `components` fields for structured validation
4. **OpenRTB 2.x advisory doc:** Equivalent of the OMSDK advisory, showing bid request/response usage patterns for `Banner.api` and `Bid.apis`
5. **No `Placement` rename required in the spec** — the `ContainerPlacement` rename is a SHARC reference implementation convention, not a spec change

### Fields Summary

| Spec | Object | Field | Role |
|------|--------|-------|------|
| OpenRTB 2.x | `Imp.Banner` | `api` | SSP declares SHARC support |
| OpenRTB 2.x | `Imp.Video` | `api` | Not used for SHARC (video only) |
| OpenRTB 2.x | `Bid` | `apis` | DSP declares SHARC creative |
| AdCOM 1.0 | `DisplayPlacement` | `api` | SSP declares SHARC support |
| AdCOM 1.0 | `DisplayPlacement` | `ctype` | SSP declares SHARC creative subtype accepted |
| AdCOM 1.0 | `Ad.Display` | `api` | DSP declares SHARC required |
| AdCOM 1.0 | `Ad.Display` | `ctype` | DSP declares creative is Structured SHARC |
| AdCOM 1.0 | List: API Frameworks | value 10 | **NEW** — SHARC 1.0 registration |
| AdCOM 1.0 | List: Creative Subtypes — Display | value 5 | **NEW** — Structured SHARC |

---

## 8. Open Questions for the WG

1. ✅ **Version granularity — RESOLVED:** SHARC 1.0 = value 10. The 1.x line is designed to have no breaking changes — minor versions add capability via extensions only. A new value would only be registered for a genuinely breaking change (SHARC 2.0+), which the design aims to avoid. No sub-versioning in the API Frameworks list.

2. ✅ **`ctype` in OpenRTB 2.x — RESOLVED:** Use `Bid.ext.crtype` (de facto standard, widely adopted in 2.x pipelines; AdCOM `ctype` takes direct inspiration from it). Recommended string value: `"SHARC"`. Two-path pattern:
   - **OpenRTB 2.x:** `Imp.Banner.api = [10]` (placement support) + `Bid.ext.crtype = "SHARC"` (creative format)
   - **AdCOM 1.0 / OpenRTB 3.0:** `DisplayPlacement.api = [10]` + `Ad.Display.ctype = 5` (formal registered value)
   - WG proposal should document both paths. String convention for `ext.crtype` TBD by WG (e.g. `"SHARC"` vs `"SHARC1"` vs `"SHARC-1.0"`).

3. **Structured SHARC object in `Ad.Display`:** Should the WG define a first-class `sharc` sub-object (like OMSDK's `omidpn`/`omidpv`) for version + component capability negotiation? The SHARC spec's `EnvironmentData` already carries container capabilities to the creative at runtime; the question is whether the bid response needs to carry them pre-auction.

4. **SIMID + SHARC companion use case:** When a Video impression includes a SHARC companion (end-card), both `Imp.Video.api = [8 or 9]` (SIMID) and companion `Banner.api = [10]` (SHARC) should appear. Confirm this is the intended signal pattern.
