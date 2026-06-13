// Simple dev server for SHARC test harness
// Sets headers needed for sandboxed iframe testing
// DEV SERVER ONLY — NOT FOR PRODUCTION USE — DO NOT DEPLOY
const http = require('http');
const fs = require('fs');
const path = require('path');

// PORT is overridable via env so callers (notably scripts/regen-mraid3-baseline.js)
// can drive the server on a non-default port without code changes. Default 8765
// is preserved for backward-compatibility with existing harness URLs and CI.
// Validated as a positive integer — Node's listen() silently picks a random
// port for NaN/0, which would produce confusing connect-refused timeouts in
// callers that assume the server is on the requested port.
function parsePort(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `Invalid PORT='${raw}' — must be a positive integer in 1..65535.`,
    );
  }
  return n;
}
const PORT = parsePort(process.env.PORT, 8765);
// Phase D — second port serves the renderer on a different origin so the
// browser harness can exercise the Creative Markup variant's cross-origin
// requirement (rule 7 — creativeRendererUrl must be cross-origin to
// window.location). Browsers treat `localhost:8765` and `localhost:8766`
// as distinct origins because the port differs. Default 8766 keeps it
// adjacent to the publisher port for ergonomics; overridable via env.
const RENDERER_PORT = parsePort(process.env.RENDERER_PORT, 8766);
const ROOT = path.resolve(__dirname);

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  // .mjs added Phase D round-4: the reference renderer at
  // `examples/renderer/index.html` loads `dist/sharc-navigation-bridge.mjs`
  // as a `<script type="module">`. Without an explicit MIME, Node's
  // octet-stream default makes browsers refuse the import with
  // `MIME type ('application/octet-stream') is not a supported …`.
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Single request handler shared between both ports. Phase D: when the
 * harness sends `?redirect=<target>`, respond with a 302 to the target
 * URL — exercises the post-load origin echo + RENDERER_ORIGIN_MISMATCH
 * (2116) path without standing up a separate server.
 */
function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rawPath = url.pathname;
  // Phase D harness hook: ?redirect=<absolute-url> → 302 to the target.
  // Used by the renderer-redirect test to drive the container into the
  // post-load origin echo path.
  //
  // DEV-ONLY: the redirect endpoint is gated to localhost / 127.0.0.1
  // targets. The harness's own `?redirect=` calls always target one of the
  // two local ports (publisher 8765 / renderer 8766), so the constraint
  // doesn't break any documented flow. An unbounded redirect would be an
  // open-redirect footgun if someone bound this server to 0.0.0.0 for
  // cross-device testing — we'd be handing out a redirector to anyone on
  // the LAN. Localhost-gating closes that off without removing the harness
  // hook. The control-char guard rejects literal CR/LF/NUL/DEL bytes —
  // not a header-splitting vuln (URL-encoded `%0d%0a` stays encoded), but
  // raw CRLF makes Node throw `ERR_INVALID_CHAR` at writeHead and surfaces
  // as a confusing 500. Reject early, return cleanly.
  const redirectTarget = url.searchParams.get('redirect');
  if (redirectTarget
      && /^https?:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?(\/|$)/.test(redirectTarget)
      && !/[\x00-\x1f\x7f]/.test(redirectTarget)) {
    res.writeHead(302, { Location: redirectTarget });
    res.end();
    return;
  }

  // DEV-ONLY harness hook: `?__slow=<ms>` delays the response body by <ms>
  // milliseconds, then serves a 1x1 transparent GIF. The lifecycle load-anchor
  // tests (Slice A, L-4) use this to make a creative's `window 'load'` lag its
  // `DOMContentLoaded` by a controllable amount (the heavy-subresource edge):
  // the creative requests `<img src="?__slow=400">`, so DCL fires immediately
  // but `window 'load'` waits ~400ms for this slow image. Clamped to 1..5000ms.
  const slowRaw = url.searchParams.get('__slow');
  if (slowRaw !== null) {
    const ms = Math.min(5000, Math.max(1, Number(slowRaw) || 0));
    const GIF = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    setTimeout(() => {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(GIF);
    }, ms);
    return;
  }
  let filePath = path.resolve(ROOT, '.' + rawPath);

  // Path traversal guard: reject any path that escapes the root directory
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Serve index.html for directory requests.
  // path.resolve() strips trailing separators, so check rawPath (which preserves
  // the trailing slash) rather than filePath. Covers bare GET / and nested dirs.
  if (rawPath === '/' || rawPath.endsWith('/')) {
    filePath = filePath + path.sep + 'index.html';
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const headers = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "object-src 'none'; base-uri 'none'";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// Publisher-side server (default port 8765 — backward compatible).
http.createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log(`SHARC dev server (publisher) at http://localhost:${PORT}/`);
  console.log(`  MRAID test harness: http://localhost:${PORT}/test/browser/mraid-test.html`);
  console.log(`  Phase D renderer protocol harness: `
    + `http://localhost:${PORT}/test/browser/test-creative-sources.html`);
});

// Renderer-side server (Phase D — different origin for Creative Markup).
// Same content tree, different port → different origin from the browser's
// perspective. The Creative Markup harness loads
// `http://localhost:<RENDERER_PORT>/examples/renderer/index.html` as the
// `creativeRendererUrl`, satisfying rule 7's cross-origin requirement.
http.createServer(handler).listen(RENDERER_PORT, '127.0.0.1', () => {
  console.log(`SHARC dev server (renderer) at http://localhost:${RENDERER_PORT}/`);
  console.log(`  Phase D reference renderer: `
    + `http://localhost:${RENDERER_PORT}/examples/renderer/`);
});
