/*
 * WaterSim — cross-origin-isolation service worker.
 *
 * The multithreaded solver needs SharedArrayBuffer, and browsers only expose
 * SAB to *cross-origin isolated* pages (COOP/COEP response headers). Static
 * hosts that cannot set headers (GitHub Pages, S3, plain nginx defaults)
 * would leave the pool permanently off — this worker injects the two headers
 * on the fly instead. The page bootstrap in index.html registers it and
 * reloads once, then `crossOriginIsolated` becomes true and the worker pool
 * activates. No-op when the server already sends correct headers (serve.py,
 * nginx configs in README "Deploying").
 */
'use strict';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var origin = self.location.origin;
  // same-origin navigations and subresources only; never touch cross-origin
  if (req.url.indexOf(origin + '/') !== 0) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res.type === 'opaque') return res;   // cannot re-wrap opaque responses
      var h = new Headers(res.headers);
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }, function () { return Response.error(); })
  );
});
