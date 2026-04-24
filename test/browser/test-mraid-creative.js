// WARNING: __SHARC_TEST_mraidCreativeInit is a SHARC test harness convention.
// Real MRAID creatives do NOT use this pattern. See CREATIVE-AUTHORING.md.
'use strict';

// Expose __SHARC_TEST_mraidCreativeInit so mraid-wrapper.html can call it after
// injecting the DOM and loading this script. This replaces the requestAnimationFrame
// polling workaround — the wrapper guarantees DOM is ready before calling us.
window.__SHARC_TEST_mraidCreativeInit = function init() {

    /* ── Logging helpers ─────────────────────────────────────── */
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

    // Expose clearLog globally so inline onclick="clearLog()" buttons work
    window.clearLog = function clearLog() {
      logEl.innerHTML = '';
      logEntry('info', 'Log cleared.');
    };

    /* ── State display update ────────────────────────────────── */
    function updateDisplay() {
      if (typeof window.mraid === 'undefined') return;
      var m = window.mraid;
      var stateEl = document.getElementById('disp-state');
      var state = m.getState();
      stateEl.textContent = state;
      stateEl.className = 'state-value ' + (state === 'default' || state === 'expanded' ? 'ok' : state === 'hidden' ? 'warn' : '');

      var viewableEl = document.getElementById('disp-viewable');
      var viewable = m.isViewable();
      viewableEl.textContent = String(viewable);
      viewableEl.className = 'state-value ' + (viewable ? 'ok' : 'warn');

      document.getElementById('disp-placement').textContent = m.getPlacementType();
      document.getElementById('disp-version').textContent = m.getVersion();
      document.getElementById('disp-muted').textContent = String(m.isAudioMuted());
    }

    /* ── MRAID event handlers ────────────────────────────────── */
    function onMraidReady() {
      logEntry('ok', '✓ ready event fired');
      logEntry('info', '  getVersion()       = ' + mraid.getVersion());
      logEntry('info', '  getState()         = ' + mraid.getState());
      logEntry('info', '  isViewable()       = ' + mraid.isViewable());
      logEntry('info', '  getPlacementType() = ' + mraid.getPlacementType());
      logEntry('info', '  isAudioMuted()     = ' + mraid.isAudioMuted());

      var defPos = mraid.getDefaultPosition();
      logEntry('info', '  getDefaultPosition() = ' + JSON.stringify(defPos));
      var maxSize = mraid.getMaxSize();
      logEntry('info', '  getMaxSize()         = ' + JSON.stringify(maxSize));
      var scrSize = mraid.getScreenSize();
      logEntry('info', '  getScreenSize()      = ' + JSON.stringify(scrSize));

      updateDisplay();
    }

    function onStateChange(state) {
      logEntry('event', '▶ stateChange("' + state + '")');
      updateDisplay();
    }

    function onViewableChange(viewable) {
      logEntry('event', '👁 viewableChange(' + viewable + ')');
      updateDisplay();
    }

    function onSizeChange(w, h) {
      logEntry('event', '📐 sizeChange(' + w + ', ' + h + ')');
      updateDisplay();
    }

    function onError(message, action) {
      logEntry('error', '⚠ error("' + message + '", "' + action + '")');
    }

    function onUnload() {
      logEntry('event', '💀 unload event fired');
    }

    /* ── Test action functions (exposed globally for onclick= buttons) ── */
    window.testExpand = function testExpand() {
      logEntry('action', 'mraid.expand() →');
      mraid.expand();
    };

    window.testCollapse = function testCollapse() {
      logEntry('action', 'mraid.collapse() →');
      mraid.collapse();
    };

    window.testClose = function testClose() {
      logEntry('action', 'mraid.close() →');
      mraid.close();
    };

    window.testOpen = function testOpen() {
      logEntry('action', 'mraid.open("https://iabtechlab.com") →');
      mraid.open('https://iabtechlab.com');
    };

    window.testSupports = function testSupports() {
      var features = ['sms', 'tel', 'calendar', 'storePicture', 'inlineVideo', 'vpaid', 'location'];
      features.forEach(function (f) {
        logEntry('info', '  supports("' + f + '") = ' + mraid.supports(f));
      });
    };

    window.testStorePicture = function testStorePicture() {
      logEntry('action', 'mraid.storePicture("...") → (should fire error)');
      mraid.storePicture('https://example.com/pic.jpg');
    };

    window.testResize = function testResize() {
      logEntry('action', 'mraid.resize() → (interstitial: should fire error)');
      mraid.setResizeProperties({ width: 320, height: 200, offsetX: 0, offsetY: 0 });
      mraid.resize();
    };

    window.testExpandUrl = function testExpandUrl() {
      logEntry('action', 'mraid.expand("https://...") → (not supported; should fire error)');
      mraid.expand('https://example.com/expanded.html');
    };

    /* ── CTA click ───────────────────────────────────────────── */
    document.getElementById('cta-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      logEntry('action', 'CTA clicked → mraid.open("https://iabtechlab.com")');
      if (window.mraid) {
        mraid.open('https://iabtechlab.com');
      }
    });

    document.getElementById('ad-banner').addEventListener('click', function () {
      logEntry('action', 'Banner clicked → mraid.expand()');
      if (window.mraid && mraid.getState() === 'default') {
        mraid.expand();
      }
    });

    /* ── Bootstrap — standard MRAID defensive pattern ────────── */
    (function bootstrap() {
      // Check if mraid is available (loaded via mraid-wrapper.html).
      // Note: do NOT try window.parent.mraid — both frames are sandboxed
      // without allow-same-origin, so cross-frame access throws SecurityError.
      // mraid-wrapper.html injects window.mraid into this frame's scope directly.
      var m = window.mraid;

      if (!m) {
        logEntry('error', 'window.mraid not found. Load via mraid-wrapper.html');
        document.getElementById('no-mraid').style.display = 'block';
        return;
      }

      // Alias for convenience (global mraid var, standard pattern)
      window.mraid = m; // ensure it's on this window

      // Register all event listeners BEFORE the state check
      mraid.addEventListener('ready', onMraidReady);
      mraid.addEventListener('stateChange', onStateChange);
      mraid.addEventListener('viewableChange', onViewableChange);
      mraid.addEventListener('sizeChange', onSizeChange);
      mraid.addEventListener('error', onError);
      mraid.addEventListener('unload', onUnload);

      logEntry('info', 'mraid object found. getState() = "' + mraid.getState() + '"');

      // Standard MRAID defensive pattern (§4 Bootstrap)
      if (mraid.getState() === 'loading') {
        logEntry('info', 'State is "loading" — waiting for ready event...');
      } else {
        // Race condition path: init already completed
        logEntry('ok', 'State is "' + mraid.getState() + '" — calling onMraidReady directly');
        onMraidReady();
      }

      updateDisplay();
    }());
};
