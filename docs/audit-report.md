# SHARC Documentation Audit Report

**Date:** 2026-05-18  
**Branch audited:** main at ae9d996 (docs(release): finish SHARC 0.7.2 docs and version cut (#110))  
**Scope:** README.md, CHANGELOG.md, all root Markdown files, and all Markdown files under docs/ and test/browser/.

## Executive summary

The 0.7.2 release documentation is mostly coherent at the README, changelog body, and API-reference level: package.json, src/sharc-protocol.js, and the README package badge all agree on 0.7.2, and the README's main 0.7.2 constructor options and accessors match the current SHARCContainer surface. The remaining docs debt is concentrated in stale secondary guides, broken relative links in archived/research docs, release-link metadata that was not advanced past 0.6.2, and design-stage artifacts that still read like active handoff material even though 0.7.2 has shipped.

## Findings

### Critical

No critical documentation defects found.

### High

1. CHANGELOG.md:1458 - The [Unreleased] compare link still points from v0.6.2...main, and there are no link definitions for [0.7.2], [0.7.1], or [0.7.0]. This makes the latest release headings render without proper compare links and sends readers through an obsolete diff range.  
   Suggested fix: add [0.7.2]: ...v0.7.1...v0.7.2, [0.7.1]: ...v0.7.0...v0.7.1, [0.7.0]: ...v0.6.2...v0.7.0, and update [Unreleased] to compare v0.7.2...main.

2. docs/getting-started.md:9 - The getting-started guide still says the current package version is 0.7.0, while the repo, protocol constant, changelog, and README are at 0.7.2.  
   Suggested fix: update the preface and version-specific framing to 0.7.2, or make the section explicitly historical and point users to docs/current-status.md.

3. docs/getting-started.md:15 - The guide is titled around "What's New in 0.7.0" and never covers the 0.7.1 bridge detection or 0.7.2 transition-state operator path. This contradicts the README's current path for legacy adm, requireSharcInit, and creativeSdkUrl.  
   Suggested fix: refresh the guide around the 0.7.2 first-run path, with 0.7.0 Creative Markup moved to a subsection or changelog-style note.

4. docs/current-status.md:25 - The status page says 0.7.0 expanded SHARCSecurityEvent to five reserved variants, but 0.7.1 added bridge_load_failed and the current source documents that additional event family.  
   Suggested fix: update the stable-current summary to mention 0.7.1 bridge diagnostics and 0.7.2 transition-state additions, or link directly to the API reference for the current union.

### Medium

1. docs/reviews/OM-sdk-architect-recommendations.md:5 - The link ./OM-sdk-research.md is broken from docs/reviews/; the target exists at docs/research/OM-sdk-research.md.  
   Suggested fix: change the link to ../research/OM-sdk-research.md.

2. docs/research/mraid-migration.md:463 and docs/research/mraid-migration.md:464 - Links to ./api-reference.md and ./getting-started.md are broken from docs/research/; both files live one directory up.  
   Suggested fix: change them to ../api-reference.md and ../getting-started.md.

3. docs/api-reference.md:48 - The constructor-options table links to #sharccreativersequestplacementchange, which is a typo and does not match the ### SHARC:Creative:requestPlacementChange heading at docs/api-reference.md:991.  
   Suggested fix: use the correct generated anchor for the heading, or add an explicit anchor near the message section.

4. docs/api-reference.md:106 and docs/api-reference.md:813 - Examples still use "0.7.0" for the SHARC version. Historical "added in 0.7.0" notes are fine, but current examples should not imply 0.7.0 is the active SDK version.  
   Suggested fix: change current-value examples to "0.7.2" and keep historical "added in" language where relevant.

5. README.md:129 - The distribution section lists bridge subpath exports for MRAID, SafeFrame, and OMID, but omits @iabtechlab/sharc/sharc-navigation-bridge, which is exported in package.json and listed in docs/current-status.md.  
   Suggested fix: add the navigation bridge to the README's subpath list or explain that it is normally consumed via sharc-creative.

6. README.md:5 - The CI badge points at github.com/InteractiveAdvertisingBureau/SHARC, while this audited working repo is github.com/jeffreycarlson/SHARC. That may be intentional upstream branding, but it is suspicious because the README clone command uses jeffreycarlson/SHARC.  
   Suggested fix: decide whether the README should represent the upstream organization or this active repository, then align the CI badge, clone command, and changelog compare links.

7. docs/design/0.7.2-NEXT-SESSION-PROMPT.md:3 and docs/design/0.7.2-WORK-IN-PROGRESS.md:4 - These are session-handoff artifacts for pre-implementation Stage 3 work, but they now live beside shipped 0.7.2 design docs after the release. They read as operational instructions with local filesystem paths and obsolete branch state.  
   Suggested fix: move them under an archive folder, add a clear "historical artifact" banner, or remove them from the curated docs index if they are not meant for readers.

8. docs/design/0.7.2-non-sharc-loading.md:3 - The design doc still says "ready for implementation" even though the implementation and release have landed.  
   Suggested fix: update status to "Implemented in 0.7.2" with PR references, or mark the doc as historical design rationale.

### Low

1. docs/creative-cookbook.md:343, docs/getting-started.md:19, and docs/getting-started.md:290 - These links point to the architecture design renderer-protocol heading using a generated anchor. Generated heading anchors are fragile across renderers because punctuation handling varies.  
   Suggested fix: add explicit HTML anchors to important architecture headings and update links to those stable IDs.

2. docs/api-reference.md:3 - The API reference says Version: 1.1 while also saying it is current through package v0.7.2. This may be a document revision, but readers can confuse it with SHARC protocol/package versioning.  
   Suggested fix: rename to Document revision: 1.1 or remove the separate version.

3. docs/current-status.md:27 - The page has a large "What Shipped in 0.7.0" section but no equivalent sections for 0.7.1 or 0.7.2, despite line 7 saying the current repo version is 0.7.2.  
   Suggested fix: add concise 0.7.1 and 0.7.2 summaries above the 0.7.0 section.

4. README.md:189 - The README advertises an OMID bridge integration page in the main harness list, while the 0.7.2 release notes explicitly defer OMID container-side wiring.  
   Suggested fix: clarify that the page is an integration/demo surface, not a statement that OMID runtime wiring is part of the 0.7.2 transition-state feature set.

5. CHANGELOG.md:14 - [Unreleased] is empty, which is acceptable immediately after a release, but the audit found no placeholder categories.  
   Suggested fix: leave it empty if no post-0.7.2 changes exist, or add hidden comments for Added, Changed, Fixed, and Docs to guide the next entry.

### Nit

1. docs/architecture-design.md:845 - A markdown link checker can misread the IPv6 regex text as a link target because of [](...) syntax in inline text.  
   Suggested fix: wrap the regex list in a fenced code block to avoid false positives from automated link tools.

2. README.md:3 - The package badge is correct at v0.7.2, but because the package is pre-publish, a shield-style "package" badge can look like an npm release badge.  
   Suggested fix: consider "repo version" or "pre-publish" wording in the badge label.

## Quick wins

- Update CHANGELOG.md compare-link definitions for 0.7.0, 0.7.1, 0.7.2, and [Unreleased].
- Fix the three broken relative links in docs/reviews/OM-sdk-architect-recommendations.md and docs/research/mraid-migration.md.
- Correct the typo in the requestPlacementChange anchor in docs/api-reference.md.
- Replace current-version examples of "0.7.0" with "0.7.2" in docs/api-reference.md.
- Change docs/getting-started.md:9 from 0.7.0 to 0.7.2.
- Add @iabtechlab/sharc/sharc-navigation-bridge to the README distribution list.

## Needs investigation

- Decide whether public-facing repository links should point to InteractiveAdvertisingBureau/SHARC or jeffreycarlson/SHARC; the README, changelog, badges, and issue links currently mix both.
- Decide how to classify design-stage handoff docs (0.7.2-NEXT-SESSION-PROMPT.md, 0.7.2-WORK-IN-PROGRESS.md, and 0.7.2-STAGE-3-COMPARISON.md) now that 0.7.2 is released.
- Confirm whether the OMID demo page should remain in the README's main entry-point list before OMID container-side wiring is fully documented as shipped.
- Confirm whether docs/getting-started.md should remain a 0.7.0 historical guide or become the current 0.7.2 quick-start path.

## Audit notes

- Scanned 61 Markdown files with rg --files -g '*.md'.
- Verified package.json version 0.7.2, src/sharc-protocol.js SHARC_VERSION = '0.7.2', and the README package badge v0.7.2.
- Checked README constructor/accessor tables against src/sharc-container.js; the main 0.7.2 options and accessors are represented, with the navigation-bridge distribution omission noted above.
- External URLs were not network-checked; suspicious external patterns were flagged by inspection only.
