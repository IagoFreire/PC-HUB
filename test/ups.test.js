import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUpsMonitor, describeEvents, describeUps } from '../server/ups.js';

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

/* ---------- eventos e quedas de energia ---------- */

const MIN = 60_000;
const log = (minute, event, cBattery = 100) => ({ dateTime: 1_792_000_000_000 + minute * MIN, event, vars: { cBattery } });

test('describeEvents junta ida para a bateria e volta da rede numa queda, mais recente primeiro', () => {
  const { outages, events, totalEvents } = describeEvents([
    log(0, 0),
    log(10, 10), log(10, 24),              // caiu (bateria + ausência de rede no mesmo instante)
    log(13, 18), log(13, 11, 97.6),        // voltou depois de 3 min, bateria em 98%
    log(60, 10),
    log(61.5, 11, 99.2),                   // queda curta de 90 s
  ]);
  assert.equal(totalEvents, 7);
  assert.equal(outages.length, 2);
  assert.deepEqual(outages[0], { start: log(60).dateTime, lowestBattery: 99, end: log(61.5).dateTime, durationSec: 90 });
  assert.deepEqual(outages[1], { start: log(10).dateTime, lowestBattery: 98, end: log(13).dateTime, durationSec: 180 });
  assert.equal(events[0].text, 'Voltou para a rede');
  assert.equal(events[0].kind, 'restore');
  assert.equal(events.at(-1).text, 'Início do monitoramento');
});

test('queda sem volta registrada: em andamento só se o nobreak está na bateria agora', () => {
  const logs = [log(0, 10), log(5, 24)];
  assert.equal(describeEvents(logs, 'battery').outages[0].ongoing, true);
  assert.equal(describeEvents(logs, 'line').outages[0].ongoing, false);
  assert.equal(describeEvents(logs, 'battery').outages[0].durationSec, null);
});

test('describeEvents ordena, ignora lixo e nomeia códigos desconhecidos', () => {
  const { events, outages } = describeEvents([log(5, 99), { event: 10 }, null, log(1, 5)]);
  assert.deepEqual(events.map((e) => e.text), ['Evento 99', 'Falha de sobrecarga']);
  assert.equal(events[1].kind, 'problem');
  assert.deepEqual(outages, []);
  assert.deepEqual(describeEvents(undefined), { outages: [], events: [], totalEvents: 0 });
});

test('monitor lê o log do Supervise e guarda por 30 s', async () => {
  const clock = { t: 0 };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/log')) return Response.json({ logs: [log(0, 10), log(2, 11)] });
    return Response.json({ device: realDevice() });
  };
  const monitor = createUpsMonitor({ url: 'http://supervise:4470', id: '0001521C0A', fetchImpl, now: () => clock.t });

  const first = await monitor.getEvents();
  assert.equal(first.available, true);
  assert.equal(first.outages[0].durationSec, 120);
  await monitor.getEvents();
  assert.equal(calls.filter((p) => p.endsWith('/log')).length, 1);

  clock.t += 31_000;
  await monitor.getEvents();
  assert.equal(calls.filter((p) => p.endsWith('/log')).length, 2);
});
