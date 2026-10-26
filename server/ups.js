// Nobreak Ragtech via Supervise (API local em /mon/1.1). Somente leitura: o Aurora nunca chama
// as rotas de shutdown/cor do Supervise.

const API_PATH = '/mon/1.1/device';
const FETCH_TIMEOUT_MS = 2500;
const CACHE_MS = 2000;

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

export function createUpsMonitor({ url, id = null, fetchImpl = fetch, now = Date.now }) {
  let deviceId = id;
  let snapshot = null;
  let inflight = null;

  async function getJson(path) {
    const res = await fetchImpl(new URL(path, url), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

  return Object.freeze({ getStatus });
}
