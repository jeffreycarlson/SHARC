/**
 * resize-test.js - Shim for resize-positive compliance ad (null-origin sandbox safe)
 *
 * mraid-wrapper.html loads resize-test.html via XHR, injects the <body> DOM
 * (which contains #resize_positive_tests_log), then loads this file via
 * <script src="resize-test.js">. window.mraid is already set by the wrapper.
 *
 * This shim dynamically loads the actual compliance script via <script src>.
 */
(function () {
  'use strict';
  var script = document.createElement('script');
  script.src = 'compliance-ads/resize-positive/resize-positive-tests.js';
  script.onerror = function () {
    console.error('[compliance resize-positive] Failed to load resize-positive-tests.js');
  };
  document.body.appendChild(script);
}());
