import http from 'node:http';
import https from 'node:https';
import { createAuthGuard } from './auth.js';
import { HttpError } from './http-error.js';
import { serveStatic } from './static.js';
import { handleTouchConnection } from './touch.js';
import { acceptWebSocket } from './websocket.js';

const MAX_BODY_BYTES = 1024;

const MAX_TOUCH_CLIENTS = 8;
// Conexões que ainda não mandaram o código: poucas por IP, para ninguém esgotar as vagas do celular.
const MAX_PENDING_TOUCH_PER_IP = 2;
const SAFE_HOST_RE = /^[a-z0-9.\-:[\]]+$/i;

/** CSP por requisição: o Safari não considera ws:// coberto por 'self', então o host vai explícito. */
function contentSecurityPolicy(host) {
  const sockets = host && SAFE_HOST_RE.test(host) ? ` ws://${host} wss://${host}` : '';
  return [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    `connect-src 'self'${sockets}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function isSameOrigin(req) {
  const { origin } = req.headers;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const SECURITY_HEADERS = Object.freeze({
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

export const defaultLog = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

/** tls: { pfx, passphrase } para servir em HTTPS (necessário para o air mouse no iPhone). */
export function createApp({ config, monitor, publicDir, touch = null, ups = null, tls = null, log = defaultLog }) {
  const guard = createAuthGuard(config.accessToken);

  const routes = {
    'GET /api/status': async () => [200, await monitor.getStatus()],
    'GET /api/ups': async () => {
      if (!ups) throw new HttpError(404, 'Nobreak não configurado.');
      return [200, await ups.getStatus()];
    },
    'POST /api/wake': async () => {
      await monitor.wake();
      log(`magic packet enviado para ${config.pc.mac} via ${config.pc.broadcast}`);
      return [202, { ok: true }];
    },
    'POST /api/power': async (req) => {
      const action = (await readJson(req))?.action;
      const result = await monitor.power(action);
      log(result?.confirmed === false
        ? `comando "${action}" enviado, sem confirmação do agente (provavelmente já desligando)`
        : `comando "${action}" enviado ao agente`);
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
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(req.headers.host));
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

  const onRequest = (req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`erro interno em ${req.method} ${req.url}: ${err.stack ?? err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: status === 500 ? 'Erro interno do servidor.' : err.message });
    });
  };
  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);

  let touchClients = 0;
  const pendingByIp = new Map();
  const changePending = (ip, delta) => {
    const next = (pendingByIp.get(ip) ?? 0) + delta;
    if (next > 0) pendingByIp.set(ip, next);
    else pendingByIp.delete(ip);
  };

  server.on('upgrade', (req, socket) => {
    socket.on('error', () => socket.destroy());
    const reject = (status) => socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
    const { pathname } = new URL(req.url, 'http://local');

    if (pathname !== '/api/touch') return reject(404);
    const client = req.socket.remoteAddress ?? 'unknown';
    if (!touch || touchClients >= MAX_TOUCH_CLIENTS) return reject(503);
    if ((pendingByIp.get(client) ?? 0) >= MAX_PENDING_TOUCH_PER_IP) return reject(429);
    // Impede que outro site aberto no celular use o WebSocket (cross-site WebSocket hijacking).
    if (!isSameOrigin(req)) return reject(403);

    const ws = acceptWebSocket(req, socket);
    if (!ws) return undefined;
    touchClients += 1;
    changePending(client, +1);
    let pending = true;
    const settlePending = () => {
      if (!pending) return;
      pending = false;
      changePending(client, -1);
    };
    ws.on('close', () => {
      touchClients -= 1;
      settlePending();
    });

    handleTouchConnection(ws, {
      authenticate: (token) => guard.check(client, `Bearer ${token}`),
      relay: touch,
      onAuthenticated: settlePending,
      log,
    });
    return undefined;
  });

  return server;
}
