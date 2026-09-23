import { scheduleTrialClassInputSchema, scheduleTrialClassResultSchema } from '@supportflow/contracts/language-school';
import type { InMemoryConversations } from '../../../core/conversations.js';
import type { ActionExecutor } from '../../../core/pending-actions.js';
import { confirmTrialClassReservation } from '../application/confirm-trial-class.js';
import { trialClassFailure } from '../application/prepare-trial-class.js';
import type { TrialClassProposalDependencies } from '../application/prepare-trial-class.js';
import type { ConversationContext } from '../domain/conversation-context.js';
import type { LanguageSchoolAction } from './pending-actions.js';

export function createTrialClassConfirmationExecutor(composition: TrialClassProposalDependencies & {
  conversations: InMemoryConversations<ConversationContext>;
}): ActionExecutor<LanguageSchoolAction> {
  return async (action) => {
    if (action.kind !== 'schedule_trial_class') throw new Error('Executor incompatível com a ação.');
    const conversation = composition.conversations.get(action.conversationId);
    if (!conversation) throw new Error('Conversa não encontrada para confirmar aula.');
    const input = scheduleTrialClassInputSchema.safeParse(action.args);
    // Exceções técnicas sobem até a rota: não consumir a ação nem emitir sucesso.
    const result = scheduleTrialClassResultSchema.parse(input.success
      ? await confirmTrialClassReservation(composition, {
        conversationId: conversation.id, context: conversation.context,
      }, input.data)
      : trialClassFailure('INVALID_INPUT'));
    return {
      reply: result.ok ? {
        created: 'Aula experimental confirmada na agenda de demonstração.',
        existing: 'Esta aula experimental já está confirmada na agenda de demonstração.',
      }[result.data.outcome] : result.error.message,
      results: [{ tool: 'schedule_trial_class', result }],
    };
  };
}
