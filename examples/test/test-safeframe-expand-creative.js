// WARNING: __SHARC_TEST_sfCreativeInit is a SHARC test harness convention.
// Real SafeFrame creatives do NOT use this pattern. See CREATIVE-AUTHORING.md.
'use strict';

window.__SHARC_TEST_sfCreativeInit = function init() {

  /* -- Logging helpers --------------------------------------------- */
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

  /* -- Config readers ---------------------------------------------- */
  function getExpandOffsets() {
    return {
      t: parseInt(document.getElementById('cfg-t').value, 10) || 0,
      l: parseInt(document.getElementById('cfg-l').value, 10) || 0,
      r: parseInt(document.getElementById('cfg-r').value, 10) || 0,
      b: parseInt(document.getElementById('cfg-b').value, 10) || 0
    };
  }

  /* -- State display update ---------------------------------------- */
  function updateDisplay() {
    var sf = window.$sf;
    if (!sf || !sf.ext) return;

    var statusEl = document.getElementById('disp-status');
    var status = sf.ext.status();
    statusEl.textContent = status;
    statusEl.className = 'state-value ' +
      (status === 'expanded' ? 'ok' :
       status === 'collapsed' ? '' : 'warn');

    var ivEl = document.getElementById('disp-inview');
    var iv = sf.ext.inViewPercentage();
    ivEl.textContent = iv + '%';
    ivEl.className = 'state-value ' + (iv > 0 ? 'ok' : 'warn');

    var focusEl = document.getElementById('disp-focus');
    var focus = sf.ext.winHasFocus();
    focusEl.textContent = String(focus);
    focusEl.className = 'state-value ' + (focus ? 'ok' : '');

    var geomObj = sf.ext.geom();
    if (geomObj && geomObj.self) {
      document.getElementById('disp-geom-self').textContent =
        'w:' + geomObj.self.w + ' h:' + geomObj.self.h +
        ' iv:' + (geomObj.self.iv !== undefined ? geomObj.self.iv.toFixed(2) : '?');
    }
  }

  /* -- SafeFrame callback ------------------------------------------ */
  function onSafeFrameEvent(status, data) {
    switch (status) {
      case 'geom-update':
        logEntry('geom', 'geom-update -- iv:' +
          (data && data.self ? data.self.iv.toFixed(2) : '?') +
          ' w:' + (data && data.self ? data.self.w : '?') +
          ' h:' + (data && data.self ? data.self.h : '?'));
        break;
      case 'expanded':
        logEntry('ok', 'expanded -- w:' +
          (data && data.info ? data.info.w : '?') +
          ' h:' + (data && data.info ? data.info.h : '?') +
          ' push:' + (data && data.info ? data.info.push : '?'));
        break;
      case 'collapsed':
        logEntry('ok', 'collapsed');
        break;
      case 'failed':
        logEntry('error', 'failed -- reason:' +
          (data && data.reason ? data.reason : 'unknown'));
        break;
      case 'focus-change':
        logEntry('focus', 'focus-change -- focus:' +
          (data && data.focus !== undefined ? data.focus : '?'));
        break;
      default:
        logEntry('info', 'callback: ' + status + ' -- ' + JSON.stringify(data));
    }
    updateDisplay();
  }

  /* -- Test actions ------------------------------------------------ */

  window.testExpandOverlay = function testExpandOverlay() {
    var sf = window.$sf;
    if (!sf) return;
    var offsets = getExpandOffsets();
    var args = { t: offsets.t, l: offsets.l, r: offsets.r, b: offsets.b, push: false };
    logEntry('action', '$sf.ext.expand(' + JSON.stringify(args) + ')');
    sf.ext.expand(args);
  };

  window.testExpandPush = function testExpandPush() {
    var sf = window.$sf;
    if (!sf) return;
    var offsets = getExpandOffsets();
    var args = { t: offsets.t, l: offsets.l, r: offsets.r, b: offsets.b, push: true };
    logEntry('action', '$sf.ext.expand(' + JSON.stringify(args) + ') -- expects failed callback');
    sf.ext.expand(args);
  };

  window.testExpandNoOffsets = function testExpandNoOffsets() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '$sf.ext.expand({}) -- maximize (no directional offsets)');
    sf.ext.expand({});
  };

  window.testCollapse = function testCollapse() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '$sf.ext.collapse()');
    sf.ext.collapse();
  };

  window.testStatus = function testStatus() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('info', '  $sf.ext.status() = "' + sf.ext.status() + '"');
  };

  window.testGeom = function testGeom() {
    var sf = window.$sf;
    if (!sf) return;
    var g = sf.ext.geom();
    logEntry('info', '  geom().win  = ' + JSON.stringify(g.win));
    logEntry('info', '  geom().self = ' + JSON.stringify(g.self));
    logEntry('info', '  geom().exp  = ' + JSON.stringify(g.exp));
  };

  /* -- Bootstrap --------------------------------------------------- */
  (function bootstrap() {
    var sf = window.$sf;

    if (!sf || !sf.ext) {
      logEntry('error', 'window.$sf not found. Load via safeframe-wrapper.html');
      document.getElementById('no-sf').style.display = 'block';
      return;
    }

    logEntry('ok', '$sf found -- specVersion: "' + (sf.specVersion || '?') + '"');
    logEntry('info', '  $sf.ext.supports() = ' + JSON.stringify(sf.ext.supports()));
    logEntry('info', '  $sf.ext.status()   = "' + sf.ext.status() + '"');

    sf.ext.register(300, 250, onSafeFrameEvent);
    logEntry('info', '  $sf.ext.register(300, 250, cb) called -- waiting for geom-update...');

    updateDisplay();
  }());
};
