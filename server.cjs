// Simple dev server for SHARC test harness
// Sets headers needed for sandboxed iframe testing
// DEV SERVER ONLY — NOT FOR PRODUCTION USE — DO NOT DEPLOY
const http = require('http');
const fs = require('fs');
const path = require('path');

// PORT is overridable via env so callers (notably scripts/regen-mraid3-baseline.js)
// can drive the server on a non-default port without code changes. Default 8765
// is preserved for backward-compatibility with existing harness URLs and CI.
const PORT = parseInt(process.env.PORT || '8765', 10);
const ROOT = path.resolve(__dirname);

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const rawPath = req.url.split('?')[0];
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
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`SHARC dev server running at http://localhost:${PORT}/`);
  console.log(`Test harness: http://localhost:${PORT}/examples/test/mraid-test.html`);
});
