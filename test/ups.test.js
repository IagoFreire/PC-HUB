import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpsMonitor, describeUps } from '../server/ups.js';

// Formato real devolvido pelo Supervise (valores de um Ragtech 1200 VA).
const realDevice = () => ({
  id: '0001521C0A',
  name: 'teste',
  userProd: '',
  last: '2026-10-26T13:24:58.377-03:00',
  regressive: { cause: 0, value: -1 },
  status: { connected: 1, syncInput: 1 },
  failures: {},
  vars: {
    cBattery: 100.21499633789062, fOutput: 59.5461311340332, iOutput: 2.5703508853912354,
    nominalPOutput: 1200, nominalVInput: 115, pOutput: 22, temperature: 54,
    vBattery: 13.333000183105469, vInput: 122.95999908447266, vOutput: 112.66500091552734,
  },
});

test('describeUps traduz os valores reais do Supervise', () => {
  const ups = describeUps(realDevice());
  assert.equal(ups.mode, 'line');
  assert.equal(ups.alert, null);
  assert.equal(ups.name, 'teste');
  assert.deepEqual(ups.input, { voltage: 123, nominalVoltage: 115 });
  assert.deepEqual(ups.output, { voltage: 112.7, frequency: 59.5, current: 2.57, loadPercent: 22, loadVA: 264, nominalVA: 1200 });
  assert.deepEqual(ups.battery, { voltage: 13.3, charge: 100 });
  assert.equal(ups.temperature, 54);
  assert.equal(ups.shutdownCountdownSec, null);
});

test('describeUps: na bateria vira aviso; falha tem prioridade e é crítica', () => {
  const onBattery = realDevice();
  onBattery.status = { connected: 1, opBattery: 1 };
  assert.equal(describeUps(onBattery).mode, 'battery');
  assert.deepEqual(describeUps(onBattery).alert, { level: 'warn', text: 'Funcionando na bateria' });

  onBattery.status.noVInput = 1;
  assert.equal(describeUps(onBattery).alert.text, 'Sem energia da rede');

  onBattery.failures = { overload: 1 };
  assert.deepEqual(describeUps(onBattery).alert, { level: 'critical', text: 'Sobrecarga na saída' });
});

test('describeUps: sem comunicação e valores ausentes não quebram', () => {
  const ups = describeUps({ status: { connected: 0 }, regressive: { value: 42 } });
  assert.equal(ups.mode, 'offline');
  assert.equal(ups.alert.level, 'warn');
  assert.equal(ups.input.voltage, null);
  assert.equal(ups.output.loadVA, null);
  assert.equal(ups.shutdownCountdownSec, 42);
  assert.equal(describeUps(undefined).mode, 'offline');
});

function fakeSupervise({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.pathname);
    if (fail) throw new Error('ECONNREFUSED');
    if (url.pathname === '/mon/1.1/device') return Response.json({ devices: [{ id: '0001521C0A' }] });
    return Response.json({ device: realDevice() });
  };
  return { calls, fetchImpl };
}

test('monitor descobre o nobreak sozinho e reaproveita a leitura por 2 s', async () => {
  const clock = { t: 0 };
  const supervise = fakeSupervise();
  const monitor = createUpsMonitor({ url: 'http://supervise:4470', fetchImpl: supervise.fetchImpl, now: () => clock.t });

  assert.equal((await monitor.getStatus()).output.loadVA, 264);
  await monitor.getStatus();
  assert.deepEqual(supervise.calls, ['/mon/1.1/device', '/mon/1.1/device/0001521C0A']);

  clock.t += 2500;
  await monitor.getStatus();
  assert.equal(supervise.calls.at(-1), '/mon/1.1/device/0001521C0A');
  assert.equal(supervise.calls.length, 3);
});

test('monitor com id no config vai direto ao nobreak', async () => {
  const supervise = fakeSupervise();
  const monitor = createUpsMonitor({ url: 'http://supervise:4470', id: '0001521C0A', fetchImpl: supervise.fetchImpl });
  await monitor.getStatus();
  assert.deepEqual(supervise.calls, ['/mon/1.1/device/0001521C0A']);
});

test('Supervise fora do ar vira available:false com explicação', async () => {
  const monitor = createUpsMonitor({ url: 'http://supervise:4470', fetchImpl: fakeSupervise({ fail: true }).fetchImpl });
  const status = await monitor.getStatus();
  assert.equal(status.available, false);
  assert.match(status.error, /Supervise/);
});
