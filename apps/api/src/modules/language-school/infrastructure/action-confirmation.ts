import type { InMemoryConversations } from '../../../core/conversations.js';
import type { ActionExecutor } from '../../../core/pending-actions.js';
import type { TrialClassProposalDependencies } from '../application/prepare-trial-class.js';
import type { ConversationContext } from '../domain/conversation-context.js';
import { createLeadConfirmationExecutor } from './lead-confirmation.js';
import type { LanguageSchoolAction } from './pending-actions.js';
import { createTrialClassConfirmationExecutor } from './trial-class-confirmation.js';

export function createLanguageSchoolConfirmationExecutor(composition: TrialClassProposalDependencies & {
  conversations: InMemoryConversations<ConversationContext>;
}): ActionExecutor<LanguageSchoolAction> {
  const confirmLead = createLeadConfirmationExecutor(composition);
  const confirmTrialClass = createTrialClassConfirmationExecutor(composition);
  return (action) => {
    switch (action.kind) {
      case 'create_lead': return confirmLead(action);
      case 'schedule_trial_class': return confirmTrialClass(action);
    }
  };
}
