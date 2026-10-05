import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerMetaWebhookRoutes } from '../src/channels/whatsapp/meta/webhook-route.js';
import { InMemoryWhatsAppInbox } from '../src/channels/whatsapp/inbox.js';
import { metaButton, metaChange, metaEnvelope, metaOrigin, metaStatus, metaText } from './helpers/meta-webhook.js';

const path = '/webhooks/whatsapp/meta';
// Sentinelas fictícias: não ler .env nem usar credenciais/contatos reais.
const privateData = {
  appSecret: 'PRIVATE_APP_SECRET', verifyToken: 'PRIVATE_VERIFY_TOKEN', accessToken: 'PRIVATE_ACCESS_TOKEN',
  query: 'PRIVATE_QUERY', challenge: 'PRIVATE_CHALLENGE', name: 'PRIVATE_PROFILE_NAME',
  phone: '5599999988888', contact: 'private-contact@example.invalid', body: 'PRIVATE_VISITOR_TEXT',
  reference: 'PRIVATE_BUTTON_REFERENCE', title: 'PRIVATE_BUTTON_TITLE', preview: 'PRIVATE_PREVIEW',
  messageId: 'PRIVATE_MESSAGE_ID', requestId: 'PRIVATE_CLIENT_REQUEST_ID', signature: 'PRIVATE_SIGNATURE',
};
const credentials = { ...metaOrigin, appSecret: privateData.appSecret, webhookVerifyToken: privateData.verifyToken };
const query = new URLSearchParams({
  'hub.mode': 'subscribe', 'hub.verify_token': privateData.verifyToken, 'hub.challenge': privateData.challenge,
}).toString();
const sensitiveEnvelope = metaEnvelope([metaChange({
  contacts: [{ wa_id: privateData.phone, profile: { name: privateData.name }, email: privateData.contact }],
  messages: [
    metaText({ id: privateData.messageId, from: privateData.phone, text: { body: privateData.body } }),
    metaButton({
      from: privateData.phone, context: { id: privateData.preview },
      interactive: { type: 'button_reply', button_reply: { id: privateData.reference, title: privateData.title } },
    }),
    metaText({ timestamp: privateData.query }),
    metaText({ type: 'image', image: { caption: privateData.body } }),
  ],
  statuses: [metaStatus({ status: 'failed', recipient_id: privateData.phone, errors: [{ message: privateData.contact }] })],
})]);
const payload = Buffer.from(JSON.stringify(sensitiveEnvelope));
function sign(body: Buffer) {
  return `sha256=${createHmac('sha256', privateData.appSecret).update(body).digest('hex')}`;
}
function post(body = payload): InjectOptions {
  return { method: 'POST', url: `${path}?extra=${privateData.query}`, payload: body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) } };
}

const servers: FastifyInstance[] = [];
const inboxes: InMemoryWhatsAppInbox[] = [];
afterEach(async () => {
  await Promise.all(inboxes.splice(0).map((inbox) => inbox.drain()));
  for (const server of servers.splice(0)) await server.close();
});

function loggedServer() {
  const lines: string[] = [];
  const server = Fastify({
    // Captura o Pino real e os logs automáticos, sem substituir seus métodos.
    logger: { level: 'trace', stream: { write: (line) => { lines.push(line); } },
      serializers: {
        req: (request) => ({ url: request.url, headers: request.headers }),
        res: (reply) => ({ headers: reply.getHeaders?.() }),
      },
    },
    // Mesmo uma composição que aceita ID externo não pode vazá-lo no canal.
    requestIdHeader: 'x-request-id',
  });
  servers.push(server);
  const inbox = new InMemoryWhatsAppInbox(undefined, { now: () => new Date('2030-06-10T12:00:00Z') });
  inboxes.push(inbox);
  registerMetaWebhookRoutes(server, credentials, inbox);
  const inject = (options: InjectOptions) => server.inject({ ...options,
    headers: { authorization: `Bearer ${privateData.accessToken}`, cookie: privateData.contact,
      'x-request-id': privateData.requestId, 'x-private-secret': privateData.appSecret, ...options.headers },
  });
  return { server, lines, inject };
}

function expectSafeLogs(lines: string[], extra: string[] = []) {
  const output = lines.join('');
  expect(lines.length).toBeGreaterThan(0);
  for (const value of [...Object.values(privateData), query, sign(payload), ...extra]) {
    expect(output).not.toContain(value);
    expect(output).not.toContain(encodeURIComponent(value));
  }
  expect(output).not.toMatch(/hub\.verify_token|hub\.challenge|"(?:headers|body|stack|cause|url|query|contacts|interactive)"/);
  const records = lines.map((line) => JSON.parse(line));
  expect(records.some((record) => record.msg === 'incoming request')).toBe(true);
  expect(records.some((record) => record.msg === 'request completed')).toBe(true);
  for (const record of records) {
    expect(record.reqId).toMatch(/^[a-f0-9-]{36}$/);
    if (record.req) expect(record.req).toEqual({ channel: 'whatsapp' });
    if (record.res) expect(Object.keys(record.res)).toEqual(['statusCode']);
  }
  return records;
}

describe('logs reais e erros sanitizados do webhook', () => {
  it('preserva o challenge na resposta sem registrar query, headers ou resposta', async () => {
    const { inject, lines } = loggedServer();
    const response = await inject({ method: 'GET', url: `${path}?${query}` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(privateData.challenge);
    expectSafeLogs(lines);
  });

  it('registra somente contagens locais para lote com texto, contato, botão, mídia e erro de status', async () => {
    const { server, inject, lines } = loggedServer();
    const retainedBodies: unknown[] = [];
    server.addHook('onResponse', async (request) => { retainedBodies.push(request.body); });
    const response = await inject(post());
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(retainedBodies).toEqual([undefined]);
    const records = expectSafeLogs(lines);
    expect(records.find((record) => record.code === 'WHATSAPP_WEBHOOK_ITEMS_IGNORED')).toMatchObject({
      counts: { INVALID_MESSAGE: 1, INVALID_STATUS: 0, UNSUPPORTED_MESSAGE: 1, UNSUPPORTED_STATUS: 0, UNSUPPORTED_CHANGE: 0 },
    });
  });

  it.each<[string, InjectOptions, number]>([
    ['modo inválido', { method: 'GET', url: `${path}?${query.replace('subscribe', privateData.query)}` }, 403],
    ['token inválido', { method: 'GET', url: `${path}?${query.replace(privateData.verifyToken, privateData.accessToken)}` }, 403],
    ['query inválida', { method: 'GET', url: `${path}?${query}&extra=${privateData.query}` }, 400],
    ['assinatura inválida', { ...post(), headers: { 'content-type': 'application/json', 'x-hub-signature-256': privateData.signature } }, 403],
    ['JSON inválido assinado', post(Buffer.from(`{"text":"${privateData.body}"`)), 400],
    ['origem divergente', post(Buffer.from(JSON.stringify({ ...sensitiveEnvelope, object: privateData.phone }))), 403],
    ['Content-Type inválido', { ...post(), headers: { 'content-type': `application/${privateData.contact}` } }, 400],
    ['corpo excessivo', post(Buffer.from(privateData.body.repeat(80_000))), 413],
    ['método inválido', { method: 'PUT', url: `${path}?${query}` }, 404],
    ['HEAD não habilitado', { method: 'HEAD', url: `${path}?${query}` }, 404],
    ['subcaminho inexistente', { method: 'GET', url: `${path}/${privateData.contact}?${query}` }, 404],
  ])('%s não publica conteúdo sensível no erro ou nos logs', async (_label, options, statusCode) => {
    const { inject, lines } = loggedServer();
    const response = await inject(options);
    expect(response.statusCode).toBe(statusCode);
    expect(response.body).toBe('');
    const exposed = JSON.stringify(response.headers);
    for (const value of Object.values(privateData)) expect(exposed).not.toContain(value);
    const records = expectSafeLogs(lines, [String(options.headers?.['x-hub-signature-256'] ?? privateData.signature)]);
    expect(records.some((record) => record.code === 'WHATSAPP_WEBHOOK_REJECTED' && record.statusCode === statusCode)).toBe(true);
  });

  it('remove mensagem, stack, cause e propriedades de exceção HTTP, mantendo erro 500 controlado', async () => {
    const { server, inject, lines } = loggedServer();
    const cause = Object.assign(new Error(privateData.appSecret), { body: sensitiveEnvelope });
    const error = Object.assign(new Error(`${privateData.contact} ${privateData.accessToken}`, { cause }), {
      url: `https://example.invalid/?${query}`, headers: { authorization: privateData.accessToken },
      request: { body: sensitiveEnvelope }, response: { body: privateData.preview }, code: privateData.reference,
    });
    server.addHook('preHandler', async (request) => {
      // Simula falha HTTP com metadados sensíveis; não chama provider/modelo.
      request.log.error({ err: error }, 'Falha simulada de transporte');
      throw error;
    });
    const response = await inject(post());
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('');
    const records = expectSafeLogs(lines);
    expect(records.find((record) => record.err)?.err).toEqual({ code: 'WHATSAPP_WEBHOOK_ERROR' });
    expect(records.some((record) => record.code === 'WHATSAPP_WEBHOOK_ERROR' && record.statusCode === 500)).toBe(true);
  });

  it('mantém correlação local distinta entre requisições, sem usar o ID externo', async () => {
    const { inject, lines } = loggedServer();
    await inject(post());
    await inject(post());
    const records = expectSafeLogs(lines);
    const incoming = records.filter((record) => record.msg === 'incoming request');
    const completed = records.filter((record) => record.msg === 'request completed');
    expect(new Set(incoming.map((record) => record.reqId)).size).toBe(2);
    expect(completed.map((record) => record.reqId)).toEqual(incoming.map((record) => record.reqId));
  });
});
