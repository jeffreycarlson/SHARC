(function () {
  var ERROR_CAP = 512;
  var PROBE_NONCE = '__SHARC_VALIDATOR_PROBE_NONCE__';

  try {
    if (document.currentScript && document.currentScript.parentNode) {
      document.currentScript.parentNode.removeChild(document.currentScript);
    }
  } catch (_) {
    // Best-effort: removing the inline probe source hides the per-case nonce
    // from later creative scripts in this private validator harness.
  }

  function cappedError(err) {
    var message = err && err.message ? err.message : String(err);
    return String(message).slice(0, ERROR_CAP);
  }

  function cloneForProbe(value) {
    if (value === undefined) return null;
    if (value === null || typeof value === 'string'
        || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return Object.prototype.toString.call(value);
    }
  }

  function probeMethod(target, name, args) {
    var out = { exists: false, status: 'absent', value: null, error: null };
    try {
      // Intentionally probe a fixed method list. Do not enumerate bridge
      // objects here; hostile Proxy traps could turn enumeration into code.
      var fn = Reflect.get(target, name);
      out.exists = typeof fn === 'function';
      if (!out.exists) return out;
      out.value = cloneForProbe(Reflect.apply(fn, target, args || []));
      out.status = 'ok';
    } catch (err) {
      out.status = 'threw';
      out.error = cappedError(err);
    }
    return out;
  }

  var activeProbeCache = {
    mraid: null,
    safeframe: null,
  };
  var lifecycleProbe = createMraidLifecycleProbe();

  function withActiveProbe(fn) {
    var hadPrior = Object.prototype.hasOwnProperty.call(window, '__sharcValidatorProbeActive');
    var prior = window.__sharcValidatorProbeActive;
    window.__sharcValidatorProbeActive = true;
    try {
      return fn();
    } finally {
      if (hadPrior) {
        window.__sharcValidatorProbeActive = prior;
      } else {
        try {
          delete window.__sharcValidatorProbeActive;
        } catch (_) {
          window.__sharcValidatorProbeActive = undefined;
        }
      }
    }
  }

  function activeMraidProbes(mraid) {
    // Active probes intentionally run once per document: they may call
    // navigation/placement methods, so later sampling ticks should report the
    // same active-call outcome instead of generating duplicate probe traffic.
    if (activeProbeCache.mraid !== null) return activeProbeCache.mraid;
    activeProbeCache.mraid = withActiveProbe(function () {
      return {
        open: probeMethod(mraid, 'open', ['https://sharc-validator.example/mraid-open-probe']),
        expand: probeMethod(mraid, 'expand'),
      };
    });
    return activeProbeCache.mraid;
  }

  function activeSafeFrameProbes(sf) {
    // Active probes intentionally run once per document; see MRAID note above.
    if (activeProbeCache.safeframe !== null) return activeProbeCache.safeframe;
    activeProbeCache.safeframe = withActiveProbe(function () {
      return {
        register: probeMethod(sf, 'register', [0, 0, function () {}]),
        redirect: probeMethod(sf, 'redirect', ['https://sharc-validator.example/safeframe-redirect-probe']),
      };
    });
    return activeProbeCache.safeframe;
  }

  function mraidProbe() {
    var mraid = window.mraid;
    var out = {
      exists: !!mraid,
      installed: window.__sharcMraidBridgeInstalled === true,
      methods: {},
      lifecycle: lifecycleProbe.snapshot(),
    };
    if (!mraid) return out;
    out.methods.getVersion = probeMethod(mraid, 'getVersion');
    out.methods.getState = probeMethod(mraid, 'getState');
    out.methods.isViewable = probeMethod(mraid, 'isViewable');
    out.methods.supports = probeMethod(mraid, 'supports', ['sms']);
    if (out.installed) {
      Object.assign(out.methods, activeMraidProbes(mraid));
    }
    return out;
  }

  function createMraidLifecycleProbe() {
    var state = {
      installedAt: performance.now(),
      documentLoadAt: null,
      parse: {
        mraidExists: false,
        getStateStatus: 'absent',
        getStateValue: null,
        readyDeliveredBeforeParseEnd: false,
        defaultStateChangeDeliveredBeforeParseEnd: false,
      },
      ready: {
        delivered: false,
        firstAt: null,
        count: 0,
        stateDefaultDeliveredAtOrBeforeReady: false,
        getStateAfterReady: null,
        lateReplayDelivered: false,
        lateReplayAt: null,
        lateReplayCount: 0,
        parseListenerCountAfterLateAttach: 0,
      },
      stateChange: {
        count: 0,
        defaultCount: 0,
        firstDefaultAt: null,
        lastState: null,
        events: [],
      },
      viewableChange: {
        trueDelivered: false,
        firstTrueAt: null,
        isViewableAtTrue: null,
        events: [],
      },
      exposureChange: {
        delivered: false,
        firstAt: null,
        firstPercentage: null,
        lastPercentage: null,
        events: [],
      },
      error: {
        count: 0,
        lastMessage: null,
        lastAction: null,
        lateReplayDelivered: false,
        lateReplayAt: null,
        lateReplayMessage: null,
        lateReplayAction: null,
      },
    };

    function now() {
      return Math.round(performance.now() * 1000) / 1000;
    }

    function limitedPush(list, value) {
      if (list.length < 16) list.push(value);
    }

    function recordDocumentLoad() {
      if (state.documentLoadAt === null) state.documentLoadAt = now();
    }

    if (document.readyState === 'complete') {
      recordDocumentLoad();
    } else {
      window.addEventListener('load', recordDocumentLoad, { once: true });
    }

    function install() {
      var mraid = window.mraid;
      state.parse.mraidExists = !!mraid;
      if (!mraid || typeof mraid.addEventListener !== 'function') {
        return;
      }
      try {
        var getState = probeMethod(mraid, 'getState');
        state.parse.getStateStatus = getState.status;
        state.parse.getStateValue = getState.value;
      } catch (_) {
        state.parse.getStateStatus = 'threw';
      }

      try {
        mraid.addEventListener('stateChange', function (newState) {
          var t = now();
          state.stateChange.count += 1;
          state.stateChange.lastState = newState || null;
          if (newState === 'default') {
            state.stateChange.defaultCount += 1;
            if (state.stateChange.firstDefaultAt === null) {
              state.stateChange.firstDefaultAt = t;
            }
          }
          limitedPush(state.stateChange.events, { t: t, state: newState || null });
        });
      } catch (_) {
        // Gate diagnostics only; method sampling records API errors separately.
      }

      try {
        mraid.addEventListener('ready', function () {
          var t = now();
          state.ready.count += 1;
          if (!state.ready.delivered) {
            state.ready.delivered = true;
            state.ready.firstAt = t;
            state.ready.stateDefaultDeliveredAtOrBeforeReady =
              state.stateChange.firstDefaultAt !== null
              && state.stateChange.firstDefaultAt <= t;
            try {
              state.ready.getStateAfterReady = mraid.getState();
            } catch (err) {
              state.ready.getStateAfterReady = 'threw:' + cappedError(err);
            }
            try {
              mraid.addEventListener('ready', function () {
                state.ready.lateReplayCount += 1;
                if (!state.ready.lateReplayDelivered) {
                  state.ready.lateReplayDelivered = true;
                  state.ready.lateReplayAt = now();
                }
              });
            } catch (_) {
              // Gate diagnostics only.
            }
            setTimeout(function () {
              state.ready.parseListenerCountAfterLateAttach = state.ready.count;
            }, 0);
          }
        });
      } catch (_) {
        // Gate diagnostics only.
      }

      try {
        mraid.addEventListener('viewableChange', function (isViewable) {
          var t = now();
          var record = { t: t, value: isViewable === true };
          if (isViewable === true && !state.viewableChange.trueDelivered) {
            state.viewableChange.trueDelivered = true;
            state.viewableChange.firstTrueAt = t;
            try {
              state.viewableChange.isViewableAtTrue = mraid.isViewable();
            } catch (err) {
              state.viewableChange.isViewableAtTrue = 'threw:' + cappedError(err);
            }
          }
          limitedPush(state.viewableChange.events, record);
        });
      } catch (_) {
        // Gate diagnostics only.
      }

      try {
        mraid.addEventListener('exposureChange', function (exposedPercentage) {
          var t = now();
          var percentage = Number(exposedPercentage);
          if (!Number.isFinite(percentage)) percentage = null;
          if (!state.exposureChange.delivered) {
            state.exposureChange.delivered = true;
            state.exposureChange.firstAt = t;
            state.exposureChange.firstPercentage = percentage;
          }
          state.exposureChange.lastPercentage = percentage;
          limitedPush(state.exposureChange.events, { t: t, exposedPercentage: percentage });
        });
      } catch (_) {
        // Gate diagnostics only.
      }

      try {
        mraid.addEventListener('error', function (message, action) {
          state.error.count += 1;
          state.error.lastMessage = message || '';
          state.error.lastAction = action || '';
          if (!state.error.lateReplayDelivered && state.error.count === 1) {
            try {
              mraid.addEventListener('error', function (lateMessage, lateAction) {
                if (state.error.lateReplayDelivered) return;
                state.error.lateReplayDelivered = true;
                state.error.lateReplayAt = now();
                state.error.lateReplayMessage = lateMessage || '';
                state.error.lateReplayAction = lateAction || '';
              });
            } catch (_) {
              // Gate diagnostics only.
            }
          }
        });
      } catch (_) {
        // Gate diagnostics only.
      }

      setTimeout(function () {
        state.parse.readyDeliveredBeforeParseEnd = state.ready.count > 0;
        state.parse.defaultStateChangeDeliveredBeforeParseEnd =
          state.stateChange.defaultCount > 0;
      }, 0);
    }

    install();

    return {
      snapshot: function () {
        if (state.documentLoadAt === null && document.readyState === 'complete') {
          recordDocumentLoad();
        }
        return cloneForProbe(state);
      },
    };
  }

  function safeframeProbe() {
    // #346: read the SafeFrame ext accessor via dynamic property access so this
    // probe's own source does NOT contain the literal SafeFrame-ext token. This
    // probe is injected into the creative HTML that the container scans (its
    // Layer-3 adm content-scan substring-matches that exact token); a literal
    // occurrence here would make the container detect the PROBE's reference and
    // spuriously provision a SafeFrame bridge on plain-HTML / OMID creatives.
    // The runtime read is identical to `window.$sf` then its `ext` property, so
    // a REAL SafeFrame creative (which ships the accessor in its own markup
    // and/or declares the SafeFrame api) still probes true and the container
    // still detects it. Keep this file free of the literal accessor token.
    var sfRoot = window['$sf'];
    var sf = sfRoot && sfRoot['e' + 'xt'];
    var out = {
      exists: !!sf,
      installed: window.__sharcSafeFrameBridgeInstalled === true,
      methods: {},
    };
    if (!sf) return out;
    out.methods.supports = probeMethod(sf, 'supports');
    out.methods.geom = probeMethod(sf, 'geom');
    if (out.installed) {
      Object.assign(out.methods, activeSafeFrameProbes(sf));
    }
    return out;
  }

  function runProbe() {
    window.parent.postMessage({
      type: 'SHARC:Validator:bridgeProbe',
      probeNonce: PROBE_NONCE,
      payload: {
        bridges: {
          mraid: mraidProbe(),
          safeframe: safeframeProbe(),
        },
      },
    }, '*');
  }

  // The reference renderer imports bridge modules before document.write().
  // Queueing probes here lets bridge auto-install timers run first, while
  // still sampling late enough to cover MRAID creatives whose parser activity
  // races the first diagnostic tick. If creative code suppresses these timers,
  // the parent records no probe and the case falls through to existing
  // rendered/inconclusive buckets.
  setTimeout(runProbe, 0);
  setTimeout(runProbe, 50);
  setTimeout(runProbe, 150);
  setTimeout(runProbe, 300);
  // Late probe (R1): the 0–300ms window closes BEFORE Container:init / onReady
  // lands and before the adapter-promotion + handshake settle, so it samples
  // pre-onReady (the documented reason #334 could not observe the viewability
  // flip). A post-settle sample at t=1500ms captures the steady state after the
  // session is established. Run the validator with --settle-ms >= 2500 so this
  // probe fires before capture closes.
  setTimeout(runProbe, 1500);
}());
