import { createLeadInputSchema, createLeadResultSchema } from '@supportflow/contracts/language-school';
import type { InMemoryConversations } from '../../../core/conversations.js';
import type { ActionExecutor } from '../../../core/pending-actions.js';
import { confirmLeadRegistration, leadFailure } from '../application/create-lead.js';
import type { ConversationContext } from '../domain/conversation-context.js';
import type { LeadRepository } from '../domain/lead-repository.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import type { LanguageSchoolAction } from './pending-actions.js';

export function createLeadConfirmationExecutor(composition: {
  schoolRepository: SchoolRepository;
  leadRepository: LeadRepository;
  conversations: InMemoryConversations<ConversationContext>;
}): ActionExecutor<LanguageSchoolAction> {
  // Chamado dentro da fila e após autorização/revisão pelo core da task 4.1.
  return async (action) => {
    if (action.kind !== 'create_lead') throw new Error('Executor indisponível para esta ação.');
    const conversation = composition.conversations.get(action.conversationId);
    if (!conversation) throw new Error('Conversa não encontrada para confirmar cadastro.');
    const input = createLeadInputSchema.safeParse(action.args);
    // Falhas técnicas anteriores à escrita seguem o CHAT_ERROR da rota, sem
    // consumir a ação como concluída. A tool de preparação usa OPERATION_FAILED.
    const result = input.success
      ? createLeadResultSchema.parse(await confirmLeadRegistration(composition, {
        conversationId: conversation.id, context: conversation.context,
      }, input.data))
      : leadFailure('INVALID_INPUT');
    if (result.ok && result.data.outcome === 'created') {
      composition.conversations.save({
        ...conversation, context: { ...conversation.context, leadId: result.data.lead.id },
      });
    }
    return {
      reply: result.ok ? {
        created: 'Cadastro realizado.',
        existing: 'Seus dados já estão cadastrados.',
        updated: 'Cadastro atualizado.',
      }[result.data.outcome] : result.error.message,
      results: [{ tool: 'create_lead', result: createLeadResultSchema.parse(result) }],
    };
  };
}
