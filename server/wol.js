import dgram from 'node:dgram';
import { normalizeMac } from './config.js';

const WOL_PORTS = [9, 7];
const REPEAT = 3;
const MAC_REPETITIONS = 16;

/** Magic packet: 6 bytes 0xFF seguidos do MAC repetido 16 vezes (102 bytes). */
export function buildMagicPacket(mac) {
  const macBytes = Buffer.from(normalizeMac(mac).replaceAll(':', ''), 'hex');
  const packet = Buffer.alloc(6 + MAC_REPETITIONS * macBytes.length, 0xff);
  for (let i = 0; i < MAC_REPETITIONS; i++) {
    macBytes.copy(packet, 6 + i * macBytes.length);
  }
  return packet;
}

/**
 * Envia o magic packet para o broadcast da rede e para 255.255.255.255,
 * nas portas 9 e 7, algumas vezes — UDP não garante entrega.
 */
export function sendMagicPacket({ mac, broadcast }, { createSocket = dgram.createSocket } = {}) {
  const packet = buildMagicPacket(mac);
  const targets = [...new Set([broadcast, '255.255.255.255'])];

  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const finish = (fn) => {
      socket.close();
      fn();
    };

    socket.once('error', (err) => finish(() => reject(err)));
    socket.bind(() => {
      socket.setBroadcast(true);
      const sends = [];
      for (let r = 0; r < REPEAT; r++) {
        for (const address of targets) {
          for (const port of WOL_PORTS) {
            sends.push(new Promise((ok, fail) => {
              socket.send(packet, port, address, (err) => (err ? fail(err) : ok()));
            }));
          }
        }
      }

      Promise.allSettled(sends).then((results) => {
        const delivered = results.filter((r) => r.status === 'fulfilled').length;
        if (delivered === 0) {
          finish(() => reject(results[0].reason));
          return;
        }
        finish(() => resolve({ delivered, attempted: results.length }));
      });
    });
  });
}
