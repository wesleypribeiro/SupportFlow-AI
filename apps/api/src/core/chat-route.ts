import { chatConfirmationRequestSchema, chatErrorResponseSchema, chatRequestSchema } from '@supportflow/contracts/chat';
import type { FastifyInstance } from 'fastify';
import type { createChatRunner } from './chat.js';
import type { InMemoryConversations } from './conversations.js';
import type { ActionDefinition, ActionExecutor, ActionReceipt, InMemoryPendingActions } from './pending-actions.js';

function publicError(code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'ACTION_STALE' | 'CHAT_ERROR') {
  const messages = {
    INVALID_REQUEST: 'Requisição de chat inválida.',
    NOT_FOUND: 'Conversa ou ação não encontrada.',
    ACTION_STALE: 'Esta ação não está mais disponível. Revise os dados antes de confirmar uma nova prévia.',
    CHAT_ERROR: 'Não foi possível concluir o atendimento. Tente novamente.',
  };
  return chatErrorResponseSchema.parse({ error: { code, message: messages[code] } });
}

export function registerChatRoute<Context extends { revision: number }, Definition extends ActionDefinition, Receipt extends ActionReceipt>(server: FastifyInstance, composition: {
  conversations: InMemoryConversations<Context>;
  actions: InMemoryPendingActions<Definition, Receipt>;
  executeAction?: ActionExecutor<Definition>;
  runTurn: ReturnType<typeof createChatRunner<Context>>;
  parseResponse: (response: unknown) => unknown;
}) {
  const { conversations, actions, executeAction, runTurn, parseResponse } = composition;

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
      const initial = conversationId === undefined ? conversations.create() : undefined;
      const id = conversationId ?? initial!.id;

      // Falhas de modelo/tools/schema são sanitizadas aqui, sem classificar exceções internas.
      try {
        return await conversations.runExclusive(id, async () => {
          // Ler somente dentro da fila: uma correção anterior pode estar em andamento.
          const conversation = initial ?? conversations.get(id);
          if (!conversation) return reply.code(404).send(publicError('NOT_FOUND'));
          const turn = await runTurn(conversation, message);
          const response = parseResponse({
            conversationId: id,
            reply: turn.reply,
            results: turn.results,
            pendingAction: actions.pending(id, turn.context.revision),
          });

          conversations.save({ ...conversation, history: turn.history, context: turn.context });
          actions.invalidate(id, turn.context.revision);
          return reply.send(response);
        });
      } catch {
        return reply.code(500).send(publicError('CHAT_ERROR'));
      }
    });

    chatServer.post('/api/chat/confirm', async (request, reply) => {
      const parsed = chatConfirmationRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(publicError('INVALID_REQUEST'));
      const { conversationId, actionId } = parsed.data;

      try {
        return await conversations.runExclusive(conversationId, async () => {
          const conversation = conversations.get(conversationId);
          if (!conversation) return reply.code(404).send(publicError('NOT_FOUND'));
          const outcome = await actions.confirm(conversationId, conversation.context.revision, actionId, executeAction);
          if (!outcome.ok) {
            return reply.code(outcome.code === 'NOT_FOUND' ? 404 : 409).send(publicError(outcome.code));
          }
          return reply.send(parseResponse({
            conversationId,
            ...outcome.receipt,
            pendingAction: actions.pending(conversationId, conversation.context.revision),
          }));
        });
      } catch {
        return reply.code(500).send(publicError('CHAT_ERROR'));
      }
    });
  });
}
