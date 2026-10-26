import { readFileSync } from 'node:fs';

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const MIN_ACCESS_TOKEN_LENGTH = 8;
const MIN_AGENT_SECRET_LENGTH = 16;
const DEFAULT_PORT = 8080;
const DEFAULT_AGENT_PORT = 7777;
const DEFAULT_TOUCH_PORT = 7778;
const DEFAULT_TLS_PORT = 8443;

export function normalizeMac(mac) {
  const hex = String(mac ?? '').replace(/[:\-.\s]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(hex)) {
    throw new Error(`MAC inválido: "${mac}" (use o formato AA:BB:CC:DD:EE:FF)`);
  }
  return hex.toUpperCase().match(/../g).join(':');
}

export function isIPv4(value) {
  return typeof value === 'string' && IPV4_RE.test(value);
}

function isPort(value) {
  return Number.isInteger(value) && value > 0 && value < 65536;
}

/** Broadcast de uma rede /24 — o caso de quase toda rede doméstica. */
export function deriveBroadcast(ip) {
  return [...ip.split('.').slice(0, 3), '255'].join('.');
}

/** HTTPS é opcional (o air mouse precisa dele: o iPhone só libera sensores em HTTPS). */
function validateTls(tls, httpPort, errors) {
  if (tls === undefined || tls === null) return null;
  const port = tls.port ?? DEFAULT_TLS_PORT;
  if (!isPort(port) || port === httpPort) errors.push('tls.port precisa ser uma porta válida e diferente de "port"');
  if (typeof tls.pfx !== 'string' || !tls.pfx) errors.push('tls.pfx precisa apontar para o arquivo .pfx (gere com tools/make-cert.ps1)');
  if (typeof tls.passphrase !== 'string') errors.push('tls.passphrase precisa ser texto');
  if (tls.ca !== undefined && tls.ca !== null && typeof tls.ca !== 'string') errors.push('tls.ca precisa ser o caminho do .cer');
  return Object.freeze({ port, pfx: tls.pfx, passphrase: tls.passphrase, ca: tls.ca ?? null });
}

const UPS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_POWER_FACTOR = 0.95;
const MIN_POWER_FACTOR = 0.3;

/** Nobreak via Supervise (Ragtech) é opcional. */
function validateUps(ups, errors) {
  if (ups === undefined || ups === null) return null;
  let url = null;
  try {
    url = new URL(ups.url);
  } catch {
    // tratado abaixo
  }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    errors.push('ups.url precisa ser o endereço do Supervise (ex: http://127.0.0.1:4470)');
  }
  if (ups.id !== undefined && ups.id !== null && !(typeof ups.id === 'string' && UPS_ID_RE.test(ups.id))) {
    errors.push('ups.id precisa ser o id do nobreak no Supervise (ex: 0001521C0A)');
  }
  const powerFactor = ups.powerFactor ?? DEFAULT_POWER_FACTOR;
  if (typeof powerFactor !== 'number' || !(powerFactor >= MIN_POWER_FACTOR && powerFactor <= 1)) {
    errors.push(`ups.powerFactor precisa ser um número entre ${MIN_POWER_FACTOR} e 1 (fontes de PC modernas: ~0.95)`);
  }
  return Object.freeze({ url: url?.origin ?? null, id: ups.id ?? null, powerFactor });
}

export function validateConfig(raw) {
  const errors = [];
  const pc = raw?.pc ?? {};
  const port = raw?.port ?? DEFAULT_PORT;
  const agentPort = pc.agentPort ?? DEFAULT_AGENT_PORT;
  const touchPort = pc.touchPort ?? DEFAULT_TOUCH_PORT;

  if (!isPort(port)) errors.push('port precisa ser um número entre 1 e 65535');
  if (typeof raw?.accessToken !== 'string' || raw.accessToken.length < MIN_ACCESS_TOKEN_LENGTH) {
    errors.push(`accessToken precisa ter pelo menos ${MIN_ACCESS_TOKEN_LENGTH} caracteres`);
  }

  let mac;
  try {
    mac = normalizeMac(pc.mac);
  } catch (err) {
    errors.push(`pc.mac: ${err.message}`);
  }

  if (!isIPv4(pc.ip)) errors.push('pc.ip precisa ser um IPv4 (ex: 192.168.0.10)');
  const broadcast = pc.broadcast ?? (isIPv4(pc.ip) ? deriveBroadcast(pc.ip) : undefined);
  if (!isIPv4(broadcast)) errors.push('pc.broadcast precisa ser um IPv4 (ex: 192.168.0.255)');
  if (!isPort(agentPort)) errors.push('pc.agentPort precisa ser um número entre 1 e 65535');
  if (!isPort(touchPort)) errors.push('pc.touchPort precisa ser um número entre 1 e 65535');
  if (typeof pc.agentSecret !== 'string' || pc.agentSecret.length < MIN_AGENT_SECRET_LENGTH) {
    errors.push(`pc.agentSecret precisa ter pelo menos ${MIN_AGENT_SECRET_LENGTH} caracteres`);
  }
  const tls = validateTls(raw?.tls, port, errors);
  const ups = validateUps(raw?.ups, errors);

  if (errors.length > 0) {
    throw new Error(`Configuração inválida:\n  - ${errors.join('\n  - ')}`);
  }

  return Object.freeze({
    port,
    host: raw.host ?? '0.0.0.0',
    accessToken: raw.accessToken,
    tls,
    ups,
    pc: Object.freeze({
      name: typeof pc.name === 'string' && pc.name.trim() ? pc.name.trim() : 'Meu PC',
      mac,
      ip: pc.ip,
      broadcast,
      agentPort,
      touchPort,
      agentSecret: pc.agentSecret,
    }),
  });
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Não encontrei ${path}. Copie config.example.json para config.json e preencha.`);
  }

  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`${path} não é um JSON válido: ${err.message}`);
  }

  return validateConfig(raw);
}
