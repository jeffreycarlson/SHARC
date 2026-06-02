(function () {
  window.__sharcOmidVendorAsyncProbe = {
    supported: false,
    events: [],
    listenerEvents: [],
  };

  if (!window.omid3p || typeof window.omid3p.registerSessionObserver !== 'function') {
    return;
  }

  setTimeout(function () {
    window.__sharcOmidVendorAsyncProbe.supported = true;
    window.omid3p.registerSessionObserver(function (event) {
      window.__sharcOmidVendorAsyncProbe.events.push(event && event.type ? event.type : 'unknown');
    }, 'doubleverify', 'fixture-async');

    if (typeof window.omid3p.addEventListener === 'function') {
      window.omid3p.addEventListener('impression', function (event) {
        window.__sharcOmidVendorAsyncProbe.listenerEvents.push(event && event.type ? event.type : 'unknown');
      });
    }
  }, 0);
})();
