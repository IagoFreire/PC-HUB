import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, defaultLog } from './app.js';
import { loadConfig } from './config.js';
import { createPcMonitor } from './pc.js';
import { CA_DOWNLOAD_PATH, createRedirectServer } from './redirect.js';
import { createTouchRelay } from './touch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env.AURORA_CONFIG ?? path.join(root, 'config.json'));
} catch (err) {
  fail(err.message);
}

function readTlsFile(relativePath, field) {
  try {
    return readFileSync(path.resolve(root, relativePath));
  } catch {
    return fail(`Não encontrei ${relativePath} (tls.${field}). Gere com: powershell -File tools\\make-cert.ps1`);
  }
}

const tls = config.tls
  ? { pfx: readTlsFile(config.tls.pfx, 'pfx'), passphrase: config.tls.passphrase }
  : null;
const caCert = config.tls?.ca ? readTlsFile(config.tls.ca, 'ca') : null;

const monitor = createPcMonitor({ pc: config.pc });
const touch = createTouchRelay({
  host: config.pc.ip,
  port: config.pc.touchPort,
  secret: config.pc.agentSecret,
  log: defaultLog,
});

let server;
try {
  server = createApp({ config, monitor, touch, tls, publicDir: path.join(root, 'public') });
} catch (err) {
  fail(`Não consegui carregar o certificado HTTPS (senha ou arquivo errado?): ${err.message}`);
}

const appPort = config.tls?.port ?? config.port;
const redirect = config.tls ? createRedirectServer({ httpsPort: config.tls.port, caCert }) : null;

const onListenError = (port, field) => (err) => {
  fail(err.code === 'EADDRINUSE'
    ? `A porta ${port} já está em uso. Mude "${field}" no config.json.`
    : `Falha no servidor: ${err.message}`);
};
server.on('error', onListenError(appPort, config.tls ? 'tls.port' : 'port'));
redirect?.on('error', onListenError(config.port, 'port'));

const lanAddresses = () => Object.values(os.networkInterfaces())
  .flat()
  .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
  .map((iface) => iface.address);

server.listen(appPort, config.host, () => {
  console.log(`Aurora pronto — controlando "${config.pc.name}" (${config.pc.ip}, ${config.pc.mac})`);
  const scheme = config.tls ? 'https' : 'http';
  for (const address of lanAddresses()) console.log(`  abra no iPhone: ${scheme}://${address}:${appPort}`);
  if (redirect) {
    redirect.listen(config.port, config.host, () => {
      for (const address of lanAddresses()) {
        console.log(`  certificado para o iPhone confiar: http://${address}:${config.port}${CA_DOWNLOAD_PATH}`);
      }
    });
  }
});
