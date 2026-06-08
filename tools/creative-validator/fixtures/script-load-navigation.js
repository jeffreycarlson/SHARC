// Fires a top-of-frame navigation that the container's load-event backstop must
// classify as `unauthorized_navigation` (outcome bucket `navigation-policy`).
//
// Determinism (#344): the navigation MUST land in the post-render window — after
// the container has accepted `:rendered` and armed `_armRendererBackstop`. The
// previous fixed 50ms timer raced render-completion: on slow CI the timer fired
// before the backstop was armed, so the navigation was never bucketed and the
// case flaked to `passed`.
//
// `window.SHARC.onReady` fires on `Container:init`, which the container sends
// ~200ms after `:rendered` via `initChannel` — strictly AFTER the backstop is
// armed (armed synchronously in `_onRendererRendered`, before the deferred
// init). Gating the navigation on `onReady` guarantees it is a genuine
// post-render load in any environment, so it is deterministically classified
// `navigation-policy`. The validator harness injects `window.SHARC` into every
// creative iframe, so the SDK is always present.
//
// This fixture is loaded synchronously at parse time (static <script src> in the
// case markup) so its `onReady` registration always precedes the 200ms-deferred
// `Container:init` — `onReady` is single-shot and not replayed to late
// subscribers, so registering before init is part of the determinism contract.
(function () {
  function navigate() {
    window.location.href = 'https://click.example/script-load-navigation';
  }

  var sharc = window.SHARC;
  if (sharc && typeof sharc.onReady === 'function') {
    // `Container:init` is post-render and post-backstop-arm. Navigate from the
    // ready callback so the load is always a subsequent (unauthorized) load,
    // never the first verified one.
    sharc.onReady(function () {
      navigate();
    });
    return;
  }

  // Defensive fallback if the SDK global is unavailable for any reason: defer to
  // a macrotask after window load so the navigation still fires post-render.
  // The deterministic path above is the contract; this only avoids a silent
  // no-op if the harness changes how it injects the SDK.
  if (document.readyState === 'complete') {
    setTimeout(navigate, 0);
  } else {
    window.addEventListener('load', function () {
      setTimeout(navigate, 0);
    }, { once: true });
  }
})();
