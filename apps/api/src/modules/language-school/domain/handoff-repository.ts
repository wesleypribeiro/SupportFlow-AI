import type { Handoff, TransferToHumanInput } from '@supportflow/contracts/language-school';

// Uma solicitação aberta por conversa, sem busca global ou ciclo de encerramento.
export interface HandoffRepository {
  findOpenByConversationId(conversationId: string): Promise<Handoff | null>;
  // Consultar/criar atomicamente. Repetições preservam o ID e o motivo originais.
  requestForConversation(conversationId: string, input: TransferToHumanInput): Promise<Handoff>;
}
