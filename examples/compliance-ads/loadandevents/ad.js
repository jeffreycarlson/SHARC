/**
 * ad.js — Shim for loadandevents compliance ad (null-origin sandbox safe)
 *
 * mraid-wrapper.html loads ad.html via XHR, injects the <body> DOM (which
 * contains #aroniabmraid3ad), then loads this file via <script src="ad.js">.
 * window.mraid is already set by the wrapper before this script runs.
 *
 * This shim dynamically loads the actual compliance script (aronmraid3.js)
 * via <script src>, which then finds window.mraid ready and #aroniabmraid3ad
 * in the DOM.
 *
 * Note: aronmraid3.js itself tries to inject <script src="mraid.js"> into
 * <head> — that script won't load (404 in SHARC context) but window.mraid
 * is already present so the compliance code still functions correctly.
 */
(function () {
  'use strict';
  var script = document.createElement('script');
  // aronmraid3.js is in the same directory as ad.html / ad.js
  script.src = 'compliance-ads/loadandevents/aronmraid3.js';
  script.onerror = function () {
    console.error('[compliance loadandevents] Failed to load aronmraid3.js');
  };
  document.body.appendChild(script);
}());
