// Nobreak Ragtech via Supervise (API local em /mon/1.1). Somente leitura: o Aurora nunca chama
// as rotas de shutdown/cor do Supervise.

const API_PATH = '/mon/1.1/device';
const FETCH_TIMEOUT_MS = 2500;
const LOG_FETCH_TIMEOUT_MS = 8000;
const CACHE_MS = 2000;
const EVENTS_CACHE_MS = 30_000;
const MAX_EVENTS = 100;
const MAX_OUTAGES = 30;

// Códigos de evento do Supervise (mesmos textos da página "Eventos" dele).
const EVENT_TEXT = Object.freeze({
  0: 'Início do monitoramento', 1: 'Fim do monitoramento', 2: 'Falha por sobretemperatura', 3: 'Falha interna',
  4: 'Falha por fim de bateria', 5: 'Falha de sobrecarga', 6: 'Curto-circuito na saída', 7: 'Tensão de saída anormal',
  8: 'Tensão de bateria anormal', 9: 'Falha no inversor', 10: 'Foi para a bateria', 11: 'Voltou para a rede',
  12: 'Modo stand-by', 14: 'Modo atenção', 15: 'Inicializando', 16: 'Frequência de entrada baixa',
  17: 'Frequência de entrada alta', 18: 'Rede elétrica normal', 19: 'Falha no sincronismo', 20: 'Sincronismo OK',
  21: 'Tensão de entrada baixa', 22: 'Tensão de entrada alta', 24: 'Ausência de rede', 26: 'Bateria baixa',
  27: 'Bateria normal', 28: 'Ruído na rede', 29: 'Bateria carregada', 30: 'Contagem de desligamento ativa',
  31: 'Comunicando', 32: 'Sem comunicação', 33: 'Controle remoto acionado', 35: 'Não calibrado',
  36: 'Desligamento por autonomia', 37: 'Desligamento pelo usuário', 38: 'Desligamento por bateria baixa',
  39: 'Desligamento por fim de bateria', 40: 'Desligamento agendado', 41: 'Cor alterada', 48: 'Descarga completa ativada',
  49: 'Ventilador anormal', 50: 'Desligamento cancelado', 51: 'Rede muito baixa', 52: 'Potência de saída muito alta',
  53: 'Falha no tiristor', 54: 'Bateria desconectada', 55: 'Bateria envelhecida', 56: 'Sobrecarga leve na saída',
  57: 'Autonomia expandida', 58: 'Autonomia reduzida',
});
// Queda = ida para a bateria / ausência de rede; volta = rede de novo.
const OUTAGE_START = new Set([10, 24]);
const OUTAGE_END = new Set([11, 18]);
const PROBLEM_EVENTS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 19, 21, 22, 26, 28, 32, 36, 37, 38, 39, 40, 49, 51, 52, 53, 54, 55, 56]);

// Mesma prioridade da tela do Supervise: falhas primeiro, depois avisos de rede/bateria.
const FAILURES = Object.freeze([
  ['overtemp', 'Falha de temperatura'],
  ['internal', 'Falha interna'],
  ['endBattery', 'Fim de bateria'],
  ['overload', 'Sobrecarga na saída'],
  ['shortcircuit', 'Curto-circuito na saída'],
  ['abnormalVOutput', 'Tensão de saída anormal'],
  ['abnormalVBattery', 'Tensão de bateria anormal'],
  ['inverter', 'Falha no inversor'],
  ['loVInput', 'Rede muito baixa'],
  ['hiPOutput', 'Potência muito alta'],
  ['tiristor', 'Falha no tiristor'],
]);
const WARNINGS = Object.freeze([
  ['loBattery', 'Bateria baixa'],
  ['noSyncInput', 'Falha de sincronismo'],
  ['loFInput', 'Frequência de rede baixa'],
  ['hiFInput', 'Frequência de rede alta'],
  ['loVInput', 'Tensão de rede baixa'],
  ['hiVInput', 'Tensão de rede alta'],
  ['noVInput', 'Sem energia da rede'],
]);

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const fixed = (value, digits) => (value === null ? null : Number(value.toFixed(digits)));

function modeOf(status) {
  if (!status.connected) return 'offline';
  if (status.opStartup) return 'startup';
  if (status.opStandBy) return 'standby';
  if (status.opBattery) return 'battery';
  return 'line';
}

function alertOf(mode, status, failures) {
  if (mode === 'offline') return { level: 'warn', text: 'Sem comunicação com o nobreak' };
  const failure = FAILURES.find(([key]) => failures[key]);
  if (failure) return { level: 'critical', text: failure[1] };
  const warning = WARNINGS.find(([key]) => status[key]);
  if (warning) return { level: 'warn', text: warning[1] };
  if (mode === 'battery') return { level: 'warn', text: 'Funcionando na bateria' };
  return null;
}

/** Converte o "device" do Supervise num retrato simples para o app. */
export function describeUps(device) {
  const status = device?.status ?? {};
  const failures = device?.failures ?? {};
  const vars = device?.vars ?? {};
  const mode = modeOf(status);
  const loadPercent = num(vars.pOutput);
  const nominalVA = num(vars.nominalPOutput);
  const charge = num(vars.cBattery);
  const countdown = num(device?.regressive?.value);

  return {
    available: true,
    mode,
    alert: alertOf(mode, status, failures),
    name: device?.userProd || device?.name || 'Nobreak',
    input: { voltage: fixed(num(vars.vInput), 1), nominalVoltage: num(vars.nominalVInput) },
    output: {
      voltage: fixed(num(vars.vOutput), 1),
      frequency: fixed(num(vars.fOutput), 1),
      current: fixed(num(vars.iOutput), 2),
      loadPercent: loadPercent === null ? null : Math.round(loadPercent),
      loadVA: loadPercent !== null && nominalVA !== null ? Math.round((nominalVA * loadPercent) / 100) : null,
      nominalVA,
    },
    battery: {
      voltage: fixed(num(vars.vBattery), 1),
      charge: charge === null ? null : Math.max(0, Math.min(100, Math.round(charge))),
    },
    temperature: fixed(num(vars.temperature), 1),
    shutdownCountdownSec: countdown !== null && countdown >= 0 ? countdown : null,
    updatedAt: typeof device?.last === 'string' ? device.last : null,
  };
}

function kindOf(code) {
  if (OUTAGE_START.has(code)) return 'outage';
  if (OUTAGE_END.has(code)) return 'restore';
  if (PROBLEM_EVENTS.has(code)) return 'problem';
  return 'info';
}

/**
 * Transforma o log do Supervise em eventos legíveis e em quedas de energia
 * (cada ida para a bateria pareada com a volta seguinte). Tudo do mais recente para o mais antigo.
 */
export function describeEvents(logs, currentMode = null) {
  const entries = (Array.isArray(logs) ? logs : [])
    .filter((log) => Number.isFinite(log?.dateTime) && Number.isInteger(log?.event))
    .sort((a, b) => a.dateTime - b.dateTime);

  const outages = [];
  let open = null;
  // Menor carga vista durante a queda ("a bateria chegou a X%"); a volta gera vários eventos no mesmo instante.
  const lowest = (current, log) => {
    const charge = num(log.vars?.cBattery);
    if (charge === null) return current;
    const rounded = Math.min(100, Math.round(charge));
    return current === null ? rounded : Math.min(current, rounded);
  };
  for (const log of entries) {
    if (open && (OUTAGE_START.has(log.event) || OUTAGE_END.has(log.event))) {
      open = { ...open, lowestBattery: lowest(open.lowestBattery, log) };
    }
    // Outro evento de volta no mesmo instante da que fechou a queda: a leitura de bateria dele também conta.
    const lastClosed = outages.at(-1);
    if (!open && OUTAGE_END.has(log.event) && lastClosed?.end === log.dateTime) {
      outages[outages.length - 1] = { ...lastClosed, lowestBattery: lowest(lastClosed.lowestBattery, log) };
    }
    if (OUTAGE_START.has(log.event) && !open) {
      open = { start: log.dateTime, lowestBattery: lowest(null, log) };
    } else if (OUTAGE_END.has(log.event) && open) {
      outages.push({ ...open, end: log.dateTime, durationSec: Math.round((log.dateTime - open.start) / 1000) });
      open = null;
    }
  }
  // Sem registro de volta: só é "em andamento" se o nobreak está na bateria agora.
  if (open) outages.push({ ...open, end: null, durationSec: null, ongoing: currentMode === 'battery' });

  const events = entries.map((log) => ({
    at: log.dateTime,
    code: log.event,
    text: EVENT_TEXT[log.event] ?? `Evento ${log.event}`,
    kind: kindOf(log.event),
  }));

  return {
    outages: outages.reverse().slice(0, MAX_OUTAGES),
    events: events.reverse().slice(0, MAX_EVENTS),
    totalEvents: entries.length,
  };
}

export function createUpsMonitor({ url, id = null, fetchImpl = fetch, now = Date.now }) {
  let deviceId = id;
  let snapshot = null;
  let inflight = null;
  let eventsSnapshot = null;
  let eventsInflight = null;

  async function getJson(path, timeoutMs = FETCH_TIMEOUT_MS) {
    const res = await fetchImpl(new URL(path, url), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Sem id no config: usa o primeiro nobreak que o Supervise listar.
  async function resolveDeviceId() {
    if (deviceId) return deviceId;
    const { devices } = await getJson(API_PATH);
    const first = Array.isArray(devices) ? devices.find((d) => typeof d?.id === 'string') : null;
    if (!first) throw new Error('nenhum nobreak listado');
    deviceId = first.id;
    return deviceId;
  }

  async function refresh() {
    const checkedAt = now();
    try {
      const target = await resolveDeviceId();
      const { device } = await getJson(`${API_PATH}/${encodeURIComponent(target)}`);
      snapshot = { ...describeUps(device), checkedAt };
    } catch (err) {
      snapshot = {
        available: false,
        error: `Não consegui ler o Supervise em ${url} (${err.message}). Ele está aberto no notebook?`,
        checkedAt,
      };
    }
    return snapshot;
  }

  async function getStatus() {
    if (!snapshot || now() - snapshot.checkedAt > CACHE_MS) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return snapshot;
  }

  async function refreshEvents() {
    const checkedAt = now();
    try {
      const target = await resolveDeviceId();
      const [{ logs }, status] = await Promise.all([
        getJson(`${API_PATH}/${encodeURIComponent(target)}/log`, LOG_FETCH_TIMEOUT_MS),
        getStatus(),
      ]);
      eventsSnapshot = { available: true, ...describeEvents(logs, status.mode ?? null), checkedAt };
    } catch (err) {
      eventsSnapshot = {
        available: false,
        error: `Não consegui ler os eventos do Supervise (${err.message}).`,
        checkedAt,
      };
    }
    return eventsSnapshot;
  }

  /** O log é maior e muda pouco: guardado por 30 s. */
  async function getEvents() {
    if (!eventsSnapshot || now() - eventsSnapshot.checkedAt > EVENTS_CACHE_MS) {
      eventsInflight ??= refreshEvents().finally(() => {
        eventsInflight = null;
      });
      await eventsInflight;
    }
    return eventsSnapshot;
  }

  return Object.freeze({ getStatus, getEvents });
}
