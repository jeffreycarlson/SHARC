/**
 * TS consumer probe — exercises every published subpath export with the
 * generated .d.ts files. Run via `npm run test:types`.
 *
 * This file is NOT shipped (excluded from the package via the `files:`
 * allowlist) but IS typechecked as part of the build verification flow.
 * If a future change weakens the generated types — e.g. drops a JSDoc tag,
 * collapses a parameter to `any`, removes an export — this file's
 * `tsc --noEmit` run will fail loudly.
 *
 * Notes:
 *   - We use relative `../../dist/...` imports rather than the package
 *     subpath ('@iabtechlab/sharc/...') because the package is not
 *     installed into node_modules during local development. The runtime
 *     module resolution is identical either way once published.
 *   - Each block must call at least one method that requires correctly-typed
 *     arguments, so that argument-shape regressions surface as compile errors.
 */

import { SHARCContainer, type SHARCSecurityEvent, type SHARCSecurityEventCallback } from '../../dist/sharc-container';
import { SHARCCreative } from '../../dist/sharc-creative';
import { MRAIDCompatBridge } from '../../dist/sharc-mraid-bridge';
import { SafeFrameCompatBridge } from '../../dist/sharc-safeframe-bridge';
import { OmidCompatBridge } from '../../dist/sharc-omid-bridge';
import { installNavigationBridge, SHARCNavigationError } from '../../dist/sharc-navigation-bridge';

// ── SHARCContainer constructor surface ──
declare const slot: HTMLElement;
const container = new SHARCContainer({
  creativeUrl: 'https://example/ad.html',
  placementElement: slot,
  placementId: '/12345/sports/scoreboard',
  placementName: 'sidebar',
  environmentData: {
    currentPlacement: { width: 320, height: 50 },
  },
  autoStart: false,
  visible: true,
  extensions: [new MRAIDCompatBridge()],
});

// ── SHARCContainer instance shape ──
const url: string | null = container.creativeUrl;
const rendererUrl: string | null = container.creativeRendererUrl;
const source: 'url' | 'html' = container.creativeSource;
const injected: boolean = container.creativeInjected;
const rendered: boolean = container.creativeRendered;
const el: HTMLElement = container.placementElement;
const pid: string | null = container.placementId;
const pname: string | null = container.placementName;
const psid: string = container.placementSessionId;
const sid: string | null = container.sessionId;
void url;
void rendererUrl;
void source;
void injected;
void rendered;
void el;
void pid;
void pname;
void psid;
void sid;

// ── Creative Markup constructor surface (Phase A — option shape only) ──
const markupContainer = new SHARCContainer({
  creativeHtml: '<html><body>inline ad markup</body></html>',
  creativeRendererUrl: 'https://renderer.operator.example/0.7.0/',
  placementElement: slot,
  allowPopups: true,
  allowTopNavigationByUserActivation: true,
  allowStorageAccessByUserActivation: true,
  allowModals: false,
  allowDownloads: false,
  wrapperPolicy: 'warn',
  onSecurityEvent: (event: SHARCSecurityEvent) => {
    void event.type;
    void event.severity;
    void event.placementSessionId;
  },
});
void markupContainer;

// ── Verify the exported callback type is reusable as a standalone alias ──
const _securityHandler: SHARCSecurityEventCallback = (event) => {
  void event.details;
};
void _securityHandler;

// ── Verify discriminated-union narrowing works (Phase D — closes #62) ──
// If `SHARCSecurityEvent` collapsed to `{ type: string; details: any }` again,
// these branch-specific property accesses would compile under the loose
// shape — we exercise per-variant `details` keys so a regression to the
// loose shape would show up as a missing-property error here. (We declare
// the event rather than receive it from a callback so this block stays a
// pure type-narrowing probe.)
declare const _evt: SHARCSecurityEvent;
if (_evt.type === 'wrapper_top_frame_inaccessible') {
  const wrapperOrigin: string | null = _evt.details.wrapperOrigin;
  const rendererUrl: string = _evt.details.creativeRendererUrl;
  void wrapperOrigin;
  void rendererUrl;
} else if (_evt.type === 'renderer_origin_mismatch') {
  const expected: string = _evt.details.expectedOrigin;
  const actual: string = _evt.details.actualOrigin;
  const code: 2116 = _evt.errorCode;
  void expected;
  void actual;
  void code;
} else if (_evt.type === 'renderer_protocol_error') {
  const subtype: 'malformed_payload' | 'timeout' | 'post_failed' = _evt.details.subtype;
  const reason: string = _evt.details.reason;
  void subtype;
  void reason;
} else if (_evt.type === 'renderer_failed') {
  const reason: string = _evt.details.reason;
  const code: 2115 = _evt.errorCode;
  void reason;
  void code;
} else if (_evt.type === 'unauthorized_navigation') {
  // Phase E widened the variant from `'markup'` literal to the
  // `'markup' | 'url'` union (Creative URL coverage). The probe MUST
  // accept either branch — a regression that re-narrows to a single
  // literal would fail to compile here. We exercise both literals via
  // a switch so a future re-narrow shows up as a missing-case error,
  // not a silent loss of the URL branch.
  const variant: 'markup' | 'url' = _evt.details.variant;
  const code: 2118 = _evt.errorCode;
  // Phase D round-4 SRE HIGH-1: details.msSinceRender carries the wall-
  // clock delay between the variant's render-anchor event and the
  // post-render load event (Markup: `:rendered` accept; URL: initial
  // iframe load — Phase E).
  const msSinceRender: number = _evt.details.msSinceRender;
  switch (variant) {
    case 'markup': {
      const m: 'markup' = variant;
      void m;
      break;
    }
    case 'url': {
      const u: 'url' = variant;
      void u;
      break;
    }
  }
  void code;
  void msSinceRender;
}

// ── Bridge constructor variants ──
const mraid = new MRAIDCompatBridge({ baseUrl: '/sharc' });
const safeframe = new SafeFrameCompatBridge({ baseUrl: '/sharc' });
const omid = new OmidCompatBridge({
  omSdkServiceScriptUrl: 'https://example/omsdk.js',
  omSdkSessionClientUrl: 'https://example/omid-session-client.js',
  partnerName: 'Test',
  partnerVersion: '1.0',
});
void mraid;
void safeframe;
void omid;

// ── Creative API export shape ──
type _CreativeCtor = typeof SHARCCreative;
const _creativeCtorProbe: _CreativeCtor = SHARCCreative;
void _creativeCtorProbe;

// ── Navigation bridge export shape (Phase D — deliverable 4) ──
const _uninstallNav: () => void = installNavigationBridge();
void _uninstallNav;

// ── SHARCNavigationError exported class (Phase D round-4 — OpenClaw MEDIUM-3) ──
// Verifies the `code` field is publicly typed as `string` (intentionally
// permissive for forward extensibility — new codes will land in minor
// versions and should NOT widen-break consumers). Operators relying on
// `code` for branching should pair `instanceof SHARCNavigationError` with
// the documented enumeration in `docs/api-reference.md` § Navigation Bridge
// Error Contract rather than narrow-asserting on a literal type.
// (Round-5 TRA MEDIUM-1 fix: prior comment claimed this probe would catch
// a regression that loosens `code` to `string`, but `code` is already typed
// as `string` in the .d.ts — the assertion was trivially `string ← string`.)
const _navErr = new SHARCNavigationError('SDK_UNAVAILABLE', 'probe');
const _navErrCode: string = _navErr.code;
const _navErrName: string = _navErr.name;
void _navErrCode;
void _navErrName;
