import type { WhatsAppConversationIdentity } from './conversation-bindings.js';
import type { WhatsAppInboundMessage } from './inbox.js';

const WINDOW_MS = 24 * 60 * 60 * 1_000;

function identityKey(identity: WhatsAppConversationIdentity): string {
  return JSON.stringify([identity.provider, identity.accountId, identity.phoneNumberId, identity.senderId]);
}

// Compartilhada por inbox/outbox, sem estado comercial ou fila adicional.
export class InMemoryWhatsAppServiceWindow {
  private readonly latest = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  // Somente a primeira admissão de texto/botão autenticado pode atualizar a
  // janela. Reentregas, colisões, status e saídas não passam por este método.
  admit(event: WhatsAppInboundMessage): boolean {
    const now = this.now().getTime();
    if (!Number.isFinite(now) || event.occurredAt > now) return false;
    const key = identityKey(event);
    this.latest.set(key, Math.max(this.latest.get(key) ?? event.occurredAt, event.occurredAt));
    return true;
  }

  isOpen(identity: WhatsAppConversationIdentity): boolean {
    const timestamp = this.latest.get(identityKey(identity));
    if (timestamp === undefined) return false;
    const age = this.now().getTime() - timestamp;
    return age >= 0 && age < WINDOW_MS;
  }
}
