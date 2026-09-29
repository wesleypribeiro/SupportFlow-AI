import { transferToHumanInputSchema, transferToHumanResultSchema } from '@supportflow/contracts/language-school';
import type { TransferToHumanResult } from '@supportflow/contracts/language-school';
import { handoffFailure, transferToHuman } from '../application/transfer-to-human.js';
import type { HandoffScope } from '../application/transfer-to-human.js';
import type { HandoffRepository } from '../domain/handoff-repository.js';

// Adapter determinístico. Registro no LangChain e apresentação no chat ficam na 6.2.
export function createTransferToHumanTool(repository: HandoffRepository) {
  return async function transfer_to_human(input: unknown, scope: HandoffScope): Promise<TransferToHumanResult> {
    const parsed = transferToHumanInputSchema.safeParse(input);
    if (!parsed.success) return transferToHumanResultSchema.parse(handoffFailure('INVALID_INPUT'));
    try {
      return transferToHumanResultSchema.parse(await transferToHuman(repository, scope, parsed.data));
    } catch {
      return transferToHumanResultSchema.parse(handoffFailure('OPERATION_FAILED'));
    }
  };
}
