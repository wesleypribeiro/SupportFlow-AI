import { randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';

export type Conversation<Context> = {
  id: string;
  history: BaseMessage[];
  context: Context;
};

export class InMemoryConversations<Context> {
  private readonly conversations = new Map<string, Conversation<Context>>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly createContext: () => Context) {}

  // Mensagens, confirmações e preparação usam a mesma ordem local por conversa.
  async runExclusive<Result>(id: string, operation: () => Result | Promise<Result>): Promise<Result> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const running = previous.then(operation);
    const tail = running.then(() => {}, () => {});
    this.queues.set(id, tail);
    try {
      return await running;
    } finally {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    }
  }

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
