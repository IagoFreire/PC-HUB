// Com HTTPS ligado, a porta HTTP só faz duas coisas: entregar a CA local para o iPhone confiar
// nela e redirecionar todo o resto para o endereço HTTPS.
import http from 'node:http';

export const CA_DOWNLOAD_PATH = '/aurora-ca.cer';
const HOSTNAME_RE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i;

/** Tira a porta do header Host e recusa qualquer coisa que não pareça um nome/IP (evita header injection). */
export function hostnameOf(hostHeader) {
  const host = String(hostHeader ?? '');
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return HOSTNAME_RE.test(hostname) ? hostname : null;
}

export function createRedirectServer({ httpsPort, caCert = null }) {
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://local');

    if (caCert && pathname === CA_DOWNLOAD_PATH) {
      // Esse content-type faz o Safari oferecer "baixar perfil de configuração".
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="aurora-ca.cer"',
        'Content-Length': caCert.length,
        'Cache-Control': 'no-store',
      });
      res.end(caCert);
      return;
    }

    const hostname = hostnameOf(req.headers.host);
    if (!hostname) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Host inválido.');
      return;
    }
    res.writeHead(301, { Location: `https://${hostname}:${httpsPort}${req.url}` });
    res.end();
  });
}
