# SHARC Origin Context — April 4, 2026

## Background

### SafeFrame 2.0 Shelved
The IAB Tech Lab SafeFrame Implementation Working Group released SafeFrame 2.0 for public comment, but received significant feedback indicating that several proposed features could not be fully supported within the existing SafeFrame framework.

A key principle of SafeFrame 2.0 was to enable cross-platform compatibility with MRAID implementations. However, with MRAID also undergoing updates and plans for revision on the horizon, the working group recognized an opportunity to start fresh rather than release a stop-gap update.

### SHARC Emerges
Instead of completing SafeFrame 2.0, the group pivoted to create **Safe HTML Ad Richmedia Container (SHARC)** — a unified standard for both web and mobile ad containers.

**Key goals:**
- Replace both SafeFrame (web) and MRAID (mobile) with a single standard
- Enable ad developers to write one rich media ad and deploy anywhere
- Simplify the ad container ecosystem
- Modern approach compared to legacy frameworks

### SHARC vs Legacy

| Aspect | SafeFrame | MRAID | SHARC |
|--------|---|---|-------|
| **Platform** | Web only | Mobile only | Web + Mobile + Any |
| **Scope** | Managed iframe + API | Mobile ad container | Universal container |
| **Status** | v1.1 (current) | 3.x (current) | In development (2022+) |

## References

- [SafeFrame Implementation Guidelines](https://iabtechlab.com/standards-old/safeframe-implementation-guidelines/)
- [IAB Tech Lab Blog — SHARC](https://iabtechlab.com/blog/sharc-were-going-to-need-a-bigger-team/)
- [Safe Ad Container Working Group](https://iabtechlab.com/working-groups/safe-ad-container-working-group/)

## Historical Context for Reference Implementation

This reference implementation is being built with knowledge of SHARC's origins. Understanding that SHARC was designed to address the fragmentation between SafeFrame and MRAID helps inform decisions about:

1. **Unified approach** — Design for both web and mobile from day one
2. **Modern patterns** — No legacy constraints from SafeFrame or MRAID
3. **Simplicity** — Learn from feedback that caused SafeFrame 2.0 to stall
4. **Future-proofing** — Architecture that can evolve without major rewrites

---

*This document is auto-generated from IAB Tech Lab public sources.*
