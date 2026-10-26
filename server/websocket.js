// WebSocket mínimo (RFC 6455) só para o trackpad: mensagens de texto pequenas, sem fragmentação.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_PAYLOAD_BYTES = 4096;
const MAX_CONTROL_PAYLOAD_BYTES = 125;
const MAX_PENDING_WRITE_BYTES = 16 * 1024;
const HEARTBEAT_MS = 15_000;
const IDLE_TIMEOUT_MS = 45_000;

const OPCODE = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });
const CLOSE = Object.freeze({ normal: 1000, protocolError: 1002, unsupported: 1003, tooBig: 1009 });

/**
 * Lê um frame do cliente. Devolve null se ainda faltam bytes, { error } se o frame é inválido,
 * ou { fin, opcode, payload, length } com o tamanho total consumido do buffer.
 */
export function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_PAYLOAD_BYTES)) return { error: CLOSE.tooBig };
    length = Number(big);
    offset = 10;
  }

  if (length > MAX_PAYLOAD_BYTES) return { error: CLOSE.tooBig };
  // Frames de controle (close/ping/pong) têm no máximo 125 bytes e não podem ser fragmentados.
  if (opcode >= 0x8 && (length > MAX_CONTROL_PAYLOAD_BYTES || !fin)) return { error: CLOSE.protocolError };
  // Pela RFC, todo frame vindo do navegador é mascarado.
  if (!masked) return { error: CLOSE.protocolError };
  if (buffer.length < offset + 4 + length) return null;

  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i++) payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
  return { fin, opcode, payload, length: offset + 4 + length };
}

/** Monta um frame do servidor (sem máscara). */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  const header = length < 126
    ? Buffer.from([0x80 | opcode, length])
    : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #lastSeen = Date.now();
  #heartbeat;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on('data', (chunk) => this.#onData(chunk));
    // O servidor HTTP usa allowHalfOpen: cliente que só fecha o TCP (app morto) gera 'end', não 'close'.
    socket.on('end', () => this.#finish());
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
    // Celular que sumiu sem fechar (Wi-Fi caiu): sem pong por 45 s, a conexão é encerrada.
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastSeen > IDLE_TIMEOUT_MS) {
        this.close(CLOSE.normal, 'idle');
        return;
      }
      this.#write(OPCODE.ping);
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  /** Escreve um frame, descartando se o cliente não está lendo (evita acumular memória). */
  #write(opcode, payload) {
    if (this.#socket.writableLength > MAX_PENDING_WRITE_BYTES) return;
    this.#socket.write(encodeFrame(opcode, payload));
  }

  get isOpen() {
    return !this.#closed;
  }

  send(message) {
    if (this.#closed) return;
    this.#write(OPCODE.text, Buffer.from(JSON.stringify(message)));
  }

  close(code = CLOSE.normal, reason = '') {
    if (this.#closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.#socket.end(encodeFrame(OPCODE.close, body));
    this.#finish();
  }

  #onData(chunk) {
    if (this.#closed) return;
    this.#lastSeen = Date.now();
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      const frame = parseFrame(this.#buffer);
      if (frame === null) return;
      if (frame.error) {
        this.close(frame.error);
        return;
      }
      this.#buffer = this.#buffer.subarray(frame.length);
      if (!this.#handleFrame(frame)) return;
    }
  }

  /** Processa um frame; devolve false quando a conexão foi encerrada. */
  #handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.text:
        if (!fin) {
          this.close(CLOSE.unsupported);
          return false;
        }
        this.emit('message', payload.toString('utf8'));
        return !this.#closed;
      case OPCODE.ping:
        this.#write(OPCODE.pong, payload);
        return true;
      case OPCODE.pong:
        return true;
      case OPCODE.close:
        this.close(CLOSE.normal);
        return false;
      default:
        this.close(CLOSE.unsupported);
        return false;
    }
  }

  #finish() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    // end() já enviou o frame de close; destroy no próximo tick para ele sair antes.
    setImmediate(() => this.#socket.destroy());
    this.emit('close');
  }
}

/** Completa o handshake de upgrade; devolve a conexão ou null (já respondendo 400). */
export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const isUpgrade = String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
  if (!isUpgrade || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }

  const accept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  socket.setNoDelay(true);
  return new WebSocketConnection(socket);
}
