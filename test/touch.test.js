import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import { createTouchRelay, handleTouchConnection, validateTouchEvent } from '../server/touch.js';

const SECRET = 's'.repeat(32);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('tempo esgotado esperando condição');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Aurora Touch falso: mesmo handshake do aurora-touch.ps1, guarda os eventos recebidos. */
async function fakeHelper(secret = SECRET) {
  const received = [];
  const server = net.createServer((sock) => {
    const nonce = randomBytes(32).toString('hex');
    let buffer = '';
    let authed = false;
    sock.setEncoding('utf8');
    sock.write(`AURORA1 ${nonce}\n`);
    sock.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (authed) {
          received.push(JSON.parse(line));
        } else if (line === createHmac('sha256', secret).update(nonce).digest('hex')) {
          authed = true;
          sock.write('OK\n');
        } else {
          sock.destroy();
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, received, close: () => new Promise((r) => server.close(r)) };
}

function fakeWs() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.closedWith = null;
  ws.send = (message) => ws.sent.push(message);
  ws.close = (code) => {
    if (ws.closedWith !== null) return;
    ws.closedWith = code;
    ws.emit('close');
  };
  return ws;
}

function fakeRelay({ openError } = {}) {
  const events = [];
  return {
    events,
    open: async () => {
      if (openError) throw new Error(openError);
    },
    send: async (event) => {
      events.push(event);
    },
  };
}

/* ---------- validação ---------- */

test('validateTouchEvent arredonda e limita movimento e rolagem', () => {
  assert.deepEqual(validateTouchEvent({ t: 'm', dx: 3.6, dy: -99999 }), { t: 'm', dx: 4, dy: -1000 });
  assert.deepEqual(validateTouchEvent({ t: 's', dx: 0, dy: 99999 }), { t: 's', dx: 0, dy: 2400 });
  assert.equal(validateTouchEvent({ t: 'm', dx: 0, dy: 0 }), null);
  assert.equal(validateTouchEvent({ t: 'm', dx: 'x', dy: Number.NaN }), null);
});

test('validateTouchEvent só aceita botões l/r e teclas conhecidas', () => {
  assert.deepEqual(validateTouchEvent({ t: 'c', b: 'r' }), { t: 'c', b: 'r' });
  assert.equal(validateTouchEvent({ t: 'd', b: 'meio' }), null);
  assert.deepEqual(validateTouchEvent({ t: 'key', k: 'enter' }), { t: 'key', k: 'enter' });
  assert.equal(validateTouchEvent({ t: 'key', k: 'win+r' }), null);
  assert.equal(validateTouchEvent({ t: 'exec', cmd: 'calc' }), null);
  assert.equal(validateTouchEvent(null), null);
});

test('validateTouchEvent limpa texto: tira controles, normaliza quebra de linha e corta em 256', () => {
  assert.deepEqual(validateTouchEvent({ t: 'k', text: 'olá\r\nmundo\u0007' }), { t: 'k', text: 'olá\nmundo' });
  assert.equal(validateTouchEvent({ t: 'k', text: 'x'.repeat(300) }).text.length, 256);
  assert.equal(validateTouchEvent({ t: 'k', text: '\u0000' }), null);
  assert.equal(validateTouchEvent({ t: 'k', text: 42 }), null);
});

/* ---------- relay TCP ---------- */

test('relay faz o handshake HMAC e entrega eventos em ordem, um por linha', async () => {
  const helper = await fakeHelper();
  const relay = createTouchRelay({ host: '127.0.0.1', port: helper.port, secret: SECRET });
  try {
    await relay.send({ t: 'm', dx: 5, dy: -3 });
    await relay.send({ t: 'c', b: 'l' });
    await waitFor(() => helper.received.length === 2);
    assert.deepEqual(helper.received, [{ t: 'm', dx: 5, dy: -3 }, { t: 'c', b: 'l' }]);
  } finally {
    relay.close();
    await helper.close();
  }
});

test('relay reconecta sozinho depois que a conexão cai', async () => {
  const helper = await fakeHelper();
  const relay = createTouchRelay({ host: '127.0.0.1', port: helper.port, secret: SECRET });
  try {
    await relay.open();
    relay.close();
    await relay.send({ t: 'key', k: 'enter' });
    await waitFor(() => helper.received.length === 1);
  } finally {
    relay.close();
    await helper.close();
  }
});

test('relay explica quando o segredo não confere', async () => {
  const helper = await fakeHelper('outro-segredo-qualquer-123');
  const relay = createTouchRelay({ host: '127.0.0.1', port: helper.port, secret: SECRET });
  try {
    await assert.rejects(relay.open(), /recusou o segredo/);
  } finally {
    await helper.close();
  }
});

test('relay explica quando o Aurora Touch não está rodando', async () => {
  const helper = await fakeHelper();
  await helper.close();
  const relay = createTouchRelay({ host: '127.0.0.1', port: helper.port, secret: SECRET });
  await assert.rejects(relay.open(), /Não consegui conectar ao Aurora Touch/);
});

/* ---------- conexão do celular ---------- */

test('conexão do celular exige o código antes de qualquer evento', async () => {
  const ws = fakeWs();
  const relay = fakeRelay();
  handleTouchConnection(ws, { authenticate: () => 'denied', relay });

  ws.emit('message', JSON.stringify({ t: 'auth', token: 'errado' }));
  await tick();
  assert.equal(ws.sent[0].code, 'auth');
  assert.equal(ws.closedWith, 4002);
  assert.deepEqual(relay.events, []);
});

test('depois de autenticar, eventos válidos vão ao relay e inválidos são descartados', async () => {
  const ws = fakeWs();
  const relay = fakeRelay();
  handleTouchConnection(ws, { authenticate: (token) => (token === 'certo' ? 'ok' : 'denied'), relay });

  ws.emit('message', JSON.stringify({ t: 'auth', token: 'certo' }));
  await tick();
  assert.deepEqual(ws.sent, [{ t: 'ready' }]);

  ws.emit('message', JSON.stringify({ t: 'm', dx: 2, dy: 2 }));
  ws.emit('message', JSON.stringify({ t: 'exec', cmd: 'rm' }));
  ws.emit('message', 'não é json');
  await tick();
  assert.deepEqual(relay.events, [{ t: 'm', dx: 2, dy: 2 }]);
  ws.close(1000);
});

test('se o celular cai no meio de um arraste, o botão é solto', async () => {
  const ws = fakeWs();
  const relay = fakeRelay();
  handleTouchConnection(ws, { authenticate: () => 'ok', relay });
  ws.emit('message', JSON.stringify({ t: 'auth', token: 'x' }));
  await tick();

  ws.emit('message', JSON.stringify({ t: 'd', b: 'l' }));
  await tick();
  ws.close(1006);
  await tick();
  assert.deepEqual(relay.events, [{ t: 'd', b: 'l' }, { t: 'u', b: 'l' }]);
});

test('limite de taxa nunca descarta soltar botão (evita botão preso)', async () => {
  const ws = fakeWs();
  const relay = fakeRelay();
  handleTouchConnection(ws, { authenticate: () => 'ok', relay });
  ws.emit('message', JSON.stringify({ t: 'auth', token: 'x' }));
  await tick();

  ws.emit('message', JSON.stringify({ t: 'd', b: 'l' }));
  for (let i = 0; i < 500; i++) ws.emit('message', JSON.stringify({ t: 'm', dx: 1, dy: 0 }));
  ws.emit('message', JSON.stringify({ t: 'u', b: 'l' }));
  await tick();

  const moves = relay.events.filter((e) => e.t === 'm').length;
  assert.ok(moves <= 240, `movimentos limitados (${moves})`);
  assert.deepEqual(relay.events.at(-1), { t: 'u', b: 'l' });
  ws.close(1000);
});

test('falha ao conectar no PC vira mensagem de erro para o celular', async () => {
  const ws = fakeWs();
  handleTouchConnection(ws, { authenticate: () => 'ok', relay: fakeRelay({ openError: 'PC fora do ar' }) });
  ws.emit('message', JSON.stringify({ t: 'auth', token: 'x' }));
  await tick();
  assert.deepEqual(ws.sent, [{ t: 'error', code: 'relay', message: 'PC fora do ar' }]);
  assert.equal(ws.closedWith, 4002);
});
