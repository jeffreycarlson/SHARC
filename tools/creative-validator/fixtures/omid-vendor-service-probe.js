/**
 * @file Synthetic OMID vendor probe for the REAL-service discovery path (#244).
 *
 * Models the dominant real-world `dvtp_src.js` shape: the inline copy that
 * executes in the creative window does NOTHING with `window.omid3p` (the real
 * DV loader deliberately ignores it), while the copy the REAL `omweb-v1.js`
 * service injects from a `VerificationScriptResource` finds
 * `omidVerificationProperties` (service-minted `injectionId`) and subscribes
 * through the OM SDK verification-service postMessage protocol. Served by the
 * validator's request interception at
 * `https://cdn.doubleverify.com/__sharc-validator-fixtures/omid-vendor-service-probe.js`
 * so the synthesized sidecar promotes it like a real DV tag. Synthetic
 * fixture — no real vendor code.
 */

(function () {
  'use strict';

  var properties = window.omidVerificationProperties;
  if (!properties || typeof properties.injectionId !== 'string') {
    // Inline (non-injected) copy: dead-ends exactly like the real vendor
    // loader chain — no omid3p use, no service connection.
    return;
  }

  var serviceWindow = properties.serviceWindow || window.parent;
  var injectionId = properties.injectionId;
  var sequence = 0;

  function send(method, args) {
    sequence += 1;
    try {
      serviceWindow.postMessage({
        omid_message_guid: 'fixture-service-probe-' + sequence,
        omid_message_method: method,
        omid_message_version: '1.0.3',
        omid_message_args: args,
      }, '*');
    } catch (_) {
      // Probe is diagnostics-only.
    }
  }

  send('VerificationService.addSessionListener', ['doubleverify.com-omid', injectionId]);
  send('VerificationService.addEventListener', ['impression', injectionId]);
  send('VerificationService.addEventListener', ['geometryChange', injectionId]);
})();
