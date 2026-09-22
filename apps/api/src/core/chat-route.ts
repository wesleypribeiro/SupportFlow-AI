import { chatErrorResponseSchema, chatRequestSchema } from '@supportflow/contracts/chat';
import type { FastifyInstance } from 'fastify';
import type { createChatRunner } from './chat.js';
import type { InMemoryConversations } from './conversations.js';

function publicError(code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'CHAT_ERROR') {
  const messages = {
    INVALID_REQUEST: 'Requisição de chat inválida.',
    NOT_FOUND: 'Conversa não encontrada.',
    CHAT_ERROR: 'Não foi possível concluir o atendimento. Tente novamente.',
  };
  return chatErrorResponseSchema.parse({ error: { code, message: messages[code] } });
}

export function registerChatRoute<Context>(server: FastifyInstance, composition: {
  conversations: InMemoryConversations<Context>;
  runTurn: ReturnType<typeof createChatRunner<Context>>;
  parseResponse: (response: unknown) => unknown;
}) {
  const { conversations, runTurn, parseResponse } = composition;

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

      const { conversationId, message } = parsed.data;
      const conversation = conversationId === undefined
        ? conversations.create()
        : conversations.get(conversationId);

      if (!conversation) {
        return reply.code(404).send(publicError('NOT_FOUND'));
      }

      // Falhas de modelo/tools/schema são sanitizadas aqui, sem classificar exceções internas.
      try {
        const turn = await runTurn(conversation, message);
        const response = parseResponse({
          conversationId: conversation.id,
          reply: turn.reply,
          results: turn.results,
          pendingAction: null,
        });

        conversations.save({ ...conversation, history: turn.history, context: turn.context });
        return reply.send(response);
      } catch {
        return reply.code(500).send(publicError('CHAT_ERROR'));
      }
    });
  });
}
