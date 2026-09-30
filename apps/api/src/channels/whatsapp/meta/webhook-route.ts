import type { FastifyInstance } from 'fastify';
import type { WhatsAppConfig } from '../config.js';
import { verifyWebhookHandshake, verifyWebhookSignature } from './webhook-security.js';
import { projectMetaWebhook } from './webhook-projection.js';

// Limite local do produto, em bytes; não representa um limite oficial da Meta.
const WEBHOOK_BODY_LIMIT = 1_048_576;
type WebhookCredentials = Pick<Extract<WhatsAppConfig, { enabled: true }>, 'appSecret' | 'webhookVerifyToken' | 'wabaId' | 'phoneNumberId'>;

export function registerMetaWebhookRoutes(server: FastifyInstance, credentials: WebhookCredentials) {
  server.register(async (webhook) => {
    // Encapsulamento Fastify: não afeta os parsers das rotas web/health.
    webhook.removeAllContentTypeParsers();
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
      done(null, body);
    });
    webhook.setErrorHandler((error, _request, reply) => {
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      const invalidRequest = typeof status === 'number' && status >= 400 && status < 500;
      // Inclusive erros de framing/content-type: nunca publicar detalhes do parser.
      return reply.code(status === 413 ? 413 : invalidRequest ? 400 : 500).send();
    });

    webhook.get('/webhooks/whatsapp/meta', { exposeHeadRoute: false }, async (request, reply) => {
      const url = request.raw.url ?? '';
      const rawQuery = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const result = verifyWebhookHandshake(request.query, credentials.webhookVerifyToken, rawQuery);
      if (result.status !== 200) return reply.code(result.status).send();
      return reply.type('text/plain; charset=utf-8').send(result.challenge);
    });

    webhook.post('/webhooks/whatsapp/meta', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) return reply.code(400).send();
      if (!verifyWebhookSignature(body, request.headers['x-hub-signature-256'], credentials.appSecret)) {
        return reply.code(403).send();
      }

      let json: unknown;
      try {
        // Decodificação/parsing somente após autenticar os bytes originais.
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
      } catch {
        return reply.code(400).send();
      }

      const projection = projectMetaWebhook(json, credentials);
      if (projection.status !== 200) return reply.code(projection.status).send();
      if (Object.values(projection.observations).some((count) => count > 0)) {
        request.log.info({ code: 'WHATSAPP_WEBHOOK_ITEMS_IGNORED', counts: projection.observations });
      }
      // Task 2.3: eventos validados, ainda sem admissão/inbox ou processamento.
      return reply.code(200).send();
    });
  });
}
