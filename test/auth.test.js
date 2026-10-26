import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearerToken, createAuthGuard, tokensMatch } from '../server/auth.js';

test('bearerToken extrai o token do header', () => {
  assert.equal(bearerToken('Bearer abc123'), 'abc123');
  assert.equal(bearerToken('bearer   abc123 '), 'abc123');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
});

test('tokensMatch compara com segurança, inclusive tamanhos diferentes', () => {
  assert.equal(tokensMatch('segredo', 'segredo'), true);
  assert.equal(tokensMatch('segred', 'segredo'), false);
  assert.equal(tokensMatch(null, 'segredo'), false);
});

test('guard bloqueia o cliente após 10 erros e libera depois da janela', () => {
  const clock = { t: 0 };
  const guard = createAuthGuard('segredo', { now: () => clock.t });

  for (let i = 0; i < 10; i++) assert.equal(guard.check('1.2.3.4', 'Bearer errado'), 'denied');
  assert.equal(guard.check('1.2.3.4', 'Bearer segredo'), 'locked');
  assert.equal(guard.check('5.6.7.8', 'Bearer segredo'), 'ok');

  clock.t += 16 * 60_000;
  assert.equal(guard.check('1.2.3.4', 'Bearer segredo'), 'ok');
});

test('acerto zera a contagem de erros', () => {
  const guard = createAuthGuard('segredo', { now: () => 0 });
  for (let i = 0; i < 9; i++) guard.check('ip', 'Bearer errado');
  assert.equal(guard.check('ip', 'Bearer segredo'), 'ok');
  for (let i = 0; i < 9; i++) assert.equal(guard.check('ip', 'Bearer errado'), 'denied');
});
