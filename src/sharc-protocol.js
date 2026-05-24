/**
 * @fileoverview SHARC Protocol Core
 *
 * The foundational protocol layer for Secure HTML Ad Richmedia Container (SHARC).
 *
 * Transport: MessageChannel (primary) with postMessage fallback.
 * Serialization: Structured Clone (no JSON.stringify).
 * State machine: Aligned with Chrome/WebKit Page Lifecycle API.
 *
 * Architecture: Two classes:
 *   - SHARCContainerProtocol — used by the container (publisher side)
 *   - SHARCCreativeProtocol  — used by the creative (ad side)
 *
 * Both extend SHARCProtocolBase which provides the shared message bus.
 *
 * @version 0.7.5
 * @see https://github.com/IABTechLab/SHARC
 */

// True ESM module. Exports named bindings for bundlers/tooling, and also
// attaches the protocol namespace to globalThis.SHARC.Protocol in browsers so
// existing browser-global consumers can keep working when loaded via
// <script type="module">.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current SHARC spec version this implementation conforms to. */
const SHARC_VERSION = '0.7.5';

/**
 * Placeholder AdCOM `APIFramework` integer code for SHARC.
 *
 * Until AdCOM upstream registration completes (memory
 * `project_upstream_contribution_roadmap`), SHARC has no canonical integer
 * in AdCOM v1.0's `APIFramework` list. This sentinel sits comfortably
 * outside AdCOM's currently-assigned range so it does not collide with any
 * registered framework. At AdCOM publication, the implementer updates this
 * constant to the published value — no other code changes are required
 * because every picker, supersession rule, and test references this
 * symbolic name rather than a hardcoded integer.
 *
 * See 0.7.2 design doc § 6.3 ("AdCOM code constants") for the full pattern.
 */
const SHARC_API_CODE = 9001;

/**
 * Placeholder AdCOM `APIFramework` integer code for SafeFrame.
 *
 * Companion to {@link SHARC_API_CODE} — SafeFrame is also unregistered in
 * AdCOM v1.0. Same publication-locking pattern.
 *
 * See 0.7.2 design doc § 6.3.
 */
const SAFEFRAME_API_CODE = 9002;

/**
 * Renderer protocol version — bumps independently of {@link SHARC_VERSION}.
 *
 * Sent in `SHARC:Renderer:render` so the renderer page can reject containers
 * that speak a renderer protocol it does not implement. See proposal
 * docs/proposals/creative-sources.md § Renderer protocol messages and
 * § Container and renderer must upgrade together. Initial value `'1'` for
 * 0.7.0. Bumped only when the on-the-wire renderer protocol shape changes
 * (additive fields do not warrant a bump).
 */
const RENDERER_PROTOCOL_VERSION = '1';

/**
 * Protocol-level message types.
 * @enum {string}
 */
const ProtocolMessages = Object.freeze({
  CREATE_SESSION: 'SHARC:Creative:createSession',
  RESOLVE: 'resolve',
  REJECT: 'reject',
});

/**
 * Container-to-creative message types.
 * @enum {string}
 */
const ContainerMessages = Object.freeze({
  INIT: 'SHARC:Container:init',
  START_CREATIVE: 'SHARC:Container:startCreative',
  STATE_CHANGE: 'SHARC:Container:stateChange',
  PLACEMENT_CHANGE: 'SHARC:Container:placementChange',
  PLACEMENT_CONSTRAINTS_CHANGE: 'SHARC:Container:placementConstraintsChange',
  PLACEMENT_TRANSITION_END: 'SHARC:Container:placementTransitionEnd',
  AUDIO_VOLUME_CHANGE: 'SHARC:Container:audioVolumeChange',
  LOG: 'SHARC:Container:log',
  FATAL_ERROR: 'SHARC:Container:fatalError',
  CLOSE: 'SHARC:Container:close',
});

/**
 * Creative-to-container message types.
 * @enum {string}
 */
const CreativeMessages = Object.freeze({
  FATAL_ERROR: 'SHARC:Creative:fatalError',
  GET_CONTAINER_STATE: 'SHARC:Creative:getContainerState',
  GET_PLACEMENT_OPTIONS: 'SHARC:Creative:getPlacementOptions',
  GET_PLACEMENT_CONSTRAINTS: 'SHARC:Creative:getPlacementConstraints',
  LOG: 'SHARC:Creative:log',
  REPORT_INTERACTION: 'SHARC:Creative:reportInteraction',
  REQUEST_NAVIGATION: 'SHARC:Creative:requestNavigation',
  REQUEST_PLACEMENT_CHANGE: 'SHARC:Creative:requestPlacementChange',
  REQUEST_CLOSE: 'SHARC:Creative:requestClose',
  GET_FEATURES: 'SHARC:Creative:getFeatures',
});

/**
 * Container states aligned with Chrome/WebKit Page Lifecycle API.
 *
 * States visible to the creative: ready, active, passive, hidden, frozen
 * Container-internal bookends (never sent to creative): loading, terminated
 *
 * @enum {string}
 */
const ContainerStates = Object.freeze({
  LOADING: 'loading',       // Internal: pre-init, not sent to creative
  READY: 'ready',           // Container:init resolved, awaiting startCreative
  ACTIVE: 'active',         // Visible + focused + interactive
  PASSIVE: 'passive',       // Visible + no focus (split-screen, call interruption)
  HIDDEN: 'hidden',         // Not visible (app backgrounded, tab hidden, screen off)
  FROZEN: 'frozen',         // OS has suspended JS execution
  TERMINATED: 'terminated', // Internal: container terminated, not sent to creative
});

/**
 * Creative-queryable states (subset of ContainerStates).
 * @type {Set<string>}
 */
const CREATIVE_QUERYABLE_STATES = new Set([
  ContainerStates.READY,
  ContainerStates.ACTIVE,
  ContainerStates.PASSIVE,
  ContainerStates.HIDDEN,
  ContainerStates.FROZEN,
]);

/**
 * Valid state transitions.
 * @type {Object.<string, string[]>}
 */
const STATE_TRANSITIONS = Object.freeze({
  // LOADING → ACTIVE legitimizes the HTML-adapter route for non-handshake
  // creatives (0.7.2 design § 4.5). The handshake-driven path remains
  // LOADING → READY → ACTIVE; the new edge permits the parallel route
  // without synthesizing a misleading READY state.
  [ContainerStates.LOADING]: [ContainerStates.READY, ContainerStates.ACTIVE, ContainerStates.TERMINATED],
  [ContainerStates.READY]: [ContainerStates.ACTIVE, ContainerStates.TERMINATED],
  [ContainerStates.ACTIVE]: [ContainerStates.PASSIVE, ContainerStates.HIDDEN, ContainerStates.TERMINATED],
  [ContainerStates.PASSIVE]: [ContainerStates.ACTIVE, ContainerStates.HIDDEN, ContainerStates.TERMINATED],
  [ContainerStates.HIDDEN]: [ContainerStates.PASSIVE, ContainerStates.FROZEN, ContainerStates.TERMINATED],
  [ContainerStates.FROZEN]: [ContainerStates.ACTIVE, ContainerStates.PASSIVE, ContainerStates.HIDDEN, ContainerStates.TERMINATED],
  [ContainerStates.TERMINATED]: [], // terminal
});

/**
 * Messages that expect a resolve/reject response.
 * @type {Set<string>}
 */
const MESSAGES_REQUIRING_RESPONSE = new Set([
  ContainerMessages.INIT,
  ContainerMessages.START_CREATIVE,
  ContainerMessages.FATAL_ERROR,
  ContainerMessages.CLOSE,
  ContainerMessages.PLACEMENT_CONSTRAINTS_CHANGE,
  ContainerMessages.PLACEMENT_TRANSITION_END,
  CreativeMessages.GET_CONTAINER_STATE,
  CreativeMessages.GET_PLACEMENT_OPTIONS,
  CreativeMessages.GET_PLACEMENT_CONSTRAINTS,
  CreativeMessages.REPORT_INTERACTION,
  CreativeMessages.REQUEST_PLACEMENT_CHANGE,
  CreativeMessages.REQUEST_CLOSE,
  CreativeMessages.REQUEST_NAVIGATION,
  CreativeMessages.GET_FEATURES,
  ProtocolMessages.CREATE_SESSION,
]);

/**
 * Error codes (from SHARC spec).
 * @enum {number}
 */
const ErrorCodes = Object.freeze({
  UNSPECIFIED_CREATIVE: 2100,
  CANNOT_LOAD_RESOURCES: 2101,
  WRONG_SHARC_VERSION_CREATIVE: 2103,
  CANNOT_EXECUTE_CREATIVE: 2104,
  AD_INTERNAL_ERROR: 2108,
  DEVICE_NOT_SUPPORTED: 2109,
  CONTAINER_NOT_SENDING: 2110,
  CONTAINER_NOT_RESPONDING: 2111,
  // 2112 and 2113 are intentionally unassigned — reserved for future creative-side
  // error codes that may emerge as the spec evolves. Renderer-protocol codes
  // start at 2114 to keep them grouped.
  // Renderer protocol errors (Creative Markup variant) — added in 0.7.0.
  // See proposal: docs/proposals/creative-sources.md § Error Codes.
  RENDERER_TIMEOUT: 2114,
  RENDERER_FAILED: 2115,
  RENDERER_ORIGIN_MISMATCH: 2116,
  RENDERER_PROTOCOL_ERROR: 2117,
  RENDERER_UNAUTHORIZED_NAVIGATION: 2118,
  // 2119: synchronous postMessage(SHARC:Renderer:render) threw — DataCloneError,
  // null contentWindow, etc. Distinct from 2114 (timeout) for telemetry/alerting
  // accuracy: a transport-layer send failure is not a latency failure.
  RENDERER_POST_FAILED: 2119,
  // 2120: optional preflight integrity verification for creativeRendererUrl
  // failed before the renderer iframe was allowed to load. Distinct from
  // renderer-reported failures because no SHARC:Renderer:render message was sent.
  RENDERER_INTEGRITY_FAIL: 2120,
  UNSPECIFIED_CONTAINER: 2200,
  WRONG_SHARC_VERSION_CONTAINER: 2201,
  UNSUPPORTED_FEATURE: 2203,
  OVERLOADING_CHANNEL: 2205,
  RESOLVE_TIMEOUT: 2208,
  CREATIVE_NOT_SUPPORTED: 2209,
  INIT_SPEC_VIOLATION: 2210,
  MESSAGE_SPEC_VIOLATION: 2211,
  NO_CREATE_SESSION: 2212,
  NO_START_REPLY: 2213,
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generates a UUID v4 string for session IDs.
 * Uses crypto.randomUUID() if available, otherwise constructs one manually.
 * @returns {string} A UUID v4 string.
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: manual UUID v4 construction
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Checks if MessageChannel is available in this environment.
 * @returns {boolean}
 */
function isMessageChannelAvailable() {
  return typeof MessageChannel !== 'undefined';
}

// ---------------------------------------------------------------------------
// SHARCProtocolBase
// ---------------------------------------------------------------------------

/**
 * Base class providing the shared SHARC message bus.
 *
 * Handles:
 *   - Message ID sequencing (per-sender monotonic counter)
 *   - Resolve/reject correlation (pending promise map)
 *   - Event listener registration
 *   - Structured Clone message dispatch via MessageChannel port
 *
 * Subclasses provide the transport setup (container vs creative).
 */
class SHARCProtocolBase {
  constructor() {
    /**
     * Current session ID. Intentionally `''` (not `null`) as the internal sentinel
     * for "no session yet" — the message routing check in `_onPortMessage` compares
     * incoming `sessionId` against this value, and the wire protocol uses empty
     * string as its uninitialized state. The public-facing `SHARCContainer.sessionId`
     * getter normalizes `''` → `null` at the API boundary; internal code should
     * never need to distinguish the two.
     * @type {string}
     */
    this.sessionId = '';

    /**
     * Next message ID to send.
     * @type {number}
     * @protected
     */
    this._nextMessageId = 0;

    /**
     * Listeners keyed by message type.
     * @type {Object.<string, Array<(data: Object) => void>>}
     * @private
     */
    this._listeners = {};

    /**
     * Pending resolve/reject callbacks keyed by outgoing messageId.
     * @type {Object.<number, (responseData: Object) => void>}
     * @protected
     */
    this._pendingResponses = {};

    /**
     * The MessagePort we use to send/receive messages.
     * Set by subclass after transport setup.
     * @type {MessagePort|null}
     * @protected
     */
    this._port = null;

    /**
     * Whether the protocol is in a terminated state.
     * @type {boolean}
     * @protected
     */
    this._terminated = false;

    /**
     * Rate limiter state: sliding window of message timestamps (SEC-007).
     * Max 50 messages per second, burst of 10.
     * @type {number[]}
     * @private
     */
    this._rateLimiterTimestamps = [];
  }

  // -------------------------------------------------------------------------
  // Port management
  // -------------------------------------------------------------------------

  /**
   * Attaches the MessagePort and starts listening for incoming messages.
   * Called by subclasses after the port is established.
   * @param {MessagePort} port - The port to use for communication.
   * @protected
   */
  _attachPort(port) {
    this._port = port;
    this._port.onmessage = this._onPortMessage.bind(this);
    // MessagePort needs start() if using addEventListener
    // onmessage assignment implicitly starts it, but call it explicitly for safety
    if (typeof this._port.start === 'function') {
      this._port.start();
    }
  }

  // -------------------------------------------------------------------------
  // Message sending
  // -------------------------------------------------------------------------

  /**
   * Sends a SHARC message over the MessagePort.
   *
   * If the message type requires a response, returns a Promise that resolves
   * or rejects when the counterpart sends resolve/reject.
   *
   * @param {string} type - The full SHARC message type string.
   * @param {*} [args] - The message args payload (Structured Clone compatible).
   * @returns {Promise<*>} Resolves with the value from the resolve message,
   *   or rejects with the error from the reject message.
   * @protected
   */
  _sendMessage(type, args = {}) {
    if (this._terminated) {
      return Promise.reject(new Error('Protocol is terminated'));
    }
    if (!this._port) {
      return Promise.reject(new Error('No MessagePort available'));
    }

    const messageId = this._nextMessageId++;
    const message = {
      sessionId: this.sessionId,
      messageId,
      timestamp: Date.now(),
      type,
      args,
    };

    if (MESSAGES_REQUIRING_RESPONSE.has(type)) {
      // Cap pending responses to prevent memory exhaustion (SEC-011)
      const MAX_PENDING = 100;
      if (Object.keys(this._pendingResponses).length >= MAX_PENDING) {
        return Promise.reject(new Error('Too many pending responses — message channel may be overloaded'));
      }
      return new Promise((resolve, reject) => {
        this._pendingResponses[messageId] = (responseData) => {
          if (responseData.type === ProtocolMessages.RESOLVE) {
            resolve(responseData.args ? responseData.args.value : undefined);
          } else {
            const err = responseData.args ? responseData.args.value : {};
            reject(err);
          }
        };
        this._port.postMessage(message);
      });
    }

    // Fire-and-forget — still return a resolved Promise for API consistency
    this._port.postMessage(message);
    return Promise.resolve();
  }

  /**
   * Sends a resolve response for a received message.
   * @param {Object} incomingMessage - The message being resolved.
   * @param {*} [value] - The resolve payload.
   * @protected
   */
  _resolve(incomingMessage, value = {}) {
    if (this._terminated || !this._port) return;
    this._port.postMessage({
      sessionId: this.sessionId,
      messageId: this._nextMessageId++,
      timestamp: Date.now(),
      type: ProtocolMessages.RESOLVE,
      args: {
        messageId: incomingMessage.messageId,
        value,
      },
    });
  }

  /**
   * Sends a reject response for a received message.
   * @param {Object} incomingMessage - The message being rejected.
   * @param {number} errorCode - The error code.
   * @param {string} [errorMessage] - Additional error information.
   * @protected
   */
  _reject(incomingMessage, errorCode, errorMessage = '') {
    if (this._terminated || !this._port) return;
    this._port.postMessage({
      sessionId: this.sessionId,
      messageId: this._nextMessageId++,
      timestamp: Date.now(),
      type: ProtocolMessages.REJECT,
      args: {
        messageId: incomingMessage.messageId,
        value: { errorCode, message: errorMessage },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Message receiving
  // -------------------------------------------------------------------------

  /**
   * Returns true if the incoming message is within the allowed rate limit.
   * Uses a sliding window of max 50 messages per second (SEC-007).
   * @returns {boolean}
   * @private
   */
  _rateLimitAllow() {
    const MAX_MESSAGES_PER_SECOND = 50;
    const now = Date.now();
    const windowStart = now - 1000;
    // Evict timestamps older than 1 second
    this._rateLimiterTimestamps = this._rateLimiterTimestamps.filter((t) => t > windowStart);
    if (this._rateLimiterTimestamps.length >= MAX_MESSAGES_PER_SECOND) {
      return false;
    }
    this._rateLimiterTimestamps.push(now);
    return true;
  }

  /**
   * Handles incoming MessagePort messages.
   * @param {MessageEvent} event
   * @protected
   */
  _onPortMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // SEC-007: Rate limit incoming messages
    if (!this._rateLimitAllow()) {
      console.warn('[SHARC] Message rate limit exceeded — dropping message');
      return;
    }

    const { sessionId, type } = data;

    // Session validation
    if (type !== ProtocolMessages.CREATE_SESSION) {
      if (!sessionId || sessionId !== this.sessionId) {
        // Log but don't error — could be a race during session establishment
        return;
      }
    }

    // Route: resolve/reject → correlate with pending
    if (type === ProtocolMessages.RESOLVE || type === ProtocolMessages.REJECT) {
      this._handleResponse(data);
      return;
    }

    // Route: known message type → listeners
    this._dispatchToListeners(type, data);
  }

  /**
   * Routes resolve/reject messages to their pending promise callbacks.
   * @param {Object} data - The resolve/reject message data.
   * @private
   */
  _handleResponse(data) {
    const respondingToId = data.args && data.args.messageId;
    if (respondingToId === undefined || respondingToId === null) return;

    const callback = this._pendingResponses[respondingToId];
    if (callback) {
      delete this._pendingResponses[respondingToId];
      callback(data);
    }
  }

  /**
   * Dispatches a received message to all registered listeners for its type.
   * @param {string} type - The message type.
   * @param {Object} data - The full message data.
   * @private
   */
  _dispatchToListeners(type, data) {
    const listeners = this._listeners[type];
    if (listeners && listeners.length > 0) {
      listeners.forEach((listener) => {
        try {
          listener(data);
        } catch (err) {
          console.error(`[SHARC] Listener error for '${type}':`, err);
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public listener API
  // -------------------------------------------------------------------------

  /**
   * Registers a listener for a specific message type.
   * @param {string} type - The full SHARC message type string.
   * @param {(data: Object) => void} callback - Called with the full message data object.
   */
  addListener(type, callback) {
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
    this._listeners[type].push(callback);
  }

  /**
   * Removes a listener for a specific message type.
   * @param {string} type - The message type.
   * @param {(data: Object) => void} callback - The exact function reference to remove.
   */
  removeListener(type, callback) {
    const listeners = this._listeners[type];
    if (!listeners) return;
    const idx = listeners.indexOf(callback);
    if (idx !== -1) {
      listeners.splice(idx, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Resets all protocol state. Call before reuse or after termination.
   * Rejects all pending responses before clearing to prevent hanging Promises.
   */
  reset() {
    // Reject any pending promises before clearing (prevents hanging Promises / memory leaks)
    const termError = { errorCode: ErrorCodes.UNSPECIFIED_CONTAINER, message: 'Protocol reset' };
    Object.entries(this._pendingResponses).forEach(([msgId, cb]) => {
      cb({ type: ProtocolMessages.REJECT, args: { messageId: Number(msgId), value: termError } });
    });
    this.sessionId = '';
    this._nextMessageId = 0;
    this._listeners = {};
    this._pendingResponses = {};
    this._terminated = false;
    if (this._port) {
      this._port.onmessage = null;
      this._port = null;
    }
  }

  /**
   * Terminates the protocol. No further messages will be sent or received.
   * Rejects all pending promise callbacks with a termination error.
   */
  terminate() {
    if (this._terminated) return; // Guard against multiple terminate() calls
    this._terminated = true;
    // Reject all pending promises with a properly-structured synthetic message.
    // We call callbacks directly (already looked up by messageId), so the
    // synthetic messageId in args is not used for correlation — but we
    // include a placeholder to keep the message shape well-formed.
    const termError = { errorCode: ErrorCodes.UNSPECIFIED_CONTAINER, message: 'Protocol terminated' };
    Object.entries(this._pendingResponses).forEach(([msgId, cb]) => {
      cb({ type: ProtocolMessages.REJECT, args: { messageId: Number(msgId), value: termError } });
    });
    this._pendingResponses = {};
    if (this._port) {
      this._port.onmessage = null;
    }
  }
}

// ---------------------------------------------------------------------------
// SHARCContainerProtocol
// ---------------------------------------------------------------------------

/**
 * Container-side SHARC protocol.
 *
 * Usage:
 * ```javascript
 * const proto = new SHARCContainerProtocol();
 * // After iframe is loaded:
 * proto.initChannel(iframeContentWindow);
 * // Listen for creative events:
 * proto.addListener(ProtocolMessages.CREATE_SESSION, (msg) => { ... });
 * // Send container messages:
 * proto.sendInit(environmentData, supportedFeatures).then(resolve => { ... });
 * ```
 */
class SHARCContainerProtocol extends SHARCProtocolBase {
  constructor() {
    super();

    /**
     * The MessageChannel used for communication.
     * Container owns both ports; port2 is transferred to the creative.
     * @type {MessageChannel|null}
     * @private
     */
    this._channel = null;

    /**
     * Whether we're using the MessageChannel transport (vs. fallback postMessage).
     * @type {boolean}
     * @private
     */
    this._usingMessageChannel = false;

    /**
     * The target window for the fallback postMessage transport.
     * @type {Window|null}
     * @private
     */
    this._fallbackTarget = null;

    /**
     * Bound fallback message handler (for cleanup).
     * @type {(event: MessageEvent) => void|null}
     * @private
     */
    this._fallbackHandler = null;
  }

  // -------------------------------------------------------------------------
  // Transport setup
  // -------------------------------------------------------------------------

  /**
   * Initializes the MessageChannel transport and sends port2 to the creative
   * iframe via a one-time bootstrap postMessage.
   *
   * This must be called AFTER the creative iframe's document is ready to
   * receive messages (e.g., in the iframe's `load` event or after a short
   * delay for the creative to set up its window listener).
   *
   * @param {Window} creativeWindow - The creative iframe's contentWindow.
   * @param {string} [targetOrigin='*'] - The targetOrigin for the bootstrap
   *   message. '*' is intentional — the port contains no sensitive data.
   *   See architecture-design.md §5 for rationale.
   * @param {string} [placementSessionId] - Container-generated UUID v4
   *   identifying this ad load. Forwarded to the creative in the bootstrap
   *   handshake so the creative SDK can echo it on `createSession` and use
   *   it as a routing/log key. See proposal Part 2 (placement-element-rename-and-stamping.md).
   */
  initChannel(creativeWindow, targetOrigin = '*', placementSessionId) {
    if (isMessageChannelAvailable()) {
      this._channel = new MessageChannel();
      this._usingMessageChannel = true;
      // Attach port1 to ourselves
      this._attachPort(this._channel.port1);
      // Transfer port2 to the creative — one-time bootstrap postMessage
      const handshake = {
        type: 'SHARC:Container:handshake',
        version: SHARC_VERSION,
      };
      if (placementSessionId) {
        handshake.placementSessionId = placementSessionId;
      }
      creativeWindow.postMessage(
        handshake,
        targetOrigin,
        [this._channel.port2]
      );
    } else {
      // Fallback: raw postMessage with sessionId filtering
      console.warn('[SHARC Container] MessageChannel unavailable — falling back to postMessage');
      this._usingMessageChannel = false;
      this._fallbackTarget = creativeWindow;
      this._setupFallbackTransport(creativeWindow);
    }
  }

  /**
   * Sets up the legacy postMessage fallback transport.
   * @param {Window} creativeWindow
   * @private
   */
  _setupFallbackTransport(creativeWindow) {
    /** @type {(event: MessageEvent) => void} */
    const fallbackHandler = (event) => {
      if (event.source !== creativeWindow) return;
      this._onPortMessage(event);
    };
    this._fallbackHandler = fallbackHandler;
    window.addEventListener('message', this._fallbackHandler, false);
  }

  // -------------------------------------------------------------------------
  // Overridden message sending for fallback transport
  // -------------------------------------------------------------------------

  /**
   * @override
   */
  _sendMessage(type, args = {}) {
    if (!this._usingMessageChannel && this._fallbackTarget) {
      // Fallback path: use postMessage directly.
      // Security note (SEC-002): The bootstrap message uses `*` targetOrigin
      // because it carries only a MessagePort (no sensitive data). All subsequent
      // messages are delivered via the private MessagePort, not via postMessage.
      // In the fallback transport (effectively zero real-world cases per the
      // architecture doc), `*` is still used because the creative origin may
      // not be known at the point postMessage is called. The fallback transport
      // should be avoided in production by ensuring MessageChannel availability.
      //
      // Per spec (architecture-design.md §3.3): use Structured Clone, no JSON.stringify.
      // window.postMessage uses Structured Clone natively — pass the object directly.
      if (this._terminated) return Promise.reject(new Error('Protocol is terminated'));
      const messageId = this._nextMessageId++;
      const message = { sessionId: this.sessionId, messageId, timestamp: Date.now(), type, args };
      if (MESSAGES_REQUIRING_RESPONSE.has(type)) {
        return new Promise((resolve, reject) => {
          this._pendingResponses[messageId] = (responseData) => {
            if (responseData.type === ProtocolMessages.RESOLVE) {
              resolve(responseData.args ? responseData.args.value : undefined);
            } else {
              reject(responseData.args ? responseData.args.value : {});
            }
          };
          // Structured Clone: pass message object directly (no JSON.stringify)
          this._fallbackTarget.postMessage(message, '*');
        });
      }
      // Structured Clone: pass message object directly (no JSON.stringify)
      this._fallbackTarget.postMessage(message, '*');
      return Promise.resolve();
    }
    return super._sendMessage(type, args);
  }

  // -------------------------------------------------------------------------
  // Container message API
  // -------------------------------------------------------------------------

  /**
   * Sends Container:init to the creative.
   * @param {Object} environmentData - Environment details (placement, version, etc.)
   * @param {Array<string | {name: string, version?: string}>} [supportedFeatures=[]] - Supported feature descriptors.
   *   Accepts either plain feature name strings or descriptor objects.
   * @returns {Promise<Object>} Resolves when creative accepts init; rejects if creative rejects.
   */
  sendInit(environmentData, supportedFeatures = []) {
    return this._sendMessage(ContainerMessages.INIT, { environmentData, supportedFeatures });
  }

  /**
   * Sends Container:startCreative to the creative.
   * @returns {Promise<Object>} Resolves when creative is ready to display.
   */
  sendStartCreative() {
    return this._sendMessage(ContainerMessages.START_CREATIVE, {});
  }

  /**
   * Sends Container:stateChange to the creative.
   * Only sends creative-queryable states (never sends loading or terminated).
   *
   * No-ops when no SHARC session has been established (`sessionId === ''`).
   * The state machine still transitions locally — operators observing the
   * container via `onStateChange` see the change — but no message is sent to
   * a non-existent creative session. This makes the 0.7.2 HTML lifecycle
   * adapter safe in non-handshake mode: the adapter drives `LOADING → ACTIVE`
   * for creatives that never establish a SHARC session, and `sendStateChange`
   * is a clean no-op rather than producing an unhandled `Promise.reject(...)`
   * from `_sendMessage` (which would otherwise be fatal under Node v25's
   * strict unhandled-rejection semantics).
   *
   * @param {string} containerState - One of the CREATIVE_QUERYABLE_STATES values.
   */
  sendStateChange(containerState) {
    if (!CREATIVE_QUERYABLE_STATES.has(containerState)) {
      console.warn(`[SHARC Container] Refusing to send non-queryable state '${containerState}' to creative`);
      return;
    }
    if (this.sessionId === '') {
      // No session = no creative listener. Local state transition already
      // happened; nothing to send. See JSDoc above for rationale.
      return;
    }
    this._sendMessage(ContainerMessages.STATE_CHANGE, { containerState });
  }

  /**
   * Sends Container:audioVolumeChange to the creative.
   * Fire-and-forget — NOT in MESSAGES_REQUIRING_RESPONSE.
   * Derives `volume` (0.0–1.0) internally from clamped volumePercentage.
   *
   * @param {number}  volumePercentage - Integer 0–100 (clamped internally).
   * @param {boolean} isMuted          - Explicit mute state; NEVER derived from volumePercentage.
   */
  sendAudioVolumeChange(volumePercentage, isMuted) {
    if (typeof volumePercentage !== 'number' || typeof isMuted !== 'boolean') {
      console.warn('[SHARC Protocol] sendAudioVolumeChange: invalid args', { volumePercentage, isMuted });
      return;
    }
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercentage)));
    this._sendMessage(ContainerMessages.AUDIO_VOLUME_CHANGE, {
      volumePercentage: clamped,
      volume: clamped / 100,
      isMuted: isMuted,
    });
  }

  /**
   * Sends Container:placementChange to the creative.
   * @param {Object} placementUpdate - Updated placement information.
   */
  sendPlacementChange(placementUpdate) {
    this._sendMessage(ContainerMessages.PLACEMENT_CHANGE, { placementUpdate });
  }

  /**
   * Sends Container:log to the creative.
   * @param {string} message - The log message.
   */
  sendLog(message) {
    this._sendMessage(ContainerMessages.LOG, { message });
  }

  /**
   * Sends Container:fatalError to the creative.
   * @param {number} errorCode - The error code.
   * @param {string} [errorMessage] - Additional details.
   * @returns {Promise<*>} Resolves when creative acknowledges the error.
   */
  sendFatalError(errorCode, errorMessage = '') {
    return this._sendMessage(ContainerMessages.FATAL_ERROR, { errorCode, errorMessage });
  }

  /**
   * Sends Container:close to the creative.
   * @returns {Promise<*>} Resolves when creative acknowledges close.
   */
  sendClose() {
    return this._sendMessage(ContainerMessages.CLOSE, {});
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  /**
   * Validates that a string is a well-formed UUID v4.
   * @param {string} id
   * @returns {boolean}
   * @private
   */
  _isValidUUID(id) {
    return typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  }

  /**
   * Called by the container when it receives a createSession message from the creative.
   * Validates the session ID format (SEC-006) and sends a resolve.
   * @param {Object} createSessionMsg - The incoming createSession message.
   */
  acceptSession(createSessionMsg) {
    const providedId = createSessionMsg.sessionId;
    // SEC-006: Validate session ID format — must be a well-formed UUID v4
    if (!this._isValidUUID(providedId)) {
      this._reject(createSessionMsg, ErrorCodes.INIT_SPEC_VIOLATION, 'Invalid session ID format — must be UUID v4');
      return;
    }
    this.sessionId = providedId;
    this._resolve(createSessionMsg, {});
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * @override
   */
  reset() {
    super.reset();
    this._channel = null;
    this._usingMessageChannel = false;
    if (this._fallbackHandler) {
      window.removeEventListener('message', this._fallbackHandler, false);
      this._fallbackHandler = null;
    }
    this._fallbackTarget = null;
  }
}

// ---------------------------------------------------------------------------
// SHARCCreativeProtocol
// ---------------------------------------------------------------------------

/**
 * Creative-side SHARC protocol.
 *
 * Usage:
 * ```javascript
 * const proto = new SHARCCreativeProtocol();
 * proto.init(); // Call as soon as script loads — listens for the bootstrap port message
 * proto.addListener(ContainerMessages.INIT, (msg) => {
 *   // handle init
 *   proto.resolve(msg, {});
 * });
 * proto.createSession(); // Call when creative is ready for SHARC
 * ```
 */
class SHARCCreativeProtocol extends SHARCProtocolBase {
  /**
   * @param {{ trustedOrigin?: string }} [options] - Optional config.
   *   `trustedOrigin`: if set, the bootstrap handshake will be rejected unless
   *   `event.origin` matches this value exactly. Use when the creative knows
   *   its expected container origin in advance. Leave unset (default) to only
   *   enforce the `event.source === window.parent` check — which rejects
   *   ports injected by any window other than the direct parent.
   *
   *   Format: exact string match against the browser's `event.origin` —
   *   scheme + host + optional port, no path, no trailing slash. Examples:
   *   `"https://publisher.example"`, `"http://localhost:3000"`. A scheme
   *   mismatch (e.g. `"publisher.example"` without scheme, or
   *   `"https://publisher.example/"` with a trailing slash) will reject
   *   every handshake — there's no normalization.
   */
  constructor(options) {
    super();

    /**
     * Placement type declared by the creative ('inline' or 'interstitial').
     * Sent to the container in createSession.
     * @type {string}
     * @private
     */
    this._placementType = 'inline';

    /**
     * Optional origin pin for the bootstrap handshake (SEC-003).
     * @type {string|null}
     * @private
     */
    this._trustedOrigin = (options && typeof options.trustedOrigin === 'string')
      ? options.trustedOrigin
      : null;

    /**
     * Whether the MessagePort bootstrap message has been received.
     * @type {boolean}
     * @private
     */
    this._portReceived = false;

    /**
     * Promise that resolves when the MessagePort is received from the container.
     * createSession() waits on this before sending.
     * @type {Promise<void>}
     * @private
     */
    this._portReadyPromise = new Promise((resolve) => {
      this._portReadyResolve = resolve;
    });

    /**
     * Bound handler for the bootstrap window message (for cleanup).
     * @type {(event: MessageEvent) => void}
     * @private
     */
    this._bootstrapHandler = null;

    /**
     * Whether we're using the MessageChannel transport.
     * @type {boolean}
     * @private
     */
    this._usingMessageChannel = false;
  }

  // -------------------------------------------------------------------------
  // Transport setup
  // -------------------------------------------------------------------------

  /**
   * Initializes the creative-side transport.
   * Listens for the one-time bootstrap message from the container that carries port2.
   * Falls back to window.postMessage if no port message arrives within 500ms.
   *
   * Call this as early as possible in the creative's script execution.
   */
  init() {
    if (isMessageChannelAvailable()) {
      // Listen for the bootstrap port message from the container
      /** @type {(event: MessageEvent) => void} */
      this._bootstrapHandler = this._onBootstrapMessage.bind(this);
      window.addEventListener('message', this._bootstrapHandler, false);
    } else {
      // Fallback: raw postMessage — use window.parent as target
      this._usingMessageChannel = false;
      this._setupFallbackTransport();
    }
  }

  /**
   * Handles the one-time bootstrap postMessage from the container.
   * The bootstrap message carries the MessagePort (port2) in event.ports[0].
   * @param {MessageEvent} event
   * @private
   */
  _onBootstrapMessage(event) {
    // Only inspect messages that claim to be our handshake. Skipping unrelated
    // postMessage traffic first ensures the SEC-003 warnings below fire only
    // for real misconfigurations, not for every ambient message on the window.
    if (
      !event.data ||
      typeof event.data !== 'object' ||
      event.data.type !== 'SHARC:Container:handshake'
    ) return;

    // SEC-003: Defense-in-depth origin validation for the one-time bootstrap.
    // The MessagePort itself carries no sensitive data, but accepting a port from
    // an unexpected window would let a compromised sibling frame or rogue script
    // hijack the creative's transport. Reject anything that isn't from the direct
    // parent window, and (if configured) pin to an expected origin.
    if (event.source !== window.parent) {
      console.warn('[SHARC] Rejected bootstrap handshake: event.source is not window.parent');
      return;
    }
    if (this._trustedOrigin !== null && event.origin !== this._trustedOrigin) {
      console.warn(
        '[SHARC] Rejected bootstrap handshake: event.origin "' + event.origin +
        '" does not match SHARC_CONFIG.trustedOrigin "' + this._trustedOrigin + '"'
      );
      return;
    }

    // Check for the port on the (already-type-verified) handshake message
    if (
      event.ports &&
      event.ports[0]
    ) {
      // Remove the bootstrap listener — we only need the port once
      window.removeEventListener('message', this._bootstrapHandler, false);
      this._bootstrapHandler = null;
      this._portReceived = true;
      this._usingMessageChannel = true;
      this._attachPort(event.ports[0]);
      // Unblock createSession() which may be waiting for the port
      if (this._portReadyResolve) {
        this._portReadyResolve();
        this._portReadyResolve = null;
      }
    }
  }

  /**
   * Sets up the legacy postMessage fallback transport.
   * @private
   */
  _setupFallbackTransport() {
    /** @type {(event: MessageEvent) => void} */
    const fallbackHandler = (event) => {
      // "Looks like SHARC" heuristic — used to scope SEC-003 warnings to
      // protocol traffic and avoid noise from unrelated postMessage senders.
      const looksLikeSharc = !!(
        event.data && typeof event.data === 'object' && event.data.sessionId
      );
      if (event.source !== window.parent) {
        if (looksLikeSharc) {
          console.warn('[SHARC] Dropped fallback message: event.source is not window.parent');
        }
        return;
      }
      // SEC-003: If trustedOrigin is configured, enforce it on the fallback
      // transport too — the fallback carries all subsequent protocol traffic
      // via raw postMessage, not a private port.
      if (this._trustedOrigin !== null && event.origin !== this._trustedOrigin) {
        if (looksLikeSharc) {
          console.warn(
            '[SHARC] Dropped fallback message: event.origin "' + event.origin +
            '" does not match SHARC_CONFIG.trustedOrigin "' + this._trustedOrigin + '"'
          );
        }
        return;
      }
      // Per spec (architecture-design.md §3.3): Structured Clone, no JSON parsing.
      // window.postMessage natively uses Structured Clone, so event.data is already
      // a plain object — no JSON.parse needed.
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      // Construct a synthetic MessageEvent-like object (sufficient for our internal use)
      this._onPortMessage(/** @type {MessageEvent} */ ({ data }));
    };
    window.addEventListener('message', fallbackHandler, false);
  }

  // -------------------------------------------------------------------------
  // Overridden message sending for fallback transport
  // -------------------------------------------------------------------------

  /**
   * @override
   */
  _sendMessage(type, args = {}) {
    if (!this._usingMessageChannel) {
      // Fallback: send via window.parent.postMessage
      // Per spec (architecture-design.md §3.3): Structured Clone, no JSON.stringify.
      // window.postMessage uses Structured Clone natively — pass the object directly.
      if (this._terminated) return Promise.reject(new Error('Protocol is terminated'));
      const messageId = this._nextMessageId++;
      const message = { sessionId: this.sessionId, messageId, timestamp: Date.now(), type, args };
      if (MESSAGES_REQUIRING_RESPONSE.has(type)) {
        return new Promise((resolve, reject) => {
          this._pendingResponses[messageId] = (responseData) => {
            if (responseData.type === ProtocolMessages.RESOLVE) {
              resolve(responseData.args ? responseData.args.value : undefined);
            } else {
              reject(responseData.args ? responseData.args.value : {});
            }
          };
          // Structured Clone: pass message object directly (no JSON.stringify)
          window.parent.postMessage(message, '*');
        });
      }
      // Structured Clone: pass message object directly (no JSON.stringify)
      window.parent.postMessage(message, '*');
      return Promise.resolve();
    }
    return super._sendMessage(type, args);
  }

  // -------------------------------------------------------------------------
  // Creative protocol API
  // -------------------------------------------------------------------------

  /**
   * Sets the placement type to be sent in the next createSession message.
   * Provides a typed accessor for the public Creative SDK so it can configure
   * placement type without reaching into the protocol's private field.
   * @param {'inline'|'interstitial'} type - Placement type.
   * @throws {TypeError} If type is not 'inline' or 'interstitial'.
   */
  setPlacementType(type) {
    if (type !== 'inline' && type !== 'interstitial') {
      throw new TypeError(
        `[SHARC Creative] placementType must be 'inline' or 'interstitial'; got '${type}'`,
      );
    }
    this._placementType = type;
  }

  /**
   * Sends createSession, establishing this creative's session with the container.
   * Generates a new session ID.
   * @returns {Promise<*>} Resolves when container accepts the session.
   */
  createSession() {
    this.sessionId = generateUUID();
    // Wait for the MessagePort bootstrap before sending — the container
    // delivers port2 asynchronously after the iframe load event.
    return this._portReadyPromise.then(() => {
      return this._sendMessage(ProtocolMessages.CREATE_SESSION, {
        placementType: this._placementType || 'inline',
        version: SHARC_VERSION,
      });
    });
  }

  /**
   * Sends Creative:fatalError to the container.
   * @param {number} errorCode
   * @param {string} [errorMessage]
   */
  sendFatalError(errorCode, errorMessage = '') {
    this._sendMessage(CreativeMessages.FATAL_ERROR, { errorCode, errorMessage });
  }

  /**
   * Requests the current container state.
   * @returns {Promise<string>} Resolves with the current state string.
   */
  getContainerState() {
    return this._sendMessage(CreativeMessages.GET_CONTAINER_STATE, {});
  }

  /**
   * Requests current placement options.
   * @returns {Promise<Object>} Resolves with placement information.
   */
  getPlacementOptions() {
    return this._sendMessage(CreativeMessages.GET_PLACEMENT_OPTIONS, {});
  }

  /**
   * Queries the container's placement constraints.
   * Returns what the container allows before the creative requests a change.
   * @returns {Promise<Object>} Resolves with constraint information.
   */
  getPlacementConstraints() {
    return this._sendMessage(CreativeMessages.GET_PLACEMENT_CONSTRAINTS, {});
  }

  /**
   * Sends a log message to the container.
   * @param {string} message
   */
  log(message) {
    this._sendMessage(CreativeMessages.LOG, { message });
  }

  /**
   * Reports interaction tracking URIs to the container for firing.
   * @param {string[]} trackingUris - Array of tracking URIs.
   * @returns {Promise<Object>} Resolves with tracker firing results.
   */
  reportInteraction(trackingUris) {
    return this._sendMessage(CreativeMessages.REPORT_INTERACTION, { trackingUris });
  }

  /**
   * Requests navigation to a URL.
   * @param {Object} args - Navigation arguments.
   * @param {string} args.url - The URL to navigate to.
   * @param {string} args.target - 'clickthrough' | 'deeplink' | 'store' | 'custom'
   * @param {string} [args.customScheme] - Required when target === 'custom'
   * @returns {Promise<Object>} Resolves when container accepts navigation.
   */
  requestNavigation(args) {
    return this._sendMessage(CreativeMessages.REQUEST_NAVIGATION, args);
  }

  /**
   * Requests a placement change.
   * @param {Object} args - Placement change arguments.
   * @param {string} args.intent - 'resize' | 'expand' | 'collapse' | 'fullscreen'
   * @param {Object} [args.targetDimensions] - Required when intent === 'resize'
   * @param {string} [args.anchorPoint] - 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
   * @returns {Promise<Object>} Resolves with updated placement information.
   */
  requestPlacementChange(args) {
    return this._sendMessage(CreativeMessages.REQUEST_PLACEMENT_CHANGE, args);
  }

  /**
   * Requests the container to close.
   * @returns {Promise<*>} Resolves if container accepts; rejects if container refuses.
   */
  requestClose() {
    return this._sendMessage(CreativeMessages.REQUEST_CLOSE, {});
  }

  /**
   * Requests the list of supported features/extensions.
   * @returns {Promise<Array>} Resolves with array of Feature objects.
   */
  getFeatures() {
    return this._sendMessage(CreativeMessages.GET_FEATURES, {});
  }

  /**
   * Sends a resolve response for an incoming container message.
   * Exposed publicly on the creative protocol so creative code can resolve messages.
   * @param {Object} incomingMessage - The message to resolve.
   * @param {*} [value] - The resolve value.
   */
  resolve(incomingMessage, value = {}) {
    this._resolve(incomingMessage, value);
  }

  /**
   * Sends a reject response for an incoming container message.
   * @param {Object} incomingMessage - The message to reject.
   * @param {number} errorCode
   * @param {string} [errorMessage]
   */
  reject(incomingMessage, errorCode, errorMessage = '') {
    this._reject(incomingMessage, errorCode, errorMessage);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * @override
   */
  reset() {
    super.reset();
    this._portReceived = false;
    this._usingMessageChannel = false;
    if (this._bootstrapHandler) {
      window.removeEventListener('message', this._bootstrapHandler, false);
      this._bootstrapHandler = null;
    }
  }
}

// ---------------------------------------------------------------------------
// StateMachine
// ---------------------------------------------------------------------------

/**
 * Enforces valid SHARC container state transitions.
 * Any invalid transition emits a warning but does NOT throw — runtime
 * robustness is more important than strict failure.
 */
class SHARCStateMachine {
  /**
   * @param {string} [initialState=ContainerStates.LOADING]
   */
  constructor(initialState = ContainerStates.LOADING) {
    /** @type {string} */
    this.state = initialState;

    /**
     * Listeners for state change events.
     * @type {Array<(newState: string, previousState: string) => void>}
     */
    this._changeListeners = [];
  }

  /**
   * Attempts a state transition.
   * @param {string} newState - The target state.
   * @returns {boolean} True if the transition was valid and applied; false otherwise.
   */
  transition(newState) {
    const allowed = STATE_TRANSITIONS[this.state];
    if (!allowed) {
      console.warn(`[SHARC StateMachine] No transitions defined from state '${this.state}'`);
      return false;
    }
    if (!allowed.includes(newState)) {
      console.warn(
        `[SHARC StateMachine] Invalid transition: '${this.state}' → '${newState}'. ` +
        `Allowed: [${allowed.join(', ')}]`
      );
      return false;
    }
    const previousState = this.state;
    this.state = newState;
    this._changeListeners.forEach((fn) => {
      try { fn(newState, previousState); } catch (e) { console.error('[SHARC StateMachine] onChange listener error:', e); }
    });
    return true;
  }

  /**
   * Registers a listener for state transitions.
   * @param {(newState: string, previousState: string) => void} callback - Called with (newState, previousState).
   */
  onChange(callback) {
    this._changeListeners.push(callback);
  }

  /**
   * Returns the current state.
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Returns whether this state is one the creative can query.
   * @param {string} [state] - Defaults to current state.
   * @returns {boolean}
   */
  isCreativeQueryable(state = this.state) {
    return CREATIVE_QUERYABLE_STATES.has(state);
  }
}

const SHARCProtocol = {
  SHARCProtocolBase,
  SHARCContainerProtocol,
  SHARCCreativeProtocol,
  SHARCStateMachine,
  ProtocolMessages,
  ContainerMessages,
  CreativeMessages,
  ContainerStates,
  ErrorCodes,
  CREATIVE_QUERYABLE_STATES,
  STATE_TRANSITIONS,
  MESSAGES_REQUIRING_RESPONSE,
  SHARC_VERSION,
  SHARC_API_CODE,
  SAFEFRAME_API_CODE,
  RENDERER_PROTOCOL_VERSION,
};

if (typeof globalThis !== 'undefined') {
  globalThis.SHARC = globalThis.SHARC || {};
  globalThis.SHARC.Protocol = SHARCProtocol;
}

// Legacy IIFE support - ensure global namespace is available even with sideEffects: false
if (typeof window !== 'undefined' && typeof window.SHARC === 'undefined') {
  window.SHARC = {};
  window.SHARC.Protocol = SHARCProtocol;
}

export {
  SHARCProtocol,
  SHARCProtocolBase,
  SHARCContainerProtocol,
  SHARCCreativeProtocol,
  SHARCStateMachine,
  ProtocolMessages,
  ContainerMessages,
  CreativeMessages,
  ContainerStates,
  ErrorCodes,
  CREATIVE_QUERYABLE_STATES,
  STATE_TRANSITIONS,
  MESSAGES_REQUIRING_RESPONSE,
  SHARC_VERSION,
  SHARC_API_CODE,
  SAFEFRAME_API_CODE,
  RENDERER_PROTOCOL_VERSION,
};
