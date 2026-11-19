import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { staticFiles } from './static-files.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const allowedFiles = new Set([
  ...staticFiles,
  'owner-auth-redirect.js',
  'todos.css',
  'todos.js',
  'polish.css',
  'polish.js',
]);
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
]);

function respond(res, status, headers = {}, body = '') {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function isWithinRoot(root, target) {
  return target === root || target.startsWith(root + sep);
}

export async function createLocalOwnerManagerServer({ root = repositoryRoot } = {}) {
  const canonicalRoot = await realpath(root);
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return respond(res, 405, { Allow: 'GET, HEAD' });
      }
      let requestUrl;
      try {
        requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        return respond(res, 400);
      }
      if (req.method === 'GET' && requestUrl.pathname === '/roggy/callback') {
        return respond(res, 303, { Location: `/${requestUrl.search}` });
      }

      let decodedPath;
      try {
        decodedPath = decodeURIComponent(requestUrl.pathname);
      } catch {
        return respond(res, 400);
      }
      if (decodedPath.includes('\\') || decodedPath.includes('\0') || /[\u0000-\u001f\u007f]/.test(decodedPath)) {
        return respond(res, 404);
      }
      const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
      if (!allowedFiles.has(relativePath)) return respond(res, 404);
      const candidate = resolve(canonicalRoot, relativePath);
      if (!isWithinRoot(canonicalRoot, candidate)) return respond(res, 404);

      let filePath;
      try {
        filePath = await realpath(candidate);
      } catch {
        return respond(res, 404);
      }
      if (!isWithinRoot(canonicalRoot, filePath)) return respond(res, 404);
      const info = await stat(filePath);
      if (!info.isFile()) return respond(res, 404);
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': info.size,
        'Content-Type': mimeTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) respond(res, 500);
      else res.destroy();
    }
  });
}

async function main() {
  const server = await createLocalOwnerManagerServer();
  server.listen(8766, '127.0.0.1', () => {
    console.log('LayneGarmin owner manager ready on 127.0.0.1:8766');
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.exitCode = 1; });
}