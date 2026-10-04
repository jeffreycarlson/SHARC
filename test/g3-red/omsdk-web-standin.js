/**
 * Recorded-behavior stand-in for the pinned OM SDK for Web pair
 * (omweb-v1 1.5.2-google27 + omid-session-client-v1 1.6.6-iab457).
 *
 * The pinned binaries are portal-gated and may not be committed
 * (tools/creative-validator/VENDORED.md), so CI runs against this stand-in.
 * It is honest in two ways the per-file mocks it replaces were not:
 *
 * 1. SURFACE. Every object exposes exactly the public members the pinned
 *    session client has (RECORDED_SURFACE, extracted from the real 1.6.6
 *    binary on 2026-10-04). Objects are Proxies: any read of a member the
 *    real client lacks (registerAdView, addFriendlyObstruction,
 *    Context.setContentUrl, AdSession.sessionId, AdEvents.stateChange, ...)
 *    is recorded in `phantomReads`, including `typeof x.foo` probes. A guarded
 *    call to a phantom can no longer pass silently.
 *
 * 2. BEHAVIOR. The service side models what the real omweb-v1 did in Chrome
 *    for each call (probe 486-omweb-registration-probe.mjs, 2026-10-04):
 *    - Context(partner, resources, contentUrl, customReferenceData,
 *      universalAdId): contentUrl is a constructor argument; the Context has
 *      NO setContentUrl (session client :725-751). The AdSession constructor
 *      sends slotElement and contentUrl once (:1156-1158), so a
 *      setSlotElement after `new AdSession` never reaches the service.
 *    - omweb measures only when it has a slot element; an <iframe> slot is
 *      measured only once setElementBounds has been called (omweb `Jb`/`Kb`,
 *      `Ib`). Probe variant H: iframe slot, no bounds -> 0 geometryChange and
 *      an impression without viewport/adView.
 *    - With slot + bounds, the ad rect is the slot's client rect offset by
 *      the bounds (omweb `Mb`), intersected with the viewport. geometryChange
 *      is emitted only when the value changes (omweb `Lb`), with the shape
 *      recorded in probe variant E (pixelsInView, geometry.pixels,
 *      onScreenGeometry.{pixels,obstructions,friendlyObstructions},
 *      declaredFriendlyObstructions). The web service has no API to declare
 *      friendly obstructions, so declaredFriendlyObstructions is always 0.
 *    - impression carries viewport/adView/declaredFriendlyObstructions plus
 *      impressionType/mediaType/creativeType when measuring; only the three
 *      type fields when not. loaded carries only the three type fields.
 *    - Every service event carries getAdSessionId() as adSessionId.
 *    - sessionStart reaches the integration's session observer synchronously
 *      inside start(), carrying contentUrl from the Context (null default).
 *
 * NOT modeled (proved only by the operator-run real-binary gate): the
 * IntersectionObserver timing (tests call remeasure()), document.hidden /
 * 'backgrounded', the transient stale-intersection event omweb emits after a
 * bounds update, and service-side verification-script injection.
 */

// Public prototype members of the pinned 1.6.6 session client, recorded from
// the real binary (scratchpad 486-surface.cjs). Instance fields of Context are
// real (session client :729-737); AdSession instance state is all `_`-private.
export const RECORDED_SURFACE = Object.freeze({
  namespace: ['AdEvents', 'AdSession', 'Context', 'CreativeType', 'ErrorType', 'ImpressionType',
    'InteractionType', 'MediaEvents', 'OmidVersion', 'Partner', 'UniversalAdId', 'VastProperties',
    'VerificationScriptResource', 'VerificationVendorId', 'VideoPlayerState', 'listenForServiceWindow',
    'verificationVendorIdForScriptUrl'],
  Context: ['setServiceWindow', 'setSlotElement', 'setVideoElement',
    'partner', 'verificationScriptResources', 'slotElement', 'videoElement', 'contentUrl',
    'customReferenceData', 'underEvaluation', 'serviceWindow', 'universalAdId'],
  AdSession: ['assertSessionRunning', 'creativeLoaded', 'error', 'finish', 'getAdSessionId',
    'impressionOccurred', 'isSupported', 'registerAdEvents', 'registerMediaEvents',
    'registerSessionObserver', 'sendMessage', 'sendOneWayMessage', 'setCreativeType',
    'setElementBounds', 'setImpressionType', 'start'],
  AdEvents: ['impressionOccurred', 'loaded'],
  MediaEvents: ['adUserInteraction', 'bufferFinish', 'bufferStart', 'complete', 'firstQuartile',
    'midpoint', 'pause', 'playerStateChange', 'resume', 'skipped', 'start', 'thirdQuartile',
    'volumeChange'],
});

// sessionStart.data the pinned pair delivered in Chrome (see #484 gate);
// contentUrl and pageUrl are filled per session.
const SESSION_START_CONTEXT = Object.freeze({
  apiVersion: '1.0',
  accessMode: 'limited',
  environment: 'web',
  omidJsInfo: {
    omidImplementer: 'omsdk',
    serviceVersion: '1.5.2-google27',
    sessionClientVersion: '1.6.6-iab457',
    partnerName: 'sharc',
    partnerVersion: '0.7.13',
  },
  adSessionType: 'html',
  supports: ['clid', 'vlid'],
  sessionOwner: 'javascript',
  customReferenceData: undefined,
  underEvaluation: false,
  canMeasureVisibility: true,
});

const MEDIA_TYPE_FOR = { htmlDisplay: 'display', nativeDisplay: 'display', video: 'video', audio: 'audio' };

function isIframe(el) {
  return !!(el && el.tagName && String(el.tagName).toLowerCase() === 'iframe');
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  const x = typeof r.x === 'number' ? r.x : r.left;
  const y = typeof r.y === 'number' ? r.y : r.top;
  return { x, y, width: r.width, height: r.height };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const ex = Math.min(a.x + a.width, b.x + b.width);
  const ey = Math.min(a.y + a.height, b.y + b.height);
  if (ex <= x || ey <= y) return { x: 0, y: 0, width: 0, height: 0 };
  return { x, y, width: ex - x, height: ey - y };
}

/**
 * Installs the stand-in as `win.OmidSessionClient`.
 * @param {Window} win
 * @param {{ deliverSessionStartInStart?: boolean }} [opts]
 */
export function installOmSdkWebStandin(win, { deliverSessionStartInStart = true } = {}) {
  const calls = [];
  const phantomReads = [];
  const sessions = [];
  const serviceListeners = new Map();
  const targets = new WeakMap();
  let nextId = 0;

  function watch(kind, target) {
    const allowed = new Set(RECORDED_SURFACE[kind]);
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        if (typeof prop === 'string' && !allowed.has(prop) && prop !== 'then' && prop !== 'toJSON') {
          phantomReads.push(kind + '.' + prop);
        }
        return Reflect.get(t, prop, receiver);
      },
    });
    targets.set(proxy, target);
    return proxy;
  }

  function emitService(session, type, data) {
    const ev = { adSessionId: session.id, timestamp: Date.now(), type, data };
    session.serviceEvents.push(structuredClone(ev));
    for (const cb of (serviceListeners.get(type) || []).slice()) cb(structuredClone(ev));
  }

  function measure(session) {
    if (!session.started || !session.slot) return null;
    if (isIframe(session.slot) && !session.bounds) return null;
    const slot = rectOf(session.slot);
    const ad = session.bounds
      ? { x: slot.x + session.bounds.x, y: slot.y + session.bounds.y,
        width: session.bounds.width, height: session.bounds.height }
      : slot;
    const viewport = { width: win.innerWidth, height: win.innerHeight };
    const onScreen = intersect(intersect(ad, slot), { x: 0, y: 0, ...viewport });
    const adPixels = ad.width * ad.height;
    const onPixels = onScreen.width * onScreen.height;
    const pct = adPixels > 0 ? Math.round((onPixels / adPixels) * 100) : 0;
    return {
      viewport,
      adView: {
        percentageInView: pct,
        pixelsInView: onPixels,
        reasons: pct === 100 ? [] : (pct === 0 ? ['viewport'] : ['clipped']),
        geometry: { ...ad, pixels: adPixels },
        onScreenGeometry: { ...onScreen, pixels: onPixels, obstructions: [], friendlyObstructions: [] },
      },
      declaredFriendlyObstructions: 0,
    };
  }

  function remeasure(session) {
    const g = measure(session);
    if (!g) return;
    const key = JSON.stringify(g);
    if (key === session.lastGeometryKey) return;
    session.lastGeometryKey = key;
    emitService(session, 'geometryChange', g);
  }

  function typeFields(session) {
    return {
      impressionType: session.impressionType,
      mediaType: MEDIA_TYPE_FOR[session.creativeType] || 'display',
      creativeType: session.creativeType,
    };
  }

  function Partner(name, version) { this.name = name; this.version = version; }

  function Context(partner, verificationScriptResources, contentUrl, customReferenceData, universalAdId) {
    calls.push({ api: 'Context', args: [partner, verificationScriptResources, contentUrl,
      customReferenceData, universalAdId], argc: arguments.length });
    this.partner = partner;
    this.verificationScriptResources = verificationScriptResources;
    this.videoElement = this.slotElement = null;
    this.contentUrl = contentUrl === undefined ? null : contentUrl;
    this.customReferenceData = customReferenceData === undefined ? null : customReferenceData;
    this.underEvaluation = false;
    this.serviceWindow = null;
    this.universalAdId = universalAdId === undefined ? null : universalAdId;
    return watch('Context', this);
  }
  Context.prototype.setSlotElement = function (el) {
    if (el == null || typeof el !== 'object') throw new Error('Context.slotElement must be a non-null object');
    calls.push({ api: 'Context.setSlotElement', args: [el] });
    this.slotElement = el;
  };
  Context.prototype.setVideoElement = function (el) {
    calls.push({ api: 'Context.setVideoElement', args: [el] });
    this.videoElement = el;
  };
  Context.prototype.setServiceWindow = function (w) {
    calls.push({ api: 'Context.setServiceWindow', args: [w] });
    this.serviceWindow = w;
  };

  function AdSession(contextProxy) {
    const context = targets.get(contextProxy) || contextProxy;
    const session = {
      id: 'omsdk-adsession-' + (++nextId),
      context,
      slot: context.slotElement || null,
      contentUrl: context.contentUrl == null ? null : context.contentUrl,
      bounds: null,
      started: false,
      creativeType: null,
      impressionType: null,
      observers: [],
      serviceEvents: [],
      lastGeometryKey: null,
    };
    sessions.push(session);
    calls.push({ api: 'AdSession', args: [contextProxy], slotAtConstruction: session.slot,
      contentUrlAtConstruction: session.contentUrl, sessionIndex: sessions.length - 1 });
    const self = this;
    this.getAdSessionId = function () { return session.id; };
    this.isSupported = function () { return true; };
    this.setCreativeType = function (t) {
      if (t === 'definedByJavaScript') throw new Error('Creative type cannot be redefined with value definedByJavaScript');
      calls.push({ api: 'AdSession.setCreativeType', args: [t] });
      session.creativeType = t;
    };
    this.setImpressionType = function (t) {
      if (t === 'definedByJavaScript') throw new Error('Impression type cannot be redefined with value definedByJavaScript');
      calls.push({ api: 'AdSession.setImpressionType', args: [t] });
      session.impressionType = t;
    };
    this.setElementBounds = function (b) {
      if (b == null || typeof b !== 'object') throw new Error('AdSession.elementBounds must be a non-null object');
      calls.push({ api: 'AdSession.setElementBounds', args: [structuredClone(b)], started: session.started });
      session.bounds = structuredClone(b);
      remeasure(session);
    };
    this.registerSessionObserver = function (fn) {
      calls.push({ api: 'AdSession.registerSessionObserver' });
      session.observers.push(fn);
    };
    this.start = function () {
      calls.push({ api: 'AdSession.start' });
      session.started = true;
      const data = {
        context: structuredClone(SESSION_START_CONTEXT),
        impressionType: session.impressionType,
        mediaType: MEDIA_TYPE_FOR[session.creativeType] || 'display',
        creativeType: session.creativeType,
        supportsLoadedEvent: true,
        pageUrl: win.location.href,
        contentUrl: session.contentUrl,
      };
      emitService(session, 'sessionStart', data);
      if (deliverSessionStartInStart) {
        for (const fn of session.observers.slice()) {
          fn({ adSessionId: session.id, timestamp: Date.now(), type: 'sessionStart', data: structuredClone(data) });
        }
      }
      remeasure(session);
    };
    this.finish = function () {
      calls.push({ api: 'AdSession.finish' });
      session.started = false;
      emitService(session, 'sessionFinish', {});
      for (const fn of session.observers.slice()) {
        fn({ adSessionId: session.id, timestamp: Date.now(), type: 'sessionFinish' });
      }
    };
    this.error = function (type, message) { calls.push({ api: 'AdSession.error', args: [type, message] }); };
    this.registerAdEvents = function () {};
    this.registerMediaEvents = function () {};
    this.assertSessionRunning = function () { if (!session.started) throw new Error('Session not started.'); };
    this.creativeLoaded = function () {};
    this.impressionOccurred = function () {};
    this.sendMessage = function () {};
    this.sendOneWayMessage = function () {};
    this.__session = session;
    const proxy = watch('AdSession', self);
    targets.set(proxy, self);
    return proxy;
  }

  function AdEvents(adSessionProxy) {
    const session = (targets.get(adSessionProxy) || adSessionProxy).__session;
    this.loaded = function () {
      calls.push({ api: 'AdEvents.loaded' });
      emitService(session, 'loaded', typeFields(session));
    };
    this.impressionOccurred = function () {
      if (!session.started) throw new Error('Session not started.');
      calls.push({ api: 'AdEvents.impressionOccurred' });
      const g = measure(session);
      emitService(session, 'impression', g ? { ...g, ...typeFields(session) } : typeFields(session));
    };
    return watch('AdEvents', this);
  }

  function MediaEvents() {
    for (const m of RECORDED_SURFACE.MediaEvents) this[m] = function () {};
    return watch('MediaEvents', this);
  }

  function VerificationScriptResource(resourceUrl, vendorKey, verificationParameters, accessMode) {
    this.resourceUrl = resourceUrl;
    this.vendorKey = vendorKey;
    this.verificationParameters = verificationParameters;
    this.accessMode = accessMode;
  }
  function VastProperties(isSkippable, skipOffset, isAutoPlay, position) {
    Object.assign(this, { isSkippable, skipOffset, isAutoPlay, position });
  }

  const ns = {
    AdEvents, AdSession, Context, MediaEvents, Partner, VastProperties, VerificationScriptResource,
    CreativeType: {}, ErrorType: {}, ImpressionType: {}, InteractionType: {}, OmidVersion: '1.6.6-iab457',
    UniversalAdId: function () {}, VerificationVendorId: {}, VideoPlayerState: {},
    listenForServiceWindow() {}, verificationVendorIdForScriptUrl() {},
  };
  // The real client exports under a versioned key and 'default' (session
  // client :1-20, `versions = ['1.6.6-iab457']` + 'default').
  const watchedNs = watch('namespace', ns);
  win.OmidSessionClient = { '1.6.6-iab457': watchedNs, default: watchedNs };

  return {
    calls,
    phantomReads,
    sessions,
    /** Subscribe like a service-path verification vendor (DV, Pixalate). */
    addServiceListener(type, cb) {
      if (!serviceListeners.has(type)) serviceListeners.set(type, []);
      serviceListeners.get(type).push(cb);
    },
    /** Models an IntersectionObserver callback on every live session. */
    remeasure() { for (const s of sessions) remeasure(s); },
    uninstall() { delete win.OmidSessionClient; },
  };
}
