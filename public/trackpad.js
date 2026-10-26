// Trackpad e teclado: gestos na tela do celular viram mouse e teclado no PC (via WebSocket).
import { MAX_MOTION_DT_S, motionToCursor, rotationLayoutFor } from './air-mouse.js';

const TAP_MAX_MS = 220;
const TWO_FINGER_TAP_MAX_MS = 320;
const TAP_SLOP_PX = 8;
const DRAG_WINDOW_MS = 300;
const DRAG_RADIUS_PX = 44;
const SENSITIVITY = 1.5;
const ACCELERATION = 1.1;
const MAX_SPEED_PX_PER_MS = 2.5;
const SCROLL_GAIN = 3;
const RECONNECT_MS = 1500;
const RECONNECT_AFTER_ERROR_MS = 4000;
const SHEET_FALLBACK_MS = 600;
const KEYBOARD_SENTINEL = ' ';
const MAX_ECHO_CHARS = 120;
const MOTION_CHECK_MS = 1500;
const ROTATION_LAYOUT = rotationLayoutFor(globalThis.DeviceMotionEvent);

const HARDWARE_KEYS = Object.freeze({
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'esc',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
});

const point = (touch) => ({ x: touch.clientX, y: touch.clientY });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function centroid(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

export function createTrackpad({ getToken, haptic, onAuthError, notify = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    view: $('padView'),
    surface: $('padSurface'),
    status: $('padStatus'),
    statusText: $('padStatusText'),
    back: $('padBack'),
    kbdBtn: $('padKbdBtn'),
    airBtn: $('padAirBtn'),
    keyRow: $('padKeyRow'),
    input: $('padInput'),
    echo: $('padEcho'),
    echoText: $('padEchoText'),
  };

  let ws = null;
  let ready = false;
  let isOpen = false;
  let retryTimer = null;
  let gesture = null;
  let lastTap = null;
  let frame = 0;
  // Air mouse: com o modo ligado, segurar a superfície ("embreagem") faz o giroscópio mover o cursor.
  let airMode = false;
  let airClutch = false;
  let lastMotionAt = 0;
  let motionSeen = false;
  const heldButtons = new Set();
  // Acumuladores de movimento/rolagem entre frames (frações de pixel ficam para o próximo).
  const pending = { m: { x: 0, y: 0 }, s: { x: 0, y: 0 } };

  /* ---------- Conexão ---------- */

  function setStatus(state, text) {
    el.status.dataset.state = state;
    el.statusText.textContent = text;
  }

  function send(event) {
    if (ws && ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  function connect() {
    clearTimeout(retryTimer);
    const url = new URL('api/touch', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    ws = socket;
    ready = false;
    setStatus('connecting', 'Conectando ao PC…');

    socket.addEventListener('open', () => socket.send(JSON.stringify({ t: 'auth', token: getToken() })));
    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'ready') {
        ready = true;
        setStatus('ready', 'Conectado ao PC');
      } else if (msg.t === 'error') {
        setStatus('error', msg.message);
        if (msg.code === 'auth') {
          close();
          onAuthError(msg.message);
        }
      }
    });
    socket.addEventListener('close', () => {
      if (ws !== socket) return;
      ws = null;
      ready = false;
      if (!isOpen) return;
      const hadError = el.status.dataset.state === 'error';
      if (!hadError) setStatus('connecting', 'Reconectando…');
      retryTimer = setTimeout(connect, hadError ? RECONNECT_AFTER_ERROR_MS : RECONNECT_MS);
    });
  }

  function disconnect() {
    clearTimeout(retryTimer);
    releaseButtons();
    const socket = ws;
    ws = null;
    ready = false;
    socket?.close();
  }

  /* ---------- Movimento e rolagem ---------- */

  function queue(kind, x, y) {
    pending[kind].x += x;
    pending[kind].y += y;
    frame ||= requestAnimationFrame(flush);
  }

  function takeWhole(acc, gain) {
    const x = Math.trunc(acc.x * gain);
    const y = Math.trunc(acc.y * gain);
    acc.x -= x / gain;
    acc.y -= y / gain;
    return { x, y };
  }

  function flush() {
    frame = 0;
    const move = takeWhole(pending.m, 1);
    if (move.x || move.y) send({ t: 'm', dx: move.x, dy: move.y });
    const scroll = takeWhole(pending.s, SCROLL_GAIN);
    // Rolagem "natural": o conteúdo segue o dedo. No Windows, roda positiva = sobe / vai à direita.
    if (scroll.x || scroll.y) send({ t: 's', dx: -scroll.x, dy: scroll.y });
  }

  function click(button) {
    send({ t: 'c', b: button });
    haptic('tap');
  }

  function releaseButtons() {
    for (const button of heldButtons) send({ t: 'u', b: button });
    heldButtons.clear();
    for (const btn of el.view.querySelectorAll('.pad-btn.is-pressed')) btn.classList.remove('is-pressed');
    if (gesture?.dragging) send({ t: 'u', b: 'l' });
  }

  /* ---------- Gestos ---------- */

  function onTouchStart(event) {
    event.preventDefault();
    const now = event.timeStamp;
    if (!gesture) {
      const first = point(event.targetTouches[0]);
      const nearLastTap = lastTap && now - lastTap.at < DRAG_WINDOW_MS && distance(first, lastTap.pos) < DRAG_RADIUS_PX;
      gesture = {
        startedAt: now,
        lastAt: now,
        maxTouches: 0,
        travel: 0,
        dragArmed: Boolean(nearLastTap) && !airMode,
        dragging: false,
        points: new Map(),
      };
      el.surface.classList.add('is-touching');
    }
    for (const touch of event.changedTouches) gesture.points.set(touch.identifier, point(touch));
    gesture.maxTouches = Math.max(gesture.maxTouches, event.targetTouches.length);
    // Um dedo segurando = apontar; o segundo dedo vira rolagem e solta a "embreagem".
    airClutch = airMode && gesture.maxTouches === 1;
  }

  function onTouchMove(event) {
    event.preventDefault();
    if (!gesture) return;
    const ids = [...event.targetTouches].map((t) => t.identifier).filter((id) => gesture.points.has(id));
    if (ids.length === 0) return;

    const before = centroid(ids.map((id) => gesture.points.get(id)));
    for (const touch of event.targetTouches) {
      if (gesture.points.has(touch.identifier)) gesture.points.set(touch.identifier, point(touch));
    }
    const after = centroid(ids.map((id) => gesture.points.get(id)));
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const step = Math.hypot(dx, dy);
    const dt = Math.max(1, event.timeStamp - gesture.lastAt);
    gesture.lastAt = event.timeStamp;
    gesture.travel += step;

    if (ids.length >= 2) {
      if (gesture.travel > TAP_SLOP_PX) queue('s', dx, dy);
      return;
    }
    // Sobrou um dedo de um gesto de dois: não mexe o cursor de surpresa.
    if (gesture.maxTouches > 1) return;
    // No air mouse quem move o cursor é o giroscópio, não o dedo.
    if (airMode) return;

    if (gesture.dragArmed && !gesture.dragging && gesture.travel > TAP_SLOP_PX) {
      gesture.dragging = true;
      send({ t: 'd', b: 'l' });
    }
    const gain = SENSITIVITY * (1 + ACCELERATION * Math.min(step / dt, MAX_SPEED_PX_PER_MS));
    queue('m', dx * gain, dy * gain);
  }

  function onTouchEnd(event) {
    event.preventDefault();
    if (!gesture) return;
    for (const touch of event.changedTouches) gesture.points.delete(touch.identifier);
    if (event.targetTouches.length > 0) return;

    const finished = gesture;
    gesture = null;
    airClutch = false;
    el.surface.classList.remove('is-touching');

    if (finished.dragging) {
      send({ t: 'u', b: 'l' });
      lastTap = null;
      return;
    }
    if (event.type === 'touchcancel') return;

    const duration = event.timeStamp - finished.startedAt;
    const still = finished.travel < TAP_SLOP_PX;
    if (still && finished.maxTouches === 1 && duration < TAP_MAX_MS) {
      click('l');
      lastTap = { at: event.timeStamp, pos: point(event.changedTouches[0]) };
      return;
    }
    if (still && finished.maxTouches === 2 && duration < TWO_FINGER_TAP_MAX_MS) click('r');
    lastTap = null;
  }

  el.surface.addEventListener('touchstart', onTouchStart, { passive: false });
  el.surface.addEventListener('touchmove', onTouchMove, { passive: false });
  el.surface.addEventListener('touchend', onTouchEnd, { passive: false });
  el.surface.addEventListener('touchcancel', onTouchEnd, { passive: false });

  /* ---------- Air mouse ---------- */

  function onMotion(event) {
    motionSeen = true;
    const now = event.timeStamp;
    const dt = lastMotionAt ? Math.min((now - lastMotionAt) / 1000, MAX_MOTION_DT_S) : 0;
    lastMotionAt = now;
    if (!airClutch) return;
    const { dx, dy } = motionToCursor(event.rotationRate, event.accelerationIncludingGravity, dt, ROTATION_LAYOUT);
    if (dx || dy) queue('m', dx, dy);
  }

  /** Pede acesso aos sensores; devolve uma mensagem de erro ou null. Precisa vir de um toque. */
  async function enableMotion() {
    if (!('DeviceMotionEvent' in window)) return 'Este navegador não tem sensores de movimento.';
    if (!window.isSecureContext) {
      return 'O air mouse precisa do Aurora em HTTPS (o iPhone só libera os sensores assim). Veja "HTTPS" no README.';
    }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        if (await DeviceMotionEvent.requestPermission() !== 'granted') {
          return 'Acesso ao movimento negado. Libere em Ajustes › Apps › Safari › Movimento e Orientação.';
        }
      } catch {
        return 'Não consegui pedir acesso aos sensores de movimento.';
      }
    }
    return null;
  }

  function applyAirMode(on) {
    airMode = on;
    airClutch = false;
    el.view.classList.toggle('air-mode', on);
    el.airBtn.setAttribute('aria-pressed', String(on));
    if (on) {
      lastMotionAt = 0;
      motionSeen = false;
      window.addEventListener('devicemotion', onMotion);
      setTimeout(() => {
        if (airMode && !motionSeen) notify('Nenhum dado do giroscópio chegou. Este aparelho tem giroscópio?');
      }, MOTION_CHECK_MS);
    } else {
      window.removeEventListener('devicemotion', onMotion);
    }
  }

  el.airBtn.addEventListener('click', async () => {
    haptic('tap');
    if (airMode) {
      applyAirMode(false);
      return;
    }
    // requestPermission é chamado aqui dentro, ainda no toque (o iOS exige).
    const problem = await enableMotion();
    if (problem) {
      notify(problem);
      return;
    }
    applyAirMode(true);
  });

  /* ---------- Botões físicos (esquerdo/direito) ---------- */

  for (const btn of el.view.querySelectorAll('[data-button]')) {
    const button = btn.dataset.button;
    const press = (event) => {
      event.preventDefault();
      if (heldButtons.has(button)) return;
      heldButtons.add(button);
      btn.classList.add('is-pressed');
      send({ t: 'd', b: button });
    };
    const release = (event) => {
      event.preventDefault();
      if (!heldButtons.delete(button)) return;
      btn.classList.remove('is-pressed');
      send({ t: 'u', b: button });
      haptic('tap');
    };
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
  }

  /* ---------- Teclado ---------- */

  // Prévia local do que foi digitado: é o que VOCÊ mandou, não o texto real do PC.
  let echo = '';

  function setEcho(next) {
    echo = next.slice(-MAX_ECHO_CHARS);
    el.echoText.textContent = echo;
    el.echo.classList.toggle('is-empty', echo === '');
    // Centralizado enquanto cabe; quando passa da largura, alinha pelo fim para mostrar o que acabou de ser digitado.
    const caretWidth = el.echo.lastElementChild.offsetWidth;
    el.echo.classList.toggle('is-overflowing', el.echoText.offsetWidth + caretWidth > el.echo.clientWidth);
  }

  function typeText(text) {
    send({ t: 'k', text });
    // Texto colado com várias linhas: a prévia mostra só a última.
    const lines = text.split(/\r\n|\r|\n/);
    setEcho(lines.length > 1 ? lines.at(-1) : echo + text);
  }

  function pressKey(key) {
    send({ t: 'key', k: key });
    if (key === 'backspace') setEcho([...echo].slice(0, -1).join(''));
    else if (key === 'enter') setEcho('');
    else if (key === 'tab') setEcho(`${echo}⇥`);
  }

  // Um caractere fixo no campo garante que o iOS sempre dispare "apagar", mesmo sem texto.
  function resetInput() {
    el.input.value = KEYBOARD_SENTINEL;
    el.input.setSelectionRange(KEYBOARD_SENTINEL.length, KEYBOARD_SENTINEL.length);
  }

  el.kbdBtn.addEventListener('click', () => {
    haptic('tap');
    if (document.activeElement === el.input) {
      el.input.blur();
      return;
    }
    resetInput();
    el.input.focus();
  });

  el.input.addEventListener('focus', () => {
    setEcho('');
    el.view.classList.add('kbd-open');
    el.keyRow.hidden = false;
    el.kbdBtn.setAttribute('aria-pressed', 'true');
  });

  el.input.addEventListener('blur', () => {
    el.view.classList.remove('kbd-open');
    el.keyRow.hidden = true;
    el.kbdBtn.setAttribute('aria-pressed', 'false');
  });

  el.input.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'insertCompositionText') return;
    event.preventDefault();
    const text = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
    switch (event.inputType) {
      case 'insertText':
      case 'insertReplacementText':
      case 'insertFromPaste':
        if (text) typeText(text);
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        pressKey('enter');
        break;
      case 'deleteContentBackward':
        pressKey('backspace');
        break;
      case 'deleteContentForward':
        pressKey('delete');
        break;
      default:
        break;
    }
    resetInput();
  });

  // Acentos montados por composição (teclados de outros idiomas) chegam aqui no fim.
  el.input.addEventListener('compositionend', (event) => {
    if (event.data) typeText(event.data);
    resetInput();
  });

  el.input.addEventListener('keydown', (event) => {
    const key = HARDWARE_KEYS[event.key];
    if (!key || event.isComposing) return;
    event.preventDefault();
    pressKey(key);
  });

  for (const keyBtn of el.keyRow.querySelectorAll('[data-key]')) {
    const fire = () => {
      pressKey(keyBtn.dataset.key);
      haptic('tap');
    };
    // preventDefault no toque mantém o foco no campo, então o teclado do iPhone não fecha.
    keyBtn.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });
    keyBtn.addEventListener('touchend', (event) => {
      event.preventDefault();
      fire();
    }, { passive: false });
    keyBtn.addEventListener('mousedown', (event) => event.preventDefault());
    keyBtn.addEventListener('click', fire);
  }

  /* ---------- Teclado virtual x altura da tela ---------- */

  const viewport = window.visualViewport;
  function syncViewport() {
    if (!viewport) return;
    el.view.style.setProperty('--pad-h', `${viewport.height}px`);
    el.view.style.setProperty('--pad-top', `${viewport.offsetTop}px`);
  }
  viewport?.addEventListener('resize', syncViewport);
  viewport?.addEventListener('scroll', syncViewport);

  /* ---------- Abrir / fechar ---------- */

  function open() {
    if (isOpen) return;
    isOpen = true;
    syncViewport();
    el.view.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => el.view.classList.add('is-open')));
    connect();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    el.input.blur();
    if (airMode) applyAirMode(false);
    disconnect();
    gesture = null;
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

  el.back.addEventListener('click', () => {
    haptic('tap');
    close();
  });

  document.addEventListener('visibilitychange', () => {
    if (!isOpen) return;
    if (document.hidden) disconnect();
    else connect();
  });

  return Object.freeze({
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  });
}
