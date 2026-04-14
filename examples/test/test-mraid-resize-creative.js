// WARNING: __SHARC_TEST_mraidCreativeInit is a SHARC test harness convention.
// Real MRAID creatives do NOT use this pattern. See CREATIVE-AUTHORING.md.
'use strict';

window.__SHARC_TEST_mraidCreativeInit = function init() {

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

    window.clearLog = function clearLog() {
      logEl.innerHTML = '';
      logEntry('info', 'Log cleared.');
    };

    /* -- Config readers -------------------------------------------- */
    function getResizeConfig() {
      return {
        width:               parseInt(document.getElementById('cfg-width').value, 10) || 320,
        height:              parseInt(document.getElementById('cfg-height').value, 10) || 480,
        offsetX:             parseInt(document.getElementById('cfg-offsetX').value, 10) || 0,
        offsetY:             parseInt(document.getElementById('cfg-offsetY').value, 10) || 0,
        customClosePosition: document.getElementById('cfg-closePos').value,
        allowOffscreen:      document.getElementById('cfg-offscreen').checked
      };
    }

    /* -- State display update -------------------------------------- */
    function updateDisplay() {
      if (typeof window.mraid === 'undefined') return;
      var m = window.mraid;

      var stateEl = document.getElementById('disp-state');
      var state = m.getState();
      stateEl.textContent = state;
      stateEl.className = 'state-value ' +
        (state === 'default' ? 'ok' :
         state === 'resized' ? 'warn' :
         state === 'expanded' ? 'warn' : '');

      var viewableEl = document.getElementById('disp-viewable');
      viewableEl.textContent = String(m.isViewable());
      viewableEl.className = 'state-value ' + (m.isViewable() ? 'ok' : 'warn');

      var curPos = m.getCurrentPosition();
      document.getElementById('disp-curpos').textContent =
        curPos.width + 'x' + curPos.height + ' @' + curPos.x + ',' + curPos.y;

      var maxSize = m.getMaxSize();
      document.getElementById('disp-maxsize').textContent =
        maxSize.width + 'x' + maxSize.height;
    }

    /* -- MRAID event handlers -------------------------------------- */
    function onMraidReady() {
      logEntry('ok', 'ready event fired');
      logEntry('info', '  getState()         = ' + mraid.getState());
      logEntry('info', '  getPlacementType() = ' + mraid.getPlacementType());
      logEntry('info', '  getMaxSize()       = ' + JSON.stringify(mraid.getMaxSize()));
      logEntry('info', '  getCurrentPosition()= ' + JSON.stringify(mraid.getCurrentPosition()));
      logEntry('info', '  getResizeProperties()= ' + JSON.stringify(mraid.getResizeProperties()));
      updateDisplay();
    }

    function onStateChange(state) {
      logEntry('event', 'stateChange("' + state + '")');
      updateDisplay();
    }

    function onSizeChange(w, h) {
      logEntry('event', 'sizeChange(' + w + ', ' + h + ')');
      updateDisplay();
    }

    function onError(message, action) {
      logEntry('error', 'error("' + message + '", "' + action + '")');
    }

    function onViewableChange(viewable) {
      logEntry('event', 'viewableChange(' + viewable + ')');
      updateDisplay();
    }

    /* -- Test actions ---------------------------------------------- */

    window.testSetResizeProps = function testSetResizeProps() {
      var cfg = getResizeConfig();
      logEntry('action', 'mraid.setResizeProperties(' + JSON.stringify(cfg) + ')');
      mraid.setResizeProperties(cfg);
      logEntry('info', '  getResizeProperties() = ' + JSON.stringify(mraid.getResizeProperties()));
    };

    window.testResize = function testResize() {
      logEntry('action', 'mraid.resize()');
      mraid.resize();
    };

    window.testClose = function testClose() {
      logEntry('action', 'mraid.close() -- should collapse from resized/expanded to default');
      mraid.close();
    };

    window.testCollapse = function testCollapse() {
      logEntry('action', 'mraid.collapse()');
      mraid.collapse();
    };

    window.testExpandThenResize = function testExpandThenResize() {
      logEntry('action', 'mraid.expand() then mraid.resize() -- resize should error from expanded');
      mraid.expand();
      // Wait for expand to complete, then try resize
      var listener = function (state) {
        if (state === 'expanded') {
          mraid.removeEventListener('stateChange', listener);
          logEntry('action', 'Now in expanded state -- calling mraid.resize()');
          var cfg = getResizeConfig();
          mraid.setResizeProperties(cfg);
          mraid.resize();
        }
      };
      mraid.addEventListener('stateChange', listener);
    };

    window.testResizeNoProps = function testResizeNoProps() {
      logEntry('action', 'mraid.resize() without setResizeProperties -- should error');
      // Reset resize props by creating fresh bridge state (not possible externally).
      // Instead just call resize directly; the bridge tracks whether setResizeProperties
      // was called with valid dimensions.
      mraid.resize();
    };

    /* -- Bootstrap ------------------------------------------------- */
    (function bootstrap() {
      var m = window.mraid;

      if (!m) {
        logEntry('error', 'window.mraid not found. Load via mraid-wrapper.html');
        document.getElementById('no-mraid').style.display = 'block';
        return;
      }

      mraid.addEventListener('ready', onMraidReady);
      mraid.addEventListener('stateChange', onStateChange);
      mraid.addEventListener('sizeChange', onSizeChange);
      mraid.addEventListener('viewableChange', onViewableChange);
      mraid.addEventListener('error', onError);

      logEntry('info', 'mraid object found. getState() = "' + mraid.getState() + '"');

      if (mraid.getState() === 'loading') {
        logEntry('info', 'State is "loading" -- waiting for ready event...');
      } else {
        logEntry('ok', 'State is "' + mraid.getState() + '" -- calling onMraidReady directly');
        onMraidReady();
      }

      updateDisplay();
    }());
};
