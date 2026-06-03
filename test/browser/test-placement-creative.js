// WARNING: __SHARC_TEST_placementCreativeInit is a SHARC test harness convention.
// This creative also self-boots via SHARC.onReady() when loaded standalone.
// See CREATIVE-AUTHORING.md.
'use strict';

// Self-boot path: when loaded standalone (not via wrapper), SHARC API is
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

    window.testExpand = function testExpand() {
      logEntry('action', 'requestPlacementChange({ intent: "expand" })');
      SHARC.requestPlacementChange({
        intent: 'expand'
      }).then(function (result) {
        logEntry('ok', 'expand resolved: ' + JSON.stringify(result));
        setResult('result-expand', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'expand rejected: ' + JSON.stringify(err));
        setResult('result-expand', false, (err && err.message) || String(err));
      });
    };

    window.testCollapse = function testCollapse() {
      logEntry('action', 'requestPlacementChange({ intent: "collapse" })');
      SHARC.requestPlacementChange({
        intent: 'collapse'
      }).then(function (result) {
        logEntry('ok', 'collapse resolved: ' + JSON.stringify(result));
        setResult('result-collapse', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'collapse rejected: ' + JSON.stringify(err));
        setResult('result-collapse', false, (err && err.message) || String(err));
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
        var placement = payload;
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

      SHARC.requestPlacementChange({ intent: 'collapse' }).catch(function () {
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
        setResult('result-get-placement', true, JSON.stringify(opts));
      }).catch(function (err) {
        logEntry('error', 'getPlacementOptions rejected: ' + JSON.stringify(err));
        setResult('result-get-placement', false, (err && err.message) || String(err));
      });
    };

    /* -- Edge scenario tests ---------------------------------------- */

    window.testResizeWhileResized = function testResizeWhileResized() {
      logEntry('action', 'Resize to 320x480, then resize to 300x250 without collapse');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        closeRegion: { position: 'top-right', size: 50 }
      }).then(function (_result) {
        logEntry('info', 'First resize resolved. Now resizing to 300x250...');
        return SHARC.requestPlacementChange({
          intent: 'resize',
          targetDimensions: { width: 300, height: 250 },
          closeRegion: { position: 'top-right', size: 50 }
        });
      }).then(function (result) {
        logEntry('ok', 'Second resize resolved (same-intent re-entry allowed): ' + JSON.stringify(result));
        setResult('result-resize2', true, 'Same-intent re-entry works');
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'Resize-while-resized failed: ' + JSON.stringify(err));
        setResult('result-resize2', false, (err && err.message) || String(err));
      });
    };

    window.testExpandWhileResized = function testExpandWhileResized() {
      logEntry('action', 'Resize first, then expand without collapse (should reject)');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        closeRegion: { position: 'top-right', size: 50 }
      }).then(function (_result) {
        logEntry('info', 'Resized. Now attempting expand without collapse...');
        return SHARC.requestPlacementChange({
          intent: 'expand'
        });
      }).then(function (result) {
        logEntry('error', 'Expand should have been rejected but resolved: ' + JSON.stringify(result));
        setResult('result-max-resized', false, 'Should have rejected');
      }).catch(function (err) {
        logEntry('ok', 'Correctly rejected expand-while-resized: ' + JSON.stringify(err));
        var passed = err && err.errorCode === 2203;
        setResult('result-max-resized', passed, (err && err.message) || String(err));
        // Clean up: collapse
        SHARC.requestPlacementChange({ intent: 'collapse' }).catch(function () {});
      });
    };

    window.testTransitionEnd = function testTransitionEnd() {
      logEntry('action', 'Resize with transition hint, listen for placementTransitionEnd');
      var gotEnd = false;
      var listener = function (data) {
        gotEnd = true;
        logEntry('ok', 'placementTransitionEnd received: ' + JSON.stringify(data));
        setResult('result-transend', true, 'Event fired');
      };
      SHARC.on('placementTransitionEnd', listener);
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 480 },
        closeRegion: { position: 'top-right', size: 50 },
        transition: { duration: 200, easing: 'ease-out' }
      }).then(function () {
        // Wait for the transition end event (up to 1 second)
        setTimeout(function () {
          if (!gotEnd) {
            logEntry('error', 'placementTransitionEnd not received within 1s');
            setResult('result-transend', false, 'Event not received');
          }
        }, 1000);
      }).catch(function (err) {
        logEntry('error', 'Resize rejected: ' + JSON.stringify(err));
        setResult('result-transend', false, (err && err.message) || String(err));
      });
    };

    window.testConstraintsShape = function testConstraintsShape() {
      logEntry('action', 'Query constraints and verify payload has flat fields (not nested)');
      if (typeof SHARC.getPlacementConstraints !== 'function') {
        setResult('result-shape', false, 'API not available');
        return;
      }
      SHARC.getPlacementConstraints().then(function (constraints) {
        logEntry('info', 'Raw constraints: ' + JSON.stringify(constraints));
        // Verify flat fields exist (not nested under a 'constraints' key)
        var hasFlat = Object.hasOwn(constraints, 'allowedIntents') ||
                      Object.hasOwn(constraints, 'maxWidth') ||
                      Object.hasOwn(constraints, 'allowOffscreen');
        var hasNested = Object.hasOwn(constraints, 'constraints');
        if (hasFlat && !hasNested) {
          logEntry('ok', 'Payload uses flat fields (correct)');
          setResult('result-shape', true, 'Flat fields confirmed');
        } else if (hasNested) {
          logEntry('error', 'Payload uses nested constraints key (incorrect)');
          setResult('result-shape', false, 'Nested shape detected');
        } else {
          logEntry('error', 'Payload has neither flat nor nested fields');
          setResult('result-shape', false, 'Empty payload');
        }
      }).catch(function (err) {
        logEntry('error', 'Constraints query failed: ' + JSON.stringify(err));
        setResult('result-shape', false, (err && err.message) || String(err));
      });
    };

    window.testResizeSmaller = function testResizeSmaller() {
      logEntry('action', 'requestPlacementChange({ intent: "resize", 320x100 })');
      SHARC.requestPlacementChange({
        intent: 'resize',
        targetDimensions: { width: 320, height: 100 }
      }).then(function (result) {
        logEntry('ok', 'resize-smaller resolved: ' + JSON.stringify(result));
        var passed = true;
        if (result && result.width) {
          passed = (result.width === 320 && result.height === 100);
        }
        setResult('result-resize-smaller', passed, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'resize-smaller rejected: ' + JSON.stringify(err));
        setResult('result-resize-smaller', false, (err && err.message) || String(err));
      });
    };

    window.testFullscreen = function testFullscreen() {
      logEntry('action', 'requestPlacementChange({ intent: "fullscreen" })');
      SHARC.requestPlacementChange({
        intent: 'fullscreen'
      }).then(function (result) {
        logEntry('ok', 'fullscreen resolved: ' + JSON.stringify(result));
        setResult('result-fullscreen', true, JSON.stringify(result));
        updateDisplay(result);
      }).catch(function (err) {
        logEntry('error', 'fullscreen rejected: ' + JSON.stringify(err));
        setResult('result-fullscreen', false, (err && err.message) || String(err));
      });
    };

    window.testRequestNavigation = function testRequestNavigation() {
      logEntry('action', 'requestNavigation({ url: "https://iabtechlab.com" })');
      SHARC.requestNavigation({ url: 'https://iabtechlab.com' }).then(function (result) {
        logEntry('ok', 'navigation resolved: ' + JSON.stringify(result));
        setResult('result-navigate', true, JSON.stringify(result));
      }).catch(function (err) {
        logEntry('error', 'navigation rejected: ' + JSON.stringify(err));
        setResult('result-navigate', false, (err && err.message) || String(err));
      });
    };

    logEntry('info', 'Placement test creative initialized.');
  }

  // Wrapper path: expose init callback
  window.__SHARC_TEST_placementCreativeInit = initPlacementCreative;

  // Self-boot path: if SHARC API is already on window, init immediately
  if (typeof window.SHARC !== 'undefined' && typeof window.SHARC.onReady === 'function') {
    initPlacementCreative();
  }

}());
