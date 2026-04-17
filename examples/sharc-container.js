/**
 * @fileoverview SHARC Container Library
 *
 * Production-ready container-side implementation for the SHARC protocol.
 *
 * Responsibilities:
 *   - Creating and managing the secure iframe rendering context
 *   - Running the container side of the SHARC protocol lifecycle
 *   - Enforcing the Page-Lifecycle-aligned state machine
 *   - Owning close, navigation, placement change, and tracker operations
 *   - Managing the MessageChannel handshake
 *
 * Dependencies:
 *   - sharc-protocol.js (must be loaded first, or required via CommonJS)
 *
 * Usage:
 * ```javascript
 * const container = new SHARCContainer({
 *   creativeUrl: 'https://ads.example.com/creative.html',
 *   containerEl: document.getElementById('ad-slot'),
 *   environmentData: { ... },
 *   extensions: [new OmidCompatBridge({ partnerName: 'MyPublisher', partnerVersion: '1.0' })],
 *   onStateChange: (state) => console.log('State:', state),
 *   onClose: () => document.getElementById('ad-slot').remove(),
 * });
 * container.load();
 * ```
 *
 * @version 0.1.0
 */

import {
  SHARCContainerProtocol,
  SHARCStateMachine,
  ProtocolMessages,
  ContainerMessages,
  CreativeMessages,
  ContainerStates,
  ErrorCodes,
} from './sharc-protocol.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default timeout values in milliseconds. */
const DEFAULT_TIMEOUTS = {
  createSession: 5000,  // 5s to receive createSession
  initResolve: 2000,    // 2s for creative to resolve Container:init
  startResolve: 2000,   // 2s for creative to resolve Container:startCreative
  closeSequence: 2000,  // 2s for creative close sequence
};

/** Current SHARC spec version this implementation conforms to. */
const SHARC_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// SHARCContainer
// ---------------------------------------------------------------------------

/**
 * Container-side SHARC implementation.
 *
 * Manages the full lifecycle of a single SHARC ad instance:
 *   loading → ready → active ↔ passive ↔ hidden → frozen → terminated
 *
 * Each SHARCContainer instance manages exactly one ad. To show a new ad,
 * create a new SHARCContainer instance.
 */
class SHARCContainer {
  /**
   * @param {Object} options
   * @param {string} options.creativeUrl - URL of the SHARC-enabled creative HTML.
   * @param {HTMLElement} options.containerEl - The DOM element to insert the iframe into.
   * @param {Object} options.environmentData - Environment data to pass in Container:init.
   *   @param {Object} options.environmentData.currentPlacement - Placement dimensions.
   *   @param {Object} [options.environmentData.dataspec] - AdCOM or custom dataspec info.
   *   @param {Object} [options.environmentData.data] - Data from the dataspec.
   *   @param {Object} [options.environmentData.containerNavigation] - Navigation capabilities.
   *   @param {boolean} [options.environmentData.isMuted] - Whether audio is muted.
   *   @param {number} [options.environmentData.volume] - Volume level (0-1, or -1 if unknown).
   *   @param {Object} [options.environmentData.publisherContext] - Publisher environment context.
   *     @param {string} [options.environmentData.publisherContext.pageUrl] - Page URL (MRAID 3.0 pattern: "" if unavailable).
   *     @param {string} [options.environmentData.publisherContext.domain] - Domain ("" if unavailable).
   *     @param {string} [options.environmentData.publisherContext.bundleId] - App bundle ID ("" if unavailable).
   *     @param {string} [options.environmentData.publisherContext.platform] - "web"|"ios"|"android"|"ctv" ("" if unknown).
   * @param {Array<string | {name: string, version?: string}>} [options.supportedFeatures=[]] - Explicit feature descriptors this container supports.
   *   Accepts either plain feature name strings or descriptor objects; extra descriptor metadata is tolerated but ignored by the creative's built-in feature lookup.
   *   In practice, pass extensions instead — each extension contributes its feature name automatically. If creatives need descriptor metadata like `version`, pass descriptor objects explicitly.
   * @param {Object[]} [options.extensions=[]] - Extension plugin objects (e.g. OmidCompatBridge, MRAIDCompatBridge).
   *   Each extension may implement:
   *     - `getFeatureName()` → string  — added to supportedFeatures in Container:init
   *     - `injectIntoMarkup(html)` → string — called before iframe load to inject scripts into creative HTML
   *       (only used when options.useMarkupInjection=true — see below)
   *     - `destroy()` — called when the container is terminated
   * @param {boolean} [options.useMarkupInjection=false] - Opt-in: fetch the creative HTML, pipe it through
   *   each extension's injectIntoMarkup(), and load via srcdoc instead of src.
   *
   *   DEFAULT (Option 2 — recommended): OM SDK loads on the publisher page as a <script> tag.
   *   The container-side bridge manages the Session Client from the page context. No fetch, no srcdoc.
   *   Works across all origins. Matches the native SDK model (app owns OM SDK, not the creative).
   *
   *   ALTERNATIVE (Option 3 — same-origin only): Set useMarkupInjection=true when the creative URL
   *   is same-origin and CORS is not a constraint. Useful for test environments and publishers who
   *   control both the page and the creative server. Cross-origin creative URLs will fail to fetch
   *   and fall back to direct src loading (OM SDK will not be injected).
   * @param {Object} [options.timeouts] - Override default timeout values.
   * @param {Function} [options.onStateChange] - Called with (newState, previousState) on transition.
   * @param {Function} [options.onClose] - Called when the container has fully closed.
   * @param {Function} [options.onError] - Called with (errorCode, errorMessage) on fatal errors.
   * @param {Function} [options.onNavigation] - Called with (navigationArgs) when creative requests navigation.
   * @param {Function} [options.onInteraction] - Called with (trackingUris) when creative reports interaction.
   * @param {Function} [options.onMessage] - Called with every received message (for debugging/logging).
   * @param {boolean} [options.autoStart=true] - If true, calls startCreative automatically after init resolves.
   * @param {boolean} [options.visible=false] - Initial iframe visibility. Set to false to preload silently.
   */
  constructor(/** @type {Object} */ options = {}) {
    const {
      creativeUrl,
      containerEl,
      environmentData = {},
      supportedFeatures = [],
      extensions = [],
      timeouts = {},
      onStateChange,
      onClose,
      onError,
      onNavigation,
      onInteraction,
      onMessage,
      autoStart = true,
      visible = false,
      useMarkupInjection = false,
      placementPolicy,
      closeButtonStyles,
    } = options;

    if (!creativeUrl) throw new Error('[SHARCContainer] creativeUrl is required');
    if (!containerEl) throw new Error('[SHARCContainer] containerEl is required');

    /** @type {string} */
    this.creativeUrl = creativeUrl;

    /** @type {HTMLElement} */
    this.containerEl = containerEl;

    /** @type {Object} */
    this.environmentData = environmentData;

    // Auto-derive publisherContext from browser APIs if not explicitly provided
    if (!this.environmentData.publisherContext) {
      this.environmentData.publisherContext = SHARCContainer._derivePublisherContext();
    }

    /**
     * Extension plugin instances.
     * Each may contribute a feature name, inject markup, and/or require cleanup.
     * @type {Array}
     */
    this._extensions = extensions;

    /**
     * Explicit supportedFeatures passed directly by the caller.
     * Accepts either plain feature name strings or descriptor objects.
     * Extension-contributed features are merged in at session time, but only as feature names.
     * @type {Array<string | {name: string, version?: string}>}
     */
    this._explicitSupportedFeatures = supportedFeatures;

    /** @type {Object} */
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };

    /** @type {boolean} */
    this.autoStart = autoStart;

    // Callbacks
    this._onStateChange = onStateChange || null;
    this._onClose = onClose || null;
    this._onError = onError || null;
    this._onNavigation = onNavigation || null;
    this._onInteraction = onInteraction || null;
    this._onMessage = onMessage || null;

    /** @type {HTMLIFrameElement|null} */
    this._iframe = null;

    /** @type {SHARCContainerProtocol} */
    this._protocol = new SHARCContainerProtocol();

    /** @type {SHARCStateMachine} */
    this._stateMachine = new SHARCStateMachine(ContainerStates.LOADING);

    /** Active timeout handles (for cleanup). @type {Object.<string,number>} */
    this._timeouts = {};

    /** Whether a close has been requested. @type {boolean} */
    this._closeRequested = false;

    /** Whether _terminate() has already been called. @type {boolean} */
    this._terminated = false;

    // Wire up state machine → callback
    this._stateMachine.onChange((newState, prevState) => {
      this._onStateChange && this._onStateChange(newState, prevState);
    });

    // Wire up page lifecycle listeners (for web browser state tracking)
    this._pageFocusHandler = this._onPageFocus.bind(this);
    this._pageBlurHandler = this._onPageBlur.bind(this);
    this._visibilityHandler = this._onVisibilityChange.bind(this);
    this._freezeHandler = this._onFreeze.bind(this);
    this._resumeHandler = this._onResume.bind(this);

    this._initiallyVisible = visible;

    // Debounced handler for viewport changes that may affect placement constraints
    this._constraintsDebounceTimer = null;
    this._constraintsResizeHandler = this._onConstraintsRelevantResize.bind(this);
    this._constraintsOrientationHandler = this._onConstraintsRelevantOrientation.bind(this);

    /**
     * Last placement payload sent via notifyPlacementChange().
     * Used by _syncPlacementState() to skip redundant sends.
     * @type {Object|null}
     */
    this._lastSentPlacement = null;

    /**
     * When true, fetch() the creative HTML and pipe it through extension injectors
     * before loading via srcdoc. Opt-in only — see options.useMarkupInjection JSDoc.
     * Default: false (publisher-page OM SDK loading, Option 2).
     * @type {boolean}
     */
    this._useMarkupInjection = useMarkupInjection;

    /**
     * Rate limiter state: sliding window of message timestamps (SEC-007).
     * Max 50 messages per second.
     * @type {number[]}
     * @private
     */
    this._rateLimiterTimestamps = [];

    /**
     * Placement policy — container-local enforcement layer.
     * Never sent over the wire. When undefined, no policy enforcement occurs.
     * @type {Object|undefined}
     */
    this._placementPolicy = placementPolicy || undefined;

    /**
     * Publisher customization for the container-rendered close button.
     * Applied via Object.assign over defaults; minimum 50 DIP enforced.
     * @type {Object|null}
     */
    this._closeButtonStyles = closeButtonStyles || null;

    /**
     * The container-rendered close button DOM element (sibling to iframe).
     * @type {HTMLElement|null}
     */
    this._closeButton = null;

    /**
     * Tracks the current placement intent ('resize', 'maximize', 'fullscreen', or null).
     * Used by close button click handler to determine restore vs close behavior.
     * @type {string|null}
     */
    this._currentIntent = null;

    /**
     * Snapshot of the original placement from construction time.
     * Used by restore to return to the original state, independent of
     * mutations that _handleRequestPlacementChange applies to environmentData.
     * @type {Object}
     */
    this._originalPlacement = { ...(this.environmentData.currentPlacement || {}) };

    /**
     * Snapshot of the iframe's CSS state before the first resize.
     * Restored on minimize/restore to fix position reset bug.
     * @type {Object|null}
     */
    this._preResizeCSSState = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Creates the iframe, sets up the MessageChannel, and begins the SHARC
   * initialization handshake. This starts the ad lifecycle.
   *
   * @returns {SHARCContainer} this (for chaining)
   */
  load() {
    this._createIframe();
    this._registerProtocolListeners();
    this._attachPageLifecycleListeners();
    this._startSessionTimeout();
    return this;
  }

  /**
   * Initiates the Container:close message flow.
   * Sends Container:close, waits up to 2s for creative acknowledgment, then terminates.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  close() {
    if (this._closeRequested) return;
    this._closeRequested = true;
    this._initiateClose();
  }

  /**
   * Sends Container:log to the creative.
   * @param {string} message
   */
  log(message) {
    this._protocol.sendLog(message);
  }

  /**
   * Returns the current container state.
   * @returns {string}
   */
  getState() {
    return this._stateMachine.getState();
  }

  /**
   * Transitions the container to a new state.
   * Sends a stateChange message to the creative if the new state is creative-queryable.
   * @param {string} newState - A ContainerStates value (e.g. 'active', 'hidden', 'frozen').
   * @returns {boolean} True if the transition was valid and applied.
   */
  setState(newState) {
    const success = this._stateMachine.transition(newState);
    if (success && this._stateMachine.isCreativeQueryable(newState)) {
      this._protocol.sendStateChange(newState);
    }
    return success;
  }

  /**
   * Notifies the creative of an audio state change.
   * Clamps volumePercentage to [0, 100] before storing or sending.
   * isMuted is independent of volumePercentage — muting does NOT zero the volume.
   * LOADING / READY / HIDDEN buffer into environmentData.
   * ACTIVE / PASSIVE send live.
   * FROZEN / TERMINATED warn and drop.
   *
   * @param {Object}  audioState
   * @param {number}  audioState.volumePercentage - Current volume level (0–100)
   * @param {boolean} audioState.isMuted          - Whether audio is muted (independent of volume)
   */
  setAudioState({ volumePercentage, isMuted }) {
    const state = this._stateMachine.getState();

    if (!Number.isFinite(volumePercentage)) {
      console.warn('[SHARCContainer] setAudioState: volumePercentage must be a finite number');
      return;
    }

    // FROZEN / TERMINATED — drop entirely; JS is suspended or protocol is gone.
    if (state === ContainerStates.FROZEN || state === ContainerStates.TERMINATED) {
      console.warn('[SHARCContainer] setAudioState called in invalid state:', state);
      return;
    }

    // Store independently — never derive isMuted from volumePercentage
    this.environmentData.volumePercentage = Math.max(0, Math.min(100, Math.round(volumePercentage)));
    this.environmentData.volume = this.environmentData.volumePercentage / 100;
    this.environmentData.isMuted = isMuted;

    // LOADING — MessagePort not yet established; persist to environmentData only.
    // The updated values will be delivered on the ACTIVE transition via _syncAudioState().
    if (state === ContainerStates.LOADING) {
      return;
    }

    // READY / HIDDEN — MessagePort is live but the creative is not yet interactive.
    // Buffer the value in environmentData only; _syncAudioState() will deliver it
    // on the next ACTIVE transition. Sending now would be redundant — the ACTIVE
    // transition sync is the sole delivery mechanism for preloaded ads.
    if (state === ContainerStates.READY || state === ContainerStates.HIDDEN) {
      return;
    }

    // ACTIVE / PASSIVE — creative is running; send the update live.
    this._protocol.sendAudioVolumeChange(this.environmentData.volumePercentage, isMuted);
  }

  /**
   * Builds the outbound placementChange payload.
   * Priority 2: Automatically enriches the payload with the current iframe position
   * if the iframe exists, so bridges can use it for resize/expand calculations.
   * @param {Object} placementUpdate - Placement data to send.
   * @param {Object} [placementUpdate.size] - {width, height} of the new placement.
   * @param {Object} [placementUpdate.position] - {x, y} of the new placement.
   * @returns {Object}
   * @private
   */
  _buildPlacementChangePayload(placementUpdate) {
    const payload = { ...placementUpdate };
    if (this._iframe) {
      try {
        const iframeRect = this._iframe.getBoundingClientRect();
        payload.position = {
          x: iframeRect.x,
          y: iframeRect.y,
          width: iframeRect.width,
          height: iframeRect.height,
        };
      } catch (e) {
        // Non-browser environment: skip position enrichment
      }
    }
    return payload;
  }

  /**
   * Sends a placementChange notification to the creative.
   * The outbound payload may enrich placementUpdate.position with the iframe's
   * current x/y/width/height when that information is available.
   * @param {Object} placementUpdate - Placement data to send.
   * @param {Object} [extra] - Additional fields to include (e.g. transition, closeButtonPosition).
   */
  notifyPlacementChange(placementUpdate, extra) {
    const payload = this._buildPlacementChangePayload(placementUpdate);
    // Send notification with extra fields merged at the args level
    const args = { placementUpdate: payload };
    if (extra) {
      if (extra.transition) args.transition = extra.transition;
      if (extra.closeButtonPosition) args.closeButtonPosition = extra.closeButtonPosition;
    }
    this._protocol._sendMessage(ContainerMessages.PLACEMENT_CHANGE, args);
    this._lastSentPlacement = payload;
  }

  // -------------------------------------------------------------------------
  // Iframe creation
  // -------------------------------------------------------------------------

  /**
   * Creates and inserts the secure iframe for the creative.
   *
   * Default path (Option 2 — recommended): sets iframe.src directly. OM SDK loads
   * on the publisher page as a regular <script> tag; the container-side bridge
   * manages the Session Client from the page context. Zero CORS dependency.
   *
   * Alternative path (Option 3 — opt-in via useMarkupInjection=true): fetches the
   * creative HTML, pipes it through each extension's injectIntoMarkup(), and loads
   * via srcdoc. Same-origin creative URLs only. Falls back to direct src if fetch
   * fails, logging a warning. Useful for test environments and same-origin deployments.
   *
   * @private
   */
  _createIframe() {
    const iframe = document.createElement('iframe');

    // Secure sandbox attributes.
    // SEC-001: `allow-same-origin` is intentionally ABSENT.
    // Combining `allow-scripts` + `allow-same-origin` on a same-origin iframe
    // allows the embedded document to remove the sandbox attribute entirely
    // (complete sandbox escape). MessageChannel does NOT require same-origin
    // — the port is transferred and works across origins.
    iframe.setAttribute('sandbox', [
      'allow-scripts',
      // 'allow-same-origin' — REMOVED: defeats sandbox isolation (SEC-001)
      'allow-forms',
      'allow-popups',
      // 'allow-popups-to-escape-sandbox' — REMOVED: grants unsandboxed popup access (SEC-010)
    ].join(' '));

    // Minimal allow policies
    iframe.setAttribute('allow', 'autoplay; fullscreen');

    // Scrolling and styling
    iframe.style.cssText = [
      'border: none',
      'width: 100%',
      'height: 100%',
      `display: ${this._initiallyVisible ? 'block' : 'none'}`,
    ].join('; ');

    iframe.setAttribute('id', `sharc-creative-${Date.now()}`);

    // Attach to DOM now so contentWindow is available when we wire the channel
    this.containerEl.appendChild(iframe);

    this._iframe = iframe;

    // -----------------------------------------------------------------------
    // Default (Option 2): load creative via src directly.
    // OM SDK is managed on the publisher page; no fetch or srcdoc needed.
    //
    // Alternative (Option 3): if useMarkupInjection=true, fetch the creative
    // HTML, pipe through injectors, and load via srcdoc.
    // Same-origin creative URLs only — cross-origin fetches will fail and
    // fall back to direct src with a warning.
    //
    // NOTE: srcdoc gives the iframe an effective origin of the parent document
    // (or 'null' with sandbox). Injected scripts must use absolute URLs.
    // -----------------------------------------------------------------------

    // Wire MessageChannel on load regardless of path.
    iframe.addEventListener('load', () => {
      setTimeout(() => this._protocol.initChannel(iframe.contentWindow), 200);
    });

    if (!this._useMarkupInjection) {
      // Default path (Option 2 — recommended): publisher-page OM SDK loading.
      iframe.src = this.creativeUrl;
      return;
    }

    // Alternative path (Option 3 — opt-in): fetch → inject → srcdoc.
    const injectors = this._extensions.filter(
      (ext) => typeof ext.injectIntoMarkup === 'function'
    );

    if (injectors.length === 0) {
      // No injectors registered — fall straight through to src.
      iframe.src = this.creativeUrl;
      return;
    }

    this._fetchAndInjectCreative(injectors).catch((err) => {
      // Fetch or injection failed — fall back to direct src.
      // The creative will load without injected scripts; OMID measurement
      // via injection will not function. Monitor for this warning in production.
      console.warn(
        '[SHARCContainer] Markup injection failed; falling back to direct src load. ' +
        'Check that creativeUrl is same-origin or use the default publisher-page ' +
        'OM SDK loading pattern (useMarkupInjection=false).',
        err && (err.message || err)
      );
      iframe.src = this.creativeUrl;
    });
  }

  /**
   * Fetches the creative HTML, pipes it through each injector extension, and
   * assigns the result to `iframe.srcdoc`.
   *
   * SECURITY NOTE: Extensions are trusted publisher code. The `injectIntoMarkup`
   * hook receives the creative HTML string (from a validated same-origin fetch)
   * and returns a modified string. This code must NOT be used with untrusted
   * input or extensions from unverified sources, as malicious code could inject
   * arbitrary content into the creative iframe.
   *
   * @param {Array} injectors - Extensions with `injectIntoMarkup(html)` method.
   * @returns {Promise<void>}
   * @private
   */
  async _fetchAndInjectCreative(injectors) {
    // Fetch the creative HTML. Use no-cors only as a fallback; prefer cors so
    // we can read the response body. If the creative is cross-origin and the
    // server doesn't send CORS headers, this will throw — that is intentional:
    // we cannot inject into markup we cannot read.
    let html;
    try {
      const response = await fetch(this.creativeUrl, {
        method: 'GET',
        redirect: 'follow',
        // Omit credentials to avoid sending cookies to the creative origin.
        credentials: 'omit',
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      html = await response.text();
    } catch (fetchErr) {
      // Re-throw so _createIframe's .catch() can fall back to direct src load.
      throw new Error(`Failed to fetch creative for injection: ${fetchErr.message || fetchErr}`);
    }

    // Pipe through each injector in registration order.
    // Each injector receives the HTML string and returns the modified string.
    for (const injector of injectors) {
      try {
        const result = injector.injectIntoMarkup(html);
        if (typeof result === 'string' && result.length > 0) {
          html = result;
        }
      } catch (injectErr) {
        console.warn(
          '[SHARCContainer] Extension injectIntoMarkup threw; continuing with prior HTML.',
          injectErr && (injectErr.message || injectErr)
        );
      }
    }

    // Load the injected markup via srcdoc.
    // The iframe's load event will fire, triggering MessageChannel setup.
    if (this._iframe) {
      this._iframe.srcdoc = html;
    }
  }

  // -------------------------------------------------------------------------
  // Protocol listener registration
  // -------------------------------------------------------------------------

  /**
   * Registers all incoming message listeners on the protocol.
   * @private
   */
  _registerProtocolListeners() {
    const proto = this._protocol;

    // createSession — session establishment
    proto.addListener(ProtocolMessages.CREATE_SESSION, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleCreateSession(msg);
    });

    // Creative:fatalError
    proto.addListener(CreativeMessages.FATAL_ERROR, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleCreativeFatalError(msg);
    });

    // Creative:getContainerState
    proto.addListener(CreativeMessages.GET_CONTAINER_STATE, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      const state = this._stateMachine.getState();
      const responseState = this._stateMachine.isCreativeQueryable(state) ? state : ContainerStates.READY;
      proto._resolve(msg, { currentState: responseState });
    });

    // Creative:getPlacementOptions
    proto.addListener(CreativeMessages.GET_PLACEMENT_OPTIONS, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      proto._resolve(msg, {
        currentPlacementOptions: this.environmentData.currentPlacement || {},
      });
    });

    // Creative:getPlacementConstraints
    proto.addListener(CreativeMessages.GET_PLACEMENT_CONSTRAINTS, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      const policy = this._placementPolicy || {};
      proto._resolve(msg, {
        maxWidth:           policy.maxWidth != null ? policy.maxWidth : null,
        maxHeight:          policy.maxHeight != null ? policy.maxHeight : null,
        allowedIntents:     policy.allowedIntents || ['resize', 'maximize', 'fullscreen', 'minimize', 'restore'],
        requireCloseRegion: !!policy.requireCloseRegion,
        allowOffscreen:     policy.allowOffscreen !== false,
      });
    });

    // Creative:log
    proto.addListener(CreativeMessages.LOG, /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', msg);
      console.log('[SHARC Creative Log]', msg.args && msg.args.message);
    }));

    // Creative:reportInteraction
    proto.addListener(CreativeMessages.REPORT_INTERACTION, /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleReportInteraction(msg);
    }));

    // Creative:requestNavigation
    proto.addListener(CreativeMessages.REQUEST_NAVIGATION, /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestNavigation(msg);
    }));

    // Creative:requestPlacementChange
    proto.addListener(CreativeMessages.REQUEST_PLACEMENT_CHANGE, /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestPlacementChange(msg);
    }));

    // Creative:requestClose
    proto.addListener(CreativeMessages.REQUEST_CLOSE, /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestClose(msg);
    }));

    // Creative:getFeatures
    proto.addListener(CreativeMessages.GET_FEATURES, /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', msg);
      // Return the same merged feature list that was sent in Container:init.
      // _mergedSupportedFeatures is populated during _handleCreateSession.
      proto._resolve(msg, { features: this._mergedSupportedFeatures || this._explicitSupportedFeatures || [] });
    }));

    // Creative:requestOmid — fire-and-forget feature message from creative
    // The creative can send these via SHARC.requestFeature('com.iabtechlab.sharc.omid', {...}).
    // The container forwards them back into the creative frame as a window.postMessage
    // so the OmidCompatBridge (running inside the creative frame) can handle them.
    // This supports the full SHARC protocol path in addition to the direct
    // window.SHARC.omid.request() call surface.
    proto.addListener('SHARC:Creative:requestOmid', /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', msg);
      if (this._iframe && this._iframe.contentWindow) {
        this._iframe.contentWindow.postMessage(
          Object.assign({ type: 'SHARC:Omid:request' }, msg.args && msg.args.args || {}),
          '*'
        );
      }
      // Resolve immediately — this is a fire-and-forget notification
      proto._resolve(msg, {});
    }));

    // Creative:requestMessage — SafeFrame $sf.ext.message() bridged via requestFeature
    // The creative calls $sf.ext.message(msg) which maps to:
    //   SHARC.requestFeature('com.iabtechlab.sharc.safeframe.message', { payload: msg })
    // The container receives it here and delivers via onMessage for the publisher to handle.
    proto.addListener('SHARC:Creative:requestMessage', /** @type {(msg: any) => void} */ ((msg) => {
      this._onMessage && this._onMessage('received', { type: 'safeframe-message', args: msg && msg.args });
      // Resolve immediately — fire-and-forget, SafeFrame spec doesn't define a return value
      proto._resolve(msg, {});
    }));
  }

  // -------------------------------------------------------------------------
  // Session lifecycle handlers
  // -------------------------------------------------------------------------

  /**
   * Handles incoming createSession from the creative.
   * Establishes the session, clears the session timeout, and sends Container:init.
   * @param {Object} msg
   * @private
   */
  _handleCreateSession(msg) {
    this._clearTimeout('createSession');

    // Establish session
    this._protocol.acceptSession(msg);

    // Build the merged supportedFeatures list:
    //   1. Explicit features passed via options.supportedFeatures
    //   2. Feature names contributed by each extension via getFeatureName()
    // Extensions auto-add feature names only. Pass explicit descriptor objects if
    // creatives need metadata such as version/capabilities from Container:init.
    // Extensions that don't implement getFeatureName() are silently skipped.
    const extensionFeatureNames = this._extensions
      .filter((ext) => typeof ext.getFeatureName === 'function')
      .map((ext) => {
        try { return ext.getFeatureName(); } catch (e) { return null; }
      })
      .filter(Boolean);

    // Auto-register placement feature strings
    const placementFeatures = [
      'com.iabtechlab.sharc.placement.resize',
      'com.iabtechlab.sharc.placement.constraints',
      'com.iabtechlab.sharc.placement.animate',
    ];

    const mergedFeatures = [
      ...this._explicitSupportedFeatures,
      ...extensionFeatureNames,
      ...placementFeatures,
    ];

    // Cache for subsequent getFeatures() queries from the creative
    this._mergedSupportedFeatures = mergedFeatures;

    // Build the full init payload
    // Priority 2: Include iframe's absolute position so bridges can use it for resize/expand
    let initialPosition = null;
    if (this._iframe) {
      try {
        const iframeRect = this._iframe.getBoundingClientRect();
        initialPosition = {
          x: iframeRect.x,
          y: iframeRect.y,
          width: iframeRect.width,
          height: iframeRect.height,
        };
      } catch (e) {
        // getBoundingClientRect may fail in non-browser environments; initialPosition stays null
      }
    }

    const initArgs = {
      environmentData: {
        ...this.environmentData,
        currentState: ContainerStates.READY,
        version: SHARC_VERSION,
        ...(initialPosition !== null ? { initialPosition } : {}),
      },
      supportedFeatures: mergedFeatures,
    };

    // Send Container:init
    const initTimeout = this._startTimeout('initResolve', () => {
      console.error('[SHARCContainer] Timeout waiting for Container:init resolve');
      this._handleFatalError(ErrorCodes.RESOLVE_TIMEOUT, 'Timeout waiting for init resolve');
    });

    this._protocol.sendInit(initArgs.environmentData, initArgs.supportedFeatures)
      .then((resolveValue) => {
        this._clearTimeout('initResolve');
        this._onMessage && this._onMessage('sent-resolved', { type: ContainerMessages.INIT, resolveValue });
        this._handleInitResolved(resolveValue);
      })
      .catch((rejectValue) => {
        this._clearTimeout('initResolve');
        console.error('[SHARCContainer] Creative rejected init:', rejectValue);
        this._handleFatalError(
          rejectValue && rejectValue.errorCode || ErrorCodes.CANNOT_EXECUTE_CREATIVE,
          'Creative rejected Container:init'
        );
      });
  }

  /**
   * Called when the creative resolves Container:init.
   * Transitions to READY, optionally fires startCreative.
   * @param {*} resolveValue
   * @private
   */
  _handleInitResolved(resolveValue) {
    this.setState(ContainerStates.READY);

    if (this.autoStart) {
      this._sendStartCreative();
    }
    // If autoStart is false, caller is responsible for calling _sendStartCreative()
    // via a public method (e.g., start()).
  }

  /**
   * Sends Container:startCreative.
   * @private
   */
  _sendStartCreative() {
    this._startTimeout('startResolve', () => {
      console.error('[SHARCContainer] Timeout waiting for Container:startCreative resolve');
      this._handleFatalError(ErrorCodes.NO_START_REPLY, 'Timeout waiting for startCreative resolve');
    });

    this._protocol.sendStartCreative()
      .then((resolveValue) => {
        this._clearTimeout('startResolve');
        this._onMessage && this._onMessage('sent-resolved', { type: ContainerMessages.START_CREATIVE, resolveValue });
        this._handleStartCreativeResolved();
      })
      .catch((rejectValue) => {
        this._clearTimeout('startResolve');
        console.error('[SHARCContainer] Creative rejected startCreative:', rejectValue);
        this._handleFatalError(
          rejectValue && rejectValue.errorCode || ErrorCodes.CANNOT_EXECUTE_CREATIVE,
          'Creative rejected Container:startCreative'
        );
      });
  }

  /**
   * Manually triggers startCreative (when autoStart is false).
   * Only valid when the container is in the READY state.
   * @returns {void}
   */
  start() {
    if (this._stateMachine.getState() !== ContainerStates.READY) {
      console.warn('[SHARCContainer] start() called but state is not READY');
      return;
    }
    this._sendStartCreative();
  }

  /**
   * Called when the creative resolves Container:startCreative.
   * Makes the iframe visible and transitions to ACTIVE.
   * @private
   */
  _handleStartCreativeResolved() {
    // Make the iframe visible
    if (this._iframe) {
      this._iframe.style.display = 'block';
    }
    this._transitionToActive();
  }

  // -------------------------------------------------------------------------
  // Environment state sync helpers
  // -------------------------------------------------------------------------

  /**
   * Transitions the container to ACTIVE and syncs environment state to the creative.
   * Shared by all three ACTIVE transition sites:
   *   - _handleStartCreativeResolved (initial start)
   *   - _onPageFocus (focus regained from PASSIVE)
   *   - _onResume (unfreeze with visible + focused page)
   * @private
   */
  _transitionToActive() {
    this.setState(ContainerStates.ACTIVE);
    this._syncAudioState();
    this._syncPlacementState();
  }

  /**
   * Re-sends the current audio state (volumePercentage, isMuted) to the creative
   * as an audioVolumeChange message. Called on every ACTIVE transition so that
   * creatives which were preloaded in READY/HIDDEN state receive any audio updates
   * that were buffered in environmentData but not yet delivered.
   *
   * No-op when volumePercentage or isMuted are not defined (e.g. the publisher
   * never initialised audio state).
   * @private
   */
  _syncAudioState() {
    const { volumePercentage, isMuted } = this.environmentData;
    if (volumePercentage === undefined || isMuted === undefined) return;
    this._protocol.sendAudioVolumeChange(volumePercentage, isMuted);
  }

  /**
   * Re-sends the current placement to the creative as a placementChange message.
   * Called on every ACTIVE transition to catch orientation / layout changes that
   * occurred during preload (READY or HIDDEN state).
   *
   * Skips the send only when the normalized outbound payload matches the last
   * placementChange payload sent via notifyPlacementChange().
   *
   * No-op when currentPlacement is null or undefined.
   * @private
   */
  _syncPlacementState() {
    const placement = this.environmentData.currentPlacement;
    if (placement == null) return;

    const payload = this._buildPlacementChangePayload(placement);
    if (this._placementPayloadUnchanged(payload)) return;

    this.notifyPlacementChange(placement);
  }

  /**
   * Returns true when the given placement payload matches the last sent payload
   * on width/height and position bounds.
   * @param {Object} payload
   * @returns {boolean}
   * @private
   */
  _placementPayloadUnchanged(payload) {
    const last = this._lastSentPlacement;
    if (!last) return false;

    const lastPosition = last.position || {};
    const nextPosition = payload.position || {};

    return last.width === payload.width &&
           last.height === payload.height &&
           lastPosition.x === nextPosition.x &&
           lastPosition.y === nextPosition.y &&
           lastPosition.width === nextPosition.width &&
           lastPosition.height === nextPosition.height;
  }

  // -------------------------------------------------------------------------
  // Creative request handlers
  // -------------------------------------------------------------------------

  /**
   * Handles Creative:fatalError.
   * @param {Object} msg
   * @private
   */
  _handleCreativeFatalError(msg) {
    const { errorCode, errorMessage } = (msg.args || {});
    console.error('[SHARCContainer] Creative fatal error:', errorCode, errorMessage);
    this._onError && this._onError(errorCode, errorMessage);
    this._terminate();
  }

  /**
   * Handles Creative:reportInteraction — fires tracking URIs.
   * @param {Object} msg
   * @private
   */
  _handleReportInteraction(msg) {
    const MAX_TRACKERS = 20;
    const { trackingUris = [] } = (msg.args || {});
    // SEC-004: Validate tracker URIs — only https/http allowed, cap at MAX_TRACKERS
    const safeUris = trackingUris
      .slice(0, MAX_TRACKERS)
      .filter((uri) => this._isNavigationUrlSafe(uri));
    this._onInteraction && this._onInteraction(safeUris);
    this._fireTrackers(safeUris).then((results) => {
      this._protocol._resolve(msg, { results });
    });
  }

  /**
   * Validates a URL for safe navigation/tracking use.
   * Only allows https: and http: schemes (SEC-003, SEC-004).
   * Rejects javascript:, data:, file:, and all other schemes.
   * @param {string} url
   * @returns {boolean}
   * @private
   */
  _isNavigationUrlSafe(url) {
    if (typeof url !== 'string' || !url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  /**
   * Fires tracker URIs and returns a promise that resolves when all have been fired.
   * @param {string[]} trackingUris - Array of safe tracker URIs.
   * @returns {Promise<Array<{ uri: string, status: 'success' | 'error', statusText: string }>>}
   * @private
   */
  async _fireTrackers(trackingUris) {
    const results = [];
    for (const uri of trackingUris) {
      try {
        const tracker = new Image();
        tracker.onload = () => results.push({ uri, status: 'success', statusText: 'OK' });
        tracker.onerror = () => results.push({ uri, status: 'error', statusText: 'Error' });
        tracker.src = uri;
      } catch (e) {
        results.push({ uri, status: 'error', statusText: 'Exception' });
      }
    }
    // Give trackers a moment to start firing, then resolve
    await new Promise((resolve) => setTimeout(resolve, 50));
    return results;
  }

  /**
   * Handles Creative:requestNavigation — calls onNavigation callback.
   * @param {Object} msg
   * @private
   */
  _handleRequestNavigation(msg) {
    const { url } = (msg.args || {});
    if (url && this._isNavigationUrlSafe(url)) {
      this._onNavigation && this._onNavigation({ url });
      this._protocol._resolve(msg, {});
    } else {
      this._protocol._reject(msg, ErrorCodes.CANNOT_EXECUTE_CREATIVE, 'Invalid navigation URL');
    }
  }

  /**
   * Handles Creative:requestPlacementChange.
   * @param {Object} msg
   * @private
   */
  _handleRequestPlacementChange(msg) {
    const { placementUpdate, transition, closeButtonPosition } = (msg.args || {});
    // Optional: _placementPolicy enforcement can go here in the future
    this.notifyPlacementChange(placementUpdate, { transition, closeButtonPosition });
    this._protocol._resolve(msg, {});
  }

  /**
   * Handles Creative:requestClose.
   * @param {Object} msg
   * @private
   */
  _handleRequestClose(msg) {
    // If the creative requests close, just confirm it; the container decides
    // whether to actually close. For backward compatibility, we treat all
    // requestClose messages as confirmation to proceed with close.
    this.close();
    this._protocol._resolve(msg, {});
  }

  // -------------------------------------------------------------------------
  // Page lifecycle listeners
  // -------------------------------------------------------------------------

  /**
   * Attaches page lifecycle event listeners (visibility, focus, freeze, resume).
   * @private
   */
  _attachPageLifecycleListeners() {
    // visibilitychange
    document.addEventListener('visibilitychange', this._visibilityHandler, false);

    // Focus/blur
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', this._pageFocusHandler, false);
      window.addEventListener('blur', this._pageBlurHandler, false);
    }

    // Freeze/resume (Safari)
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('freeze', this._freezeHandler, false);
      document.addEventListener('resume', this._resumeHandler, false);
    }

    // Resize observer for placement constraints (debounced)
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        if (this._constraintsDebounceTimer) {
          clearTimeout(this._constraintsDebounceTimer);
        }
        this._constraintsDebounceTimer = setTimeout(() => {
          this._onConstraintsRelevantResize();
        }, 200);
      });
      resizeObserver.observe(document.body);
    }

    // Orientation change (mobile)
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('orientationchange', this._constraintsOrientationHandler, false);
    }
  }

  /**
   * Detaches page lifecycle event listeners.
   * @private
   */
  _detachPageLifecycleListeners() {
    document.removeEventListener('visibilitychange', this._visibilityHandler, false);

    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('focus', this._pageFocusHandler, false);
      window.removeEventListener('blur', this._pageBlurHandler, false);
    }

    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('freeze', this._freezeHandler, false);
      document.removeEventListener('resume', this._resumeHandler, false);
    }
  }

  /**
   * Page focus — transition from passive to active.
   * @private
   */
  _onPageFocus() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.PASSIVE) {
      this._transitionToActive();
    }
  }

  /**
   * Page blur — transition from active to passive.
   * @private
   */
  _onPageBlur() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.ACTIVE) {
      this.setState(ContainerStates.PASSIVE);
    }
  }

  /**
   * Page visibility change.
   * @private
   */
  _onVisibilityChange() {
    const state = this._stateMachine.getState();
    if (document.hidden) {
      if (state === ContainerStates.ACTIVE || state === ContainerStates.PASSIVE) {
        this.setState(ContainerStates.HIDDEN);
      }
    } else {
      // Page visible again — check if we should go active
      if (this._stateMachine.isCreativeQueryable(state)) {
        // We need to check focus state to decide between ACTIVE and PASSIVE
        // but we can't do that here synchronously — defer to focus/blur handlers
      }
    }
  }

  /**
   * Page freeze (Safari) — transition to frozen.
   * @private
   */
  _onFreeze() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.ACTIVE || state === ContainerStates.PASSIVE || state === ContainerStates.HIDDEN) {
      this.setState(ContainerStates.FROZEN);
    }
  }

  /**
   * Page resume (Safari) — transition based on visibility/focus.
   * @private
   */
  _onResume() {
    const state = this._stateMachine.getState();
    if (state !== ContainerStates.FROZEN) return;

    if (document.hidden) {
      this.setState(ContainerStates.HIDDEN);
    } else if (document.visibilityState === 'visible') {
      // Check focus state to decide ACTIVE vs PASSIVE
      if (document.hasFocus()) {
        this._transitionToActive();
      } else {
        this.setState(ContainerStates.PASSIVE);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup and termination
  // -------------------------------------------------------------------------

  /**
   * Clears a named timeout.
   * @param {string} name - The timeout name.
   * @private
   */
  _clearTimeout(name) {
    const id = this._timeouts[name];
    if (id) {
      clearTimeout(id);
      delete this._timeouts[name];
    }
  }

  /**
   * Starts a named timeout.
   * @param {string} name - The timeout name.
   * @param {Function} callback - The callback to run when the timeout expires.
   * @returns {number} The timeout ID.
   * @private
   */
  _startTimeout(name, callback) {
    this._clearTimeout(name);
    this._timeouts[name] = setTimeout(() => {
      delete this._timeouts[name];
      callback();
    }, this.timeouts[name]);
    return this._timeouts[name];
  }

  /**
   * Terminates the container and cleans up resources.
   * Called when the creative has been closed, or when a fatal error occurs.
   * @private
   */
  _terminate() {
    if (this._terminated) return;
    this._terminated = true;

    // Stop all timeouts
    Object.keys(this._timeouts).forEach((name) => this._clearTimeout(name));

    // Clear session
    this._protocol.terminate();

    // Detach protocol listeners
    this._protocol.removeListeners();

    // Detach page lifecycle listeners
    this._detachPageLifecycleListeners();

    // Remove iframe
    if (this._iframe && this._iframe.parentElement) {
      this._iframe.parentElement.removeChild(this._iframe);
      this._iframe = null;
    }

    // Close button cleanup
    if (this._closeButton && this._closeButton.parentElement) {
      this._closeButton.parentElement.removeChild(this._closeButton);
      this._closeButton = null;
    }

    // Run close callback
    if (this._onClose) {
      this._onClose();
    }

    // Mark state as terminated
    this.setState(ContainerStates.TERMINATED);

    // Call extension destroy hooks
    this._extensions.forEach((ext) => {
      if (typeof ext.destroy === 'function') {
        try { ext.destroy(); } catch (e) {
          console.warn('[SHARCContainer] Extension destroy threw:', e);
        }
      }
    });
  }

  /**
   * Initiates the close sequence.
   * @private
   */
  _initiateClose() {
    const closeTimeout = this._startTimeout('closeSequence', () => {
      console.error('[SHARCContainer] Timeout during close sequence');
      this._terminate();
    });

    // Notify the creative
    this._protocol.sendClose();

    // If creative doesn't respond, terminate anyway
    // The closeTimeout handles cleanup
  }

  /**
   * Handles fatal errors.
   * @param {string} errorCode - Error code.
   * @param {string} errorMessage - Error message.
   * @private
   */
  _handleFatalError(errorCode, errorMessage) {
    this._onError && this._onError(errorCode, errorMessage);
    this._terminate();
  }

  // -------------------------------------------------------------------------
  // Static helper methods
  // -------------------------------------------------------------------------

  /**
   * Derives publisherContext from the browser's runtime environment.
   * Resolution: window.top.location.href → document.referrer → "".
   * Rejects non-http(s) schemes (file://, about:blank, data:, etc.).
   * Follows MRAID 3.0 §2.1 pattern: empty string for unavailable string fields.
   *
   * @returns {Object} { pageUrl, domain, bundleId, platform }
   */
  static _derivePublisherContext() {
    const ctx = {
      pageUrl: '',
      domain: '',
      bundleId: '',
      platform: 'web',
    };
    try {
      let pageUrl = '';
      try {
        // Same-origin iframe: access top-level URL directly
        if (window.top && window.top.location && window.top.location.href) {
          pageUrl = window.top.location.href;
        }
      } catch (_) {
        // Cross-origin: fall back to referrer
        if (document.referrer) {
          pageUrl = document.referrer;
        }
      }

      // Only accept http(s) schemes
      if (pageUrl && /^https?:/.test(pageUrl)) {
        ctx.pageUrl = pageUrl;
        try {
          const a = document.createElement('a');
          a.href = pageUrl;
          ctx.domain = a.hostname || '';
        } catch (_) {
          ctx.domain = '';
        }
      }
    } catch (_) {
      // Best-effort — return empty strings if anything fails
    }
    return ctx;
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.SHARC = globalThis.SHARC || {};
  globalThis.SHARC.Container = SHARCContainer;
}

// Legacy IIFE support - ensure global namespace is available even with sideEffects: false
if (typeof window !== 'undefined' && typeof window.SHARC === 'undefined') {
  window.SHARC = {};
  window.SHARC.Container = SHARCContainer;
}

export { SHARCContainer, DEFAULT_TIMEOUTS, SHARC_VERSION };