/**
 * @fileoverview SHARC global Window augmentations — internal typecheck only.
 *
 * This file is NOT shipped to consumers. Per-module typed surfaces are
 * generated from JSDoc into `dist/sharc-*.d.ts` and exposed via the
 * `"types"` entries in `package.json#exports`. Consumers who write:
 *
 *   import { Container } from '@iabtechlab/sharc/sharc-container';
 *
 * pick up the generated types — not anything declared here.
 *
 * What lives in this file: ambient `Window` and runtime-global declarations
 * that JSDoc cannot express because they describe what SHARC writes to or
 * reads from the host environment (window.mraid, window.$sf, window.SHARC,
 * window.MRAID_ENV, window.SHARC_CONFIG, etc). Class references on
 * window.SHARC.* are kept loose (`any`) because typed consumers should
 * import the bridge classes from their package subpaths rather than
 * reflecting on the global.
 */

/**
 * OMID Session Client namespace — provided externally by the IAB OM SDK
 * service script. Surface mirrors the IAB OM Web SDK 1.5+ public API.
 * Used by the SHARC OMID bridge for viewability measurement.
 */
declare namespace OmidSessionClient {
  interface SessionEvent {
    type: 'sessionStart' | 'sessionError' | 'sessionFinish';
    data?: unknown;
    timestamp?: number;
  }

  interface AdSession {
    registerSessionObserver(observer: (event: SessionEvent) => void): void;
    setCreativeType(creativeType: string): void;
    setImpressionType(impressionType: string): void;
    start(): void;
    finish(): void;
    addFriendlyObstruction(element: HTMLElement, purpose: string, reason: string): void;
    removeFriendlyObstruction(element: HTMLElement): void;
  }

  interface VerificationScriptResource {
    resourceUrl: string;
    vendorKey?: string;
    verificationParameters?: string;
  }

  class Partner {
    constructor(name: string, version: string);
    name: string;
    version: string;
  }

  class Context {
    constructor(partner: Partner, verificationScripts?: VerificationScriptResource[]);
    setServiceScriptUrl(url: string): void;
    setContentUrl(url: string): void;
  }

  class VastProperties {
    constructor(isSkippable: boolean, skipOffset: number, isAutoPlay: boolean, placement: string);
  }

  const AdSession: { new (context: Context): AdSession };
  const AdEvents: {
    new (session: AdSession): {
      loaded(vastProperties?: VastProperties): void;
      impressionOccurred(): void;
      skipped(): void;
    };
  };
  const MediaEvents: {
    new (session: AdSession): {
      start(duration: number, volume: number): void;
      pause(): void;
      resume(): void;
      complete(): void;
      firstQuartile(): void;
      midpoint(): void;
      thirdQuartile(): void;
      bufferStart(): void;
      bufferFinish(): void;
      playerStateChange(state: number | string): void;
      volumeChange(volume: number): void;
    };
  };
  const PlayerState: { readonly [stateName: string]: number };
}

/**
 * MRAID 3.0 environment object — populated by the host SDK before the
 * creative loads (MRAID 3.0 §2.1).
 */
interface MRAIDEnv {
  version: string;
  sdk: string;
  sdkVersion: string;
  appId: string;
  ifa: string;
  limitAdTracking: boolean;
  coppa: boolean;
  publisherPageUrl?: string;
  publisherDomain?: string;
  publisherBundleId?: string;
  publisherPlatform?: string;
}

/**
 * Optional global config consumed by sharc-creative.js at construction time.
 * Set on the host page before the creative iframe loads.
 */
interface SHARCConfig {
  /**
   * Exact-match origin string for postMessage trust (e.g. "https://pub.example").
   * No trailing slash, no path. Mismatch fails every check.
   */
  trustedOrigin?: string;
}

declare global {
  interface Window {
    /**
     * SHARC namespace — populated by sharc-protocol.js, sharc-container.js,
     * sharc-creative.js, and the bridge files. The class references here
     * are intentionally `any` — typed consumers should import directly:
     *
     *   import { Container } from '@iabtechlab/sharc/sharc-container';
     *   import { MRAIDCompatBridge } from '@iabtechlab/sharc/sharc-mraid-bridge';
     *
     * The Window globals are present as a runtime-reflection escape hatch
     * (e.g. for IIFE script-tag loading where ES module imports are not
     * available) and do not carry the generated typed surface.
     */
    SHARC?: {
      SHARC_VERSION?: string;
      Protocol?: {
        SHARC_VERSION?: string;
        SHARC_API_CODE?: number;
        SAFEFRAME_API_CODE?: number;
        RENDERER_PROTOCOL_VERSION?: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        SHARCProtocolBase: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        SHARCContainerProtocol: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        SHARCCreativeProtocol: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        SHARCStateMachine: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ProtocolMessages: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ContainerMessages: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        CreativeMessages: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ContainerStates: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ErrorCodes: any;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Container?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Creative?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ErrorCodes?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      MRAIDCompatBridge?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SafeFrameCompatBridge?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      OmidCompatBridge?: any;
      // Phase D — Creative Sources navigation bridge.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      installNavigationBridge?: (w?: Window) => () => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requestNavigation?: (args: { url: string; target?: string }) => any;
      omid?: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        request(action: string, args?: any): void;
        isSessionActive(): boolean;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getAdSession(): any;
      };
    };

    /**
     * MRAID 3.0 API exposed by the SHARC MRAID bridge after sharc-mraid-bridge.js
     * loads. Surface is described loosely here; for typed consumption import the
     * bridge module directly.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mraid?: any;

    /**
     * SafeFrame 1.1 API exposed by the SHARC SafeFrame bridge after
     * sharc-safeframe-bridge.js loads.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $sf?: any;

    /** MRAID 3.0 environment, populated by the host SDK before creative load. */
    MRAID_ENV?: MRAIDEnv;

    /** Optional creative-side config, read once during sharc-creative.js setup. */
    SHARC_CONFIG?: SHARCConfig;

    /**
     * OMID Session Client namespace, loaded from the OM SDK service script.
     * Typed consumers should normally interact via the SHARC OMID bridge,
     * but the namespace is exposed here for advanced integrations that need
     * to inspect session state directly.
     */
    OmidSessionClient?: typeof OmidSessionClient;

    /** Set to true once installOmidBridge() has been called. */
    __sharcOmidInstalled?: boolean;

    /**
     * Set to true once installNavigationBridge() has been called on this
     * window. Phase D — Creative Sources navigation bridge.
     */
    __sharcNavBridgeInstalled?: boolean;

    /**
     * Opt-in flag for the navigation bridge's auto-install branch. When
     * set BEFORE sharc-navigation-bridge.js loads, the bridge installs
     * itself at module-evaluation time. Default off — the renderer page
     * is expected to call installNavigationBridge() explicitly at the
     * precise install point (BEFORE document.write(creativeHtml)).
     */
    __sharcNavBridgeAutoInstall?: boolean;
  }
}

export {};
