import { randomUUID } from 'node:crypto';
import { identifierSchema } from '@supportflow/contracts';
import { handoffSchema, transferToHumanInputSchema } from '@supportflow/contracts/language-school';
import type { Handoff, TransferToHumanInput } from '@supportflow/contracts/language-school';
import type { HandoffRepository } from '../domain/handoff-repository.js';

export class InMemoryHandoffRepository implements HandoffRepository {
  private readonly requests = new Map<string, Handoff>();

  async findOpenByConversationId(conversationId: string): Promise<Handoff | null> {
    const request = this.requests.get(conversationId);
    return request ? structuredClone(request) : null;
  }

  async requestForConversation(conversationId: string, input: TransferToHumanInput): Promise<Handoff> {
    const id = identifierSchema.parse(conversationId);
    const data = transferToHumanInputSchema.parse(input);
    // Fronteira atômica local: nenhum await/yield entre consulta e inserção.
    const existing = this.requests.get(id);
    if (existing) return structuredClone(existing);
    const request = handoffSchema.parse({ id: randomUUID(), reason: data.reason, status: 'requested' });
    this.requests.set(id, structuredClone(request));
    return structuredClone(request);
  }
}
