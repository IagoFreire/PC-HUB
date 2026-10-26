// Air mouse: converte o giroscópio do celular em movimento do cursor.
// Sem DOM aqui, para dar para testar com node --test.

const DEADZONE_DEG_S = 1.5;      // abaixo disso é tremor da mão
const PX_PER_DEG = 18;           // graus girados -> pixels (~60° de pulso cruzam uma tela Full HD)
const ACCEL_GAIN = 0.8;          // girar rápido vai proporcionalmente mais longe
const ACCEL_REF_DEG_S = 90;
const ACCEL_MAX = 2;
const MIN_GRAVITY = 3;           // m/s²; menos que isso a leitura de gravidade não é confiável
export const MAX_MOTION_DT_S = 0.05;

/**
 * Ordem dos eixos em rotationRate. A especificação (Chrome/Android) usa alpha = eixo z,
 * beta = eixo x e gamma = eixo y. O WebKit do iPhone entrega alpha = x, beta = y e gamma = z.
 * O iOS é o único com DeviceMotionEvent.requestPermission, então serve para detectar.
 */
export function rotationLayoutFor(DeviceMotionEventCtor) {
  return typeof DeviceMotionEventCtor?.requestPermission === 'function' ? 'webkit' : 'spec';
}

/** Velocidade de giro (graus/s) em torno dos eixos x, y e z do aparelho. */
export function rotationAxes(rate, layout = 'spec') {
  return layout === 'webkit'
    ? { x: rate.alpha ?? 0, y: rate.beta ?? 0, z: rate.gamma ?? 0 }
    : { x: rate.beta ?? 0, y: rate.gamma ?? 0, z: rate.alpha ?? 0 };
}

/**
 * Vetor unitário "para cima" no referencial do aparelho, ou null se a gravidade não for confiável.
 * Os navegadores discordam no sinal da gravidade, então o sinal é deduzido do jeito de segurar:
 * a tela fica virada para cima ou para você e o topo do celular não aponta para o chão,
 * logo o "para cima" tem y + z positivo. Isso vale deitado (z) e em pé (y).
 */
export function upVector(gravity) {
  const x = gravity?.x ?? 0;
  const y = gravity?.y ?? 0;
  const z = gravity?.z ?? 0;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < MIN_GRAVITY) return null;
  const sign = y + z < 0 ? -1 : 1;
  // "+ 0" transforma -0 em 0 (inverter o sinal de um componente zerado gera -0).
  return { x: (sign * x) / length + 0, y: (sign * y) / length + 0, z: (sign * z) / length + 0 };
}

function rateToPixels(rateDegPerSec, dt) {
  const magnitude = Math.abs(rateDegPerSec);
  if (!Number.isFinite(magnitude) || magnitude < DEADZONE_DEG_S) return 0;
  const effective = magnitude - DEADZONE_DEG_S;
  const accel = 1 + ACCEL_GAIN * Math.min(effective / ACCEL_REF_DEG_S, ACCEL_MAX);
  return Math.sign(rateDegPerSec) * effective * dt * PX_PER_DEG * accel;
}

/**
 * Horizontal: giro em torno da vertical do mundo (projeção na gravidade), então funciona
 * com o celular deitado na mão ou em pé, sem calibrar. Vertical: inclinar o topo (eixo x).
 */
export function motionToCursor(rate, gravity, dt, layout = 'spec') {
  if (!rate || !(dt > 0)) return { dx: 0, dy: 0 };
  const seconds = Math.min(dt, MAX_MOTION_DT_S);
  const axes = rotationAxes(rate, layout);
  const up = upVector(gravity) ?? { x: 0, y: 0, z: 1 };
  const yaw = axes.x * up.x + axes.y * up.y + axes.z * up.z;
  // Girar para a esquerda (anti-horário visto de cima) e inclinar o topo para cima são rotações positivas.
  // "0 -" em vez de "-": evita devolver -0 quando não há movimento.
  return { dx: 0 - rateToPixels(yaw, seconds), dy: 0 - rateToPixels(axes.x, seconds) };
}
