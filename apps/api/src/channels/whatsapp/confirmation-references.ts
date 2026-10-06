import { randomBytes } from 'node:crypto';
import type { InMemoryWhatsAppConversationBindings, WhatsAppConversationBinding } from './conversation-bindings.js';
import { whatsappEventSchema, whatsappIdSchema } from './events.js';
import type { WhatsAppSendRequest, WhatsAppSendResult } from './transport.js';

type ActionIdentity = { actionId: string; kind: string };
export type WhatsAppConfirmationReference = ActionIdentity & {
  reference: string;
  binding: WhatsAppConversationBinding;
  messageIds: string[];
};
type Resolution =
  | { ok: true; target: ActionIdentity & { conversationId: string } }
  | { ok: false; code: 'INVALID_CONFIRMATION' };

function bindingKey(binding: WhatsAppConversationBinding): string {
  const { identity, conversationId } = binding;
  return JSON.stringify([identity.provider, identity.accountId, identity.phoneNumberId, identity.senderId, conversationId]);
}

// Índice privado do canal, sem args, revisão, recibos ou lifecycle paralelo.
// O chamador registra uma ação oficial já commitada antes de enviar a prévia.
export class InMemoryWhatsAppConfirmationReferences {
  private readonly references = new Map<string, WhatsAppConfirmationReference>();
  private readonly actions = new Map<string, string>();

  constructor(private readonly bindings: Pick<InMemoryWhatsAppConversationBindings, 'get'>) {}

  get(reference: string): WhatsAppConfirmationReference | undefined {
    const record = this.references.get(reference);
    return record && structuredClone(record);
  }

  getOrCreate(binding: WhatsAppConversationBinding, action: ActionIdentity): WhatsAppConfirmationReference {
    const current = this.bindings.get(binding.identity);
    if (!current || bindingKey(current) !== bindingKey(binding) || !action.actionId || !action.kind) {
      throw new Error('Vínculo de confirmação indisponível.');
    }
    const key = JSON.stringify([bindingKey(current), action.actionId]);
    const existing = this.actions.get(key);
    if (existing) {
      const record = this.references.get(existing)!;
      // O mesmo actionId não pode ser reaproveitado para outro tipo de operação.
      if (record.kind !== action.kind) throw new Error('Vínculo de confirmação indisponível.');
      return structuredClone(record);
    }

    let reference: string;
    do { reference = randomBytes(32).toString('base64url'); } while (this.references.has(reference));
    const record: WhatsAppConfirmationReference = {
      reference,
      binding: {
        identity: {
          provider: current.identity.provider, accountId: current.identity.accountId,
          phoneNumberId: current.identity.phoneNumberId, senderId: current.identity.senderId,
        },
        conversationId: current.conversationId,
      },
      actionId: action.actionId, kind: action.kind, messageIds: [],
    };
    this.references.set(reference, record);
    this.actions.set(key, reference);
    return structuredClone(record);
  }

  // Somente o retorno do transporte backend pode estabelecer esta correlação.
  // context.id recebido, status e aceite indeterminado nunca cadastram messageIds.
  recordSendResult(reference: string, request: WhatsAppSendRequest, result: WhatsAppSendResult): boolean {
    const record = this.references.get(reference);
    if (!record || result.status !== 'accepted' || !whatsappIdSchema.safeParse(result.messageId).success
      || !result.messageId.trim() || request.recipientId !== record.binding.identity.senderId
      || request.message.type !== 'reply_buttons' || !request.message.buttons.some((button) => button.id === reference)) {
      return false;
    }
    if (!record.messageIds.includes(result.messageId)) record.messageIds.push(result.messageId);
    return true;
  }

  // Recebe somente evento autenticado pelo transporte. A validação estrita também
  // impede que texto/IDs digitados ou uma resposta incompleta sejam resolvidos.
  resolve(input: unknown): Resolution {
    const parsed = whatsappEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.type !== 'button_reply') return { ok: false, code: 'INVALID_CONFIRMATION' };
    const event = parsed.data;
    const record = this.references.get(event.reference);
    const binding = this.bindings.get(event);
    if (!record || !binding || bindingKey(record.binding) !== bindingKey(binding)
      || !record.messageIds.includes(event.replyToMessageId)) {
      return { ok: false, code: 'INVALID_CONFIRMATION' };
    }
    // Apenas localiza o alvo original. A confirmação compartilhada decidirá
    // completed/stale/revision; não exigir pendingAction atual aqui.
    return { ok: true, target: {
      conversationId: record.binding.conversationId, actionId: record.actionId, kind: record.kind,
    } };
  }
}
