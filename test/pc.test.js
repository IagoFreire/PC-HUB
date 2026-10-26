import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPcMonitor } from '../server/pc.js';

const pc = Object.freeze({
  name: 'PC', ip: '192.168.0.10', mac: 'B0:82:E2:4C:1F:EF',
  broadcast: '192.168.0.255', agentPort: 7777, agentSecret: 's'.repeat(32),
});

function harness({ agent = 'ok', pingAlive = false } = {}) {
  const clock = { t: 1_000_000 };
  const calls = [];
  const world = { agent, pingAlive, uptime: 120 };

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (world.powerError && url.endsWith('/power')) throw world.powerError;
    if (world.agent === 'down') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (world.agent === 'unauthorized') return new Response('{}', { status: 401 });
    if (url.endsWith('/health')) return Response.json({ ok: true, uptimeSec: world.uptime, hostname: 'DESKTOP' });
    return Response.json({ ok: true }, { status: 202 });
  };

  const monitor = createPcMonitor({
    pc,
    fetchImpl,
    pingImpl: async () => world.pingAlive,
    sendPacket: async () => ({ delivered: 12 }),
    now: () => clock.t,
  });

  const tick = (ms) => { clock.t += ms; };
  return { monitor, world, calls, tick };
}

test('PC com agente respondendo aparece ligado, com uptime', async () => {
  const { monitor, calls } = harness();
  const status = await monitor.getStatus();

  assert.equal(status.online, true);
  assert.equal(status.agent, 'ok');
  assert.equal(status.uptimeSec, 120);
  assert.equal(status.lastSeenAt, status.checkedAt);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${pc.agentSecret}`);
  assert.equal(status.pc.agentSecret, undefined);
});

test('sem agente, mas respondendo ping, aparece ligado com agente indisponível', async () => {
  const { monitor } = harness({ agent: 'down', pingAlive: true });
  const status = await monitor.getStatus();
  assert.equal(status.online, true);
  assert.equal(status.agent, 'unreachable');
});

test('sem agente e sem ping aparece desligado', async () => {
  const { monitor } = harness({ agent: 'down' });
  const status = await monitor.getStatus();
  assert.equal(status.online, false);
  assert.equal(status.lastSeenAt, null);
});

test('segredo errado no agente é reportado como unauthorized', async () => {
  const { monitor } = harness({ agent: 'unauthorized' });
  assert.equal((await monitor.getStatus()).agent, 'unauthorized');
});

test('status é reaproveitado por um curto intervalo', async () => {
  const { monitor, calls, tick } = harness();
  await monitor.getStatus();
  await monitor.getStatus();
  assert.equal(calls.length, 1);
  tick(2000);
  await monitor.getStatus();
  assert.equal(calls.length, 2);
});

test('wake marca "waking" até o PC responder', async () => {
  const { monitor, world, tick } = harness({ agent: 'down' });
  await monitor.wake();
  assert.equal((await monitor.getStatus()).pending, 'waking');

  world.agent = 'ok';
  tick(2000);
  const status = await monitor.getStatus();
  assert.equal(status.online, true);
  assert.equal(status.pending, null);
});

test('wake expira se o PC nunca ligar', async () => {
  const { monitor, tick } = harness({ agent: 'down' });
  await monitor.wake();
  tick(4 * 60_000);
  assert.equal((await monitor.getStatus()).pending, null);
});

test('shutdown envia o comando ao agente e fica "shutting-down" até cair', async () => {
  const { monitor, world, calls, tick } = harness();
  await monitor.power('shutdown');

  const powerCall = calls.find((c) => c.url.endsWith('/power'));
  assert.equal(powerCall.init.method, 'POST');
  assert.deepEqual(JSON.parse(powerCall.init.body), { action: 'shutdown' });
  assert.equal((await monitor.getStatus()).pending, 'shutting-down');

  world.agent = 'down';
  tick(2000);
  assert.equal((await monitor.getStatus()).pending, null);
});

test('restart passa por desligado e volta a "waking"', async () => {
  const { monitor, world, tick } = harness();
  await monitor.power('restart');
  assert.equal((await monitor.getStatus()).pending, 'restarting');

  world.agent = 'down';
  tick(2000);
  assert.equal((await monitor.getStatus()).pending, 'waking');

  world.agent = 'ok';
  tick(2000);
  assert.equal((await monitor.getStatus()).pending, null);
});

test('restart rápido demais para ver offline é detectado pelo uptime menor', async () => {
  const { monitor, world, tick } = harness();
  await monitor.getStatus();
  await monitor.power('restart');

  world.uptime = 15;
  tick(2000);
  assert.equal((await monitor.getStatus()).pending, null);
});

test('shutdown sem resposta por timeout conta como enviado e fica "shutting-down"', async () => {
  const { monitor, world } = harness();
  world.powerError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  const result = await monitor.power('shutdown');
  assert.equal(result.confirmed, false);
  assert.equal((await monitor.getStatus()).pending, 'shutting-down');
});

test('shutdown com conexão cortada pelo Windows conta como enviado', async () => {
  const { monitor, world } = harness();
  world.powerError = new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
  assert.equal((await monitor.power('shutdown')).confirmed, false);
});

test('comando confirmado pelo agente vem com confirmed: true e timeout longo', async () => {
  const { monitor, calls } = harness();
  assert.equal((await monitor.power('shutdown')).confirmed, true);
  assert.ok(calls.find((c) => c.url.endsWith('/power')).init.signal instanceof AbortSignal);
});

test('power rejeita ação desconhecida com 400', async () => {
  const { monitor } = harness();
  await assert.rejects(monitor.power('format-c'), (err) => err.status === 400);
});

test('power falha com 502 quando o agente está fora ou recusa o segredo', async () => {
  await assert.rejects(harness({ agent: 'down' }).monitor.power('shutdown'), (err) => err.status === 502);
  await assert.rejects(harness({ agent: 'unauthorized' }).monitor.power('shutdown'), /segredo/);
});
