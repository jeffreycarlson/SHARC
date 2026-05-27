window.__sharcValidatorNestedIframeLoaded = false;
setTimeout(function () {
  var frame = document.createElement('iframe');
  frame.onload = function () {
    window.__sharcValidatorNestedIframeLoaded = true;
  };
  frame.srcdoc = '<!doctype html><html><body>nested frame</body></html>';
  document.body.appendChild(frame);
}, 50);
