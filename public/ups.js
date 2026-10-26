// Nobreak: selo de bateria no cabeçalho + tela com os detalhes (dados do Supervise via /api/ups).

const VIEW_POLL_MS = 2000;
const SHEET_FALLBACK_MS = 600;
const GAUGE_RADIUS = 52;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
const CHIP_FILL_WIDTH = 13;
const LOW_CHARGE = 20;
const MID_CHARGE = 50;

const MODE_TEXT = Object.freeze({
  line: 'Na rede',
  battery: 'Na bateria',
  standby: 'Em espera',
  startup: 'Iniciando',
  offline: 'Sem comunicação',
});

const formatters = new Map();
function fmt(value, digits, unit = '') {
  if (value === null || value === undefined) return '—';
  if (!formatters.has(digits)) {
    formatters.set(digits, new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return `${formatters.get(digits).format(value)}${unit}`;
}

function formatCountdown(seconds) {
  if (seconds === null || seconds === undefined) return 'Inativo';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

/** Cor geral: ok (rede), warn (bateria/aviso), critical (falha), muted (sem dados). */
function toneOf(snapshot) {
  if (!snapshot?.available || snapshot.mode === 'offline') return 'muted';
  if (snapshot.alert?.level === 'critical') return 'critical';
  if (snapshot.mode === 'battery' || snapshot.alert) return 'warn';
  return 'ok';
}

function chargeLevel(charge) {
  if (charge === null || charge === undefined) return 'unknown';
  if (charge < LOW_CHARGE) return 'low';
  if (charge < MID_CHARGE) return 'mid';
  return 'high';
}

export function createUpsPanel({ request, haptic, notify }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    chip: $('upsChip'),
    chipText: $('upsChipText'),
    chipFill: $('upsChipFill'),
    view: $('upsView'),
    back: $('upsBack'),
    gauge: $('upsGauge'),
    gaugeArc: $('upsGaugeArc'),
    charge: $('upsCharge'),
    name: $('upsName'),
    mode: $('upsMode'),
    alert: $('upsAlert'),
    foot: $('upsFoot'),
    vIn: $('upsVIn'),
    vOut: $('upsVOut'),
    freq: $('upsFreq'),
    load: $('upsLoad'),
    loadVA: $('upsLoadVA'),
    vBat: $('upsVBat'),
    temp: $('upsTemp'),
    current: $('upsCurrent'),
    countdown: $('upsCountdown'),
  };

  let enabled = true;
  let isOpen = false;
  let timer = null;
  let lastMode = null;

  el.gaugeArc.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE}`;

  function renderChip(snapshot) {
    const charge = snapshot.available ? snapshot.battery.charge : null;
    el.chip.hidden = false;
    el.chip.dataset.tone = toneOf(snapshot);
    el.chip.dataset.mode = snapshot.mode ?? 'offline';
    el.chipText.textContent = fmt(charge, 0, '%');
    el.chipFill.setAttribute('width', String(((charge ?? 0) / 100) * CHIP_FILL_WIDTH));
    el.chip.setAttribute('aria-label', snapshot.available
      ? `Nobreak ${MODE_TEXT[snapshot.mode]?.toLowerCase() ?? ''}, bateria ${fmt(charge, 0, '%')}`
      : 'Nobreak sem dados');
  }

  function renderView(snapshot) {
    el.view.dataset.tone = toneOf(snapshot);
    if (!snapshot.available) {
      el.mode.textContent = 'Sem dados';
      el.alert.textContent = snapshot.error ?? 'Não consegui ler o nobreak.';
      el.charge.textContent = '—';
      el.gauge.dataset.level = 'unknown';
      el.gaugeArc.style.strokeDashoffset = `${GAUGE_CIRCUMFERENCE}`;
      return;
    }

    const { battery, output, input } = snapshot;
    el.name.textContent = snapshot.name;
    el.mode.textContent = MODE_TEXT[snapshot.mode] ?? snapshot.mode;
    el.alert.textContent = snapshot.alert?.text ?? 'Tudo normal';
    el.charge.textContent = fmt(battery.charge, 0, '%');
    el.gauge.dataset.level = chargeLevel(battery.charge);
    el.gaugeArc.style.strokeDashoffset = `${GAUGE_CIRCUMFERENCE * (1 - (battery.charge ?? 0) / 100)}`;

    el.vIn.textContent = fmt(input.voltage, 1, ' V');
    el.vOut.textContent = fmt(output.voltage, 1, ' V');
    el.freq.textContent = fmt(output.frequency, 1, ' Hz');
    el.load.textContent = fmt(output.loadPercent, 0, '%');
    el.loadVA.textContent = output.loadVA === null ? '' : `${fmt(output.loadVA, 0)} de ${fmt(output.nominalVA, 0)} VA`;
    el.vBat.textContent = fmt(battery.voltage, 1, ' V');
    el.temp.textContent = fmt(snapshot.temperature, 0, ' °C');
    el.current.textContent = fmt(output.current, 2, ' A');
    el.countdown.textContent = formatCountdown(snapshot.shutdownCountdownSec);

    const updated = snapshot.updatedAt ? new Date(snapshot.updatedAt) : null;
    el.foot.textContent = updated && !Number.isNaN(updated.getTime())
      ? `Supervise · atualizado às ${updated.toLocaleTimeString('pt-BR')}`
      : 'Supervise';
  }

  // Avisa na troca rede ↔ bateria (falta e volta de energia).
  function announce(snapshot) {
    if (!snapshot.available) return;
    if (lastMode && lastMode !== snapshot.mode) {
      if (snapshot.mode === 'battery') notify('⚡ Faltou energia: o nobreak está na bateria');
      else if (lastMode === 'battery' && snapshot.mode === 'line') notify('Energia voltou: nobreak de volta na rede');
    }
    lastMode = snapshot.mode;
  }

  function update(snapshot) {
    renderChip(snapshot);
    announce(snapshot);
    if (isOpen) renderView(snapshot);
  }

  /** Busca o nobreak. Erro de autenticação sobe para o app tratar; 404 = não configurado. */
  async function refresh() {
    if (!enabled) return;
    try {
      update(await request('ups'));
    } catch (err) {
      if (err.status === 404) {
        enabled = false;
        el.chip.hidden = true;
        return;
      }
      if (err.status === 401) throw err;
      update({ available: false, error: err.message });
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!isOpen || document.hidden) return;
    timer = setTimeout(async () => {
      await refresh().catch(() => {});  // auth é tratada pelo polling principal
      schedule();
    }, VIEW_POLL_MS);
  }

  function open() {
    if (isOpen || !enabled) return;
    isOpen = true;
    el.view.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => el.view.classList.add('is-open')));
    refresh().catch(() => {}).finally(schedule);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(timer);
    el.view.classList.remove('is-open');
    const hide = () => {
      if (!isOpen) el.view.hidden = true;
    };
    const fallback = setTimeout(hide, SHEET_FALLBACK_MS);
    el.view.addEventListener('transitionend', () => {
      clearTimeout(fallback);
      hide();
    }, { once: true });
  }

  el.chip.addEventListener('click', () => {
    haptic('tap');
    open();
  });
  el.back.addEventListener('click', () => {
    haptic('tap');
    close();
  });
  document.addEventListener('visibilitychange', () => {
    if (isOpen) schedule();
  });

  return Object.freeze({ refresh, open, close });
}
