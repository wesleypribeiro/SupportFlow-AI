// Ensaio local do Nginx REAL. Requer Node 24, nginx com SSL, openssl e loopback.
// Não inicia a aplicação, não lê .env e não acessa Meta/OpenAI/túneis externos.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nginx = process.env.NGINX_BIN || 'nginx';
const webhook = '/webhooks/whatsapp/meta';
const query = 'hub.mode=subscribe&hub.verify_token=PRIVATE_VERIFY_TOKEN&hub.challenge=PRIVATE_CHALLENGE';
const signature = `sha256=${'a'.repeat(64)}`;
const body = Buffer.from('{ "text": "PRIVATE_BODY_á", "contact": "private@example.invalid", "reference": "PRIVATE_REFERENCE" }');
const received = [];
let directory;
let proxy;
let proxyClosed;
let upstream;

async function command(binary, args) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stdout.on('data', (chunk) => { diagnostic += chunk; });
  child.stderr.on('data', (chunk) => { diagnostic += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, `Falha no comando local ${binary}: ${diagnostic}`);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function exchange(port, ca, method, path, payload) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, ca, method, path, agent: false,
      headers: { 'content-type': 'application/json', authorization: 'Bearer PRIVATE_ACCESS_TOKEN',
        'x-hub-signature-256': signature, 'x-request-id': 'PRIVATE_REQUEST_ID',
        ...(payload ? { 'content-length': payload.length } : {}) },
      // Confia somente no certificado temporário deste ensaio; TLS segue validado.
      signal: AbortSignal.timeout(5_000),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

try {
  await command(nginx, ['-v']);
  directory = await mkdtemp(join(tmpdir(), 'supportflow-whatsapp-proxy-'));
  await mkdir(join(directory, 'logs'));
  await mkdir(join(directory, 'body-temp'));
  await mkdir(join(directory, 'proxy-temp'));
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'private-key.pem'), '-out', join(directory, 'certificate.pem')]);
  const ca = await readFile(join(directory, 'certificate.pem'));
  upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    // O upstream responde 200 para QUALQUER caminho: só o proxy pode provar negação.
    res.end(req.method === 'GET' ? 'PRIVATE_CHALLENGE' : '');
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const proxyPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const original = await readFile(new URL('./nginx.conf', import.meta.url), 'utf8');
  // Muda somente portas locais para evitar interferir em serviços do desenvolvedor.
  const config = original.replace('127.0.0.1:8443', `127.0.0.1:${proxyPort}`)
    .replace('127.0.0.1:3001', `127.0.0.1:${upstreamPort}`);
  const configPath = join(directory, 'nginx.conf');
  await writeFile(configPath, config);
  const args = ['-p', `${directory}/`, '-c', configPath, '-e', '/dev/null'];
  await command(nginx, [...args, '-t']);
  proxy = spawn(nginx, [...args, '-g', 'daemon off; master_process off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let proxyOutput = '';
  proxy.stdout.on('data', (chunk) => { proxyOutput += chunk; });
  proxy.stderr.on('data', (chunk) => { proxyOutput += chunk; });
  proxyClosed = once(proxy, 'close');
  // Observar disponibilidade real, sem sleep fixo que presuma prontidão.
  const deadline = Date.now() + 5_000;
  while (true) {
    assert.equal(proxy.exitCode, null, `Nginx encerrou: ${proxyOutput}`);
    try {
      assert.equal((await exchange(proxyPort, ca, 'GET', '/')).status, 403);
      break;
    } catch (error) {
      if (error.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
    }
  }
  const get = await exchange(proxyPort, ca, 'GET', `${webhook}?${query}`);
  assert.equal(get.status, 200);
  assert.equal(get.body.toString(), 'PRIVATE_CHALLENGE');
  assert.equal((await exchange(proxyPort, ca, 'POST', webhook, body)).status, 200);
  assert.equal(received[0].url, `${webhook}?${query}`);
  assert.equal(received[1].url, webhook);
  assert.deepEqual(received[1].body, body);
  assert.equal(received[1].headers['x-hub-signature-256'], signature);

  let denied = 0;
  for (const path of ['/api/chat', '/api/chat/confirm', '/health', '/', '/unknown',
    '/api/chat?test=PRIVATE_QUERY', '/api/chat/confirm?test=PRIVATE_QUERY',
    `${webhook}/`, `${webhook}/../../api/chat`, '/webhooks//whatsapp/meta',
    '/webhooks/whatsapp/%6deta', '/webhooks/whatsapp/meta%2f..%2f..%2fapi%2fchat']) {
    for (const method of ['GET', 'POST']) {
      const response = await exchange(proxyPort, ca, method, path, method === 'POST' ? body : undefined);
      assert.equal(response.status, 403, `${method} ${path} deve ser negado no proxy`);
      denied++;
    }
  }
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE', 'TRACE']) {
    // Alguns métodos são rejeitados pelo próprio parser antes da allowlist.
    const { status } = await exchange(proxyPort, ca, method, `${webhook}?${query}`);
    assert.ok(status === 403 || status === 405, `${method} deve ser negado`);
    denied++;
  }
  assert.equal(received.length, 2, 'Nenhuma requisição negada pode alcançar o upstream');

  // Falha de transporte produz apenas status/duração, sem URL/query no error_log.
  await new Promise((resolve) => upstream.close(resolve));
  assert.equal((await exchange(proxyPort, ca, 'GET', `${webhook}?${query}`)).status, 502);
  proxy.kill('SIGQUIT');
  await proxyClosed;
  const logs = await readFile(join(directory, 'logs/whatsapp-access.log'), 'utf8');
  assert.ok(logs.trim().length > 0, 'A captura de logs não pode estar vazia');
  for (const sentinel of ['PRIVATE_', 'private@example.invalid', signature, 'hub.verify_token', webhook]) {
    assert.ok(!(logs + proxyOutput).includes(sentinel), 'Logs do proxy devem estar sanitizados');
  }
  for (const line of logs.trim().split('\n')) {
    const entry = JSON.parse(line);
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'duration', 'status']);
    assert.equal(entry.code, 'WHATSAPP_PROXY_REQUEST');
    assert.equal(typeof entry.status, 'number');
    assert.equal(typeof entry.duration, 'number');
  }
  console.info(`Proxy HTTPS validado: GET/POST preservados, ${denied} acessos negados, falha 502 e logs sanitizados.`);
} catch (error) {
  console.error(`Validação local do proxy não concluída: ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally {
  if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
    proxy.kill('SIGTERM');
    await proxyClosed;
  }
  if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
}
