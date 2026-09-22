import { randomUUID } from 'node:crypto';
import { createLeadInputSchema, leadSchema } from '@supportflow/contracts/language-school';
import type { CreateLeadInput, Lead } from '@supportflow/contracts/language-school';
import type { LeadRepository } from '../domain/lead-repository.js';

export class InMemoryLeadRepository implements LeadRepository {
  private readonly leads = new Map<string, Lead>();

  async findByConversationId(conversationId: string): Promise<Lead | null> {
    const lead = this.leads.get(conversationId);
    return lead ? structuredClone(lead) : null;
  }

  async createForConversation(conversationId: string, input: CreateLeadInput): Promise<Lead | null> {
    const data = createLeadInputSchema.parse(input);
    if (this.leads.has(conversationId)) return null;
    const lead = leadSchema.parse({ ...data, id: randomUUID() });
    // Validação completa antes da escrita; consulta/gravação não intercalam awaits.
    this.leads.set(conversationId, structuredClone(lead));
    return structuredClone(lead);
  }
}
