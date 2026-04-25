/**
 * @fileoverview SHARC Global Type Definitions
 *
 * Augments the Window interface to provide typed access to SHARC globals:
 * - window.SHARC
 * - window.mraid
 * - window.$sf
 * - window.MRAID_ENV
 * - window.MRAID_ENV
 * - window.OmidSessionClient
 * - window.__sharcOmidInstalled
 */

/// <reference types="node" />

/**
 * OMID Session Client namespace (loaded from OM SDK service script).
 * Used by the SHARC OMID bridge for measurement.
 */
declare namespace OmidSessionClient {
  interface AdSession {
    registerSessionObserver(observer: (event: SessionEvent) => void): void;
    setCreativeType(creativeType: string): void;
    setImpressionType(impressionType: string): void;
    start(): void;
    finish(): void;
    addFriendlyObstruction(element: HTMLElement, purpose: string, reason: string): void;
    removeFriendlyObstruction(element: HTMLElement): void;
  }

  interface SessionEvent {
    type: 'sessionStart' | 'sessionError' | 'sessionFinish';
    data?: any;
    timestamp?: number;
  }

  interface Partner {
    new (name: string, version: string): Partner;
  }

  interface Context {
    new (partner: Partner, verificationScripts?: any[]): Context;
    setServiceScriptUrl(url: string): void;
    setContentUrl(url: string): void;
  }

  interface AdSessionConstructor {
    new (context: Context): AdSession;
  }

  interface VastProperties {
    new (isSkippable: boolean, skipOffset: number, isAutoPlay: boolean, placement: string): VastProperties;
  }

  interface AdEvents {
    new (session: AdSession): AdEvents;
    loaded(vastProperties?: VastProperties): void;
    impressionOccurred(): void;
    skipped(): void;
  }

  interface MediaEvents {
    new (session: AdSession): MediaEvents;
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
  }

  interface PlayerState {
    [key: string]: number;
  }

  const AdSession: AdSessionConstructor;
  const Partner: Partner;
  const Context: Context;
  const VastProperties: VastProperties;
  const AdEvents: any;
  const MediaEvents: any;
  const PlayerState: PlayerState;
}

/**
 * MRAID environment object (MRAID 3.0 spec).
 * Populated during SHARC Container:init.
 */
interface MRAIDEnv {
  version: string;
  sdk: string;
  sdkVersion: string;
  appId: string;
  ifa: string;
  limitAdTracking: boolean;
  coppa: boolean;
  publisherPageUrl: string;
  publisherDomain: string;
  publisherBundleId: string;
  publisherPlatform: string;
}

/**
 * SHARC MRAID Bridge extension class.
 */
interface MRAIDCompatBridgeClass {
  new (options?: { baseUrl?: string }): MRAIDCompatBridge;
}

interface MRAIDCompatBridge {
  name: string;
  options: { baseUrl?: string };
  getScriptUrls(): string[];
  getFeatureName(): string;
  getWrapperUrl(creativeUrl: string): string;
}

/**
 * SHARC SafeFrame Bridge extension class.
 */
interface SafeFrameCompatBridgeClass {
  new (options?: { baseUrl?: string }): SafeFrameCompatBridge;
}

interface SafeFrameCompatBridge {
  name: string;
  options: { baseUrl?: string };
  getScriptUrls(): string[];
  getFeatureName(): string;
  getWrapperUrl(creativeUrl: string): string;
  setMeta(environmentData: any, sfMeta: any): void;
}

/**
 * SHARC OMID Bridge extension class.
 */
interface OmidCompatBridgeClass {
  new (options?: OmidCompatBridgeOptions): OmidCompatBridge;
}

interface OmidCompatBridgeOptions {
  omSdkServiceScriptUrl?: string;
  omSdkSessionClientUrl?: string;
  baseUrl?: string;
  partnerName?: string;
  partnerVersion?: string;
  verificationScripts?: any[];
  creativeType?: string;
  impressionType?: string;
  mediaType?: string;
}

interface OmidCompatBridge {
  name: string;
  options: OmidCompatBridgeOptions;
  getFeatureName(): string;
  getFeatureDescriptor(): { name: string; version: string; capabilities: any };
  getScriptUrls(): string[];
  injectScripts(html: string): string;
  injectIntoMarkup(html: string): string;
  getWrapperUrl(creativeUrl: string): string;
  augmentEnvironmentData(environmentData: any): any;
  registerFriendlyObstruction(element: HTMLElement, purpose?: string, reason?: string): void;
  unregisterFriendlyObstruction(): void;
}

/**
 * SHARC OMID bridge request API exposed on window.SHARC.
 */
interface SHARCOMIDAPI {
  /**
   * Dispatches an OMID measurement event.
   * @param action - Event name (play, pause, resume, complete, etc.)
   * @param args - Event-specific arguments.
   */
  request(action: string, args?: any): void;

  /**
   * Returns whether the OMID session is currently active.
   * @returns {boolean}
   */
  isSessionActive(): boolean;

  /**
   * Returns the active AdSession object (for advanced integrations).
   * Returns null if no session is active.
   * @returns {Object|null}
   */
  getAdSession(): any;
}

/**
 * Augments the Window interface with SHARC globals.
 */
declare global {
  interface Window {
    /**
     * SHARC namespace — contains Protocol, Container, and bridge extensions.
     * Populated by sharc-protocol.js and bridge files.
     */
    SHARC?: {
      Protocol?: {
        SHARCProtocolBase: any;
        SHARCContainerProtocol: any;
        SHARCCreativeProtocol: any;
        SHARCStateMachine: any;
        ProtocolMessages: any;
        ContainerMessages: any;
        CreativeMessages: any;
        ContainerStates: any;
        ErrorCodes: any;
      };
      Container?: any;
      ErrorCodes?: any;
      MRAIDCompatBridge?: MRAIDCompatBridgeClass;
      SafeFrameCompatBridge?: SafeFrameCompatBridgeClass;
      OmidCompatBridge?: OmidCompatBridgeClass;
      omid?: SHARCOMIDAPI;
    };

    /**
     * MRAID 3.0 API — exposed by the SHARC MRAID bridge.
     * Available after sharc-mraid-bridge.js is loaded.
     */
    mraid?: {
      getVersion: () => string;
      getState: () => 'loading' | 'default' | 'expanded' | 'resized' | 'hidden';
      isViewable: () => boolean;
      getPlacementType: () => 'inline' | 'interstitial';
      getDefaultPosition: () => { x: number; y: number; width: number; height: number };
      getCurrentPosition: () => { x: number; y: number; width: number; height: number };
      getMaxSize: () => { width: number; height: number };
      getScreenSize: () => { width: number; height: number };
      getExpandProperties: () => { width: number; height: number; useCustomClose: boolean; isModal: boolean };
      setExpandProperties: (props: { width?: number; height?: number; useCustomClose?: boolean }) => void;
      getResizeProperties: () => {
        width: number;
        height: number;
        offsetX: number;
        offsetY: number;
        customClosePosition: string;
        allowOffscreen: boolean;
      };
      setResizeProperties: (props: any) => void;
      expand: (url?: string) => void;
      collapse: () => void;
      close: () => void;
      unload: () => void;
      open: (url: string) => void;
      useCustomClose: (bool: boolean) => void;
      resize: () => void;
      isAudioMuted: () => boolean;
      supports: (feature: string) => boolean;
      addEventListener: (event: string, listener: Function) => void;
      removeEventListener: (event: string, listener: Function) => void;
      storePicture: (url: string) => void;
      createCalendarEvent: (params: any) => void;
      playVideo: (url: string) => void;
      getOrientationProperties: () => { allowOrientationChange: boolean; forceOrientation: string };
      setOrientationProperties: (props: any) => void;
    };

    /**
     * SafeFrame 1.1 API — exposed by the SHARC SafeFrame bridge.
     * Available after sharc-safeframe-bridge.js is loaded.
     */
    $sf?: {
      specVersion: string;
      ext: {
        register: (w: number, h: number, cb: (status: string, data: any) => void) => void;
        supports: () => { 'exp-ovr': boolean; 'exp-push': boolean; 'read-cookie': boolean; 'write-cookie': boolean };
        geom: () => {
          win: { t: number; l: number; r: number; b: number; w: number; h: number };
          self: { t: number; l: number; r: number; b: number; w: number; h: number; xiv: number; yiv: number; iv: number; ovx: number; ovy: number; ov: number; ex: boolean };
          exp: { t: number; l: number; r: number; b: number; push: boolean };
        };
        expand: (obj?: { t?: number; l?: number; r?: number; b?: number; push?: boolean }) => void;
        collapse: () => void;
        status: () => 'expanded' | 'expanding' | 'collapsed' | 'collapsing';
        meta: (propName: string, ownerKey?: string) => any;
        cookie: (cookieName: string, cookieData?: any) => void;
        inViewPercentage: () => number;
        winHasFocus: () => boolean;
        hostURL: () => string;
        message: (msg: string | any) => void;
      };
    };

    /**
     * MRAID environment — populated during SHARC Container:init.
     * Contains publisher and ad platform metadata.
     */
    MRAID_ENV?: MRAIDEnv;

    /**
     * OMID Session Client — loaded from OM SDK service script.
     * Required for the SHARC OMID bridge to function.
     */
    OmidSessionClient?: typeof OmidSessionClient;

    /**
     * SHARC OMID bridge installation flag.
     * Set to true when installOmidBridge() has been called.
     */
    __sharcOmidInstalled?: boolean;
  }
}

export {};
