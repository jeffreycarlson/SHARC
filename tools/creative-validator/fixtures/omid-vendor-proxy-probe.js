(function () {
  if (!window.omid3p || typeof window.omid3p.registerSessionObserver !== 'function') {
    return;
  }

  // 455256 is DoubleVerify's IAB vendor ID; attribution intentionally keys off
  // the script source URL, not this caller-supplied value.
  window.omid3p.registerSessionObserver(function () {}, '455256', 'fixture-proxy');

  if (typeof window.omid3p.addEventListener === 'function') {
    window.omid3p.addEventListener('impression', function () {}, 'fixture-proxy');
  }
})();
