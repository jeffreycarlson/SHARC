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
// sharc-protocol.js uses a UMD wrapper so its classes are never global.
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
const SHARC_VERSION = '0.1.0';

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
   * @param {Array} [options.supportedFeatures=[]] - Explicit feature name strings this container supports.
   *   In practice, pass extensions instead — each extension contributes its feature name automatically.
   * @param {Array} [options.extensions=[]] - Extension plugin objects (e.g. OmidCompatBridge, MRAIDCompatBridge).
   *   Each extension may implement:
   *     - `getFeatureName()` → string  — added to supportedFeatures in Container:init
   *     - `injectIntoMarkup(html)` → string — called before iframe load to inject scripts into creative HTML
   *     - `destroy()` — called when the container is destroyed
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
    } = options;

    if (!creativeUrl) throw new Error('[SHARCContainer] creativeUrl is required');
    if (!containerEl) throw new Error('[SHARCContainer] containerEl is required');

    /** @type {string} */
    this.creativeUrl = creativeUrl;

    /** @type {HTMLElement} */
    this.containerEl = containerEl;

    /** @type {Object} */
    this.environmentData = environmentData;

    /**
     * Extension plugin instances.
     * Each may contribute a feature name, inject markup, and/or require cleanup.
     * @type {Array}
     */
    this._extensions = extensions;

    /**
     * Explicit supportedFeatures passed directly by the caller.
     * Extension-contributed features are merged in at session time.
     * @type {Array}
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

    /** Whether _destroy() has already been called. @type {boolean} */
    this._destroyed = false;

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
   * Initiates the close sequence.
   * Sends Container:close, waits up to 2s for creative acknowledgment, then destroys.
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
   * @param {string} newState
   */
  setState(newState) {
    const success = this._stateMachine.transition(newState);
    if (success && this._stateMachine.isCreativeQueryable(newState)) {
      this._protocol.sendStateChange(newState);
    }
    return success;
  }

  /**
   * Sends a placementChange notification to the creative.
   * @param {Object} placementUpdate
   */
  notifyPlacementChange(placementUpdate) {
    this._protocol.sendPlacementChange(placementUpdate);
  }

  // -------------------------------------------------------------------------
  // Iframe creation
  // -------------------------------------------------------------------------

  /**
   * Creates and inserts the secure iframe for the creative.
   *
   * If any extension implements `injectIntoMarkup(html)`, the creative HTML is
   * fetched, run through each injector in order, then loaded via `srcdoc`
   * instead of `src`. This is how OMID injects the OM SDK service script
   * before any creative code runs.
   *
   * Injection is automatic for all extensions that expose `injectIntoMarkup` —
   * it is NOT opt-in per extension. All injectors are applied in registration order.
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
    // Determine whether any extension needs to inject into the creative markup.
    // Extensions that implement injectIntoMarkup() require us to:
    //   1. fetch() the creative HTML
    //   2. pipe it through each injector in order
    //   3. set iframe.srcdoc instead of iframe.src
    //
    // NOTE: Using srcdoc means the iframe's effective origin is the parent
    // document's origin (or 'null' with sandbox). Scripts injected via srcdoc
    // must use absolute URLs (not relative) to load correctly.
    // -----------------------------------------------------------------------
    const injectors = this._extensions.filter(
      (ext) => typeof ext.injectIntoMarkup === 'function'
    );

    if (injectors.length === 0) {
      // Fast path: no injection needed — set src directly.
      iframe.src = this.creativeUrl;
      iframe.addEventListener('load', () => {
        setTimeout(() => this._protocol.initChannel(iframe.contentWindow), 200);
      });
      return;
    }

    // Slow path: fetch creative HTML, inject scripts, load via srcdoc.
    // Wire MessageChannel after srcdoc triggers the load event.
    iframe.addEventListener('load', () => {
      setTimeout(() => this._protocol.initChannel(iframe.contentWindow), 200);
    });

    this._fetchAndInjectCreative(injectors).catch((err) => {
      // Fetch or injection failed — fall back to loading the creative URL
      // directly and log a warning. The creative will load without OM SDK
      // scripts, so OMID measurement will not function, but the ad can still
      // render. Container publishers should monitor for this warning.
      console.warn(
        '[SHARCContainer] Script injection failed; falling back to direct src load.',
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
    // Extensions that don't implement getFeatureName() are silently skipped.
    const extensionFeatureNames = this._extensions
      .filter((ext) => typeof ext.getFeatureName === 'function')
      .map((ext) => {
        try { return ext.getFeatureName(); } catch (e) { return null; }
      })
      .filter(Boolean);

    const mergedFeatures = [
      ...this._explicitSupportedFeatures,
      ...extensionFeatureNames,
    ];

    // Cache for subsequent getFeatures() queries from the creative
    this._mergedSupportedFeatures = mergedFeatures;

    // Build the full init payload
    const initArgs = {
      environmentData: {
        ...this.environmentData,
        currentState: ContainerStates.READY,
        version: SHARC_VERSION,
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
    this.setState(ContainerStates.ACTIVE);
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
    this._destroy();
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
    const { intent, targetDimensions, anchorPoint } = (msg.args || {});
    let updatedPlacement = { ...(this.environmentData.currentPlacement || {}) };

    // Apply the placement change based on intent
    switch (intent) {
      case 'resize':
        if (targetDimensions) {
          updatedPlacement = { ...updatedPlacement, ...targetDimensions };
          this._applyIframeDimensions(targetDimensions);
        }
        break;
      case 'maximize':
      case 'fullscreen':
        // Expand to fill the container element
        updatedPlacement = this._getMaxPlacement();
        this._applyIframeDimensions(updatedPlacement);
        break;
      case 'minimize':
      case 'restore':
        // Return to initial dimensions
        updatedPlacement = this.environmentData.currentPlacement || {};
        this._applyIframeDimensions(updatedPlacement);
        break;
      default:
        console.warn('[SHARCContainer] Unknown placement intent:', intent);
    }

    this.environmentData.currentPlacement = updatedPlacement;
    this._protocol._resolve(msg, { placementUpdate: updatedPlacement });
    this._protocol.sendPlacementChange(updatedPlacement);
  }

  /**
   * Handles Creative:requestClose.
   * @param {Object} msg
   * @private
   */
  _handleRequestClose(msg) {
    // Container can choose to honor or reject. Default: honor.
    this._protocol._resolve(msg, {});
    this.close();
  }

  // -------------------------------------------------------------------------
  // Close sequence
  // -------------------------------------------------------------------------

  /**
   * Initiates the close sequence.
   * Sends Container:close and destroys after 2s max.
   * @private
   */
  _initiateClose() {
    // Start close timeout — destroy regardless after 2s
    this._startTimeout('closeSequence', () => {
      this._destroy();
    });

    this._protocol.sendClose()
      .then(() => {
        this._clearTimeout('closeSequence');
        // Allow a brief moment for creative to run its close animation
        // then destroy. The creative had its chance — we gave it resolve.
        setTimeout(() => this._destroy(), 100);
      })
      .catch(() => {
        this._clearTimeout('closeSequence');
        this._destroy();
      });
  }

  /**
   * Destroys the container — removes the iframe, terminates the protocol,
   * and fires the onClose callback.
   * Guards against multiple calls (e.g. from _handleFatalError timeout races).
   * @private
   */
  _destroy() {
    if (this._destroyed) return; // Guard: _destroy can be called from multiple code paths
    this._destroyed = true;

    // Clear all pending timeouts
    Object.keys(this._timeouts).forEach((key) => this._clearTimeout(key));

    // Transition to terminated
    this._stateMachine.transition(ContainerStates.TERMINATED);

    // Terminate protocol
    this._protocol.terminate();

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
   * Handles a fatal error — sends Container:fatalError if possible, then destroys.
   * @param {number} errorCode
   * @param {string} [message]
   * @private
   */
  _handleFatalError(errorCode, message = '') {
    this._onError && this._onError(errorCode, message);
    this._protocol.sendFatalError(errorCode, message)
      .then(() => this._destroy())
      .catch(() => this._destroy());
    // Destroy after 1s regardless
    setTimeout(() => this._destroy(), 1000);
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
  }

  /** @private */
  _onPageFocus() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.PASSIVE) {
      this.setState(ContainerStates.ACTIVE);
    }
  }

  /** @private */
  _onPageBlur() {
    const state = this._stateMachine.getState();
    if (state === ContainerStates.ACTIVE) {
      this.setState(ContainerStates.PASSIVE);
    }
  }

  /** @private */
  _onVisibilityChange() {
    const state = this._stateMachine.getState();
    if (document.visibilityState === 'hidden') {
      if (state === ContainerStates.ACTIVE) {
        // ACTIVE → HIDDEN: The Page Lifecycle can fire visibilitychange without a
        // prior blur on mobile (e.g., Android app backgrounding). Transition through
        // PASSIVE first per architecture-design.md §4.4, but since ACTIVE → HIDDEN
        // is now a valid transition in STATE_TRANSITIONS, we go direct to match the
        // browser event rather than emitting a spurious PASSIVE state.
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
          this.setState(ContainerStates.ACTIVE);
        } else {
          this.setState(ContainerStates.PASSIVE);
        }
      } else {
        this.setState(ContainerStates.HIDDEN);
      }
    }
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
      console.error('[SHARCContainer] Timeout waiting for createSession — destroying container');
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
  // Placement helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the maximum available placement (fills container element).
   * @returns {Object}
   * @private
   */
  _getMaxPlacement() {
    return {
      width: this.containerEl.offsetWidth || 300,
      height: this.containerEl.offsetHeight || 250,
    };
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
