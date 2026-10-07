import type { ConversationService } from '../../core/conversation-service.js';
import type { InMemoryWhatsAppConfirmationReferences } from './confirmation-references.js';
import type { InMemoryWhatsAppConversationBindings, WhatsAppConversationBinding, WhatsAppConversationIdentity } from './conversation-bindings.js';
import { whatsappIdSchema } from './events.js';
import type { WhatsAppEvent } from './events.js';
import type { WhatsAppInboundMessage, WhatsAppInboxRecord } from './inbox.js';
import type { InMemoryWhatsAppServiceWindow } from './service-window.js';
import type { WhatsAppMessage, WhatsAppSendRequest, WhatsAppSendResult, WhatsAppTransport } from './transport.js';

type ActionIdentity = { actionId: string; kind: string };
export type WhatsAppTextPresentation = {
  messages: Extract<WhatsAppMessage, { type: 'text' }>[];
  confirmation: (ActionIdentity & { body: string; buttonTitle: string }) | null;
};
type Content = Extract<WhatsAppMessage, { type: 'text' }>
  | (NonNullable<WhatsAppTextPresentation['confirmation']> & { type: 'confirmation' });
type StatusEvent = Extract<WhatsAppEvent, { type: 'status' }>;
type Delivery = { messageId: string; evidence: Partial<Record<StatusEvent['status'], number>> };
export type WhatsAppOutboxPart = {
  content: Content;
  state: 'pending' | 'sending' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown' | 'blocked_window' | 'superseded';
  request?: WhatsAppSendRequest;
  result?: WhatsAppSendResult;
  deliveries?: Delivery[];
};
export type WhatsAppOutboxRecord<Response> = {
  event: WhatsAppInboundMessage;
  binding?: WhatsAppConversationBinding;
  source?: WhatsAppInboxRecord<Response>;
  parts: WhatsAppOutboxPart[];
};
type MessageIdentity = Pick<WhatsAppInboundMessage, 'provider' | 'phoneNumberId' | 'messageId'>;
type RecordKind = 'response' | 'notice' | 'recovery_notice';
// Buffer auxiliar da corrida status/HTTP, não armazenamento de dedupe.
export const WHATSAPP_STATUS_BUFFER_LIMIT = 100;
export const WHATSAPP_STATUS_BUFFER_TTL_MS = 60_000;

export const reviewCurrentPreview = 'Esta prévia não está mais disponível para confirmação. Envie uma mensagem para revisar a prévia atual.';
const noRecoverableResponse = 'Não há resposta recuperável nesta sessão em memória. Registros perdidos após reinício não podem ser recuperados. Envie uma nova mensagem para continuar.';

function messageKey(event: MessageIdentity, kind: RecordKind): string {
  return JSON.stringify([event.provider, event.phoneNumberId, event.messageId, kind]);
}
function recipientKey(identity: WhatsAppConversationIdentity): string {
  return JSON.stringify([identity.provider, identity.accountId, identity.phoneNumberId, identity.senderId]);
}
function deliveryKey(event: Pick<WhatsAppEvent, 'provider' | 'accountId' | 'phoneNumberId'>, messageId: string): string {
  return JSON.stringify([event.provider, event.accountId, event.phoneNumberId, messageId]);
}
function compatibleStatus(event: StatusEvent, identity: WhatsAppConversationIdentity): boolean {
  return event.provider === identity.provider && event.accountId === identity.accountId
    && event.phoneNumberId === identity.phoneNumberId
    && (event.recipientId === undefined || event.recipientId === identity.senderId);
}
function hasAcceptedState(part: WhatsAppOutboxPart): boolean {
  return ['accepted', 'sent', 'delivered', 'read'].includes(part.state);
}

// Somente apresentação em RAM. Recibos/autorização continuam no lifecycle.
// Esta fila ordena I/O por destinatário e nunca envolve o lock da conversa.
export class InMemoryWhatsAppOutbox<Response extends { conversationId: string }> {
  private readonly records = new Map<string, WhatsAppOutboxRecord<Response>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly sends = new Map<string, { record: WhatsAppOutboxRecord<Response>; part: WhatsAppOutboxPart; delivery: Delivery }>();
  private readonly inFlight = new Map<string, WhatsAppConversationIdentity>();
  private readonly statuses = new Map<string, { event: StatusEvent; expiresAt: number }>();
  private readonly presentations = new Map<string, WhatsAppOutboxRecord<Response>>();

  constructor(private readonly options: {
    service: Pick<ConversationService<Response, ActionIdentity | null>, 'getCurrentPendingAction'>;
    bindings: InMemoryWhatsAppConversationBindings;
    references: InMemoryWhatsAppConfirmationReferences;
    transport: WhatsAppTransport;
    serviceWindow: InMemoryWhatsAppServiceWindow;
    now?: () => Date;
  }) {}

  get activeQueueCount(): number { return this.queues.size; }
  get bufferedStatusCount(): number { this.pruneStatuses(); return this.statuses.size; }

  receiveStatus(event: StatusEvent): void {
    this.pruneStatuses();
    const known = this.sends.get(deliveryKey(event, event.messageId));
    if (known) {
      if (compatibleStatus(event, known.record.event)) this.applyStatus(known.part, known.delivery, event);
      return;
    }
    // Sem envio em curso compatível, um ID desconhecido não ganha autoridade.
    if (![...this.inFlight.values()].some((identity) => compatibleStatus(event, identity))) return;
    const key = JSON.stringify([deliveryKey(event, event.messageId), event.recipientId ?? null, event.status]);
    if (this.statuses.has(key) || this.statuses.size >= WHATSAPP_STATUS_BUFFER_LIMIT) return;
    this.statuses.set(key, { event: structuredClone(event), expiresAt: this.now() + WHATSAPP_STATUS_BUFFER_TTL_MS });
  }

  previousPresentation(event: WhatsAppInboundMessage): string | null {
    const record = this.presentations.get(recipientKey(event));
    const binding = this.options.bindings.get(event);
    if (!record?.binding || record.binding.conversationId !== binding?.conversationId || record.parts.length === 0) return null;
    // Só texto realmente publicado. Nunca usar reply original, texto do webhook
    // ou uma oferta mais antiga quando a apresentação mais recente não a contém.
    const evidenced = record.parts.every((part) => part.content.type === 'text' && part.deliveries?.some((delivery) =>
      delivery.evidence.delivered !== undefined || delivery.evidence.read !== undefined
      || delivery.messageId === event.replyToMessageId));
    return evidenced ? record.parts.map((part) => part.content.body).join('\n\n') : null;
  }

  private now(): number { return (this.options.now?.() ?? new Date()).getTime(); }

  private pruneStatuses(): void {
    const now = this.now();
    for (const [key, buffered] of this.statuses) {
      if (buffered.expiresAt <= now || ![...this.inFlight.values()].some((identity) => compatibleStatus(buffered.event, identity))) {
        this.statuses.delete(key);
      }
    }
  }

  private applyStatus(part: WhatsAppOutboxPart, delivery: Delivery, event: StatusEvent): void {
    // Uma evidência por estado é suficiente; duplicatas não reescrevem o snapshot.
    delivery.evidence[event.status] ??= event.occurredAt;
    this.refreshDeliveryState(part);
  }

  private refreshDeliveryState(part: WhatsAppOutboxPart): void {
    if (part.state === 'superseded') return;
    if (part.deliveries?.some((delivery) => delivery.evidence.read !== undefined)) part.state = 'read';
    else if (part.deliveries?.some((delivery) => delivery.evidence.delivered !== undefined)) part.state = 'delivered';
    else if (part.result?.status === 'accepted') {
      const messageId = part.result.messageId;
      const evidence = part.deliveries?.find((delivery) => delivery.messageId === messageId)?.evidence;
      part.state = evidence?.failed !== undefined ? 'failed' : evidence?.sent !== undefined ? 'sent' : 'accepted';
    }
  }

  private recordAccepted(record: WhatsAppOutboxRecord<Response>, part: WhatsAppOutboxPart, messageId: string): void {
    const delivery: Delivery = { messageId, evidence: {} };
    (part.deliveries ??= []).push(delivery);
    const key = deliveryKey(record.event, messageId);
    this.sends.set(key, { record, part, delivery });
    this.pruneStatuses();
    for (const [bufferKey, buffered] of this.statuses) {
      if (deliveryKey(buffered.event, buffered.event.messageId) !== key) continue;
      if (compatibleStatus(buffered.event, record.event)) this.applyStatus(part, delivery, buffered.event);
      this.statuses.delete(bufferKey);
    }
  }

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
        && candidate.parts.some((part) => part.state === 'failed' || part.state === 'unknown' || part.state === 'blocked_window'));
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
      if (hasAcceptedState(part) || part.state === 'superseded') continue;
      if (!this.options.serviceWindow.isOpen(record.event)) {
        part.state = 'blocked_window';
        return;
      }
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
      // A leitura da prévia pode aguardar o serviço. Checar novamente antes do
      // I/O; nunca substituir o evento original pela hora de envio ou de retry.
      if (!this.options.serviceWindow.isOpen(record.event)) {
        part.state = 'blocked_window';
        return;
      }
      part.request = structuredClone(request);
      part.state = 'sending';
      const recipient = recipientKey(record.event);
      this.presentations.set(recipient, record);
      this.inFlight.set(recipient, record.event);
      let result: WhatsAppSendResult;
      try { result = await this.options.transport.send(structuredClone(request)); }
      catch { result = { status: 'unknown', reason: 'network_error' }; }
      if (result.status === 'accepted' && (!whatsappIdSchema.safeParse(result.messageId).success || !result.messageId.trim()
        || this.sends.has(deliveryKey(record.event, result.messageId))
        || (reference && !this.options.references.recordSendResult(reference, request, result)))) {
        result = { status: 'unknown', reason: 'invalid_response' };
      }
      part.result = structuredClone(result);
      part.state = result.status === 'rejected' ? 'failed' : result.status;
      if (result.status === 'accepted') this.recordAccepted(record, part, result.messageId);
      this.refreshDeliveryState(part);
      this.inFlight.delete(recipient);
      this.pruneStatuses();
      // Uma falha interrompe somente este lote. Sem timers/backoff/retry; as
      // partes restantes ficam pending até um comando explícito de recuperação.
      if (!hasAcceptedState(part)) throw new Error('Apresentação WhatsApp não aceita.');
    }
  }
}
