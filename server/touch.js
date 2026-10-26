// Trackpad: valida eventos vindos do iPhone e repassa ao Aurora Touch (no PC) por TCP autenticado.
import { createHmac } from 'node:crypto';
import net from 'node:net';

const MAX_MOVE = 1000;
const MAX_SCROLL = 2400;
const MAX_TEXT = 256;
const BUTTONS = new Set(['l', 'r']);
export const TOUCH_KEYS = Object.freeze(['enter', 'backspace', 'tab', 'esc', 'left', 'up', 'right', 'down', 'delete']);
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

// Maior que o prazo de autenticação do Aurora Touch (2 s), para esperar na fila se ele estiver ocupado.
const HANDSHAKE_TIMEOUT_MS = 5000;
const MAX_HANDSHAKE_CHARS = 256;
const PING_MS = 5000;
const MAX_BACKLOG_BYTES = 64 * 1024;
const AUTH_TIMEOUT_MS = 3000;
const MAX_EVENTS_PER_SECOND = 240;
// Só movimento e rolagem podem ser descartados no limite; clique/soltar/tecla nunca (botão preso).
const RATE_LIMITED = new Set(['m', 's']);

const clampInt = (value, max) => (Number.isFinite(value) ? Math.max(-max, Math.min(max, Math.round(value))) : 0);

/** Normaliza um evento do cliente; devolve null para qualquer coisa fora do formato esperado. */
export function validateTouchEvent(msg) {
  switch (msg?.t) {
    case 'm':
    case 's': {
      const max = msg.t === 'm' ? MAX_MOVE : MAX_SCROLL;
      const dx = clampInt(msg.dx, max);
      const dy = clampInt(msg.dy, max);
      return dx || dy ? { t: msg.t, dx, dy } : null;
    }
    case 'c':
    case 'd':
    case 'u':
      return BUTTONS.has(msg.b) ? { t: msg.t, b: msg.b } : null;
    case 'k': {
      if (typeof msg.text !== 'string') return null;
      const text = msg.text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').slice(0, MAX_TEXT);
      return text ? { t: 'k', text } : null;
    }
    case 'key':
      return TOUCH_KEYS.includes(msg.k) ? { t: 'key', k: msg.k } : null;
    default:
      return null;
  }
}

/**
 * Conexão persistente com o Aurora Touch. Handshake: o PC manda "AURORA1 <nonce>",
 * o servidor responde HMAC-SHA256(segredo, nonce) e o PC confirma com "OK".
 * Depois disso, um evento JSON por linha.
 */
export function createTouchRelay({ host, port, secret, connect = net.connect, log = () => {} }) {
  let socket = null;
  let opening = null;
  let pingTimer = null;

  function handshake() {
    return new Promise((resolve, reject) => {
      const s = connect({ host, port });
      let buffer = '';
      let stage = 'hello';
      let settled = false;

      const fail = (message, cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        s.destroy();
        reject(new Error(message, { cause }));
      };
      const timer = setTimeout(() => fail('O Aurora Touch não respondeu a tempo.'), HANDSHAKE_TIMEOUT_MS);

      s.setEncoding('utf8');
      s.setNoDelay(true);
      s.setKeepAlive(true, PING_MS);
      s.on('error', (err) => fail(
        stage === 'hello'
          ? 'Não consegui conectar ao Aurora Touch. O PC está ligado e com você logado no Windows?'
          : 'A conexão com o Aurora Touch caiu.',
        err,
      ));
      // Segredo errado: o PC simplesmente fecha a conexão sem responder "OK".
      s.on('close', () => fail(stage === 'auth'
        ? 'O Aurora Touch recusou o segredo. Confira o agentSecret e reinstale o agente.'
        : 'O Aurora Touch fechou a conexão.'));

      s.on('data', function onHandshakeData(chunk) {
        buffer += chunk;
        if (buffer.length > MAX_HANDSHAKE_CHARS) {
          fail('Resposta inesperada do Aurora Touch.');
          return;
        }
        let newline;
        while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (stage === 'hello') {
            const match = /^AURORA1 ([0-9a-f]{64})$/.exec(line);
            if (!match) {
              fail('Resposta inesperada do Aurora Touch.');
              return;
            }
            s.write(`${createHmac('sha256', secret).update(match[1]).digest('hex')}\n`);
            stage = 'auth';
          } else if (line === 'OK') {
            settled = true;
            clearTimeout(timer);
            s.off('data', onHandshakeData);
            resolve(s);
          } else {
            fail('O Aurora Touch recusou o segredo. Confira o agentSecret e reinstale o agente.');
          }
        }
      });
    });
  }

  function open() {
    if (socket) return Promise.resolve();
    opening ??= handshake()
      .then((s) => {
        socket = s;
        // Os listeners de erro do handshake continuam ligados; 'close' cuida da limpeza.
        s.on('close', () => {
          if (socket !== s) return;
          socket = null;
          clearInterval(pingTimer);
          log('conexão com o Aurora Touch encerrada');
        });
        pingTimer = setInterval(() => s.write('{"t":"p"}\n'), PING_MS);
        pingTimer.unref?.();
        log(`conectado ao Aurora Touch em ${host}:${port}`);
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  }

  async function send(event) {
    await open();
    if (!socket) throw new Error('A conexão com o Aurora Touch caiu.');
    // Rede engasgada: descarta movimento (o próximo compensa), mas nunca cliques ou teclas.
    if (event.t === 'm' && socket.writableLength > MAX_BACKLOG_BYTES) return;
    socket.write(`${JSON.stringify(event)}\n`);
  }

  function close() {
    clearInterval(pingTimer);
    socket?.destroy();
    socket = null;
  }

  return Object.freeze({ open, send, close });
}

/** Atende um WebSocket do trackpad: autentica, aplica limites e repassa eventos ao relay. */
export function handleTouchConnection(ws, { authenticate, relay, onAuthenticated = () => {}, log = () => {} }) {
  let authenticated = false;
  let windowStart = Date.now();
  let eventsInWindow = 0;
  const heldButtons = new Set();

  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

  const fail = (message, code = 'relay') => {
    ws.send({ t: 'error', code, message });
    ws.close(4002, code);
  };

  async function onAuth(msg) {
    clearTimeout(authTimer);
    const verdict = msg?.t === 'auth' ? authenticate(msg.token) : 'denied';
    if (verdict !== 'ok') {
      fail(verdict === 'locked' ? 'Muitas tentativas erradas. Espere 15 minutos.' : 'Código de acesso incorreto.', 'auth');
      return;
    }
    authenticated = true;
    onAuthenticated();
    try {
      await relay.open();
      ws.send({ t: 'ready' });
    } catch (err) {
      log(`trackpad: ${err.message}`);
      fail(err.message);
    }
  }

  function withinRateLimit() {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      eventsInWindow = 0;
    }
    eventsInWindow += 1;
    return eventsInWindow <= MAX_EVENTS_PER_SECOND;
  }

  ws.on('message', (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!authenticated) {
      onAuth(msg);
      return;
    }
    const event = validateTouchEvent(msg);
    if (!event) return;
    if (RATE_LIMITED.has(event.t) && !withinRateLimit()) return;
    if (event.t === 'd') heldButtons.add(event.b);
    if (event.t === 'u') heldButtons.delete(event.b);

    relay.send(event).catch((err) => {
      log(`trackpad: ${err.message}`);
      fail('Perdi a conexão com o PC. Reconectando…');
    });
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    // Celular sumiu no meio de um arraste: solta o botão (o Aurora Touch também solta ao desconectar).
    for (const b of heldButtons) {
      relay.send({ t: 'u', b }).catch((err) => log(`trackpad: não consegui soltar o botão: ${err.message}`));
    }
  });
}
