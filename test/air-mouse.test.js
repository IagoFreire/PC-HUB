import assert from 'node:assert/strict';
import { test } from 'node:test';
import { motionToCursor, rotationAxes, rotationLayoutFor, upVector } from '../public/air-mouse.js';

const FLAT = { x: 0, y: 0, z: 9.81 };          // deitado, tela para cima (convenção da especificação)
const FLAT_IOS = { x: 0, y: 0, z: -9.81 };     // o mesmo, com o sinal que o iPhone reporta
const UPRIGHT = { x: 0, y: 9.81, z: 0 };       // em pé, tela para o usuário
const UPRIGHT_IOS = { x: 0, y: -9.81, z: 0 };
const DT = 1 / 60;

// Giros físicos descritos pelos eixos do aparelho, convertidos para o formato de cada navegador.
const spec = ({ x = 0, y = 0, z = 0 }) => ({ alpha: z, beta: x, gamma: y });
const webkit = ({ x = 0, y = 0, z = 0 }) => ({ alpha: x, beta: y, gamma: z });

test('detecta a ordem de eixos do iPhone pelo requestPermission', () => {
  assert.equal(rotationLayoutFor({ requestPermission: () => {} }), 'webkit');
  assert.equal(rotationLayoutFor(function DeviceMotionEvent() {}), 'spec');
  assert.equal(rotationLayoutFor(undefined), 'spec');
  assert.deepEqual(rotationAxes({ alpha: 1, beta: 2, gamma: 3 }, 'webkit'), { x: 1, y: 2, z: 3 });
  assert.deepEqual(rotationAxes({ alpha: 1, beta: 2, gamma: 3 }, 'spec'), { x: 2, y: 3, z: 1 });
});

for (const [name, format, layout, flat, upright] of [
  ['especificação', spec, 'spec', FLAT, UPRIGHT],
  ['iPhone (WebKit)', webkit, 'webkit', FLAT_IOS, UPRIGHT_IOS],
]) {
  test(`${name}: inclinar o topo para cima sobe o cursor, sem andar para os lados`, () => {
    const { dx, dy } = motionToCursor(format({ x: 60 }), flat, DT, layout);
    assert.ok(dy < 0, `dy=${dy}`);
    assert.equal(dx, 0);
  });

  test(`${name}: deitado, girar para a esquerda leva o cursor para a esquerda, sem subir`, () => {
    const { dx, dy } = motionToCursor(format({ z: 60 }), flat, DT, layout);
    assert.ok(dx < 0, `dx=${dx}`);
    assert.equal(dy, 0);
  });

  test(`${name}: em pé, girar para a esquerda também leva para a esquerda`, () => {
    const { dx, dy } = motionToCursor(format({ y: 60 }), upright, DT, layout);
    assert.ok(dx < 0, `dx=${dx}`);
    assert.equal(dy, 0);
  });
}

test('relatado no iPhone: inclinar para cima NÃO pode mover o cursor para a esquerda', () => {
  // O iPhone manda a inclinação em alpha; antes era lida como giro horizontal.
  const { dx, dy } = motionToCursor({ alpha: 60, beta: 0, gamma: 0 }, FLAT_IOS, DT, 'webkit');
  assert.equal(dx, 0);
  assert.ok(dy < 0);
});

test('o "para cima" independe do sinal da gravidade do navegador', () => {
  assert.deepEqual(upVector(FLAT), upVector(FLAT_IOS));
  assert.deepEqual(upVector(UPRIGHT), upVector(UPRIGHT_IOS));
  assert.equal(upVector({ x: 0, y: 0, z: 0.5 }), null);
});

test('tremor abaixo da zona morta não mexe o cursor', () => {
  assert.deepEqual(motionToCursor(spec({ x: 1, y: -1.2, z: 0.5 }), FLAT, DT), { dx: 0, dy: 0 });
});

test('girar rápido vai proporcionalmente mais longe (aceleração)', () => {
  const slow = Math.abs(motionToCursor(spec({ z: 20 }), FLAT, DT).dx);
  const fast = Math.abs(motionToCursor(spec({ z: 200 }), FLAT, DT).dx);
  assert.ok(fast / slow > 10, `esperava mais que linear (${fast / slow})`);
});

test('sem gravidade confiável assume deitado; entradas inválidas não movem', () => {
  assert.ok(motionToCursor(spec({ z: 60 }), null, DT).dx < 0);
  assert.deepEqual(motionToCursor(spec({ z: 60 }), FLAT, 0), { dx: 0, dy: 0 });
  assert.deepEqual(motionToCursor(null, FLAT, DT), { dx: 0, dy: 0 });
});

test('um engasgo longo entre leituras não vira um salto do cursor', () => {
  const normal = motionToCursor(spec({ z: 60 }), FLAT, 0.05).dx;
  const hiccup = motionToCursor(spec({ z: 60 }), FLAT, 2).dx;
  assert.equal(hiccup, normal);
});
