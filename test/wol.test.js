import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { buildMagicPacket, sendMagicPacket } from '../server/wol.js';

function fakeSocketFactory({ failAddress } = {}) {
  const sent = [];
  const state = { closed: false, broadcast: false };
  const createSocket = () => Object.assign(new EventEmitter(), {
    bind: (cb) => cb(),
    setBroadcast: (on) => { state.broadcast = on; },
    send: (packet, port, address, cb) => {
      sent.push({ packet, port, address });
      cb(address === failAddress ? new Error('EACCES') : null);
    },
    close: () => { state.closed = true; },
  });
  return { createSocket, sent, state };
}

test('buildMagicPacket gera 6 bytes 0xFF + MAC 16 vezes', () => {
  const packet = buildMagicPacket('B0:82:E2:4C:1F:EF');
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], Array(6).fill(0xff));
  for (let i = 0; i < 16; i++) {
    assert.equal(packet.subarray(6 + i * 6, 12 + i * 6).toString('hex'), 'b082e24c1fef');
  }
});

test('sendMagicPacket envia para o broadcast da rede e o global, nas portas 9 e 7', async () => {
  const fake = fakeSocketFactory();
  const result = await sendMagicPacket({ mac: 'B0:82:E2:4C:1F:EF', broadcast: '192.168.0.255' }, fake);

  assert.equal(result.delivered, 12);
  assert.ok(fake.state.broadcast);
  assert.ok(fake.state.closed);
  assert.deepEqual(new Set(fake.sent.map((s) => s.address)), new Set(['192.168.0.255', '255.255.255.255']));
  assert.deepEqual(new Set(fake.sent.map((s) => s.port)), new Set([9, 7]));
});

test('sendMagicPacket tem sucesso se ao menos um destino aceitar', async () => {
  const fake = fakeSocketFactory({ failAddress: '255.255.255.255' });
  const result = await sendMagicPacket({ mac: 'B0:82:E2:4C:1F:EF', broadcast: '192.168.0.255' }, fake);
  assert.equal(result.delivered, 6);
  assert.equal(result.attempted, 12);
});

test('sendMagicPacket falha quando nenhum envio funciona', async () => {
  const fake = fakeSocketFactory({ failAddress: '255.255.255.255' });
  await assert.rejects(
    sendMagicPacket({ mac: 'B0:82:E2:4C:1F:EF', broadcast: '255.255.255.255' }, fake),
    /EACCES/,
  );
  assert.ok(fake.state.closed);
});
