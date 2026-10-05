import { chatRequestSchema } from '@supportflow/contracts/chat';
import type { InMemoryWhatsAppConversationBindings } from './conversation-bindings.js';
import type { WhatsAppInboundMessage } from './inbox.js';

export type WhatsAppSessionNotice = {
  kind: 'new_session' | 'session_unavailable';
  body: string;
};

type SessionPreparation =
  | { state: 'ready'; notice?: WhatsAppSessionNotice }
  | { state: 'ignored'; code: 'SESSION_UNAVAILABLE' | 'INVALID_INITIAL_TEXT'; notice?: WhatsAppSessionNotice }
  | { state: 'failed'; code: 'CHAT_ERROR' };

// Executada dentro da fila já existente da inbox. Não confirma ações, consulta
// dados comerciais ou adquire o lock do serviço por fora de suas operações.
export class WhatsAppDemoSessionPolicy {
  constructor(private readonly bindings: InMemoryWhatsAppConversationBindings) {}

  async prepare(event: WhatsAppInboundMessage): Promise<SessionPreparation> {
    if (this.bindings.get(event)) return { state: 'ready' };
    if (event.type === 'button_reply') {
      return { state: 'ignored', code: 'SESSION_UNAVAILABLE', notice: {
        kind: 'session_unavailable',
        body: 'Esta confirmação está indisponível. Os registros da sessão anterior não foram recuperados. Envie uma nova mensagem de texto para iniciar uma sessão demonstrativa vazia.',
      } };
    }
    // Apenas texto elegível pode abrir a sessão. O processamento/apresentação
    // completos de texto continuam na composição do processador (task 4.3).
    if (!chatRequestSchema.safeParse({ message: event.text }).success) {
      return { state: 'ignored', code: 'INVALID_INITIAL_TEXT' };
    }
    const opened = await this.bindings.getOrCreate(event);
    if (!opened.ok) return { state: 'failed', code: 'CHAT_ERROR' };
    return { state: 'ready', notice: {
      kind: 'new_session',
      body: 'Esta é uma nova sessão demonstrativa, com dados em memória. Os registros anteriores não foram recuperados.',
    } };
  }
}
