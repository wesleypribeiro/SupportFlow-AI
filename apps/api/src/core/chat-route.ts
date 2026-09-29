import { chatConfirmationRequestSchema, chatErrorResponseSchema, chatRequestSchema } from '@supportflow/contracts/chat';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ConversationService, ConversationServiceResult } from './conversation-service.js';

function publicError(code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'ACTION_STALE' | 'CHAT_ERROR') {
  const messages = {
    INVALID_REQUEST: 'Requisição de chat inválida.',
    NOT_FOUND: 'Conversa ou ação não encontrada.',
    ACTION_STALE: 'Esta ação não está mais disponível. Revise os dados antes de confirmar uma nova prévia.',
    CHAT_ERROR: 'Não foi possível concluir o atendimento. Tente novamente.',
  };
  return chatErrorResponseSchema.parse({ error: { code, message: messages[code] } });
}

function sendResult<Response>(reply: FastifyReply, result: ConversationServiceResult<Response>) {
  if (result.ok) return reply.send(result.response);
  const status = { NOT_FOUND: 404, ACTION_STALE: 409, CHAT_ERROR: 500 };
  return reply.code(status[result.code]).send(publicError(result.code));
}

export function registerChatRoute<Response>(server: FastifyInstance, service: ConversationService<Response>) {
  // Escopo local: erros de parsing HTTP também respeitam o envelope público do chat.
  server.register(async (chatServer) => {
    chatServer.setErrorHandler((error, _request, reply) => {
      const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      const invalidRequest = typeof status === 'number' && status >= 400 && status < 500;
      return reply.code(invalidRequest ? 400 : 500)
        .send(publicError(invalidRequest ? 'INVALID_REQUEST' : 'CHAT_ERROR'));
    });

    chatServer.post('/api/chat', async (request, reply) => {
      const parsed = chatRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(publicError('INVALID_REQUEST'));
      }

      return sendResult(reply, await service.sendMessage(parsed.data));
    });

    chatServer.post('/api/chat/confirm', async (request, reply) => {
      const parsed = chatConfirmationRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(publicError('INVALID_REQUEST'));
      return sendResult(reply, await service.confirmAction(parsed.data));
    });
  });
}
