import type { ConversationService } from '../../core/conversation-service.js';
import type { InMemoryWhatsAppConfirmationReferences } from './confirmation-references.js';
import type { InMemoryWhatsAppConversationBindings, WhatsAppConversationBinding, WhatsAppConversationIdentity } from './conversation-bindings.js';
import { whatsappIdSchema } from './events.js';
import type { WhatsAppInboundMessage, WhatsAppInboxRecord } from './inbox.js';
import type { WhatsAppMessage, WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from './transport.js';

type ActionIdentity = { actionId: string; kind: string };
export type WhatsAppTextPresentation = {
  messages: Extract<WhatsAppMessage, { type: 'text' }>[];
  confirmation: (ActionIdentity & { body: string; buttonTitle: string }) | null;
};
type Content = Extract<WhatsAppMessage, { type: 'text' }>
  | (NonNullable<WhatsAppTextPresentation['confirmation']> & { type: 'confirmation' });
export type WhatsAppOutboxPart = {
  content: Content;
  state: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown' | 'superseded';
  request?: WhatsAppSendRequest;
  result?: WhatsAppSendResult;
};
export type WhatsAppOutboxRecord<Response> = {
  event: WhatsAppInboundMessage;
  binding?: WhatsAppConversationBinding;
  source?: WhatsAppInboxRecord<Response>;
  parts: WhatsAppOutboxPart[];
};
type MessageIdentity = Pick<WhatsAppInboundMessage, 'provider' | 'phoneNumberId' | 'messageId'>;
type RecordKind = 'response' | 'notice' | 'recovery_notice';

export const reviewCurrentPreview = 'Esta prévia não está mais disponível para confirmação. Envie uma mensagem para revisar a prévia atual.';
const noRecoverableResponse = 'Não há resposta recuperável nesta sessão em memória. Registros perdidos após reinício não podem ser recuperados. Envie uma nova mensagem para continuar.';

function messageKey(event: MessageIdentity, kind: RecordKind): string {
  return JSON.stringify([event.provider, event.phoneNumberId, event.messageId, kind]);
}
function recipientKey(identity: WhatsAppConversationIdentity): string {
  return JSON.stringify([identity.provider, identity.accountId, identity.phoneNumberId, identity.senderId]);
}

// Somente apresentação em RAM. Recibos/autorização continuam no lifecycle.
// Esta fila ordena I/O por destinatário e nunca envolve o lock da conversa.
export class InMemoryWhatsAppOutbox<Response extends { conversationId: string }> {
  private readonly records = new Map<string, WhatsAppOutboxRecord<Response>>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    service: Pick<ConversationService<Response, ActionIdentity | null>, 'getCurrentPendingAction'>;
    bindings: InMemoryWhatsAppConversationBindings;
    references: InMemoryWhatsAppConfirmationReferences;
    transport: WhatsAppTransport;
  }) {}

  get activeQueueCount(): number { return this.queues.size; }

  get(event: MessageIdentity, kind: RecordKind = 'response'): WhatsAppOutboxRecord<Response> | undefined {
    const record = this.records.get(messageKey(event, kind));
    return record && structuredClone(record);
  }

  publish(source: WhatsAppInboxRecord<Response>, presentation: WhatsAppTextPresentation): Promise<void> {
    const contents: Content[] = [...presentation.messages];
    if (presentation.confirmation) contents.push({ type: 'confirmation', ...presentation.confirmation });
    const record = this.save(source.event, 'response', contents, source);
    return record ? this.enqueue(record.event, () => this.attempt(record)) : Promise.resolve();
  }

  sendNotice(event: WhatsAppInboundMessage, body: string): Promise<void> {
    const record = this.save(event, 'notice', [{ type: 'text', body }]);
    return record ? this.enqueue(event, () => this.attempt(record)) : Promise.resolve();
  }

  recover(event: WhatsAppInboundMessage): Promise<void> {
    // Selecionar dentro da fila de saída permite observar a tentativa anterior
    // ainda em curso quando o comando foi admitido, sem bloquear novas decisões.
    return this.enqueue(event, async () => {
      const binding = this.options.bindings.get(event);
      const record = binding && [...this.records.values()].reverse().find((candidate) =>
        candidate.source && candidate.binding?.conversationId === binding.conversationId
        && recipientKey(candidate.event) === recipientKey(event)
        && candidate.parts.some((part) => part.state === 'failed' || part.state === 'unknown'));
      if (!record) {
        const notice = this.save(event, 'recovery_notice', [{ type: 'text', body: noRecoverableResponse }]);
        if (notice) await this.attempt(notice);
        return;
      }
      await this.attempt(record);
    });
  }

  private save(event: WhatsAppInboundMessage, kind: RecordKind, contents: Content[], source?: WhatsAppInboxRecord<Response>) {
    const key = messageKey(event, kind);
    if (this.records.has(key)) return undefined;
    const binding = this.options.bindings.get(event);
    const record: WhatsAppOutboxRecord<Response> = structuredClone({
      event, ...(binding && { binding }), ...(source && { source }),
      parts: contents.map((content) => ({ content, state: 'pending' as const })),
    });
    this.records.set(key, record);
    return record;
  }

  private enqueue(identity: WhatsAppConversationIdentity, work: () => Promise<void>): Promise<void> {
    const key = recipientKey(identity);
    const running = (this.queues.get(key) ?? Promise.resolve()).then(work);
    const cleanup = () => { if (this.queues.get(key) === tail) this.queues.delete(key); };
    // A cauda captura rejeições; o chamador recebe a falha sanitizada para a
    // inbox, sem impedir envios posteriores nem repetir este lote.
    const tail = running.then(cleanup, cleanup);
    this.queues.set(key, tail);
    return running;
  }

  private async attempt(record: WhatsAppOutboxRecord<Response>): Promise<void> {
    for (const part of record.parts) {
      if (part.state === 'accepted' || part.state === 'superseded') continue;
      let request: WhatsAppSendRequest;
      let reference: string | undefined;
      try {
        if (part.content.type === 'confirmation') {
          const binding = this.options.bindings.get(record.event);
          if (!binding || binding.conversationId !== record.binding?.conversationId
            || (record.source?.state === 'processed' && record.source.response.conversationId !== binding.conversationId)) {
            throw new Error('Vínculo indisponível.');
          }
          // Reler imediatamente antes de cada tentativa de botão, inclusive no
          // reenvio. Não revalidar recibos: o envelope histórico fica intacto.
          const current = await this.options.service.getCurrentPendingAction({ conversationId: binding.conversationId });
          if (!current.ok) throw new Error('Prévia indisponível.');
          const action = current.response.pendingAction;
          if (!action || action.actionId !== part.content.actionId || action.kind !== part.content.kind) {
            part.state = 'superseded';
            record.parts.push({ content: { type: 'text', body: reviewCurrentPreview }, state: 'pending' });
            continue;
          }
          reference = this.options.references.getOrCreate(binding, action).reference;
          request = { recipientId: record.event.senderId, message: {
            type: 'reply_buttons', body: part.content.body, buttons: [{ id: reference, title: part.content.buttonTitle }],
          } };
        } else request = { recipientId: record.event.senderId, message: part.content };
      } catch {
        part.state = 'failed';
        throw new Error('Apresentação WhatsApp indisponível.');
      }
      part.request = structuredClone(request);
      part.state = 'sending';
      let result: WhatsAppSendResult;
      try { result = await this.options.transport.send(structuredClone(request)); }
      catch { result = { status: 'unknown', reason: 'network_error' }; }
      if (result.status === 'accepted' && (!whatsappIdSchema.safeParse(result.messageId).success || !result.messageId.trim()
        || (reference && !this.options.references.recordSendResult(reference, request, result)))) {
        result = { status: 'unknown', reason: 'invalid_response' };
      }
      part.result = structuredClone(result);
      part.state = result.status === 'rejected' ? 'failed' : result.status;
      // Uma falha interrompe somente este lote. Sem timers/backoff/retry; as
      // partes restantes ficam pending até um comando explícito de recuperação.
      if (part.state !== 'accepted') throw new Error('Apresentação WhatsApp não aceita.');
    }
  }
}
