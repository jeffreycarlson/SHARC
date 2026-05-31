window.addEventListener('load', function () {
  setTimeout(function () {
    var frame = document.createElement('iframe');
    frame.src = '/tools/creative-validator/fixtures/csp-embedded-child.txt';
    document.body.appendChild(frame);
  }, 50);
});
