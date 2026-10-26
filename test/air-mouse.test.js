import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gravitySignFor, motionToCursor, upVector } from '../public/air-mouse.js';

const FLAT = { x: 0, y: 0, z: 9.81 };     // deitado, tela para cima (convenção da especificação)
const UPRIGHT = { x: 0, y: 9.81, z: 0 };  // em pé, tela para o usuário
const DT = 1 / 60;

test('celular deitado: girar para a esquerda move o cursor para a esquerda', () => {
  const { dx, dy } = motionToCursor({ alpha: 60, beta: 0, gamma: 0 }, FLAT, DT);
  assert.ok(dx < 0);
  assert.equal(dy, 0);
});

test('levantar o topo do celular move o cursor para cima', () => {
  const { dx, dy } = motionToCursor({ alpha: 0, beta: 60, gamma: 0 }, FLAT, DT);
  assert.ok(dy < 0);
  assert.equal(dx, 0);
});

test('celular em pé: o giro horizontal vem do eixo y (gamma), sem calibrar', () => {
  const upright = motionToCursor({ alpha: 0, beta: 0, gamma: 60 }, UPRIGHT, DT);
  const flat = motionToCursor({ alpha: 60, beta: 0, gamma: 0 }, FLAT, DT);
  assert.ok(upright.dx < 0);
  assert.ok(Math.abs(upright.dx - flat.dx) < 1e-9);
  // Em pé, girar em torno do eixo z (rolar o celular) não deve mexer o cursor na horizontal.
  assert.equal(motionToCursor({ alpha: 60, beta: 0, gamma: 0 }, UPRIGHT, DT).dx, 0);
});

test('tremor abaixo da zona morta não mexe o cursor', () => {
  assert.deepEqual(motionToCursor({ alpha: 1, beta: -1.2, gamma: 0.5 }, FLAT, DT), { dx: 0, dy: 0 });
});

test('girar rápido vai proporcionalmente mais longe (aceleração)', () => {
  const slow = Math.abs(motionToCursor({ alpha: 20, beta: 0, gamma: 0 }, FLAT, DT).dx);
  const fast = Math.abs(motionToCursor({ alpha: 200, beta: 0, gamma: 0 }, FLAT, DT).dx);
  assert.ok(fast / slow > 10, `esperava mais que linear (${fast / slow})`);
});

test('iOS mede a gravidade com sinal invertido e é corrigido pelo gravitySign', () => {
  assert.equal(gravitySignFor({ requestPermission: () => {} }), -1);
  assert.equal(gravitySignFor(function DeviceMotionEvent() {}), 1);
  assert.equal(gravitySignFor(undefined), 1);
  const iosFlat = { x: 0, y: 0, z: -9.81 };
  const ios = motionToCursor({ alpha: 60, beta: 0, gamma: 0 }, iosFlat, DT, -1);
  assert.ok(ios.dx < 0);
});

test('sem gravidade confiável assume deitado; dt inválido não move', () => {
  assert.equal(upVector({ x: 0, y: 0, z: 0.5 }), null);
  assert.ok(motionToCursor({ alpha: 60 }, null, DT).dx < 0);
  assert.deepEqual(motionToCursor({ alpha: 60 }, FLAT, 0), { dx: 0, dy: 0 });
  assert.deepEqual(motionToCursor(null, FLAT, DT), { dx: 0, dy: 0 });
});

test('um engasgo longo entre leituras não vira um salto do cursor', () => {
  const normal = motionToCursor({ alpha: 60 }, FLAT, 0.05).dx;
  const hiccup = motionToCursor({ alpha: 60 }, FLAT, 2).dx;
  assert.equal(hiccup, normal);
});
