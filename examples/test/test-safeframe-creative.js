'use strict';

// Expose __sfCreativeInit so safeframe-wrapper.html can call it after injecting
// the DOM and loading this script. This replaces inline script execution —
// the wrapper guarantees DOM is ready and window.$sf is set before calling us.
//
// IMPORTANT: Do NOT access window.parent.$sf here.
// Both this frame and the wrapper are sandboxed with allow-scripts only
// (no allow-same-origin). Cross-frame access throws SecurityError.
// window.$sf is injected directly into this document's scope by the wrapper.
window.__sfCreativeInit = function init() {

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
    var sf = window.$sf;
    if (!sf || !sf.ext) return;

    var statusEl = document.getElementById('disp-status');
    var status   = sf.ext.status();
    statusEl.textContent = status;
    statusEl.className   = 'state-value ' + (status === 'expanded' ? 'ok' : status === 'collapsed' ? '' : 'warn');

    var ivEl = document.getElementById('disp-inview');
    var iv   = sf.ext.inViewPercentage();
    ivEl.textContent = iv + '%';
    ivEl.className   = 'state-value ' + (iv > 0 ? 'ok' : 'warn');

    var focusEl = document.getElementById('disp-focus');
    var focus   = sf.ext.winHasFocus();
    focusEl.textContent = String(focus);
    focusEl.className   = 'state-value ' + (focus ? 'ok' : '');

    var geomObj = sf.ext.geom();
    var ivRatio = geomObj && geomObj.self && geomObj.self.iv !== undefined ? geomObj.self.iv : '—';
    document.getElementById('disp-iv').textContent = typeof ivRatio === 'number' ? ivRatio.toFixed(2) : ivRatio;

    document.getElementById('disp-spec').textContent = window.$sf && window.$sf.specVersion ? window.$sf.specVersion : '—';
  }

  /* ── SafeFrame callback ──────────────────────────────────── */
  function onSafeFrameEvent(status, data) {
    switch (status) {
      case 'geom-update':
        logEntry('geom', '📐 geom-update — iv:' + (data && data.self ? data.self.iv.toFixed(2) : '?') +
          ' w:' + (data && data.self ? data.self.w : '?') +
          ' h:' + (data && data.self ? data.self.h : '?'));
        break;
      case 'expanded':
        logEntry('ok', '✓ expanded — w:' + (data && data.info ? data.info.w : '?') +
          ' h:' + (data && data.info ? data.info.h : '?') +
          ' push:' + (data && data.info ? data.info.push : '?'));
        break;
      case 'collapsed':
        logEntry('ok', '✓ collapsed');
        break;
      case 'failed':
        logEntry('error', '✗ failed — reason:' + (data && data.reason ? data.reason : 'unknown'));
        break;
      case 'focus-change':
        logEntry('focus', '🔦 focus-change — focus:' + (data && data.focus !== undefined ? data.focus : '?'));
        break;
      default:
        logEntry('info', 'callback: ' + status + ' — ' + JSON.stringify(data));
    }
    updateDisplay();
  }

  /* ── Test action functions (exposed globally for onclick= buttons) ── */
  window.testExpand = function testExpand() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '→ $sf.ext.expand({})');
    sf.ext.expand({});
  };

  window.testExpandPush = function testExpandPush() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '→ $sf.ext.expand({ push: true }) — expects failed callback');
    sf.ext.expand({ push: true });
  };

  window.testCollapse = function testCollapse() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '→ $sf.ext.collapse()');
    sf.ext.collapse();
  };

  window.testStatus = function testStatus() {
    var sf = window.$sf;
    if (!sf) return;
    var s = sf.ext.status();
    logEntry('info', '  $sf.ext.status() = "' + s + '"');
  };

  window.testGeom = function testGeom() {
    var sf = window.$sf;
    if (!sf) return;
    var g = sf.ext.geom();
    logEntry('info', '  geom().win  = ' + JSON.stringify(g.win));
    logEntry('info', '  geom().self = ' + JSON.stringify(g.self));
    logEntry('info', '  geom().exp  = ' + JSON.stringify(g.exp));
  };

  window.testSupports = function testSupports() {
    var sf = window.$sf;
    if (!sf) return;
    var s = sf.ext.supports();
    logEntry('info', '  $sf.ext.supports() = ' + JSON.stringify(s));
  };

  window.testInView = function testInView() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('info', '  $sf.ext.inViewPercentage() = ' + sf.ext.inViewPercentage());
  };

  window.testWinFocus = function testWinFocus() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('info', '  $sf.ext.winHasFocus() = ' + sf.ext.winHasFocus());
  };

  window.testMeta = function testMeta() {
    var sf = window.$sf;
    if (!sf) return;
    var dealId = sf.ext.meta('deal-id');
    var pos    = sf.ext.meta('pos');
    var owned  = sf.ext.meta('campaign', 'advertiser.com');
    logEntry('info', '  meta("deal-id")                    = ' + JSON.stringify(dealId));
    logEntry('info', '  meta("pos")                        = ' + JSON.stringify(pos));
    logEntry('info', '  meta("campaign", "advertiser.com") = ' + JSON.stringify(owned));
  };

  window.testCookie = function testCookie() {
    var sf = window.$sf;
    if (!sf) return;
    logEntry('action', '→ $sf.ext.cookie("__test") — expects failed callback');
    sf.ext.cookie('__test');
  };

  /* ── CTA and banner click handlers ──────────────────────── */
  document.getElementById('cta-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    logEntry('action', 'CTA clicked → $sf.ext.expand({})');
    var sf = window.$sf;
    if (sf && sf.ext.status() === 'collapsed') {
      sf.ext.expand({});
    } else if (sf && sf.ext.status() === 'expanded') {
      sf.ext.collapse();
    }
  });

  document.getElementById('ad-banner').addEventListener('click', function () {
    var sf = window.$sf;
    if (!sf) return;
    if (sf.ext.status() === 'collapsed') {
      logEntry('action', 'Banner clicked → $sf.ext.expand({})');
      sf.ext.expand({});
    }
  });

  /* ── Bootstrap — standard SafeFrame defensive pattern ────── */
  (function bootstrap() {
    // Use window.$sf only — injected by safeframe-wrapper.html before this
    // script runs. Do NOT try window.parent.$sf: both frames are sandboxed
    // without allow-same-origin, so cross-frame access throws SecurityError.
    var sf = window.$sf;

    if (!sf || !sf.ext) {
      logEntry('error', 'window.$sf not found. Load via safeframe-wrapper.html');
      document.getElementById('no-sf').style.display = 'block';
      return;
    }

    logEntry('ok', '✓ $sf found — specVersion: "' + (sf.specVersion || '?') + '"');
    logEntry('info', '  $sf.ext.supports() = ' + JSON.stringify(sf.ext.supports()));
    logEntry('info', '  $sf.ext.status()   = "' + sf.ext.status() + '"');

    // Register: standard SafeFrame pattern — declare initial size + callback
    // This does NOT immediately fire the callback (design doc §6.1)
    sf.ext.register(300, 250, onSafeFrameEvent);
    logEntry('info', '  $sf.ext.register(300, 250, cb) called — waiting for geom-update...');

    updateDisplay();
  }());
};
