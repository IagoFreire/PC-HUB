import http from 'node:http';
import { createAuthGuard } from './auth.js';
import { HttpError } from './http-error.js';
import { serveStatic } from './static.js';

const MAX_BODY_BYTES = 1024;

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Corpo da requisição grande demais.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

const defaultLog = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

export function createApp({ config, monitor, publicDir, log = defaultLog }) {
  const guard = createAuthGuard(config.accessToken);

  const routes = {
    'GET /api/status': async () => [200, await monitor.getStatus()],
    'POST /api/wake': async () => {
      await monitor.wake();
      log(`magic packet enviado para ${config.pc.mac} via ${config.pc.broadcast}`);
      return [202, { ok: true }];
    },
    'POST /api/power': async (req) => {
      const action = (await readJson(req))?.action;
      await monitor.power(action);
      log(`comando "${action}" enviado ao agente`);
      return [202, { ok: true, action }];
    },
  };

  async function handleApi(req, res, pathname) {
    const client = req.socket.remoteAddress ?? 'unknown';
    const verdict = guard.check(client, req.headers.authorization);
    if (verdict === 'locked') {
      throw new HttpError(429, 'Muitas tentativas erradas. Espere 15 minutos.');
    }
    if (verdict !== 'ok') {
      log(`código de acesso incorreto vindo de ${client}`);
      throw new HttpError(401, 'Código de acesso incorreto.');
    }

    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) throw new HttpError(404, 'Rota não encontrada.');
    const [status, body] = await handler(req);
    sendJson(res, status, body);
  }

  async function handle(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const { pathname } = new URL(req.url, 'http://local');

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, publicDir)) {
      return;
    }
    throw new HttpError(404, 'Não encontrado.');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`erro interno em ${req.method} ${req.url}: ${err.stack ?? err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: status === 500 ? 'Erro interno do servidor.' : err.message });
    });
  });
}
