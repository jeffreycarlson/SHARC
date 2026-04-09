/**
 * ad.js — Shim for viewability compliance ad (null-origin sandbox safe)
 *
 * mraid-wrapper.html loads ad.html via XHR, injects the <body> DOM, then
 * loads this file via <script src="ad.js">. window.mraid is already set.
 *
 * This shim dynamically loads the viewability compliance script via <script src>.
 * Note: viewabilityCompliance.v1.js bundles Chart.js + compliance logic.
 */
(function () {
  'use strict';
  var script = document.createElement('script');
  script.src = 'compliance-ads/viewability/viewabilityCompliance.v1.js';
  script.onerror = function () {
    console.error('[compliance viewability] Failed to load viewabilityCompliance.v1.js');
  };
  document.body.appendChild(script);
}());
