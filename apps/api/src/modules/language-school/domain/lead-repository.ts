import type { CreateLeadInput, Lead } from '@supportflow/contracts/language-school';

// Identidade no escopo da conversa; nenhuma busca/deduplicação global por contato.
export interface LeadRepository {
  findByConversationId(conversationId: string): Promise<Lead | null>;
  // Null indica que a conversa já tem lead. Nunca substitui o registro existente.
  createForConversation(conversationId: string, input: CreateLeadInput): Promise<Lead | null>;
}
