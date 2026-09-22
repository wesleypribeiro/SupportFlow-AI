import { randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';

export type Conversation = {
  id: string;
  history: BaseMessage[];
};

export class InMemoryConversations {
  private readonly conversations = new Map<string, Conversation>();

  create(): Conversation {
    return { id: randomUUID(), history: [] };
  }

  get(id: string): Conversation | undefined {
    const conversation = this.conversations.get(id);
    return conversation && { ...conversation, history: [...conversation.history] };
  }

  // Único ponto de gravação por conversa; um turno incompleto não altera o histórico.
  save(conversation: Conversation): void {
    this.conversations.set(conversation.id, {
      ...conversation,
      history: [...conversation.history],
    });
  }
}
