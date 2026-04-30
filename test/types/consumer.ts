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

// ── Bridge constructor variants ──
const mraid = new MRAIDCompatBridge({ baseUrl: '/sharc' });
const safeframe = new SafeFrameCompatBridge({ baseUrl: '/sharc' });
const omid = new OmidCompatBridge({
  omSdkServiceScriptUrl: 'https://example/omsdk.js',
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
