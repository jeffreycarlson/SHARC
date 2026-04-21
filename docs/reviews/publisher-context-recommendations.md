# Publisher Context in Container:init — Design Recommendation

> **Problem:** A creative has no independent way to verify where it's actually running.
> The bid request carries `site.page` (the claimed URL), but the tag could be embedded
> on a completely different page — domain spoofing, MFA arbitrage, brand safety violations.
>
> SafeFrame solved this via `$sf.ext.hostURL()` — the container tells the creative its
> actual URL. SHARC currently does not.
>
> **Proposal:** Add `publisherContext` to `Container:init` environment data.

---

## Proposed Structure

```json
{
  "publisherContext": {
    "pageUrl": "https://example.com/article/sports",
    "domain": "example.com",
    "package": "com.example.app",
    "platform": "ios | android | web | ctv"
  }
}
```

### Fields

| Field | Type | Web | In-App | Source |
|---|---|---|---|---|
| `pageUrl` | string | `document.URL` or `document.referrer` | `null` if in-app | Runtime (container) |
| `domain` | string | `window.location.hostname` | `null` if in-app | Derived from pageUrl |
| `package` | string | `null` if web | App bundle ID | Container config / SDK |
| `platform` | string | `"web"` | `"ios"` or `"android"` | Determined by container |

---

## Key Design Questions

### 1. Single field or multiple?

**Option A: Flat `publisherContext` object** (proposed above)
- One namespace, all fields available
- Easy for creative to check what's present
- `null` for fields not applicable to the runtime

**Option B: Separate `siteContext` vs `appContext`**
- Web: `{ "site": { "pageUrl": "...", "domain": "..." } }`
- App: `{ "app": { "bundleId": "...", "platform": "..." } }`
- Cleaner separation but harder for creatives to navigate

**Option C: Separate top-level fields**
- `environmentData.publisherPageUrl`
- `environmentData.publisherBundleId`
- `environmentData.publisherPlatform`
- Matches OpenRTB field naming but is more verbose in the protocol

### 2. Who provides the data?

- **Web:** Container reads `document.URL` / `domain` from the browser — no external input needed
- **In-App:** The mobile SDK needs to be configured with the bundle ID (already available in the native app, but the SDK must pass it to SHARC)

### 3. Trust model

- `pageUrl` is read by the container itself — harder to spoof than a bid request field
- But: what if the container is malicious? A compromised SHARC container on a bad site could report false data.
- **Defense:** The measurement/verification bridge (OMID) reads the same browser APIs independently. If the container reports `domain: "nytimes.com"` but OMID's publisher page script sees a different domain, that's a mismatch flag.

### 4. `$sf.ext.hostURL()` bridge implementation

Returns `publisherContext.pageUrl` from environment data. Returns `""` (empty string) if not available — per SafeFrame spec behavior when URL is unknown.

---

## PM Considerations

- Does this address brand safety / supply chain transparency needs for SHARC positioning?
- Is this a selling point for the IAB Working Group narrative?
- Does this overlap with or complement OMID's publisher page context?

## Architect Considerations

- Should `publisherContext` be nested or flat?
  - Nested keeps it organized under one namespace but requires null checks
  - Flat is simpler for the protocol but pollutes the top level
- What's the fallback if the container can't determine the URL (e.g., `about:blank` iframe)?
- How does this interact with the OMID adapter's publisher page context?
  - OMID already collects `publisherUrl` on the publisher page
  - Do we want it to match, complement, or be independent?
