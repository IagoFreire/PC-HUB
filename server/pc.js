import { execFile } from 'node:child_process';
import { HttpError } from './http-error.js';
import { sendMagicPacket } from './wol.js';

const PROBE_TIMEOUT_MS = 1500;
// O agente só responde depois que o shutdown.exe confirma; isso passa fácil de 1,5 s.
const POWER_TIMEOUT_MS = 10_000;
// Erros em que o comando já saiu e a resposta se perdeu (ex.: o Windows derrubou a conexão ao desligar).
const UNCONFIRMED_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
const CACHE_MS = 1500;
const WAKE_WINDOW_MS = 3 * 60_000;
const SHUTDOWN_WINDOW_MS = 2 * 60_000;

export const POWER_ACTIONS = Object.freeze(['shutdown', 'restart']);

export function ping(ip, timeoutMs = PROBE_TIMEOUT_MS) {
  const platform = process.platform;
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  const args = platform === 'win32'
    ? ['-n', '1', '-w', String(timeoutMs), ip]
    : platform === 'darwin'
      ? ['-c', '1', '-t', seconds, ip]
      : ['-c', '1', '-W', seconds, ip];

  return new Promise((resolve) => {
    execFile('ping', args, { timeout: timeoutMs + 1000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      // No Windows o ping sai com 0 até em "host inacessível"; só "TTL=" prova uma resposta.
      resolve(platform === 'win32' ? /ttl[=<]/i.test(stdout) : true);
    });
  });
}

/** O comando pode ter sido executado mesmo sem resposta: timeout ou conexão cortada no meio. */
export function commandMayHaveRun(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  return UNCONFIRMED_CODES.has(err?.cause?.code ?? err?.code);
}

function nextPending(pending, { online, uptimeSec }, at) {
  if (!pending || at > pending.until) return null;
  if (pending.kind === 'waking' && online) return null;
  if (pending.kind === 'shutting-down' && !online) return null;
  if (pending.kind === 'restarting') {
    if (!online) return { kind: 'waking', until: at + WAKE_WINDOW_MS };
    // Reboot rápido demais para o polling ver o PC offline: o uptime zerado denuncia.
    if (Number.isFinite(uptimeSec) && Number.isFinite(pending.uptimeBefore) && uptimeSec < pending.uptimeBefore) return null;
  }
  return pending;
}

export function createPcMonitor({
  pc,
  fetchImpl = fetch,
  pingImpl = ping,
  sendPacket = sendMagicPacket,
  now = Date.now,
}) {
  let snapshot = null;
  let inflight = null;
  let lastSeenAt = null;
  let pending = null;

  function callAgent(path, { method = 'GET', body, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    return fetchImpl(`http://${pc.ip}:${pc.agentPort}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${pc.agentSecret}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function probeAgent() {
    const started = now();
    try {
      const res = await callAgent('/health');
      const latencyMs = now() - started;
      if (res.status === 401) return { reachable: true, agent: 'unauthorized', latencyMs };
      if (!res.ok) return { reachable: true, agent: 'error', latencyMs };
      const data = await res.json();
      return {
        reachable: true,
        agent: 'ok',
        latencyMs,
        uptimeSec: Number.isFinite(data?.uptimeSec) ? data.uptimeSec : null,
        hostname: typeof data?.hostname === 'string' ? data.hostname : null,
      };
    } catch {
      // Timeout ou conexão recusada: o PC está desligado ou o agente não está rodando.
      return { reachable: false, agent: 'unreachable', latencyMs: null };
    }
  }

  async function refresh() {
    const [agentResult, pingAlive] = await Promise.all([probeAgent(), pingImpl(pc.ip)]);
    const checkedAt = now();
    const online = agentResult.reachable || pingAlive;
    if (online) lastSeenAt = checkedAt;
    pending = nextPending(pending, { online, uptimeSec: agentResult.uptimeSec }, checkedAt);
    snapshot = {
      online,
      agent: agentResult.agent,
      latencyMs: agentResult.latencyMs,
      uptimeSec: agentResult.uptimeSec ?? null,
      hostname: agentResult.hostname ?? null,
      checkedAt,
    };
    return snapshot;
  }

  async function getStatus() {
    if (!snapshot || now() - snapshot.checkedAt > CACHE_MS) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return {
      ...snapshot,
      lastSeenAt,
      pending: pending?.kind ?? null,
      pc: { name: pc.name, ip: pc.ip, mac: pc.mac },
    };
  }

  async function wake() {
    const result = await sendPacket(pc);
    pending = { kind: 'waking', until: now() + WAKE_WINDOW_MS };
    return result;
  }

  async function power(action) {
    if (!POWER_ACTIONS.includes(action)) {
      throw new HttpError(400, `Ação inválida. Use: ${POWER_ACTIONS.join(', ')}`);
    }

    const markPending = () => {
      pending = {
        kind: action === 'restart' ? 'restarting' : 'shutting-down',
        until: now() + SHUTDOWN_WINDOW_MS,
        uptimeBefore: snapshot?.uptimeSec ?? null,
      };
    };

    let res;
    try {
      res = await callAgent('/power', { method: 'POST', body: { action }, timeoutMs: POWER_TIMEOUT_MS });
    } catch (err) {
      if (commandMayHaveRun(err)) {
        // Sem confirmação, mas provavelmente executou; o monitoramento confirma se o PC caiu.
        markPending();
        return { action, confirmed: false };
      }
      throw new HttpError(502, 'Não consegui falar com o agente no PC. Ele está ligado e com o agente instalado?');
    }
    if (res.status === 401) {
      throw new HttpError(502, 'O segredo do agente não confere com o config.json.');
    }
    if (!res.ok) {
      throw new HttpError(502, `O agente recusou o comando (HTTP ${res.status}).`);
    }

    markPending();
    return { action, confirmed: true };
  }

  return Object.freeze({ getStatus, wake, power });
}
