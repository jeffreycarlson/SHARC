/**
 * @file SHARC validator OMID service-path canary verification client (#244).
 *
 * The harness registers this script as one extra `VerificationScriptResource`
 * on the container-owned OMID `Context`, so the REAL `omweb-v1.js` service
 * injects it exactly like a vendor verification resource (hidden iframe,
 * `omidVerificationProperties` with a service-minted `injectionId`). It then
 * subscribes through the OM SDK verification-service postMessage protocol and
 * relays every delivery to the harness top window. A vendor row's
 * "service-path delivery" signal is therefore grounded in what the service
 * actually dispatched to verification-service subscribers in this session —
 * the pinned service (1.5.2) rejects listeners whose `injectionId` it did not
 * mint (`sessionError`: "Registration to session events is only allowed for
 * verification clients injected by the OM-SDK service itself"), so a canary
 * delivery proves the full inject → register → dispatch pipeline.
 *
 * Validator-owned harness code: it measures, it never alters creative or
 * container behavior. Served via runner request interception at
 * `https://omid.validator.example/omid-canary-verification-client.js?probeNonce=…`.
 */

(function () {
  'use strict';

  // The OM SDK service compares protocol versions against 1.0.3; >= 1.0.3
  // exchanges raw (non-JSON-stringified) args. Keep the canary on the modern
  // raw-args path.
  var PROTOCOL_VERSION = '1.0.3';

  var properties = window.omidVerificationProperties || {};
  var serviceWindow = properties.serviceWindow || window.parent;
  var injectionId = typeof properties.injectionId === 'string'
    ? properties.injectionId
    : '';

  var probeNonce = '';
  try {
    var src = document.currentScript && document.currentScript.src;
    if (src) {
      var match = /[?&]probeNonce=([^&]+)/.exec(src);
      if (match) probeNonce = decodeURIComponent(match[1]);
    }
  } catch (_) {
    // Reports without a nonce are dropped by the harness listener.
  }

  function report(payload) {
    try {
      window.top.postMessage({
        type: 'SHARC:Validator:omidServiceCanary',
        probeNonce: probeNonce,
        payload: payload,
      }, '*');
    } catch (_) {
      // Diagnostics only.
    }
  }

  var pending = {};
  var sequence = 0;

  function send(method, args, onResponse) {
    var guid = 'sharc-canary-' + (++sequence) + '-'
      + Math.random().toString(16).slice(2, 10);
    pending[guid] = onResponse;
    try {
      serviceWindow.postMessage({
        omid_message_guid: guid,
        omid_message_method: method,
        omid_message_version: PROTOCOL_VERSION,
        omid_message_args: args,
      }, '*');
    } catch (err) {
      report({ kind: 'canary-error', message: String(err && err.message ? err.message : err) });
    }
  }

  function responseArgs(data) {
    var args = data.omid_message_args;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch (_) { args = []; }
    }
    return Array.isArray(args) ? args : [];
  }

  function eventSummary(ev) {
    return {
      type: ev && typeof ev.type === 'string' ? ev.type : 'unknown',
    };
  }

  window.addEventListener('message', function (ev) {
    var data = ev && ev.data;
    if (!data || typeof data !== 'object') return;
    if (data.omid_message_method !== 'response') return;
    var callback = pending[data.omid_message_guid];
    if (typeof callback !== 'function') return;
    callback.apply(null, responseArgs(data));
  });

  send('VerificationService.addSessionListener', ['sharc-validator-canary', injectionId], function (sessionEvent) {
    report({ kind: 'sessionEvent', event: eventSummary(sessionEvent) });
  });

  var eventTypes = ['impression', 'loaded', 'geometryChange'];
  for (var i = 0; i < eventTypes.length; i++) {
    (function (eventType) {
      send('VerificationService.addEventListener', [eventType, injectionId], function (event) {
        report({ kind: 'event', eventType: eventType, event: eventSummary(event) });
      });
    })(eventTypes[i]);
  }

  report({ kind: 'canary-loaded', hasInjectionId: injectionId.length > 0 });
})();
