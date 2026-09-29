import { identifierSchema } from '@supportflow/contracts';
import type { ToolFailure, TransferToHumanInput, TransferToHumanResult } from '@supportflow/contracts/language-school';
import type { HandoffRepository } from '../domain/handoff-repository.js';

// Intenção já identificada pelo backend; não integra o schema visível ao modelo.
// A interpretação conversacional desse sinal pertence à integração da task 6.2.
export type HandoffScope = {
  conversationId: string;
  visitorIntent: 'request' | 'accepted_offer' | null;
};

export function handoffFailure(code: 'INVALID_INPUT' | 'OPERATION_FAILED'): ToolFailure {
  return { ok: false, error: { code, message: code === 'INVALID_INPUT'
    ? 'Informe um motivo válido para um pedido do visitante ou uma oferta de atendimento humano aceita.'
    : 'Não foi possível registrar a solicitação de atendimento humano.' } };
}

export async function transferToHuman(
  repository: HandoffRepository, scope: HandoffScope, input: TransferToHumanInput,
): Promise<TransferToHumanResult> {
  if (scope.visitorIntent !== 'request' && scope.visitorIntent !== 'accepted_offer') {
    return handoffFailure('INVALID_INPUT');
  }
  const conversationId = identifierSchema.parse(scope.conversationId);
  // Sem leitura seguida de escrita: o repository decide e registra uma única vez.
  const request = await repository.requestForConversation(conversationId, input);
  return { ok: true, data: { request } };
}
