import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WhatsAppConfig } from '../config.js';
import { InMemoryWhatsAppInbox } from '../inbox.js';
import { verifyWebhookHandshake, verifyWebhookSignature } from './webhook-security.js';
import { projectMetaWebhook } from './webhook-projection.js';

// Limite local do produto, em bytes; não representa um limite oficial da Meta.
const WEBHOOK_BODY_LIMIT = 1_048_576;
type WebhookCredentials = Pick<Extract<WhatsAppConfig, { enabled: true }>, 'appSecret' | 'webhookVerifyToken' | 'wabaId' | 'phoneNumberId'>;

export function registerMetaWebhookRoutes(server: FastifyInstance, credentials: WebhookCredentials,
  inbox: Pick<InMemoryWhatsAppInbox, 'admit'> = new InMemoryWhatsAppInbox()) {
  server.register(async (webhook) => {
    // Allowlist de campos: nem serializers herdados nem IDs fornecidos pelo
    // visitante podem introduzir URL/query, headers, PII ou exceções nos logs.
    webhook.setChildLoggerFactory((logger, _bindings, options) => logger.child({ reqId: randomUUID() }, {
      ...options,
      serializers: {
        ...options.serializers,
        req: () => ({ channel: 'whatsapp' }),
        res: (reply: FastifyReply) => ({ statusCode: reply.statusCode }),
        err: () => ({ code: 'WHATSAPP_WEBHOOK_ERROR' }),
      },
    }));
    // O 404 padrão do Fastify inclui a URL/query tanto na resposta como no log.
    // Este handler fica restrito ao prefixo do canal, inclusive métodos inválidos.
    webhook.setNotFoundHandler((_request, reply) => reply.code(404).send());
    webhook.addHook('onSend', async (request, reply, payload) => {
      request.body = undefined;
      if (reply.statusCode >= 400) {
        request.log.info({ code: 'WHATSAPP_WEBHOOK_REJECTED', statusCode: reply.statusCode });
      }
      return payload;
    });
    // Encapsulamento Fastify: não afeta os parsers das rotas web/health.
    webhook.removeAllContentTypeParsers();
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
      done(null, body);
    });
    webhook.setErrorHandler((error, request, reply) => {
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      const invalidRequest = typeof status === 'number' && status >= 400 && status < 500;
      // Inclusive erros de framing/content-type: nunca publicar detalhes do parser.
      const statusCode = status === 413 ? 413 : invalidRequest ? 400 : 500;
      request.log.error({ code: 'WHATSAPP_WEBHOOK_ERROR', statusCode });
      return reply.code(statusCode).send();
    });

    webhook.get('/meta', { exposeHeadRoute: false }, async (request, reply) => {
      const url = request.raw.url ?? '';
      const rawQuery = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
      const result = verifyWebhookHandshake(request.query, credentials.webhookVerifyToken, rawQuery);
      if (result.status !== 200) return reply.code(result.status).send();
      return reply.type('text/plain; charset=utf-8').send(result.challenge);
    });

    webhook.post('/meta', { bodyLimit: WEBHOOK_BODY_LIMIT }, async (request, reply) => {
      const body = request.body;
      // Apenas a variável local retém os bytes durante a verificação/projeção.
      request.body = undefined;
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
      let collision = false;
      let capacity = false;
      let beforeStart = 0;
      try {
        for (const event of projection.events) {
          // Status não participa da inbox de mensagens nem executa o motor.
          if (event.type === 'status') continue;
          const admission = inbox.admit(event);
          if (admission === 'collision') collision = true;
          if (admission === 'capacity') capacity = true;
          if (admission === 'before_start') beforeStart += 1;
        }
      } catch {
        // Admissões anteriores do lote ficam deduplicáveis em uma reentrega.
        return reply.code(503).send();
      }
      if (beforeStart > 0) {
        request.log.info({ code: 'WHATSAPP_BEFORE_START_IGNORED', count: beforeStart });
      }
      if (capacity) return reply.code(503).send();
      if (collision) {
        request.log.info({ code: 'WHATSAPP_INBOX_COLLISION' });
        return reply.code(409).send();
      }
      return reply.code(200).send();
    });
  }, { prefix: '/webhooks/whatsapp' });
}
