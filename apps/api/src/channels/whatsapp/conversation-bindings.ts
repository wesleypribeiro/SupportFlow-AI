import type { ConversationService, ConversationServiceResult } from '../../core/conversation-service.js';
import type { WhatsAppEvent } from './events.js';

export type WhatsAppConversationIdentity = Pick<Extract<WhatsAppEvent, { type: 'text' }>,
  'provider' | 'accountId' | 'phoneNumberId' | 'senderId'>;

export type WhatsAppConversationBinding = {
  identity: WhatsAppConversationIdentity;
  conversationId: string;
};

type BindingResult = ConversationServiceResult<WhatsAppConversationBinding>;

function identityKey(identity: WhatsAppConversationIdentity): string {
  // Tupla sem colisões por delimitador; nenhum ID é aparado ou convertido.
  return JSON.stringify([identity.provider, identity.accountId, identity.phoneNumberId, identity.senderId]);
}

// Fronteira interna: recebe somente identidade já autenticada/projetada.
// Elegibilidade do texto e admissão são responsabilidades do chamador do canal.
export class InMemoryWhatsAppConversationBindings {
  private readonly bindings = new Map<string, WhatsAppConversationBinding>();
  private readonly openings = new Map<string, Promise<BindingResult>>();

  constructor(private readonly conversations: Pick<ConversationService<unknown>, 'openConversation'>) {}

  get(identity: WhatsAppConversationIdentity): WhatsAppConversationBinding | undefined {
    const binding = this.bindings.get(identityKey(identity));
    return binding && structuredClone(binding);
  }

  async getOrCreate(identity: WhatsAppConversationIdentity): Promise<BindingResult> {
    // Projeção explícita: não guardar perfil, contato, mensagem ou IDs internos
    // que um objeto mais amplo possa carregar por tipagem estrutural.
    const snapshot = {
      provider: identity.provider,
      accountId: identity.accountId,
      phoneNumberId: identity.phoneNumberId,
      senderId: identity.senderId,
    };
    const key = identityKey(snapshot);
    const existing = this.bindings.get(key);
    if (existing) return { ok: true, response: structuredClone(existing) };

    let opening = this.openings.get(key);
    if (!opening) {
      // Reservar a abertura sincronamente, antes de chamar o serviço assíncrono.
      // Não é fila de turnos: sendMessage/confirmAction usam somente a do core.
      opening = Promise.resolve().then(async (): Promise<BindingResult> => {
        try {
          const result = await this.conversations.openConversation();
          if (!result.ok) return result;
          const binding = { identity: snapshot, conversationId: result.response.conversationId };
          this.bindings.set(key, binding);
          return { ok: true, response: binding };
        } catch {
          return { ok: false, code: 'CHAT_ERROR' };
        } finally {
          this.openings.delete(key);
        }
      });
      this.openings.set(key, opening);
    }
    // Cada chamador recebe uma cópia, inclusive quando compartilha a abertura.
    return structuredClone(await opening);
  }
}
