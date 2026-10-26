import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
const MAX_TRACKED_CLIENTS = 1000;

const digest = (value) => createHash('sha256').update(String(value)).digest();

export function tokensMatch(given, expected) {
  return timingSafeEqual(digest(given ?? ''), digest(expected));
}

export function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match ? match[1].trim() : null;
}

/**
 * Valida o token e bloqueia temporariamente quem erra demais,
 * para que o código de acesso não possa ser adivinhado na força bruta.
 */
export function createAuthGuard(expectedToken, { now = Date.now } = {}) {
  const failures = new Map();

  function prune(at) {
    for (const [client, entry] of failures) {
      if (at - entry.firstAt > WINDOW_MS) failures.delete(client);
    }
  }

  function check(client, authorizationHeader) {
    const at = now();
    const entry = failures.get(client);
    const active = entry && at - entry.firstAt <= WINDOW_MS ? entry : null;
    if (active && active.count >= MAX_FAILURES) return 'locked';

    if (tokensMatch(bearerToken(authorizationHeader), expectedToken)) {
      failures.delete(client);
      return 'ok';
    }

    if (failures.size >= MAX_TRACKED_CLIENTS) prune(at);
    failures.set(client, active
      ? { firstAt: active.firstAt, count: active.count + 1 }
      : { firstAt: at, count: 1 });
    return 'denied';
  }

  return Object.freeze({ check });
}
