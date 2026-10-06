import type { ChatConfirmationRequest, ChatRequest } from '@supportflow/contracts/chat';
import type { createChatRunner, TurnPresentation } from './chat.js';
import type { InMemoryConversations } from './conversations.js';
import type { ActionDefinition, ActionExecutor, ActionReceipt, InMemoryPendingActions, PreparedAction } from './pending-actions.js';

export type ConversationServiceResult<Response> =
  | { ok: true; response: Response }
  | { ok: false; code: 'NOT_FOUND' | 'ACTION_STALE' | 'CHAT_ERROR' };

// Adapters validam os comandos com os contratos compartilhados antes de chamar
// o serviço. Nenhum código HTTP ou conceito do segmento entra nesta interface.
export type ConversationService<Response, PendingAction = unknown> = {
  openConversation: () => Promise<ConversationServiceResult<{ conversationId: string }>>;
  getCurrentPendingAction: (request: Pick<ChatConfirmationRequest, 'conversationId'>) => Promise<ConversationServiceResult<{ pendingAction: PendingAction }>>;
  sendMessage: (request: ChatRequest, presentation?: TurnPresentation) => Promise<ConversationServiceResult<Response>>;
  confirmAction: (request: ChatConfirmationRequest) => Promise<ConversationServiceResult<Response>>;
};

export function createConversationService<Context extends { revision: number }, Definition extends ActionDefinition, Receipt extends ActionReceipt, Response>(composition: {
  conversations: InMemoryConversations<Context>;
  actions: InMemoryPendingActions<Definition, Receipt>;
  executeAction?: ActionExecutor<Definition>;
  describeReceipt?: (action: PreparedAction<Definition>, receipt: Receipt) => Promise<string>;
  runTurn: ReturnType<typeof createChatRunner<Context>>;
  parseResponse: (response: unknown) => Response;
}): ConversationService<Response, ReturnType<InMemoryPendingActions<Definition, Receipt>['pending']>> {
  const { conversations, actions, executeAction, describeReceipt, runTurn, parseResponse } = composition;

  return {
    async openConversation() {
      try {
        // A factory injetada define os defaults. Esta abertura explícita persiste
        // apenas o estado vazio; sendMessage sem ID mantém seu commit por turno.
        const conversation = conversations.create();
        return await conversations.runExclusive(conversation.id, () => {
          conversations.save(conversation);
          return { ok: true, response: { conversationId: conversation.id } };
        });
      } catch {
        return { ok: false, code: 'CHAT_ERROR' };
      }
    },

    async getCurrentPendingAction({ conversationId }) {
      try {
        return await conversations.runExclusive(conversationId, () => {
          // A leitura observa somente o estado commitado anterior na mesma fila.
          const conversation = conversations.get(conversationId);
          if (!conversation) return { ok: false, code: 'NOT_FOUND' };
          return { ok: true, response: {
            pendingAction: actions.pending(conversationId, conversation.context.revision),
          } };
        });
      } catch {
        return { ok: false, code: 'CHAT_ERROR' };
      }
    },

    async sendMessage({ conversationId, message }, presentation) {
      try {
        // create apenas gera o estado inicial; o primeiro turno ainda não foi salvo.
        const initial = conversationId === undefined ? conversations.create() : undefined;
        const id = conversationId ?? initial!.id;

        // Única fronteira de serialização: adapters não adquirem esta fila.
        return await conversations.runExclusive(id, async () => {
          // Ler dentro da fila para observar correções anteriores já concluídas.
          const conversation = initial ?? conversations.get(id);
          if (!conversation) return { ok: false, code: 'NOT_FOUND' };
          const turn = await runTurn(conversation, message, presentation);
          const staged = turn.actionProposal !== undefined && turn.actionProposal !== null
            ? actions.stage(id, turn.context.revision, turn.actionProposal) : undefined;
          const response = parseResponse({
            conversationId: id,
            reply: turn.reply,
            results: turn.results,
            pendingAction: staged?.preview ?? (turn.actionProposal === null
              ? null : actions.pending(id, turn.context.revision)),
          });

          // Contexto/histórico e lifecycle só mudam após parseResponse.
          // Sem await entre os commits locais.
          conversations.save({ ...conversation, history: turn.history, context: turn.context });
          actions.invalidate(id, turn.context.revision);
          if (turn.actionProposal === null) actions.invalidateCurrent(id);
          staged?.commit();
          return { ok: true, response };
        });
      } catch {
        return { ok: false, code: 'CHAT_ERROR' };
      }
    },

    async confirmAction({ conversationId, actionId }) {
      try {
        return await conversations.runExclusive(conversationId, async () => {
          const conversation = conversations.get(conversationId);
          if (!conversation) return { ok: false, code: 'NOT_FOUND' };
          const outcome = await actions.confirm(conversationId, conversation.context.revision, actionId, executeAction, describeReceipt);
          if (!outcome.ok) return outcome;
          return { ok: true, response: parseResponse({
            conversationId,
            ...outcome.receipt,
            pendingAction: actions.pending(conversationId, conversation.context.revision),
          }) };
        });
      } catch {
        return { ok: false, code: 'CHAT_ERROR' };
      }
    },
  };
}
