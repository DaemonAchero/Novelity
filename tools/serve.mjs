// tools/serve.mjs
// ---------------------------------------------------------------------------
// dependency-free static server for the reader.
// Chromium blocks IndexedDB on file:// origins, so open the site through this
// server to get the real storage path (the chapter list lives in IndexedDB).
//
//   node tools/serve.mjs [port]        ->  http://localhost:8080/
//
// Every file is served with an ETag, so a reload costs a revalidation and
// nothing else: the browser keeps what it already has and the server answers
// 304 Not Modified. Text is gzipped when the browser asks for it — the seed
// (data/novel-data.js, the chapter list) is ~250 KB of JSON, ~40 KB on the
// wire — and the compressed copy is reused until the file changes.
//
// Chapter text is the one thing that is never cached: sources/** and Doer/**
// are read fresh on every request, so a chapter Doer has just written is on
// screen the moment the reader opens it.
// ---------------------------------------------------------------------------
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

// the chapter text: the two files a chapter owns are the one thing that must
// never be answered from a cache — a translation that landed a second ago has
// to show up
const NEVER_CACHE = /^(sources|Doer)\//;
const GZIP_TYPES = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.txt']);

const gzipped = new Map();   // file -> { mtimeMs, buf }, reused while the file is unchanged

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'content-type': 'text/plain', allow: 'GET, HEAD' }, 'method not allowed');
    return;
  }
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = (url === '/' ? 'index.html' : url.replace(/^\/+/, '')).split(path.sep).join('/');
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    send(res, 403, { 'content-type': 'text/plain' }, 'forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, { 'content-type': 'text/plain' }, 'not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const fresh = !NEVER_CACHE.test(rel);
    const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const headers = {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': fresh ? 'no-cache' : 'no-store',
      'last-modified': stat.mtime.toUTCString(),
    };
    if (fresh) headers.etag = etag;

    // no-cache means “revalidate before using it”, so a file the reader already
    // has costs one request and zero bytes
    if (fresh && req.headers['if-none-match'] === etag) {
      send(res, 304, headers);
      return;
    }

    fs.readFile(file, (readErr, buf) => {
      if (readErr) {
        send(res, 500, { 'content-type': 'text/plain' }, 'read failed');
        return;
      }
      const gzip = GZIP_TYPES.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      if (gzip) {
        let hit = gzipped.get(file);
        if (!hit || hit.mtimeMs !== stat.mtimeMs) {
          hit = { mtimeMs: stat.mtimeMs, buf: zlib.gzipSync(buf) };
          gzipped.set(file, hit);
        }
        headers['content-encoding'] = 'gzip';
        headers.vary = 'accept-encoding';
        headers['content-length'] = hit.buf.length;
        send(res, 200, headers, req.method === 'HEAD' ? undefined : hit.buf);
      } else {
        headers['content-length'] = buf.length;
        send(res, 200, headers, req.method === 'HEAD' ? undefined : buf);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`novelity reader ready → http://localhost:${PORT}/`);
  console.log('press Ctrl+C to stop');
});
