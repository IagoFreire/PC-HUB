import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CA_DOWNLOAD_PATH, createRedirectServer, hostnameOf } from '../server/redirect.js';

const CA = Buffer.from('certificado-falso');
let server;
let base;

before(async () => {
  server = createRedirectServer({ httpsPort: 8443, caCert: CA });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('redireciona qualquer página para o mesmo caminho em HTTPS', async () => {
  const res = await fetch(`${base}/trackpad?x=1`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://127.0.0.1:8443/trackpad?x=1');
});

test('entrega a CA local como perfil para o iPhone instalar', async () => {
  const res = await fetch(`${base}${CA_DOWNLOAD_PATH}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-x509-ca-cert');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), CA);
});

test('hostnameOf tira a porta e recusa hosts esquisitos', () => {
  assert.equal(hostnameOf('192.168.0.5:8080'), '192.168.0.5');
  assert.equal(hostnameOf('notebook.local'), 'notebook.local');
  assert.equal(hostnameOf('[fe80::1]:8080'), '[fe80::1]');
  assert.equal(hostnameOf('evil.com/x'), null);
  assert.equal(hostnameOf('a b'), null);
  assert.equal(hostnameOf(undefined), null);
});
