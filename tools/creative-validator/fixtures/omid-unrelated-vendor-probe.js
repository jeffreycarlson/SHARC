(function () {
  if (!window.omid3p || typeof window.omid3p.registerSessionObserver !== 'function') {
    return;
  }

  window.omid3p.registerSessionObserver(function () {}, 'doubleverify', 'fixture');

  if (typeof window.omid3p.addEventListener === 'function') {
    window.omid3p.addEventListener('impression', function () {}, 'product-dv-id');
  }
})();
