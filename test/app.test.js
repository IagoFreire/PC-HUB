import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { HttpError } from '../server/http-error.js';
import { resolvePublicPath } from '../server/static.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TOKEN = 'codigo-de-teste';
const auth = { Authorization: `Bearer ${TOKEN}` };

const actions = [];
const monitor = {
  getStatus: async () => ({ online: true, agent: 'ok', pending: null }),
  wake: async () => { actions.push('wake'); },
  power: async (action) => {
    if (action !== 'shutdown') throw new HttpError(400, 'Ação inválida.');
    actions.push(action);
  },
};

let server;
let base;

before(async () => {
  server = createApp({
    config: { accessToken: TOKEN, pc: { mac: 'B0:82:E2:4C:1F:EF', broadcast: '192.168.0.255' } },
    monitor,
    publicDir,
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('API exige o código de acesso', async () => {
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /incorreto/);
});

test('GET /api/status devolve o status com no-store', async () => {
  const res = await fetch(`${base}/api/status`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).online, true);
});

test('POST /api/wake e /api/power acionam o monitor', async () => {
  assert.equal((await fetch(`${base}/api/wake`, { method: 'POST', headers: auth })).status, 202);
  const res = await fetch(`${base}/api/power`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'shutdown' }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(actions, ['wake', 'shutdown']);
});

test('POST /api/power repassa erros de validação e JSON inválido', async () => {
  const bad = await fetch(`${base}/api/power`, { method: 'POST', headers: auth, body: '{"action":"x"}' });
  assert.equal(bad.status, 400);
  const broken = await fetch(`${base}/api/power`, { method: 'POST', headers: auth, body: '{nope' });
  assert.equal(broken.status, 400);
  const huge = await fetch(`${base}/api/power`, { method: 'POST', headers: auth, body: 'x'.repeat(5000) });
  assert.equal(huge.status, 413);
});

test('rota de API desconhecida dá 404', async () => {
  assert.equal((await fetch(`${base}/api/nada`, { headers: auth })).status, 404);
});

test('serve o PWA com cabeçalhos de segurança', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('não deixa sair da pasta public', async () => {
  // O parser de URL já colapsa "..", então estes ficam presos dentro de public/.
  assert.equal(resolvePublicPath(publicDir, '/../config.json'), path.join(publicDir, 'config.json'));
  assert.equal(resolvePublicPath(publicDir, '/%2e%2e/config.json'), path.join(publicDir, 'config.json'));
  // Barra invertida codificada só vira separador depois do decode — tem que ser barrada.
  assert.equal(resolvePublicPath(publicDir, '/..%5cconfig.json'), path.sep === '\\' ? null : path.join(publicDir, '..\\config.json'));
  assert.equal(resolvePublicPath(publicDir, '/%E0%A4%A'), null);
  assert.equal(resolvePublicPath(publicDir, '/a%00.html'), null);
  assert.equal((await fetch(`${base}/..%5cconfig.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
});
