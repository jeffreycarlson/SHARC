// WARNING: __SHARC_TEST_placementCreativeInit is a SHARC test harness convention.
// This creative also self-boots via SHARC.onReady() when loaded standalone.
// See CREATIVE-AUTHORING.md.
'use strict';

// Self-boot path: when loaded standalone (not via wrapper), SHARC SDK is
// available immediately via <script src> tags in the HTML.
// Wrapper path: the wrapper calls __SHARC_TEST_placementCreativeInit() after
// injecting DOM. Both paths converge in initPlacementCreative().

(function () {

  var initialized = false;

  function initPlacementCreative() {
    if (initialized) return;
    initialized = true;

    /* -- Logging helpers ------------------------------------------- */
    var logEl = document.getElementById('protocol-log');

    function logEntry(type, msg) {
      var entry = document.createElement('div');
      entry.className = 'log-entry ' + type;
      var ts = new Date().toISOString().slice(11, 23);
      entry.innerHTML =
        '<span class="ts">[' + ts + ']</span>' +
        '<span class="msg">' + escHtml(String(msg)) + '</span>';
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function escHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function formatSequence(sequence) {
      return sequence.join(' -> ');
    }

    window.clearLog = function clearLog() {
      logEl.innerHTML = '';
      logEntry('info', 'Log cleared.');
    };

    /* -- Test result helpers --------------------------------------- */
    function setResult(id, passed, detail) {
      var el = document.getElementById(id);
      if (!el) return;
      var label = id.replace('result-', '');
      el.textContent = label + ': ' + (passed ? 'PASS' : 'FAIL');
      el.className = 'test-badge ' + (passed ? 'pass' : 'fail');
      logEntry(passed ? 'ok' : 'error', (passed ? 'PASS' : 'FAIL') + ' [' + label + '] ' + (detail || ''));
    }

    /* -- State display update ------------------------------------- */
    function updateDisplay(placement) {
      if (placement) {
        var dimsEl = document.getElementById('disp-dimensions');
        if (placement.width !== undefined && placement.height !== undefined) {
          dimsEl.textContent = placement.width + 'x' + placement.height;
        }
        var posEl = document.getElementById('disp-position');
        if (placement.x !== undefined && placement.y !== undefined) {
          posEl.textContent = placement.x + ',' + placement.y;
        }
      }
    }

    /* -- SHARC event listeners ------------------------------------ */
    SHARC.onReady(function (env, features) {
      logEntry('ok', 'onReady called');
      logEntry('info', '  env: version=' + (env && env.version));
      if (features && features.length > 0) {
        logEntry('info', '  features: ' + features.map(function (f) { return f.name || f; }).join(', '));
      }
      document.getElementById('disp-container-state').textContent = 'ready';
      return Promise.resolve();
    });

    SHARC.onStart(function () {
      logEntry('ok', 'onStart called');
      document.getElementById('disp-container-state').textContent = 'active';
      document.getElementById('disp-container-state').className = 'state-value ok';
      return Promise.resolve();
    });

    SHARC.on('stateChange', function (state) {
      logEntry('event', 'stateChange -> ' + state);
      document.getElementById('disp-container-state').textContent = state;
    });

    SHARC.on('placementChange', function (placement) {
      logEntry('event', 'placementChange: ' + JSON.stringify(placement));
      updateDisplay(placement);
    });

    SHARC.on('placementTransitionEnd', function (payload) {
      logEntry('event', 'placementTransitionEnd: ' + JSON.stringify(payload));
    });

    /* -- Test actions (exposed globally for onclick= buttons) ----- */

    window.testResize320x480 = function testResize320x480() {
      logEntry('action', 'requestPlacementChange({ intent: "resize", 320x480, closeRegion })');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        closeRegion: { position: 'top-right', size: 50 }
      }).then(function (result) {
        logEntry('ok', 'resize resolved: ' + JSON.stringify(result));
        var passed = true;
        if (result && result.width) {
          passed = (result.width === 320 && result.height === 480);
        }
        setResult('result-resize', passed, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'resize rejected: ' + JSON.stringify(err));
        setResult('result-resize', false, (err && err.message) || String(err));
      });
    };

    window.testResizeWithOffset = function testResizeWithOffset() {
      logEntry('action', 'requestPlacementChange({ intent: "resize", 320x480, targetPosition })');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        targetPosition: { x: 10, y: -50 },
        closeRegion: { position: 'top-right', size: 50 }
      }).then(function (result) {
        logEntry('ok', 'resize+offset resolved: ' + JSON.stringify(result));
        setResult('result-offset', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'resize+offset rejected: ' + JSON.stringify(err));
        setResult('result-offset', false, (err && err.message) || String(err));
      });
    };

    window.testMaximize = function testMaximize() {
      logEntry('action', 'requestPlacementChange({ intent: "maximize" })');
      SHARC.requestPlacementChange({
        intent: 'maximize'
      }).then(function (result) {
        logEntry('ok', 'maximize resolved: ' + JSON.stringify(result));
        setResult('result-maximize', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'maximize rejected: ' + JSON.stringify(err));
        setResult('result-maximize', false, (err && err.message) || String(err));
      });
    };

    window.testRestore = function testRestore() {
      logEntry('action', 'requestPlacementChange({ intent: "restore" })');
      SHARC.requestPlacementChange({
        intent: 'restore'
      }).then(function (result) {
        logEntry('ok', 'restore resolved: ' + JSON.stringify(result));
        setResult('result-restore', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'restore rejected: ' + JSON.stringify(err));
        setResult('result-restore', false, (err && err.message) || String(err));
      });
    };

    window.testQueryConstraints = function testQueryConstraints() {
      logEntry('action', 'getPlacementConstraints()');
      // NOTE: getPlacementConstraints() is a new API proposed in the architecture doc.
      // If not yet implemented, this will error -- which is the expected behavior for
      // testing prior to implementation.
      if (typeof SHARC.getPlacementConstraints !== 'function') {
        logEntry('error', 'SHARC.getPlacementConstraints is not a function (not yet implemented)');
        setResult('result-constraints', false, 'API not yet available');
        return;
      }
      SHARC.getPlacementConstraints().then(function (constraints) {
        logEntry('ok', 'constraints: ' + JSON.stringify(constraints));
        var el = document.getElementById('disp-constraints');
        if (constraints) {
          var parts = [];
          if (constraints.maxWidth) parts.push('maxW:' + constraints.maxWidth);
          if (constraints.maxHeight) parts.push('maxH:' + constraints.maxHeight);
          if (constraints.allowedIntents) parts.push('intents:' + constraints.allowedIntents.join(','));
          el.textContent = parts.join(' ') || 'none';
        }
        setResult('result-constraints', true, JSON.stringify(constraints));
      }).catch(function (err) {
        logEntry('error', 'constraints rejected: ' + JSON.stringify(err));
        setResult('result-constraints', false, (err && err.message) || String(err));
      });
    };

    window.testResizeWithAnimation = function testResizeWithAnimation() {
      logEntry('action', 'requestPlacementChange({ intent: "resize", 320x480, transition })');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        closeRegion: { position: 'top-right', size: 50 },
        transition: { duration: 300, easing: 'ease-out' }
      }).then(function (result) {
        logEntry('ok', 'resize+anim resolved: ' + JSON.stringify(result));
        setResult('result-animation', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'resize+anim rejected: ' + JSON.stringify(err));
        setResult('result-animation', false, (err && err.message) || String(err));
      });
    };

    window.testZeroDurationOrder = function testZeroDurationOrder() {
      var target = { width: 320, height: 480 };
      var expected = ['resolve', 'placementChange', 'placementTransitionEnd'];
      var sequence = [];
      var finished = false;
      var timeoutId = null;

      function cleanup() {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        SHARC.off('placementChange', onPlacementChange);
        SHARC.off('placementTransitionEnd', onPlacementTransitionEnd);
      }

      function finish(passed, detail) {
        if (finished) return;
        finished = true;
        cleanup();
        setResult('result-zero-order', passed, detail);
      }

      function maybeFinish() {
        if (sequence.length < expected.length) return;
        var passed = expected.every(function (step, idx) {
          return sequence[idx] === step;
        });
        finish(passed, formatSequence(sequence));
      }

      function onPlacementChange(payload) {
        var placement = payload && payload.placementUpdate;
        if (!placement || placement.width !== target.width || placement.height !== target.height) return;
        sequence.push('placementChange');
        logEntry('info', 'zero-order sequence: ' + formatSequence(sequence));
        maybeFinish();
      }

      function onPlacementTransitionEnd(payload) {
        var dims = payload && payload.finalDimensions;
        if (!dims || dims.width !== target.width || dims.height !== target.height) return;
        sequence.push('placementTransitionEnd');
        logEntry('info', 'zero-order sequence: ' + formatSequence(sequence));
        maybeFinish();
      }

      logEntry('action', 'zero-duration ordering regression: resolve -> placementChange -> placementTransitionEnd');
      (function markPending() {
        var el = document.getElementById('result-zero-order');
        if (!el) return;
        el.textContent = 'zero-order: RUN';
        el.className = 'test-badge pending';
      }());

      SHARC.requestPlacementChange({ intent: 'restore' }).catch(function () {
        return null;
      }).then(function () {
        SHARC.on('placementChange', onPlacementChange);
        SHARC.on('placementTransitionEnd', onPlacementTransitionEnd);
        timeoutId = setTimeout(function () {
          finish(false, formatSequence(sequence) || 'timed out waiting for sequence');
        }, 1000);
        return SHARC.requestPlacementChange({
          intent: 'resize',
          targetDimensions: target,
          closeRegion: { position: 'top-right', size: 50 },
          transition: { duration: 0, easing: 'ease-out' }
        });
      }).then(function (result) {
        sequence.push('resolve');
        logEntry('ok', 'zero-duration resolved: ' + JSON.stringify(result));
        logEntry('info', 'zero-order sequence: ' + formatSequence(sequence));
        maybeFinish();
      }).catch(function (err) {
        finish(false, (err && err.message) || String(err));
        logEntry('error', 'zero-duration rejected: ' + JSON.stringify(err));
      });
    };

    window.testGetPlacementOptions = function testGetPlacementOptions() {
      logEntry('action', 'getPlacementOptions()');
      SHARC.getPlacementOptions().then(function (opts) {
        logEntry('ok', 'placementOptions: ' + JSON.stringify(opts));
        updateDisplay(opts);
      }).catch(function (err) {
        logEntry('error', 'getPlacementOptions rejected: ' + JSON.stringify(err));
      });
    };

    logEntry('info', 'Placement test creative initialized.');
  }

  // Wrapper path: expose init callback
  window.__SHARC_TEST_placementCreativeInit = initPlacementCreative;

  // Self-boot path: if SHARC SDK is already on window, init immediately
  if (typeof window.SHARC !== 'undefined' && typeof window.SHARC.onReady === 'function') {
    initPlacementCreative();
  }

}());
