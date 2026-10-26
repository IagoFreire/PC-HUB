const TOKEN_KEY = 'aurora.token';
const POLL_MS = 5000;
const POLL_FAST_MS = 1500;
const TOAST_MS = 3400;
const SHEET_FALLBACK_MS = 600;

const $ = (id) => document.getElementById(id);
const el = {
  pcName: $('pcName'),
  statusText: $('statusText'),
  statusDetail: $('statusDetail'),
  hint: $('hint'),
  powerBtn: $('powerBtn'),
  ipVal: $('ipVal'),
  timeLabel: $('timeLabel'),
  timeVal: $('timeVal'),
  agentVal: $('agentVal'),
  powerSheet: $('powerSheet'),
  powerSheetTitle: $('powerSheetTitle'),
  powerSheetMsg: $('powerSheetMsg'),
  settingsSheet: $('settingsSheet'),
  settingsMsg: $('settingsMsg'),
  settingsBtn: $('settingsBtn'),
  refreshBtn: $('refreshBtn'),
  logoutBtn: $('logoutBtn'),
  gate: $('gate'),
  gateForm: $('gateForm'),
  tokenInput: $('tokenInput'),
  gateError: $('gateError'),
  gateSubmit: $('gateSubmit'),
  toast: $('toast'),
};

class AuthError extends Error {}
class NetworkError extends Error {}
class LockedError extends Error {}

// localStorage pode lançar em modo privado; nesse caso o código vale só enquanto o app estiver aberto.
const tokenStore = {
  read() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  write(value) {
    try { localStorage.setItem(TOKEN_KEY, value); } catch { /* ver comentário acima */ }
  },
  clear() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ver comentário acima */ }
  },
};

let session = Object.freeze({ token: tokenStore.read(), status: null, reachable: true, busy: false });
let pollTimer = null;
let toastTimer = null;

const updateSession = (patch) => {
  session = Object.freeze({ ...session, ...patch });
};

/* ---------- API ---------- */

async function api(path, { method = 'GET', body, token = session.token } = {}) {
  let res;
  try {
    res = await fetch(`api/${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError('Sem conexão com o servidor Aurora.');
  }

  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(data.error || 'Código de acesso incorreto.');
  if (res.status === 429) throw new LockedError(data.error || 'Muitas tentativas. Espere alguns minutos.');
  if (!res.ok) throw new Error(data.error || `O servidor respondeu com erro ${res.status}.`);
  return data;
}

/* ---------- Formatação ---------- */

const relative = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec)) return '—';
  const minutes = Math.floor(totalSec / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return 'menos de 1 min';
  if (hours < 1) return `${minutes} min`;
  if (days < 1) return `${hours} h ${minutes % 60} min`;
  return `${days} d ${hours % 24} h`;
}

function formatAgo(timestamp) {
  if (!timestamp) return null;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'agora há pouco';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}

/* ---------- Estado → tela ---------- */

function deriveView(status, reachable) {
  if (!reachable) {
    return { state: 'disconnected', title: 'Sem conexão', detail: 'O servidor Aurora não respondeu', hint: 'Tentando de novo…', label: 'Servidor indisponível', canPress: false };
  }
  if (!status) {
    return { state: 'unknown', title: 'Verificando…', detail: '', hint: '', label: 'Verificando o PC', canPress: false };
  }

  switch (status.pending) {
    case 'waking':
      return { state: 'waking', title: 'Acordando…', detail: 'Sinal enviado pela rede', hint: 'Toque para enviar de novo', label: 'Reenviar sinal para ligar', canPress: true };
    case 'shutting-down':
      return { state: 'shutting', title: 'Desligando…', detail: 'Encerrando o Windows', hint: '', label: 'Desligando o PC', canPress: false };
    case 'restarting':
      return { state: 'restarting', title: 'Reiniciando…', detail: 'Já já ele volta', hint: '', label: 'Reiniciando o PC', canPress: false };
    default:
      break;
  }

  if (status.online) {
    const detail = Number.isFinite(status.latencyMs) ? `Respondendo em ${Math.max(1, status.latencyMs)} ms` : 'Respondendo na rede';
    return { state: 'online', title: 'Ligado', detail, hint: 'Toque para desligar', label: 'Desligar ou reiniciar o PC', canPress: true };
  }

  const ago = formatAgo(status.lastSeenAt);
  return { state: 'offline', title: 'Desligado', detail: ago ? `Visto ${ago}` : 'Dormindo tranquilo', hint: 'Toque para ligar', label: 'Ligar o PC', canPress: true };
}

function agentTone(status) {
  switch (status.agent) {
    case 'ok': return ['ok', 'Conectado'];
    case 'unauthorized': return ['bad', 'Segredo não confere'];
    case 'error': return ['warn', 'Com erro'];
    default: return status.online ? ['warn', 'Não responde'] : ['', 'Aguardando o PC'];
  }
}

function setText(node, text) {
  const value = text || ' ';
  if (node.textContent !== value) node.textContent = value;
}

function render() {
  const { status, reachable, busy } = session;
  const view = deriveView(status, reachable);

  document.body.dataset.state = view.state;
  setText(el.statusText, view.title);
  setText(el.statusDetail, view.detail);
  setText(el.hint, view.hint);
  el.powerBtn.disabled = busy || !view.canPress;
  el.powerBtn.setAttribute('aria-label', view.label);

  if (!status) return;

  setText(el.pcName, status.pc.name);
  setText(el.ipVal, status.pc.ip);
  if (status.online) {
    setText(el.timeLabel, 'Ligado há');
    setText(el.timeVal, formatDuration(status.uptimeSec));
  } else {
    setText(el.timeLabel, 'Visto por último');
    setText(el.timeVal, formatAgo(status.lastSeenAt) ?? '—');
  }

  const [tone, label] = agentTone(status);
  const [dot, text] = el.agentVal.children;
  dot.dataset.tone = tone;
  setText(text, label);
  document.title = `Aurora · ${view.title}`;
}

/* ---------- Polling ---------- */

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedule() {
  stopPolling();
  if (document.hidden || !session.token) return;
  pollTimer = setTimeout(poll, session.status?.pending ? POLL_FAST_MS : POLL_MS);
}

async function poll() {
  try {
    const status = await api('status');
    updateSession({ status, reachable: true });
  } catch (err) {
    if (err instanceof AuthError) {
      openGate(err.message);
      return;
    }
    // Bloqueio temporário (429) não invalida o código salvo; 5xx e rede fora: segue tentando.
    if (err instanceof LockedError) toast(err.message);
    updateSession({ reachable: false });
  }
  render();
  schedule();
}

/* ---------- Feedback ---------- */

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), TOAST_MS);
}

function handleActionError(err) {
  if (err instanceof AuthError) {
    openGate(err.message);
    return;
  }
  toast(err.message);
}

/* ---------- Sheets ---------- */

let lastFocus = null;

function openSheet(layer) {
  lastFocus = document.activeElement;
  layer.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    layer.classList.add('is-open');
    layer.querySelector('.sheet').focus({ preventScroll: true });
  }));
}

function closeSheet(layer) {
  if (layer.hidden) return;
  layer.classList.remove('is-open');
  const hide = () => {
    layer.hidden = true;
    lastFocus?.focus?.({ preventScroll: true });
  };
  const fallback = setTimeout(hide, SHEET_FALLBACK_MS);
  layer.querySelector('.sheet').addEventListener('transitionend', () => {
    clearTimeout(fallback);
    hide();
  }, { once: true });
}

for (const layer of [el.powerSheet, el.settingsSheet]) {
  layer.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) closeSheet(layer);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeSheet(el.powerSheet);
  closeSheet(el.settingsSheet);
});

function openPowerSheet() {
  const { status } = session;
  const agentReady = status.agent === 'ok';
  setText(el.powerSheetTitle, `Desligar ${status.pc.name}?`);
  setText(el.powerSheetMsg, agentReady
    ? 'Programas abertos serão fechados em 5 segundos.'
    : 'O agente Aurora não está respondendo no PC. Instale-o (pasta agent/) para desligar por aqui.');
  for (const button of el.powerSheet.querySelectorAll('[data-action]')) button.disabled = !agentReady;
  openSheet(el.powerSheet);
}

/* ---------- Ações ---------- */

async function runAction(task) {
  updateSession({ busy: true });
  render();
  try {
    await task();
  } catch (err) {
    handleActionError(err);
  } finally {
    updateSession({ busy: false });
    render();
    schedule();
  }
}

const wake = () => runAction(async () => {
  await api('wake', { method: 'POST' });
  updateSession({ status: { ...session.status, pending: 'waking' } });
  toast('Sinal enviado. Acordando o PC…');
});

const power = (action) => runAction(async () => {
  await api('power', { method: 'POST', body: { action } });
  updateSession({ status: { ...session.status, pending: action === 'restart' ? 'restarting' : 'shutting-down' } });
  toast(action === 'restart' ? 'Reiniciando em 5 segundos.' : 'Desligando em 5 segundos.');
});

el.powerBtn.addEventListener('click', () => {
  const { state } = deriveView(session.status, session.reachable);
  if (state === 'offline' || state === 'waking') wake();
  else if (state === 'online') openPowerSheet();
});

el.powerSheet.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  closeSheet(el.powerSheet);
  power(button.dataset.action);
});

el.settingsBtn.addEventListener('click', () => {
  const pc = session.status?.pc;
  setText(el.settingsMsg, pc ? `${pc.name} · ${pc.mac} · servidor ${location.host}` : `Servidor ${location.host}`);
  openSheet(el.settingsSheet);
});

el.refreshBtn.addEventListener('click', () => {
  closeSheet(el.settingsSheet);
  poll();
});

el.logoutBtn.addEventListener('click', () => {
  closeSheet(el.settingsSheet);
  openGate('');
});

/* ---------- Pareamento ---------- */

function openGate(message) {
  stopPolling();
  tokenStore.clear();
  updateSession({ token: null });
  el.gateError.textContent = message;
  el.tokenInput.value = '';
  el.gate.hidden = false;
}

el.gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = el.tokenInput.value.trim();
  if (!token) return;

  el.gateSubmit.disabled = true;
  el.gateError.textContent = '';
  try {
    const status = await api('status', { token });
    tokenStore.write(token);
    updateSession({ token, status, reachable: true });
    el.tokenInput.blur();
    el.gate.hidden = true;
    render();
    schedule();
  } catch (err) {
    el.gateError.textContent = err instanceof AuthError ? 'Código incorreto. Confira o config.json.' : err.message;
  } finally {
    el.gateSubmit.disabled = false;
  }
});

/* ---------- Ciclo de vida ---------- */

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else if (session.token) poll();
});

// Service worker só existe em contexto seguro (HTTPS/localhost); sem ele o app funciona igual.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
if (session.token) poll();
else openGate('');
