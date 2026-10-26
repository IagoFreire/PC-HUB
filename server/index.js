import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPcMonitor } from './pc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let config;
try {
  config = loadConfig(process.env.AURORA_CONFIG ?? path.join(root, 'config.json'));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const monitor = createPcMonitor({ pc: config.pc });
const server = createApp({ config, monitor, publicDir: path.join(root, 'public') });

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `A porta ${config.port} já está em uso. Mude "port" no config.json.`
    : `Falha no servidor: ${err.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const lanAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => `http://${iface.address}:${config.port}`);

  console.log(`Aurora pronto — controlando "${config.pc.name}" (${config.pc.ip}, ${config.pc.mac})`);
  for (const url of lanAddresses) console.log(`  abra no iPhone: ${url}`);
});
