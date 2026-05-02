/* Phase D test-only Service Worker script.
 *
 * Registered on the renderer origin by `renderer-fixture.html?mode=register-sw`.
 * Its only job is to exist as `navigator.serviceWorker.controller` on the
 * next renderer iframe load — the renderer's SW-detection check then
 * triggers the `:failed` reply with `reason: 'service_worker_detected'`.
 *
 * The fetch handler is a passthrough (delegates to the network) — the
 * SW does NOT intercept or modify any responses. The presence of the SW
 * is what the renderer-side check detects, regardless of behavior.
 *
 * Operators MUST NOT register a Service Worker on a production renderer
 * origin. See: docs/proposals/creative-sources.md § Renderer
 * implementation contract operational constraints.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
