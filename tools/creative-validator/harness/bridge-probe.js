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

  function safeframeProbe() {
    var sf = window.$sf && window.$sf.ext;
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
}());
