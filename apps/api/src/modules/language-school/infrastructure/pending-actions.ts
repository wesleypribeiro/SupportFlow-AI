import { z } from 'zod';
import {
  languageSchoolChatResponseSchema,
  leadPendingActionSchema,
  trialClassPendingActionSchema,
} from '@supportflow/contracts/language-school';
import { InMemoryPendingActions } from '../../../core/pending-actions.js';

const proposalSchema = z.discriminatedUnion('kind', [
  leadPendingActionSchema.omit({ actionId: true }),
  trialClassPendingActionSchema.omit({ actionId: true }),
]);
const receiptSchema = languageSchoolChatResponseSchema.pick({ reply: true, results: true });

function parseDefinition(input: unknown) {
  const proposal = proposalSchema.parse(input);
  // Argumentos capturados da própria prévia validada, sem payload alternativo.
  if (proposal.kind === 'create_lead') return { ...proposal, args: proposal.preview };
  return {
    ...proposal,
    args: { leadId: proposal.preview.lead.id, slotId: proposal.preview.slot.slotId },
  };
}

export type LanguageSchoolAction = ReturnType<typeof parseDefinition>;

// Contratos e composição do lifecycle; execução de negócio é injetada separadamente.
export function createLanguageSchoolPendingActions() {
  return new InMemoryPendingActions(parseDefinition, (receipt) => receiptSchema.parse(receipt));
}
