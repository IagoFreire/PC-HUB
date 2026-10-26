import { readFileSync } from 'node:fs';

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const MIN_ACCESS_TOKEN_LENGTH = 8;
const MIN_AGENT_SECRET_LENGTH = 16;
const DEFAULT_PORT = 8080;
const DEFAULT_AGENT_PORT = 7777;

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

export function validateConfig(raw) {
  const errors = [];
  const pc = raw?.pc ?? {};
  const port = raw?.port ?? DEFAULT_PORT;
  const agentPort = pc.agentPort ?? DEFAULT_AGENT_PORT;

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
  if (typeof pc.agentSecret !== 'string' || pc.agentSecret.length < MIN_AGENT_SECRET_LENGTH) {
    errors.push(`pc.agentSecret precisa ter pelo menos ${MIN_AGENT_SECRET_LENGTH} caracteres`);
  }

  if (errors.length > 0) {
    throw new Error(`Configuração inválida:\n  - ${errors.join('\n  - ')}`);
  }

  return Object.freeze({
    port,
    host: raw.host ?? '0.0.0.0',
    accessToken: raw.accessToken,
    pc: Object.freeze({
      name: typeof pc.name === 'string' && pc.name.trim() ? pc.name.trim() : 'Meu PC',
      mac,
      ip: pc.ip,
      broadcast,
      agentPort,
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
