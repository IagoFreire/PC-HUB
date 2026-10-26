import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

/** Resolve o caminho pedido dentro de publicDir, ou null se for inválido ou escapar da pasta. */
export function resolvePublicPath(publicDir, urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://local').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname.endsWith('/')) pathname += 'index.html';

  const root = path.resolve(publicDir);
  const filePath = path.resolve(root, `.${pathname}`);
  return filePath.startsWith(root + path.sep) ? filePath : null;
}

export async function serveStatic(req, res, publicDir) {
  const filePath = resolvePublicPath(publicDir, req.url);
  const type = filePath && CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  if (!type) return false;

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
