/**
 * bridge-harness.js — shared runtime for MRAID and SafeFrame bridge test harnesses.
 *
 * Each harness must set window.HARNESS_CONFIG BEFORE loading this script:
 *
 *   window.HARNESS_CONFIG = {
 *     bridgeName:      'MRAID',                         // label in logs / title
 *     featureName:     'com.iabtechlab.sharc.mraid',    // supportedFeatures entry
 *     wrapperRelPath:  '../../examples/mraid-wrapper.html', // bridge wrapper URL
 *     adIdPrefix:      'mraid-test',                    // builds ad.id + placement.tagid
 *     getInterstitialSize: function () {                // hook: return {w, h, note}
 *       return { w: 390, h: 844, note: '390×844 (iPhone 14 viewport)' };
 *     },
 *     enrichEnvData: function (envData, ctx) {          // hook: tweak envData
 *       // ctx = { adWidth, adHeight, instlMode }
 *       return envData; // default: no-op
 *     },
 *   };
 *
 * Optional: the harness may define window.harnessAudioState for MRAID-style
 * mute/volume; if present, its { isMuted, volumePct } values are mixed into
 * environmentData on load.
 */
'use strict';

(function () {
  var cfg = window.HARNESS_CONFIG;
  if (!cfg) {
    console.error('[bridge-harness] window.HARNESS_CONFIG must be set before loading bridge-harness.js');
    return;
  }

  /* ── Ad size / placement state ──────────────────────────────── */
  var adWidth     = 300;
  var adHeight    = 250;
  var instlMode   = 0;      // 0 = inline, 1 = interstitial
  var prevInlineW = 300;    // remembered inline size before interstitial
  var prevInlineH = 250;

  /* ── Container reference ─────────────────────────────────────── */
  var sharcContainer = null;

  /* ── Logging ─────────────────────────────────────────────────── */
  var _logEl = null;
  var autoScroll = true;
  function logEl() {
    if (!_logEl) _logEl = document.getElementById('protocol-log');
    return _logEl;
  }

  function ts() {
    var d = new Date();
    return [
      String(d.getHours()).padStart(2, '0'), ':',
      String(d.getMinutes()).padStart(2, '0'), ':',
      String(d.getSeconds()).padStart(2, '0'), '.',
      String(d.getMilliseconds()).padStart(3, '0'),
    ].join('');
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function logMsg(dir, type, args) {
    var el = logEl();
    var empty = el.querySelector('.log-empty');
    if (empty) empty.remove();

    var dirLabels = {
      cntr: '▼ CNTR',
      crtv: '▲ CRTV',
      sys:  'SYS',
      ok:   '✓ OK',
      err:  '✗ ERR',
    };

    var argsStr = '';
    if (args && typeof args === 'object' && Object.keys(args).length > 0) {
      try {
        argsStr = JSON.stringify(args, null, 2);
        if (argsStr.length > 400) argsStr = argsStr.slice(0, 400) + '\n  ...';
      } catch (e) { argsStr = String(args); }
    } else if (typeof args === 'string' && args) {
      argsStr = args;
    }

    var entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML =
      '<div class="log-ts">' + ts() + '</div>' +
      '<div class="log-dir ' + dir + '">' + (dirLabels[dir] || dir) + '</div>' +
      '<div class="log-body">' +
        '<div class="log-type ' + dir + '">' + escHtml(String(type)) + '</div>' +
        (argsStr ? '<div class="log-args">' + escHtml(argsStr) + '</div>' : '') +
      '</div>';
    el.appendChild(entry);
    if (autoScroll) el.scrollTop = el.scrollHeight;
  }

  function logSep(text) {
    var el = logEl();
    var empty = el.querySelector('.log-empty');
    if (empty) empty.remove();
    var sep = document.createElement('div');
    sep.className = 'log-sep';
    sep.textContent = '─── ' + text + ' ───';
    el.appendChild(sep);
    if (autoScroll) el.scrollTop = el.scrollHeight;
  }

  function logSys(text) { logMsg('sys', text, null); }
  function logOk(text)  { logMsg('ok',  text, null); }
  function logErr(text) { logMsg('err', text, null); }

  function clearLog() {
    logEl().innerHTML = '<div class="log-empty">Log cleared</div>';
  }

  /* ── State display ───────────────────────────────────────────── */
  function updateState(state) {
    var el = document.getElementById('disp-sharc-state');
    el.textContent = state || '—';
    el.className = state ? 'state-val ' + state : 'state-val';
  }

  function setLoaded(loaded) {
    document.getElementById('btn-load').disabled  = loaded;
    document.getElementById('btn-close').disabled = !loaded;
    var ids = [
      'sim-active', 'sim-passive', 'sim-hidden', 'sim-frozen',
      'sim-active2', 'sim-hidden2', 'btn-placement', 'btn-log',
    ];
    if (Array.isArray(cfg.extraDisabledIds)) {
      ids = ids.concat(cfg.extraDisabledIds);
    }
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !loaded;
    });
  }

  /* ── Loading overlay ────────────────────────────────────────── */
  function showLoadingOverlay() {
    var el = document.getElementById('ad-loading-overlay');
    if (el) el.classList.add('visible');
  }
  function hideLoadingOverlay() {
    var el = document.getElementById('ad-loading-overlay');
    if (el) el.classList.remove('visible');
  }

  /* ── Ad size / placement helpers ────────────────────────────── */
  function parsePreset(val) {
    var parts = val.split('x');
    return { w: parseInt(parts[0], 10), h: parseInt(parts[1], 10) };
  }

  function applySize(w, h) {
    adWidth  = w;
    adHeight = h;
    updateAdSlotDimensions(w, h);
    logSys('Ad size set to ' + w + '\xd7' + h);
    if (sharcContainer) reinitAd();
  }

  function updateAdSlotDimensions(w, h) {
    var slot = document.getElementById('adSlot');
    if (slot) {
      slot.style.width  = w + 'px';
      slot.style.height = h + 'px';
    }
    var label = document.getElementById('ad-slot-label');
    if (label) label.textContent = 'Ad Slot — ' + w + '\xd7' + h;
  }

  function onSizePresetChange() {
    var sel = document.getElementById('size-preset');
    var val = sel.value;
    var customRow = document.getElementById('custom-size-row');
    if (val === 'custom') {
      customRow.style.display = 'flex';
      return;
    }
    customRow.style.display = 'none';
    var dim = parsePreset(val);
    applySize(dim.w, dim.h);
  }

  function applyCustomSize() {
    var w = parseInt(document.getElementById('custom-w').value, 10);
    var h = parseInt(document.getElementById('custom-h').value, 10);
    if (!w || !h || w < 1 || h < 1) { logErr('Invalid custom size'); return; }
    applySize(w, h);
  }

  function setInstl(mode) {
    instlMode = mode;
    var btnInline  = document.getElementById('btn-instl-inline');
    var btnInstl   = document.getElementById('btn-instl-interstitial');
    var sizeSelect = document.getElementById('size-preset');
    var customRow  = document.getElementById('custom-size-row');

    if (mode === 1) {
      prevInlineW = adWidth;
      prevInlineH = adHeight;
      btnInline.classList.remove('active');
      btnInstl.classList.add('active');
      sizeSelect.disabled = true;
      customRow.style.display = 'none';

      var dims = typeof cfg.getInterstitialSize === 'function'
        ? cfg.getInterstitialSize()
        : { w: 390, h: 844, note: '390\xd7844' };
      var note = dims.note || (dims.w + '\xd7' + dims.h);

      // Clamp to available ad-slot-outer space so the iframe doesn't paint
      // past its dashed container into the log panel. Preserve aspect ratio.
      var outer = document.querySelector('.ad-slot-outer');
      if (outer) {
        var maxW = outer.clientWidth || dims.w;
        var maxH = Math.max(window.innerHeight - outer.getBoundingClientRect().top - 16, 200);
        if (dims.w > maxW || dims.h > maxH) {
          var scale = Math.min(maxW / dims.w, maxH / dims.h);
          dims.w = Math.floor(dims.w * scale);
          dims.h = Math.floor(dims.h * scale);
          note = note + ' → fit ' + dims.w + '\xd7' + dims.h;
        }
      }

      logSys('Interstitial mode: forcing size to ' + note);
      applySize(dims.w, dims.h);
    } else {
      btnInstl.classList.remove('active');
      btnInline.classList.add('active');
      sizeSelect.disabled = false;
      logSys('Inline mode: restoring size to ' + prevInlineW + '\xd7' + prevInlineH);
      applySize(prevInlineW, prevInlineH);
    }
  }

  function reinitAd() {
    logSep('Re-initializing container with new settings');
    if (sharcContainer) {
      try {
        if (typeof sharcContainer._terminate === 'function') {
          sharcContainer._terminate();
        } else {
          var slot = document.getElementById('adSlot');
          var oldIframe = slot && slot.querySelector('iframe');
          if (oldIframe) oldIframe.parentNode.removeChild(oldIframe);
          sharcContainer = null;
        }
      } catch (e) {
        logErr('Teardown error: ' + e.message);
      }
      sharcContainer = null;
      setLoaded(false);
      updateState(null);
      document.getElementById('disp-session').textContent = '—';
    }
    setTimeout(function () { loadAd(); }, 50);
  }

  /* ── Load Ad ─────────────────────────────────────────────────── */
  function loadAd() {
    if (sharcContainer) return;

    updateAdSlotDimensions(adWidth, adHeight);

    logSep('Starting SHARC ' + cfg.bridgeName + ' session');
    logSys('Constructing SHARCContainer...');
    var selectedCreative = document.getElementById('creative-select').value;
    var wrapperLabel = cfg.wrapperRelPath.replace(/^.*\//, '');
    logSys('Creative: ' + wrapperLabel + '?creative=' + selectedCreative);
    logSys('Size: ' + adWidth + '\xd7' + adHeight + ', instl: ' + instlMode +
           ' (' + (instlMode ? 'interstitial' : 'inline') + ')');
    showLoadingOverlay();

    var containerEl = document.getElementById('adSlot');
    var creativeUrl = cfg.wrapperRelPath + '?creative=' + encodeURIComponent(selectedCreative);

    var audio = window.harnessAudioState || { isMuted: false, volumePct: 100 };

    var environmentData = {
      currentPlacement: {
        initialDefaultSize: { width: adWidth, height: adHeight },
        minDefaultSize:     { width: adWidth, height: adHeight },
        maxDefaultSize:     { width: adWidth, height: adHeight },
        maxExpandSize:      { width: window.innerWidth, height: window.innerHeight },
        viewportSize:       { width: window.innerWidth, height: window.innerHeight },
      },
      dataspec: { model: 'AdCOM', ver: '1.0' },
      data: {
        ad:        { id: cfg.adIdPrefix + '-001' },
        isMuted:   audio.isMuted,
        volume:    audio.volumePct / 100,
        placement: { tagid: cfg.adIdPrefix + '-slot', instl: instlMode },
      },
      containerNavigation: {
        navigationPossible: true,
        navigationAllowed:  true,
      },
      isMuted: audio.isMuted,
      volume:  audio.volumePct / 100,
    };

    if (typeof cfg.enrichEnvData === 'function') {
      environmentData = cfg.enrichEnvData(environmentData, {
        adWidth: adWidth, adHeight: adHeight, instlMode: instlMode,
      }) || environmentData;
    }

    try {
      sharcContainer = new SHARC.Container({
        creativeUrl: creativeUrl,
        containerEl: containerEl,
        environmentData: environmentData,
        supportedFeatures: [
          { name: cfg.featureName, version: '1.0', functions: {} },
        ],
        autoStart: true,
        visible:   false,

        onStateChange: function (newState, prevState) {
          logMsg('sys', 'SHARC state: ' + (prevState || '—') + ' → ' + newState, null);
          updateState(newState);
          if (newState === 'active') hideLoadingOverlay();
        },

        onClose: function () {
          logSep('Container closed');
          logSys('Container terminated; creative removed');
          hideLoadingOverlay();
          sharcContainer = null;
          setLoaded(false);
          updateState(null);
          document.getElementById('disp-session').textContent = '—';
        },

        onError: function (code, message) {
          logErr('Fatal error ' + code + ': ' + message);
          hideLoadingOverlay();
        },

        onNavigation: function (args) {
          logMsg('crtv', 'Creative:requestNavigation', args);
          logSys('Navigation → opening ' + args.url + ' (simulated)');
        },

        onInteraction: function (uris) {
          logMsg('crtv', 'Creative:reportInteraction', { uris: uris });
        },

        onMessage: function (direction, msg) {
          if (!msg) return;
          var type = msg.type || '?';
          var args = msg.args || {};

          if (direction === 'received') {
            var dir = type.indexOf('Container') !== -1 ? 'cntr'
                    : type.indexOf('Creative')  !== -1 ? 'crtv'
                    : type === 'resolve'                ? 'ok'
                    : type === 'reject'                 ? 'err'
                    : 'sys';
            logMsg(dir, type, args);
          } else if (direction === 'sent-resolved') {
            logMsg('ok', type + ' → resolved', msg.resolveValue || null);
          }
        },
      });
    } catch (e) {
      logErr('Failed to create SHARCContainer: ' + e.message);
      logSys('Make sure sharc-container.js is loaded and SHARC.Container is available.');
      logSys('Falling back to plain iframe for visual inspection...');
      createFallbackIframe(creativeUrl, containerEl);
      return;
    }

    if (typeof cfg.onContainerCreated === 'function') {
      cfg.onContainerCreated(sharcContainer);
    }

    setLoaded(true);
    updateState('loading');

    // Show session ID once available (stop after 10 s to avoid a zombie interval)
    var sessionPoll = setInterval(function () {
      if (!sharcContainer) { clearInterval(sessionPoll); return; }
      var sid = sharcContainer._protocol && sharcContainer._protocol.sessionId;
      if (sid) {
        document.getElementById('disp-session').textContent = sid.slice(0, 8) + '…';
        logOk('Session established: ' + sid);
        clearInterval(sessionPoll);
      }
    }, 100);
    setTimeout(function () { clearInterval(sessionPoll); }, 10000);

    if (typeof sharcContainer.load === 'function') {
      sharcContainer.load();
    }
  }

  function createFallbackIframe(url, containerEl) {
    logSys('Fallback: creating plain iframe (no SHARC protocol logging)');
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:' + adWidth + 'px;height:' + adHeight + 'px;border:none;display:block;';
    iframe.src = url;
    iframe.onload = function () { hideLoadingOverlay(); };
    containerEl.appendChild(iframe);
    logSys('Iframe created. ' + cfg.bridgeName + ' bridge will function inside the wrapper.');
    setLoaded(true);
    updateState('active');
  }

  /* ── Close Ad ────────────────────────────────────────────────── */
  function closeAd() {
    if (!sharcContainer) return;
    logSep('Container initiating close');
    if (typeof sharcContainer.close === 'function') {
      sharcContainer.close();
    } else {
      logErr('sharcContainer.close() not available');
    }
  }

  /* ── State Simulation ────────────────────────────────────────── */
  function simState(state) {
    if (!sharcContainer) return;
    logSys('Simulating platform event → containerState: ' + state);
    if (typeof sharcContainer.setState === 'function') {
      var ok = sharcContainer.setState(state);
      if (!ok) logErr('Invalid state transition to "' + state + '"');
    } else {
      logErr('sharcContainer.setState() not available — check sharc-container.js API');
    }
  }

  /* ── Placement Change ────────────────────────────────────────── */
  function sendPlacement() {
    if (!sharcContainer) return;
    var update = {
      containerDimensions: { width: 640, height: 480, x: 0, y: 0 },
      inline: false,
      standardSize: 'max',
    };
    logMsg('cntr', 'Container:placementChange (sent)', update);
    if (typeof sharcContainer.notifyPlacementChange === 'function') {
      sharcContainer.notifyPlacementChange(update);
    } else {
      logErr('sharcContainer.notifyPlacementChange() not available');
    }
  }

  /* ── Send Log ────────────────────────────────────────────────── */
  function sendLog() {
    if (!sharcContainer) return;
    var msg = 'Container log at ' + new Date().toISOString();
    logMsg('cntr', 'Container:log (sent)', { message: msg });
    if (typeof sharcContainer.log === 'function') {
      sharcContainer.log(msg);
    } else {
      logErr('sharcContainer.log() not available');
    }
  }

  /* ── Keyboard shortcuts ──────────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      if (!sharcContainer) loadAd();
    }
    if (e.key === 'Escape' && sharcContainer) {
      closeAd();
    }
  });

  /* ── Exports (as globals — classic script) ──────────────────── */
  window.BridgeHarness = {
    get container() { return sharcContainer; },
    get adWidth()   { return adWidth; },
    get adHeight()  { return adHeight; },
    log: { msg: logMsg, sep: logSep, sys: logSys, ok: logOk, err: logErr, clear: clearLog },
  };

  // onclick handlers reach these as globals
  window.loadAd = loadAd;
  window.closeAd = closeAd;
  window.clearLog = clearLog;
  window.simState = simState;
  window.sendPlacement = sendPlacement;
  window.sendLog = sendLog;
  window.onSizePresetChange = onSizePresetChange;
  window.applyCustomSize = applyCustomSize;
  window.setInstl = setInstl;
})();
