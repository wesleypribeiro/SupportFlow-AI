import { randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';

export type Conversation<Context> = {
  id: string;
  history: BaseMessage[];
  context: Context;
};

export class InMemoryConversations<Context> {
  private readonly conversations = new Map<string, Conversation<Context>>();

  constructor(private readonly createContext: () => Context) {}

  create(): Conversation<Context> {
    return { id: randomUUID(), history: [], context: this.createContext() };
  }

  get(id: string): Conversation<Context> | undefined {
    const conversation = this.conversations.get(id);
    return conversation && {
      ...conversation,
      history: [...conversation.history],
      context: structuredClone(conversation.context),
    };
  }

  // Histórico e contexto são gravados juntos, somente após um turno completo.
  save(conversation: Conversation<Context>): void {
    this.conversations.set(conversation.id, {
      ...conversation,
      history: [...conversation.history],
      context: structuredClone(conversation.context),
    });
  }
}
