import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFrame, MAX_PAYLOAD_BYTES, parseFrame } from '../server/websocket.js';

function clientFrame(text, { opcode = 0x1, fin = true, masked = true } = {}) {
  const payload = Buffer.from(text);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const first = (fin ? 0x80 : 0) | opcode;
  const maskBit = masked ? 0x80 : 0;
  const header = payload.length < 126
    ? Buffer.from([first, maskBit | payload.length])
    : Buffer.from([first, maskBit | 126, payload.length >> 8, payload.length & 0xff]);
  const body = masked ? Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4])) : payload;
  return Buffer.concat(masked ? [header, mask, body] : [header, body]);
}

test('parseFrame desmascara um frame de texto do cliente', () => {
  const frame = parseFrame(clientFrame('{"t":"m"}'));
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.fin, true);
  assert.equal(frame.payload.toString(), '{"t":"m"}');
  assert.equal(frame.length, 2 + 4 + 9);
});

test('parseFrame lida com tamanho de 16 bits', () => {
  const text = 'x'.repeat(300);
  assert.equal(parseFrame(clientFrame(text)).payload.toString(), text);
});

test('parseFrame espera mais bytes quando o frame está incompleto', () => {
  const full = clientFrame('olá mundo');
  assert.equal(parseFrame(full.subarray(0, 1)), null);
  assert.equal(parseFrame(full.subarray(0, full.length - 1)), null);
});

test('parseFrame recusa frame sem máscara e payload grande demais', () => {
  assert.deepEqual(parseFrame(clientFrame('oi', { masked: false })), { error: 1002 });
  assert.deepEqual(parseFrame(clientFrame('x'.repeat(MAX_PAYLOAD_BYTES + 1))), { error: 1009 });
});

test('parseFrame recusa ping grande ou fragmentado (frames de controle)', () => {
  assert.deepEqual(parseFrame(clientFrame('x'.repeat(126), { opcode: 0x9 })), { error: 1002 });
  assert.deepEqual(parseFrame(clientFrame('oi', { opcode: 0x9, fin: false })), { error: 1002 });
  assert.equal(parseFrame(clientFrame('oi', { opcode: 0x9 })).opcode, 0x9);
});

test('encodeFrame gera frame do servidor sem máscara', () => {
  const small = encodeFrame(0x1, Buffer.from('ok'));
  assert.deepEqual([...small], [0x81, 2, 0x6f, 0x6b]);
  const medium = encodeFrame(0x1, Buffer.alloc(200));
  assert.deepEqual([...medium.subarray(0, 4)], [0x81, 126, 0, 200]);
});
