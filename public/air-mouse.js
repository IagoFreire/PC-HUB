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
 * Pela especificação, um aparelho deitado de tela para cima mede accelerationIncludingGravity.z ≈ +9,8.
 * O Safari do iOS mede o contrário (-9,8). O iOS é o único com DeviceMotionEvent.requestPermission.
 */
export function gravitySignFor(DeviceMotionEventCtor) {
  return typeof DeviceMotionEventCtor?.requestPermission === 'function' ? -1 : 1;
}

/** Vetor unitário "para cima" no referencial do aparelho, ou null se a gravidade não for confiável. */
export function upVector(gravity, gravitySign = 1) {
  const x = (gravity?.x ?? 0) * gravitySign;
  const y = (gravity?.y ?? 0) * gravitySign;
  const z = (gravity?.z ?? 0) * gravitySign;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < MIN_GRAVITY) return null;
  return { x: x / length, y: y / length, z: z / length };
}

function rateToPixels(rateDegPerSec, dt) {
  const magnitude = Math.abs(rateDegPerSec);
  if (!Number.isFinite(magnitude) || magnitude < DEADZONE_DEG_S) return 0;
  const effective = magnitude - DEADZONE_DEG_S;
  const accel = 1 + ACCEL_GAIN * Math.min(effective / ACCEL_REF_DEG_S, ACCEL_MAX);
  return Math.sign(rateDegPerSec) * effective * dt * PX_PER_DEG * accel;
}

/**
 * rate: rotationRate do devicemotion em graus/s (alpha = eixo z, beta = eixo x, gamma = eixo y).
 * Horizontal: giro em torno da vertical do mundo (projeção na gravidade), então funciona
 * com o celular deitado na mão ou em pé, sem calibrar. Vertical: inclinar o topo (eixo x).
 */
export function motionToCursor(rate, gravity, dt, gravitySign = 1) {
  if (!rate || !(dt > 0)) return { dx: 0, dy: 0 };
  const seconds = Math.min(dt, MAX_MOTION_DT_S);
  const up = upVector(gravity, gravitySign) ?? { x: 0, y: 0, z: 1 };
  const beta = rate.beta ?? 0;
  const yaw = beta * up.x + (rate.gamma ?? 0) * up.y + (rate.alpha ?? 0) * up.z;
  // Girar para a esquerda (anti-horário visto de cima) e inclinar para cima são rotações positivas.
  // "0 -" em vez de "-": evita devolver -0 quando não há movimento.
  return { dx: 0 - rateToPixels(yaw, seconds), dy: 0 - rateToPixels(beta, seconds) };
}
