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

'use strict';

// ---------------------------------------------------------------------------
// Import (or reference) protocol constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------
// sharc-protocol.js uses a CJS/browser-global wrapper so its classes are never global.
// In browser mode they live in window.SHARC.Protocol; in Node.js via require.

const {
  SHARCContainerProtocol,
  SHARCStateMachine,
  ProtocolMessages,
  ContainerMessages,
  CreativeMessages,
  ContainerStates,
  ErrorCodes,
} = (typeof module !== 'undefined' && module.exports)
  ? require('./sharc-protocol')
  : ((typeof window !== 'undefined' && window.SHARC && window.SHARC.Protocol) || {});

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
  constructor(options = {}) {
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

    /** Callbacks */
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
    proto.addListener(CreativeMessages.LOG, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      console.log('[SHARC Creative Log]', msg.args && msg.args.message);
    });

    // Creative:reportInteraction
    proto.addListener(CreativeMessages.REPORT_INTERACTION, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleReportInteraction(msg);
    });

    // Creative:requestNavigation
    proto.addListener(CreativeMessages.REQUEST_NAVIGATION, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestNavigation(msg);
    });

    // Creative:requestPlacementChange
    proto.addListener(CreativeMessages.REQUEST_PLACEMENT_CHANGE, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestPlacementChange(msg);
    });

    // Creative:requestClose
    proto.addListener(CreativeMessages.REQUEST_CLOSE, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      this._handleRequestClose(msg);
    });

    // Creative:getFeatures
    proto.addListener(CreativeMessages.GET_FEATURES, (msg) => {
      this._onMessage && this._onMessage('received', msg);
      // Return the same merged feature list that was sent in Container:init.
      // _mergedSupportedFeatures is populated during _handleCreateSession.
      proto._resolve(msg, { features: this._mergedSupportedFeatures || this._explicitSupportedFeatures || [] });
    });

    // Creative:requestOmid — fire-and-forget feature message from creative
    // The creative can send these via SHARC.requestFeature('com.iabtechlab.sharc.omid', {...}).
    // The container forwards them back into the creative frame as a window.postMessage
    // so the OmidCompatBridge (running inside the creative frame) can handle them.
    // This supports the full SHARC protocol path in addition to the direct
    // window.SHARC.omid.request() call surface.
    proto.addListener('SHARC:Creative:requestOmid', (msg) => {
      this._onMessage && this._onMessage('received', msg);
      if (this._iframe && this._iframe.contentWindow) {
        this._iframe.contentWindow.postMessage(
          Object.assign({ type: 'SHARC:Omid:request' }, msg.args && msg.args.args || {}),
          '*'
        );
      }
      // Resolve immediately — this is a fire-and-forget notification
      proto._resolve(msg, {});
    });

    // Creative:requestMessage — SafeFrame $sf.ext.message() bridged via requestFeature
    // The creative calls $sf.ext.message(msg) which maps to:
    //   SHARC.requestFeature('com.iabtechlab.sharc.safeframe.message', { payload: msg })
    // The container receives it here and delivers via onMessage for the publisher to handle.
    proto.addListener('SHARC:Creative:requestMessage', (msg) => {
      this._onMessage && this._onMessage('received', { type: 'safeframe-message', args: msg && msg.args });
      // Resolve immediately — fire-and-forget, SafeFrame spec doesn't define a return value
      proto._resolve(msg, {});
    });
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
   * Handles Creative:requestNavigation.
   * Validates the URL before acting (SEC-003).
   * Resolves or rejects the message — the creative awaits this result.
   * @param {Object} msg
   * @private
   */
  _handleRequestNavigation(msg) {
    const navArgs = msg.args || {};
    const { url, target } = navArgs;

    // SEC-003: Validate URL before any navigation action
    if (url && !this._isNavigationUrlSafe(url)) {
      this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION, 'Invalid or unsafe navigation URL');
      return;
    }

    if (this._onNavigation) {
      // Custom navigation handler — let the publisher decide
      // Handler return value does not affect protocol response; container resolves.
      try { this._onNavigation(navArgs); } catch (e) { /* ignore handler errors */ }
      this._protocol._resolve(msg, {});
    } else {
      // Default behavior: open clickthrough in new tab
      if (url && (target === 'clickthrough' || !target)) {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }
        this._protocol._resolve(msg, {});
      } else {
        // Container cannot handle this navigation type — reject so creative can try itself
        this._protocol._reject(msg, ErrorCodes.UNSPECIFIED_CONTAINER, 'Navigation type not handled by container');
      }
    }
  }

  /**
   * Handles Creative:requestPlacementChange.
   * @param {Object} msg
   * @private
   */
  _handleRequestPlacementChange(msg) {
    const args = msg.args || {};
    const { intent, targetDimensions, targetPosition, anchorPoint, closeRegion, allowOffscreen, transition } = args;

    // ── Basic type guards — run regardless of policy ──
    if (intent !== undefined && typeof intent !== 'string') {
      this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION,
        'intent must be a string, got ' + typeof intent);
      return;
    }
    if (targetDimensions) {
      if (typeof targetDimensions.width !== 'number' || !isFinite(targetDimensions.width) || targetDimensions.width <= 0 ||
          typeof targetDimensions.height !== 'number' || !isFinite(targetDimensions.height) || targetDimensions.height <= 0) {
        this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION,
          'targetDimensions width and height must be finite positive numbers');
        return;
      }
    }

    // ── Validation pipeline (only when policy is configured) ──
    let validationResolvedClose = null;
    if (this._placementPolicy) {
      const validation = this._validatePlacementRequest(args);
      if (!validation.valid) {
        this._protocol._reject(msg, validation.code, validation.message);
        return;
      }
      validationResolvedClose = validation.resolvedClose || null;
    }

    // ── Offscreen enforcement for no-policy containers ──
    if (!this._placementPolicy) {
      const effectiveAllowOffscreen = allowOffscreen !== undefined ? allowOffscreen : true;
      if (intent === 'resize' && effectiveAllowOffscreen === false && targetDimensions && this._iframe) {
        const pos = targetPosition || {
          x: this._iframe.offsetLeft,
          y: this._iframe.offsetTop,
        };
        const viewport = this._getViewportBounds();
        if (pos.x < 0 || pos.y < 0 ||
            pos.x + targetDimensions.width > viewport.width ||
            pos.y + targetDimensions.height > viewport.height) {
          this._protocol._reject(msg, ErrorCodes.UNSUPPORTED_FEATURE,
            'Resize would extend offscreen and allowOffscreen is false');
          return;
        }
      }
    }

    // ── Sub-state guard: prevent stacking placement changes without restore ──
    if (this._currentIntent && intent !== 'restore' && intent !== 'minimize') {
      // Already in a non-default placement — must restore first
      // Exception: allow same intent (e.g., resize while resized adjusts dimensions)
      if (this._currentIntent !== intent) {
        if (msg.type !== 'synthetic') {
          this._protocol._reject(msg, ErrorCodes.UNSUPPORTED_FEATURE,
            'Must restore before changing from ' + this._currentIntent + ' to ' + intent);
        }
        return;
      }
    }

    // ── Execution (with position snapshot, animation, and close button) ──
    let updatedPlacement = { ...(this.environmentData.currentPlacement || {}) };
    let skippedTransitionEndDimensions = null;

    // Resolve close button position from hint (use pre-resolved value from validation if available)
    const resolvedClose = validationResolvedClose
      ? validationResolvedClose
      : (closeRegion
        ? this._resolveClosePosition(closeRegion, targetDimensions || updatedPlacement, targetPosition)
        : { position: 'top-right', size: 50, overridden: false });

    switch (intent) {
      case 'resize':
        this._snapshotPreResizeState();
        this._currentIntent = 'resize';
        if (targetDimensions) {
          if (transition && this._supportsAnimation()) {
            const fromDims = { width: updatedPlacement.width || 0, height: updatedPlacement.height || 0 };
            updatedPlacement = { ...updatedPlacement, ...targetDimensions };
            skippedTransitionEndDimensions = this._applyAnimatedDimensions(fromDims, targetDimensions, transition, anchorPoint);
          } else {
            updatedPlacement = { ...updatedPlacement, ...targetDimensions };
            this._applyIframeDimensions(targetDimensions);
            if (transition) {
              skippedTransitionEndDimensions = targetDimensions;
            }
          }
        }
        if (targetPosition) {
          this._applyIframePosition(targetPosition);
        }
        this._createCloseButton(resolvedClose.position);
        break;
      case 'maximize':
      case 'fullscreen':
        this._snapshotPreResizeState();
        this._currentIntent = intent;
        updatedPlacement = this._getMaxPlacement(intent);
        if (transition && this._supportsAnimation()) {
          const fromDims = { width: this.environmentData.currentPlacement.width || 0, height: this.environmentData.currentPlacement.height || 0 };
          skippedTransitionEndDimensions = this._applyAnimatedDimensions(fromDims, updatedPlacement, transition, anchorPoint);
        } else {
          this._applyIframeDimensions(updatedPlacement);
          if (transition) {
            skippedTransitionEndDimensions = updatedPlacement;
          }
        }
        this._createCloseButton('top-right');
        break;
      case 'minimize':
      case 'restore':
        this._currentIntent = null;
        updatedPlacement = this._restorePreResizeState();
        this._removeCloseButton();
        break;
      default:
        this._protocol._reject(msg, ErrorCodes.MESSAGE_SPEC_VIOLATION,
          "Unknown placement intent: '" + intent + "'");
        return;
    }

    this.environmentData.currentPlacement = updatedPlacement;
    const resolvePayload = { placementUpdate: updatedPlacement };
    if (transition && this._supportsAnimation()) {
      resolvePayload.transition = this._clampTransition(transition);
    }
    // Include close button position in resolve when a close button is rendered
    if (this._closeButton && (intent === 'resize' || intent === 'maximize' || intent === 'fullscreen')) {
      resolvePayload.closeButtonPosition = {
        position: resolvedClose.position,
        x: this._closeButton.getBoundingClientRect ? this._closeButton.getBoundingClientRect().x : 0,
        y: this._closeButton.getBoundingClientRect ? this._closeButton.getBoundingClientRect().y : 0,
        width: 50,
        height: 50,
      };
    }
    if (msg.type !== 'synthetic') {
      this._protocol._resolve(msg, resolvePayload);
    }
    // Build notification extras (transition, closeButtonPosition)
    const notifyExtra = {};
    if (resolvePayload.transition) notifyExtra.transition = resolvePayload.transition;
    if (resolvePayload.closeButtonPosition) notifyExtra.closeButtonPosition = resolvePayload.closeButtonPosition;
    this.notifyPlacementChange(updatedPlacement, Object.keys(notifyExtra).length > 0 ? notifyExtra : undefined);
    if (skippedTransitionEndDimensions) {
      this._protocol._sendMessage(ContainerMessages.PLACEMENT_TRANSITION_END, {
        finalDimensions: skippedTransitionEndDimensions,
      });
    }
  }

  /**
   * Validates a placement request against the configured placement policy.
   * Returns { valid: true, resolvedClose?: {...} } if the request is valid,
   * or { valid: false, code, message } for rejection.
   * @param {Object} args - The requestPlacementChange args.
   * @returns {{ valid: true, resolvedClose?: Object } | { valid: false, code: number, message: string }}
   * @private
   */
  _validatePlacementRequest(args) {
    const policy = this._placementPolicy;
    if (!policy) return { valid: true };

    const { intent, targetDimensions, closeRegion } = args;

    // 1. Intent allowlist
    const knownIntents = ['resize', 'maximize', 'fullscreen', 'restore', 'minimize'];
    if (intent && knownIntents.indexOf(intent) === -1) {
      return { valid: false, code: ErrorCodes.MESSAGE_SPEC_VIOLATION, message: "Unknown placement intent: '" + intent + "'" };
    }
    const allowedIntents = policy.allowedIntents || knownIntents;
    if (intent && allowedIntents.indexOf(intent) === -1) {
      return { valid: false, code: ErrorCodes.UNSUPPORTED_FEATURE, message: "Intent '" + intent + "' not allowed by placement policy" };
    }

    // 2. Dimension limits
    if (intent === 'resize' && targetDimensions) {
      const maxW = policy.maxWidth != null ? policy.maxWidth : Infinity;
      const maxH = policy.maxHeight != null ? policy.maxHeight : Infinity;
      if (targetDimensions.width > maxW || targetDimensions.height > maxH) {
        return { valid: false, code: ErrorCodes.UNSUPPORTED_FEATURE, message: 'Dimensions exceed placement policy limits (max: ' + maxW + 'x' + maxH + ')' };
      }
    }

    // 3. Close region presence (when required by policy)
    if (intent === 'resize' && policy.requireCloseRegion && !closeRegion) {
      return { valid: false, code: ErrorCodes.MESSAGE_SPEC_VIOLATION, message: 'Placement policy requires closeRegion hint on resize requests' };
    }

    // 4. Close hint resolution (Section 4.3 step 4)
    // Resolve close position here so it runs before offscreen and custom validator.
    // Note: closeRegion.size is clamped (not rejected) by _resolveClosePosition — the
    // container renders its own close button, so the size field is informational.
    let resolvedClose = null;
    if (closeRegion) {
      resolvedClose = this._resolveClosePosition(
        closeRegion,
        targetDimensions || (this.environmentData.currentPlacement || {}),
        args.targetPosition
      );
    }

    // 5. Offscreen enforcement (Section 4.3 step 5)
    const effectiveAllowOffscreen = args.allowOffscreen !== undefined
      ? args.allowOffscreen
      : (policy.allowOffscreen !== undefined ? policy.allowOffscreen : true);

    if (intent === 'resize' && effectiveAllowOffscreen === false && targetDimensions && this._iframe) {
      const pos = args.targetPosition || {
        x: this._iframe.offsetLeft,
        y: this._iframe.offsetTop,
      };
      const viewport = this._getViewportBounds();
      if (pos.x < 0 || pos.y < 0 ||
          pos.x + targetDimensions.width > viewport.width ||
          pos.y + targetDimensions.height > viewport.height) {
        return { valid: false, code: ErrorCodes.UNSUPPORTED_FEATURE, message: 'Resize would extend offscreen and allowOffscreen is false' };
      }
    }

    // 6. Custom validator (synchronous)
    if (typeof policy.customValidator === 'function') {
      try {
        var result = policy.customValidator(args);
        if (result && result.allowed === false) {
          return { valid: false, code: 2203, message: result.reason || 'Rejected by custom validator' };
        }
      } catch (e) {
        console.warn('[SHARCContainer] customValidator threw:', e);
        return { valid: false, code: 2203, message: 'Custom validator error: ' + (e.message || 'unknown') };
      }
    }

    return { valid: true, resolvedClose: resolvedClose };
  }

  /**
   * Validates a close region hint and returns the effective close position.
   * The container always renders its own close button — this determines WHERE.
   * @param {Object} closeRegion - { position: string, size: number } hint from creative
   * @param {Object} targetDimensions - { width, height }
   * @param {Object} targetPosition - { x, y } or null
   * @returns {{ position: string, size: number, overridden: boolean }}
   * @private
   */
  _resolveClosePosition(closeRegion, targetDimensions, targetPosition) {
    const size = Math.max(closeRegion.size || 50, 50);
    const hintedPosition = closeRegion.position || 'top-right';

    const adX = targetPosition ? targetPosition.x : (this._iframe ? this._iframe.offsetLeft : 0);
    const adY = targetPosition ? targetPosition.y : (this._iframe ? this._iframe.offsetTop : 0);
    const adW = targetDimensions.width || 0;
    const adH = targetDimensions.height || 0;

    const rect = this._computeCloseRegionRect(adX, adY, adW, adH, hintedPosition, size);
    const viewport = this._getViewportBounds();

    if (rect.left < 0 || rect.top < 0 ||
        rect.right > viewport.width || rect.bottom > viewport.height) {
      console.warn('[SHARCContainer] Close region hint offscreen at', hintedPosition, '— defaulting to top-right');
      return { position: 'top-right', size: size, overridden: true };
    }

    return { position: hintedPosition, size: size, overridden: false };
  }

  /**
   * Computes the screen-space rect for a close region position.
   * @param {number} adX - Ad left position
   * @param {number} adY - Ad top position
   * @param {number} adW - Ad width
   * @param {number} adH - Ad height
   * @param {string} position - Position enum
   * @param {number} size - Close button size
   * @returns {{ left: number, top: number, right: number, bottom: number }}
   * @private
   */
  _computeCloseRegionRect(adX, adY, adW, adH, position, size) {
    let closeX, closeY;
    switch (position) {
      case 'top-left':      closeX = adX; closeY = adY; break;
      case 'top-center':    closeX = adX + (adW - size) / 2; closeY = adY; break;
      case 'top-right':     closeX = adX + adW - size; closeY = adY; break;
      case 'center-left':   closeX = adX; closeY = adY + (adH - size) / 2; break;
      case 'center-right':  closeX = adX + adW - size; closeY = adY + (adH - size) / 2; break;
      case 'bottom-left':   closeX = adX; closeY = adY + adH - size; break;
      case 'bottom-center': closeX = adX + (adW - size) / 2; closeY = adY + adH - size; break;
      case 'bottom-right':  closeX = adX + adW - size; closeY = adY + adH - size; break;
      default:              closeX = adX + adW - size; closeY = adY; break;
    }
    return { left: closeX, top: closeY, right: closeX + size, bottom: closeY + size };
  }

  /**
   * Snapshots the iframe's CSS state before resize, if not already captured.
   * @private
   */
  _snapshotPreResizeState() {
    if (this._preResizeCSSState || !this._iframe) return;
    this._preResizeCSSState = {
      position: this._iframe.style.position,
      left:     this._iframe.style.left,
      top:      this._iframe.style.top,
      width:    this._iframe.style.width,
      height:   this._iframe.style.height,
      containerWidth:  this.containerEl.style.width,
      containerHeight: this.containerEl.style.height,
    };
  }

  /**
   * Restores iframe CSS state to the pre-resize snapshot.
   * Clears the snapshot so the next resize captures fresh state.
   * @returns {Object} The original placement dimensions to use as updatedPlacement.
   * @private
   */
  _restorePreResizeState() {
    if (this._preResizeCSSState && this._iframe) {
      this._iframe.style.position = this._preResizeCSSState.position;
      this._iframe.style.left     = this._preResizeCSSState.left;
      this._iframe.style.top      = this._preResizeCSSState.top;
      this._iframe.style.width    = this._preResizeCSSState.width;
      this._iframe.style.height   = this._preResizeCSSState.height;
      this.containerEl.style.width  = this._preResizeCSSState.containerWidth;
      this.containerEl.style.height = this._preResizeCSSState.containerHeight;
    }
    this._preResizeCSSState = null;
    return { ...(this._originalPlacement || this.environmentData.currentPlacement || {}) };
  }

  /**
   * Returns the current viewport bounds.
   * @returns {{ width: number, height: number }}
   * @private
   */
  _getViewportBounds() {
    return {
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
    };
  }

  /**
   * Handles Creative:requestClose by entering the Container:close message flow.
   * @param {Object} msg
   * @private
   */
  _handleRequestClose(msg) {
    // Container can choose to honor or reject. Default: honor.
    this._protocol._resolve(msg, {});
    this.close();
  }

  // -------------------------------------------------------------------------
  // Container:close flow
  // -------------------------------------------------------------------------

  /**
   * Initiates the Container:close message flow.
   * Sends Container:close and terminates after 2s max.
   * @private
   */
  _initiateClose() {
    // Start close timeout — force terminate after 2s if the Container:close flow does not complete
    this._startTimeout('closeSequence', () => {
      this._terminate();
    });

    this._protocol.sendClose()
      .then(() => {
        this._clearTimeout('closeSequence');
        // Allow a brief moment for creative to run its close animation
        // then terminate. The creative had its chance, we gave it resolve.
        setTimeout(() => this._terminate(), 100);
      })
      .catch(() => {
        this._clearTimeout('closeSequence');
        this._terminate();
      });
  }

  /**
   * Terminates the container instance — removes the iframe, terminates the protocol,
   * and fires the onClose callback.
   * Guards against multiple calls (e.g. from _handleFatalError timeout races).
   * @private
   */
  _terminate() {
    if (this._terminated) return; // Guard: _terminate can be called from multiple code paths
    this._terminated = true;

    // Clear all pending timeouts
    Object.keys(this._timeouts).forEach((key) => this._clearTimeout(key));

    // Transition to terminated
    this._stateMachine.transition(ContainerStates.TERMINATED);

    // Terminate protocol
    this._protocol.terminate();

    // Remove close button
    this._removeCloseButton();

    // Remove iframe from DOM
    if (this._iframe && this._iframe.parentNode) {
      this._iframe.parentNode.removeChild(this._iframe);
      this._iframe = null;
    }

    // Remove page lifecycle listeners
    this._detachPageLifecycleListeners();

    // Clean up extensions
    this._extensions.forEach((ext) => {
      if (typeof ext.destroy === 'function') {
        try { ext.destroy(); } catch (e) { /* ignore extension destroy errors */ }
      }
    });

    // Fire close callback
    this._onClose && this._onClose();
  }

  // -------------------------------------------------------------------------
  // Fatal error handling
  // -------------------------------------------------------------------------

  /**
   * Handles a fatal error — sends Container:fatalError if possible, then terminates.
   * @param {number} errorCode
   * @param {string} [message]
   * @private
   */
  _handleFatalError(errorCode, message = '') {
    this._onError && this._onError(errorCode, message);
    this._protocol.sendFatalError(errorCode, message)
      .then(() => this._terminate())
      .catch(() => this._terminate());
    // Force terminate after 1s regardless
    setTimeout(() => this._terminate(), 1000);
  }

  // -------------------------------------------------------------------------
  // Page Lifecycle tracking (web browser)
  // -------------------------------------------------------------------------

  /**
   * Attaches browser Page Lifecycle event listeners.
   * Maps browser visibility/focus events to SHARC state transitions.
   * @private
   */
  _attachPageLifecycleListeners() {
    document.addEventListener('visibilitychange', this._visibilityHandler, false);
    window.addEventListener('focus', this._pageFocusHandler, false);
    window.addEventListener('blur', this._pageBlurHandler, false);
    document.addEventListener('freeze', this._freezeHandler, false);
    document.addEventListener('resume', this._resumeHandler, false);
    // Constraint-relevant: viewport resize and orientation change
    window.addEventListener('resize', this._constraintsResizeHandler, false);
    window.addEventListener('orientationchange', this._constraintsOrientationHandler, false);
  }

  /**
   * Removes browser Page Lifecycle event listeners.
   * @private
   */
  _detachPageLifecycleListeners() {
    document.removeEventListener('visibilitychange', this._visibilityHandler, false);
    window.removeEventListener('focus', this._pageFocusHandler, false);
    window.removeEventListener('blur', this._pageBlurHandler, false);
    document.removeEventListener('freeze', this._freezeHandler, false);
    document.removeEventListener('resume', this._resumeHandler, false);
    window.removeEventListener('resize', this._constraintsResizeHandler, false);
    window.removeEventListener('orientationchange', this._constraintsOrientationHandler, false);
    if (this._constraintsDebounceTimer) {
      clearTimeout(this._constraintsDebounceTimer);
      this._constraintsDebounceTimer = null;
    }
  }

  /** @private */
  _onPageFocus() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.PASSIVE) {
      this._transitionToActive();
    }
  }

  /** @private */
  _onPageBlur() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.ACTIVE) {
      // Defer so document.activeElement reflects the new focus target.
      // If focus moved to our own iframe, the user is interacting with
      // the ad — do not transition to passive.
      setTimeout(() => {
        if (document.activeElement === this._iframe) return;
        if (this._stateMachine.getState() === ContainerStates.ACTIVE) {
          this.setState(ContainerStates.PASSIVE);
        }
      }, 0);
    }
  }

  /** @private */
  _onVisibilityChange() {
    const state = this._stateMachine.getState();
    if (document.visibilityState === 'hidden') {
      if (state === ContainerStates.ACTIVE) {
        // The Page Lifecycle can fire visibilitychange without a prior blur on
        // mobile (for example Android backgrounding). Mirror the actual browser
        // state and transition directly once hidden is already true.
        this.setState(ContainerStates.HIDDEN);
      } else if (state === ContainerStates.PASSIVE) {
        this.setState(ContainerStates.HIDDEN);
      }
    } else if (document.visibilityState === 'visible') {
      if (state === ContainerStates.HIDDEN) {
        // Return to passive (may become active on next focus event)
        this.setState(ContainerStates.PASSIVE);
      }
    }
  }

  /** @private */
  _onFreeze() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.HIDDEN) {
      this.setState(ContainerStates.FROZEN);
    }
  }

  /** @private */
  _onResume() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.FROZEN) {
      // Resume to appropriate state based on current visibility
      if (document.visibilityState === 'visible') {
        if (document.hasFocus()) {
          this._transitionToActive();
        } else {
          this.setState(ContainerStates.PASSIVE);
        }
      } else {
        this.setState(ContainerStates.HIDDEN);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Constraint change notifications
  // -------------------------------------------------------------------------

  /**
   * Handles viewport resize events that may affect placement constraints.
   * Debounced at 200ms to avoid flooding the creative during drag-resize.
   * @private
   */
  _onConstraintsRelevantResize() {
    this._debounceConstraintsNotification('viewportResize');
  }

  /**
   * Handles device orientation changes that may affect placement constraints.
   * @private
   */
  _onConstraintsRelevantOrientation() {
    this._debounceConstraintsNotification('rotation');
  }

  /**
   * Debounces constraint change notifications.
   * @param {string} reason - 'rotation', 'viewportResize', or 'policyUpdate'
   * @private
   */
  _debounceConstraintsNotification(reason) {
    if (this._constraintsDebounceTimer) {
      clearTimeout(this._constraintsDebounceTimer);
    }
    this._constraintsDebounceTimer = setTimeout(() => {
      this._constraintsDebounceTimer = null;
      this._sendConstraintsChange(reason);
    }, 200);
  }

  /**
   * Sends a placementConstraintsChange notification to the creative.
   * @param {string} reason - Why constraints changed
   * @private
   */
  _sendConstraintsChange(reason) {
    if (this._terminated || this._protocol._terminated) return;
    const policy = this._placementPolicy || {};
    this._protocol._sendMessage(ContainerMessages.PLACEMENT_CONSTRAINTS_CHANGE, {
      maxWidth:           policy.maxWidth != null ? policy.maxWidth : null,
      maxHeight:          policy.maxHeight != null ? policy.maxHeight : null,
      allowedIntents:     policy.allowedIntents || ['resize', 'maximize', 'fullscreen', 'minimize', 'restore'],
      requireCloseRegion: !!policy.requireCloseRegion,
      allowOffscreen:     policy.allowOffscreen !== false,
      reason:             reason,
    });
  }

  /**
   * Public method for publishers to update placement policy at runtime.
   * Triggers a constraintsChange notification to the creative.
   * @param {Object} newPolicy - New placement policy (same shape as constructor option).
   */
  updatePlacementPolicy(newPolicy) {
    this._placementPolicy = newPolicy || undefined;
    this._sendConstraintsChange('policyUpdate');
  }

  // -------------------------------------------------------------------------
  // Timeout helpers
  // -------------------------------------------------------------------------

  /**
   * Starts a named timeout.
   * @param {string} name - Timeout identifier.
   * @param {Function} callback - Called when timeout fires.
   * @returns {number} The timeout handle.
   * @private
   */
  _startTimeout(name, callback) {
    this._clearTimeout(name);
    const duration = this.timeouts[name] || DEFAULT_TIMEOUTS[name] || 5000;
    this._timeouts[name] = setTimeout(callback, duration);
    return this._timeouts[name];
  }

  /**
   * Clears a named timeout.
   * @param {string} name
   * @private
   */
  _clearTimeout(name) {
    if (this._timeouts[name]) {
      clearTimeout(this._timeouts[name]);
      delete this._timeouts[name];
    }
  }

  /**
   * Starts the createSession receipt timeout.
   * @private
   */
  _startSessionTimeout() {
    this._startTimeout('createSession', () => {
      console.error('[SHARCContainer] Timeout waiting for createSession — terminating container');
      this._handleFatalError(ErrorCodes.NO_CREATE_SESSION, 'createSession not received within timeout');
    });
  }

  // -------------------------------------------------------------------------
  // Tracker firing
  // -------------------------------------------------------------------------

  /**
   * Fires tracking URIs in parallel via HTTP GET.
   * @param {string[]} uris - Array of tracking URIs to fire.
   * @returns {Promise<Array>} Array of result objects.
   * @private
   */
  _fireTrackers(uris) {
    if (!uris || uris.length === 0) return Promise.resolve([]);

    const TRACKER_TIMEOUT = 5000;
    const MAX_REDIRECTS = 5;

    const fireOne = (uri) => {
      return new Promise((resolve) => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutHandle = setTimeout(() => {
          if (controller) controller.abort();
          resolve({ uri, success: false, reason: 'timeout' });
        }, TRACKER_TIMEOUT);

        const fetchOptions = {
          method: 'GET',
          redirect: 'follow',
          mode: 'no-cors',
          ...(controller ? { signal: controller.signal } : {}),
        };

        fetch(uri, fetchOptions)
          .then(() => {
            clearTimeout(timeoutHandle);
            resolve({ uri, success: true });
          })
          .catch((err) => {
            clearTimeout(timeoutHandle);
            resolve({ uri, success: false, reason: err.message || 'fetch error' });
          });
      });
    };

    return Promise.all(uris.map(fireOne));
  }

  // -------------------------------------------------------------------------
  // Close button rendering (container-owned, outside sandbox)
  // -------------------------------------------------------------------------

  /**
   * Creates and positions the container-owned close button.
   * Called on resize, maximize, and fullscreen intents.
   * The close button is a DOM sibling to the iframe, outside the sandbox.
   * @param {string} position - Resolved close position ('top-right', 'top-left', etc.)
   * @private
   */
  _createCloseButton(position) {
    this._removeCloseButton();

    const btn = document.createElement('div');
    btn.className = 'sharc-close-button';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Close advertisement');
    btn.setAttribute('tabindex', '0');

    // Default styling — X icon via CSS, no external assets
    btn.style.cssText = [
      'position:absolute',
      'width:50px',
      'height:50px',
      'min-width:50px',
      'min-height:50px',
      'z-index:2147483647',
      'cursor:pointer',
      'background:rgba(0,0,0,0.6)',
      'border-radius:50%',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-size:24px',
      'color:#fff',
      'line-height:1',
      'user-select:none',
      '-webkit-user-select:none',
      'pointer-events:auto',
      'box-sizing:border-box',
    ].join(';');

    // Apply publisher customization if provided
    if (this._closeButtonStyles) {
      Object.assign(btn.style, this._closeButtonStyles);
      // Enforce visibility — close button must always be interactive and visible
      btn.style.opacity = '1';
      btn.style.visibility = 'visible';
      btn.style.pointerEvents = 'auto';
      btn.style.display = 'flex';
    }

    // Enforce minimum 50px regardless — parseInt is fragile with non-px units
    // (e.g. '3em', 'auto'). CSS min-width/min-height enforces the floor
    // regardless of what the publisher set for width/height.
    btn.style.minWidth = '50px';
    btn.style.minHeight = '50px';

    // Prevent size collapse via max-width/max-height or overflow clipping
    btn.style.maxWidth = 'none';
    btn.style.maxHeight = 'none';
    btn.style.overflow = 'visible';

    // Position relative to the iframe
    this._applyClosePosition(btn, position);

    // X glyph (Unicode multiplication sign — renders well cross-platform)
    btn.textContent = '\u00D7';

    // Click handler — behavior depends on current state
    const self = this;
    const handleClose = () => {
      if (self._currentIntent === 'maximize' || self._currentIntent === 'fullscreen') {
        self._initiateClose();
      } else {
        // resize state: restore to original placement
        self._handleRequestPlacementChange({
          args: { intent: 'restore' },
          messageId: -1,
          type: 'synthetic',
        });
      }
    };

    btn.addEventListener('click', handleClose);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClose();
      }
    });

    // Insert as sibling to iframe, within the container element.
    // The close button uses position: absolute, so it needs a positioned
    // ancestor. Only override 'static' (the default) — don't clobber the
    // publisher's existing relative, absolute, or fixed positioning.
    var computedPosition = window.getComputedStyle(this.containerEl).position;
    if (computedPosition === 'static') {
      this.containerEl.style.position = 'relative';
    }
    this.containerEl.appendChild(btn);
    this._closeButton = btn;

    // Notify OMID extension (if present) to register the close button as a
    // friendly obstruction so it doesn't count against viewability.
    this._notifyOmidObstruction(btn, true);
  }

  /**
   * Removes the container-owned close button.
   * Called on restore, close, and destroy.
   * @private
   */
  _removeCloseButton() {
    if (this._closeButton) {
      // Notify OMID extension to unregister the friendly obstruction
      this._notifyOmidObstruction(this._closeButton, false);
      if (this._closeButton.parentNode) {
        this._closeButton.parentNode.removeChild(this._closeButton);
      }
    }
    this._closeButton = null;
  }

  /**
   * Notifies the OMID extension (if registered) to add or remove a friendly
   * obstruction for the given element. No-op if no OMID extension is present.
   * @param {HTMLElement} element - The DOM element (close button).
   * @param {boolean} register - true to register, false to unregister.
   * @private
   */
  _notifyOmidObstruction(element, register) {
    if (!this._extensions || !element) return;
    for (let i = 0; i < this._extensions.length; i++) {
      const ext = this._extensions[i];
      if (ext && typeof ext.getFeatureName === 'function' &&
          ext.getFeatureName() === 'com.iabtechlab.sharc.omid') {
        if (register && typeof ext.registerFriendlyObstruction === 'function') {
          ext.registerFriendlyObstruction(element);
        } else if (!register && typeof ext.unregisterFriendlyObstruction === 'function') {
          ext.unregisterFriendlyObstruction();
        }
        break;
      }
    }
  }

  /**
   * Positions the close button relative to the iframe based on the
   * resolved position string.
   * @param {HTMLElement} btn - The close button element
   * @param {string} position - Position enum value
   * @private
   */
  _applyClosePosition(btn, position) {
    // Reset all positioning
    btn.style.top = btn.style.bottom = btn.style.left = btn.style.right = 'auto';
    btn.style.transform = '';

    switch (position) {
      case 'top-left':      btn.style.top = '0'; btn.style.left = '0'; break;
      case 'top-center':    btn.style.top = '0'; btn.style.left = '50%';
                            btn.style.transform = 'translateX(-50%)'; break;
      case 'top-right':     btn.style.top = '0'; btn.style.right = '0'; break;
      case 'center-left':   btn.style.top = '50%'; btn.style.left = '0';
                            btn.style.transform = 'translateY(-50%)'; break;
      case 'center-right':  btn.style.top = '50%'; btn.style.right = '0';
                            btn.style.transform = 'translateY(-50%)'; break;
      case 'bottom-left':   btn.style.bottom = '0'; btn.style.left = '0'; break;
      case 'bottom-center': btn.style.bottom = '0'; btn.style.left = '50%';
                            btn.style.transform = 'translateX(-50%)'; break;
      case 'bottom-right':  btn.style.bottom = '0'; btn.style.right = '0'; break;
      default:              btn.style.top = '0'; btn.style.right = '0'; break;
    }
  }

  // -------------------------------------------------------------------------
  // Animation support
  // -------------------------------------------------------------------------

  /**
   * Returns whether this container supports animated placement transitions.
   * @returns {boolean}
   * @private
   */
  _supportsAnimation() {
    // Animation support is opt-in via feature string registration.
    // Check if the merged features include the animation feature.
    const features = this._mergedSupportedFeatures || this._explicitSupportedFeatures || [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (f === 'com.iabtechlab.sharc.placement.animate' ||
          (f && f.name === 'com.iabtechlab.sharc.placement.animate')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Applies an animated dimension change using transform: scale().
   * The visual transition runs on the GPU compositor. On completion,
   * snaps to final width/height and removes the transform.
   *
   * @param {Object} fromDims - { width, height } current dimensions
   * @param {Object} toDims - { width, height } target dimensions
   * @param {Object} transition - { duration, easing }
   * @param {string} [anchorPoint] - 'top-left', 'top-right', 'bottom-left', 'bottom-right'
   * @private
   */
  _applyAnimatedDimensions(fromDims, toDims, transition, anchorPoint) {
    if (!this._iframe) return null;

    const duration = this._clampDuration(transition.duration);
    const easing = this._sanitizeEasing(transition.easing || 'ease-out');

    // Duration 0 means instant — skip animation and let the caller
    // fire placementTransitionEnd after resolve + placementChange.
    if (duration === 0) {
      this._applyIframeDimensions(toDims);
      return toDims;
    }

    const fromW = fromDims.width || 1;
    const fromH = fromDims.height || 1;
    const scaleX = toDims.width / fromW;
    const scaleY = toDims.height / fromH;

    // Set transform-origin based on anchor point (default: top-left)
    const originMap = {
      'top-left': 'top left',
      'top-right': 'top right',
      'bottom-left': 'bottom left',
      'bottom-right': 'bottom right',
    };
    this._iframe.style.transformOrigin = originMap[anchorPoint] || 'top left';
    this._iframe.style.transition = 'transform ' + duration + 'ms ' + easing;
    this._iframe.style.transform = 'scale(' + scaleX + ', ' + scaleY + ')';

    let cleanedUp = false;
    const iframe = this._iframe;
    const protocol = this._protocol;
    const self = this;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      iframe.removeEventListener('transitionend', onEnd);
      // Snap to final dimensions — single layout recalc
      iframe.style.transition = '';
      iframe.style.transform = '';
      iframe.style.transformOrigin = '';
      self._applyIframeDimensions(toDims);

      // Notify creative that transition completed
      protocol._sendMessage(ContainerMessages.PLACEMENT_TRANSITION_END, {
        finalDimensions: toDims,
      });
    };

    const onEnd = (e) => {
      // Check both target and property — child elements inside the iframe
      // can bubble transitionend events, causing premature cleanup.
      if (e.target === iframe && e.propertyName === 'transform') cleanup();
    };

    iframe.addEventListener('transitionend', onEnd);

    // Safety timeout: if transitionend never fires (tab hidden, etc.), snap anyway.
    // 300ms margin accounts for slow mobile WebViews.
    setTimeout(cleanup, duration + 300);
    return null;
  }

  /**
   * Clamps animation duration to safe bounds.
   * Max 500ms, min 0. Non-numbers treated as 0.
   * @param {*} duration
   * @returns {number}
   * @private
   */
  _clampDuration(duration) {
    if (typeof duration !== 'number' || duration < 0) return 0;
    return Math.min(duration, 500);
  }

  /**
   * Sanitizes an easing value to one of the five CSS keywords.
   * Anything else is replaced with 'ease-out'.
   * @param {string} easing
   * @returns {string}
   * @private
   */
  _sanitizeEasing(easing) {
    const ALLOWED = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];
    return ALLOWED.indexOf(easing) !== -1 ? easing : 'ease-out';
  }

  /**
   * Clamps a transition hint to safe values.
   * @param {Object} transition - { duration, easing }
   * @returns {Object} - { duration, easing }
   * @private
   */
  _clampTransition(transition) {
    return {
      duration: this._clampDuration(transition.duration),
      easing: this._sanitizeEasing(transition.easing || 'ease-out'),
    };
  }

  // -------------------------------------------------------------------------
  // Placement helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the maximum available placement.
   * For 'fullscreen' intent, returns viewport dimensions so the creative
   * fills the screen. For 'maximize' or any other intent, fills the
   * container element.
   * @param {string} [intent] - The placement change intent
   * @returns {Object}
   * @private
   */
  _getMaxPlacement(intent) {
    if (intent === 'fullscreen') {
      // Prefer visualViewport — stable on mobile Safari where innerHeight
      // fluctuates with the address bar show/hide.
      const vv = window.visualViewport;
      return {
        width: (vv ? vv.width : window.innerWidth) || 300,
        height: (vv ? vv.height : window.innerHeight) || 250,
      };
    }
    return {
      width: this.containerEl.offsetWidth || 300,
      height: this.containerEl.offsetHeight || 250,
    };
  }

  /**
   * Sanitizes a position coordinate value to a safe CSS string.
   * Unlike _sanitizeDimension(), negative values are valid (e.g. resize offsets
   * that move the ad left of or above its initial position).
   * @param {*} val
   * @returns {string|null} Safe CSS value (e.g. "-20px"), or null if invalid.
   * @private
   */
  _sanitizePosition(val) {
    if (typeof val === 'number' && isFinite(val)) {
      return Math.round(val) + 'px';
    }
    if (typeof val === 'string' && /^-?\d+(\.\d+)?(px)?$/.test(val)) {
      return parseFloat(val) + 'px';
    }
    return null;
  }

  /**
   * Sanitizes a dimension value to a safe CSS string (SEC-012).
   * Accepts: positive numbers, strings matching "\d+(px|%)". Rejects all else.
   * @param {*} val
   * @returns {string|null} Safe CSS value, or null if invalid.
   * @private
   */
  _sanitizeDimension(val) {
    if (typeof val === 'number' && isFinite(val) && val >= 0) {
      return `${Math.round(val)}px`;
    }
    if (typeof val === 'string' && /^\d+(\.\d+)?(px|%)$/.test(val)) {
      return val;
    }
    return null; // Reject arbitrary strings to prevent CSS injection
  }

  /**
   * Applies dimensions to the iframe.
   * @param {Object} dims - { width, height }
   * @private
   */
  _applyIframeDimensions(dims) {
    if (!this._iframe) return;
    const w = this._sanitizeDimension(dims.width);
    const h = this._sanitizeDimension(dims.height);
    if (w !== null) this._iframe.style.width = w;
    if (h !== null) this._iframe.style.height = h;
    if (w !== null) this.containerEl.style.width = w;
    if (h !== null) this.containerEl.style.height = h;
  }

  /**
   * Applies a position (x, y) to the iframe for resize intent.
   * Sets position:absolute so left/top take effect. Only called for
   * 'resize' intent — maximize/restore have their own positioning logic.
   * @param {Object} pos - { x, y } in pixels
   * @private
   */
  _applyIframePosition(pos) {
    if (!this._iframe) return;
    const x = this._sanitizePosition(pos.x);
    const y = this._sanitizePosition(pos.y);
    if (x !== null || y !== null) {
      this._iframe.style.position = 'absolute';
      if (x !== null) this._iframe.style.left = x;
      if (y !== null) this._iframe.style.top = y;
    }
  }

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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHARCContainer, DEFAULT_TIMEOUTS, SHARC_VERSION };
} else if (typeof window !== 'undefined') {
  window.SHARC = window.SHARC || {};
  window.SHARC.Container = SHARCContainer;
}
