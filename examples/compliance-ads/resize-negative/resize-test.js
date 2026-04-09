/**
 * resize-test.js — Shim for resize-negative compliance ad (null-origin sandbox safe)
 *
 * mraid-wrapper.html loads resize-test.html via XHR, injects the <body> DOM
 * (which contains #resize_negative_tests_log), then loads this file via
 * <script src="resize-test.js">. window.mraid is already set by the wrapper.
 *
 * This shim dynamically loads the actual compliance script via <script src>.
 */
(function () {
  'use strict';
  var script = document.createElement('script');
  script.src = 'compliance-ads/resize-negative/resize-negative-tests.js';
  script.onerror = function () {
    console.error('[compliance resize-negative] Failed to load resize-negative-tests.js');
  };
  document.body.appendChild(script);
}());
