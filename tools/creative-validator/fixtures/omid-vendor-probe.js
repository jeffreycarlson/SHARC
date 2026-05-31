(function () {
  window.__sharcOmidVendorProbe = {
    supported: false,
    events: [],
    listenerEvents: [],
  };

  if (!window.omid3p || typeof window.omid3p.registerSessionObserver !== 'function') {
    return;
  }

  window.__sharcOmidVendorProbe.registerSource = Function.prototype.toString.call(
    window.omid3p.registerSessionObserver,
  );
  window.__sharcOmidVendorProbe.toStringSource = Function.prototype.toString.call(
    Function.prototype.toString,
  );
  window.__sharcOmidVendorProbe.toStringName = Function.prototype.toString.name;
  window.__sharcOmidVendorProbe.registerName = window.omid3p.registerSessionObserver.name;
  if (window.__sharcOmidVendorProbe.registerSource.indexOf('SHARC:Validator:omidVendorDiagnostics') !== -1
      || window.__sharcOmidVendorProbe.registerSource.indexOf('wrapCallback') !== -1
      || window.__sharcOmidVendorProbe.toStringSource.indexOf('mirroredFunctions') !== -1
      || window.__sharcOmidVendorProbe.toStringName !== 'toString') {
    return;
  }

  window.__sharcOmidVendorProbe.supported = true;
  window.omid3p.registerSessionObserver(function (event) {
    window.__sharcOmidVendorProbe.events.push(event && event.type ? event.type : 'unknown');
  }, 'doubleverify', 'fixture');

  if (typeof window.omid3p.addEventListener === 'function') {
    window.omid3p.addEventListener('impression', function (event) {
      window.__sharcOmidVendorProbe.listenerEvents.push(event && event.type ? event.type : 'unknown');
    });
  }
})();
