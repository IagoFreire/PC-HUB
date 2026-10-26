import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveBroadcast, loadConfig, normalizeMac, validateConfig } from '../server/config.js';

const validRaw = () => ({
  accessToken: 'codigo-secreto',
  pc: { mac: 'b0-82-e2-4c-1f-ef', ip: '192.168.0.10', agentSecret: 'x'.repeat(32) },
});

test('normalizeMac aceita hífens, dois-pontos ou nada e devolve maiúsculo com dois-pontos', () => {
  assert.equal(normalizeMac('b0-82-e2-4c-1f-ef'), 'B0:82:E2:4C:1F:EF');
  assert.equal(normalizeMac('B082E24C1FEF'), 'B0:82:E2:4C:1F:EF');
});

test('normalizeMac rejeita MAC curto ou com caracteres inválidos', () => {
  assert.throws(() => normalizeMac('B0:82:E2:4C:1F'), /MAC inválido/);
  assert.throws(() => normalizeMac('ZZ:82:E2:4C:1F:EF'), /MAC inválido/);
  assert.throws(() => normalizeMac(undefined), /MAC inválido/);
});

test('deriveBroadcast troca o último octeto por 255', () => {
  assert.equal(deriveBroadcast('192.168.200.108'), '192.168.200.255');
});

test('validateConfig aplica padrões e deriva o broadcast', () => {
  const config = validateConfig(validRaw());
  assert.equal(config.port, 8080);
  assert.equal(config.pc.agentPort, 7777);
  assert.equal(config.pc.broadcast, '192.168.0.255');
  assert.equal(config.pc.mac, 'B0:82:E2:4C:1F:EF');
  assert.equal(config.pc.name, 'Meu PC');
  assert.ok(Object.isFrozen(config.pc));
});

test('loadConfig lê JSON com BOM e explica arquivo ausente ou inválido', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aurora-'));
  const good = path.join(dir, 'good.json');
  const bad = path.join(dir, 'bad.json');
  writeFileSync(good, `﻿${JSON.stringify(validRaw())}`);
  writeFileSync(bad, '{ quebrado');

  assert.equal(loadConfig(good).pc.ip, '192.168.0.10');
  assert.throws(() => loadConfig(bad), /não é um JSON válido/);
  assert.throws(() => loadConfig(path.join(dir, 'nao-existe.json')), /config.example.json/);
});

test('validateConfig aceita tls opcional com porta padrão 8443', () => {
  const config = validateConfig({ ...validRaw(), tls: { pfx: 'certs/aurora.pfx', passphrase: 'x' } });
  assert.deepEqual({ ...config.tls }, { port: 8443, pfx: 'certs/aurora.pfx', passphrase: 'x', ca: null });
  assert.equal(validateConfig(validRaw()).tls, null);
});

test('validateConfig recusa tls incompleto ou na mesma porta do http', () => {
  assert.throws(
    () => validateConfig({ ...validRaw(), port: 8443, tls: { port: 8443, passphrase: 1 } }),
    (err) => ['tls.pfx', 'tls.passphrase', 'tls.port'].every((field) => err.message.includes(field)),
  );
});

test('validateConfig aceita ups opcional e normaliza a url', () => {
  const config = validateConfig({ ...validRaw(), ups: { url: 'http://192.168.0.7:4470/qualquer', id: '0001521C0A' } });
  assert.deepEqual({ ...config.ups }, { url: 'http://192.168.0.7:4470', id: '0001521C0A', powerFactor: 0.95 });
  assert.equal(validateConfig(validRaw()).ups, null);
  assert.throws(
    () => validateConfig({ ...validRaw(), ups: { url: 'file:///c:/x', id: '../x', powerFactor: 2 } }),
    /ups\.url[\s\S]*ups\.id[\s\S]*ups\.powerFactor/,
  );
  assert.equal(validateConfig({ ...validRaw(), ups: { url: 'http://x:4470', powerFactor: 0.7 } }).ups.powerFactor, 0.7);
});

test('validateConfig lista todos os problemas de uma vez', () => {
  assert.throws(
    () => validateConfig({ accessToken: '123', port: 70000, pc: { mac: 'x', ip: '999.1.1.1', agentSecret: 'curto' } }),
    (err) => ['accessToken', 'port', 'pc.mac', 'pc.ip', 'pc.agentSecret'].every((field) => err.message.includes(field)),
  );
});
