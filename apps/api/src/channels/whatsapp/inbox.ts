import { createHash } from 'node:crypto';
import type { ConversationServiceResult } from '../../core/conversation-service.js';
import type { WhatsAppConversationIdentity } from './conversation-bindings.js';
import type { WhatsAppEvent } from './events.js';

export type WhatsAppInboundMessage = Exclude<WhatsAppEvent, { type: 'status' }>;
type MessageIdentity = Pick<WhatsAppInboundMessage, 'provider' | 'phoneNumberId' | 'messageId'>;
export type WhatsAppInboxProcessor<Response> = (event: WhatsAppInboundMessage) => Promise<ConversationServiceResult<Response>>;
type ProcessingState<Response> =
  | { state: 'received' | 'processing' }
  | { state: 'processed'; response: Response }
  | { state: 'failed'; code: 'NOT_FOUND' | 'ACTION_STALE' | 'CHAT_ERROR' }
  | { state: 'ignored'; code: 'PROCESSOR_UNAVAILABLE' };
export type WhatsAppInboxRecord<Response> = {
  event: WhatsAppInboundMessage;
  fingerprint: string;
} & ProcessingState<Response>;

function messageKey(identity: MessageIdentity): string {
  return JSON.stringify([identity.provider, identity.phoneNumberId, identity.messageId]);
}

function bindingKey(identity: WhatsAppConversationIdentity): string {
  return JSON.stringify([identity.provider, identity.accountId, identity.phoneNumberId, identity.senderId]);
}

function fingerprint(event: WhatsAppInboundMessage): string {
  // Ordem canônica, independente da ordem das propriedades do objeto. Preserva
  // texto/IDs/timestamp originais; metadados descartados na projeção não entram.
  return createHash('sha256').update(JSON.stringify([
    event.provider, event.accountId, event.phoneNumberId, event.messageId,
    event.senderId, event.occurredAt, event.type,
    event.type === 'text' ? event.text : event.reference,
    event.replyToMessageId ?? null,
  ])).digest('hex');
}

// Estado local de uma execução. Não é outbox nem autorização de confirmação.
// O processador chama o serviço diretamente, sem adquirir runExclusive de novo.
export class InMemoryWhatsAppInbox<Response = unknown> {
  private readonly records = new Map<string, WhatsAppInboxRecord<Response>>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly processor?: WhatsAppInboxProcessor<Response>) {}

  get activeQueueCount(): number { return this.queues.size; }

  get(identity: MessageIdentity): WhatsAppInboxRecord<Response> | undefined {
    const record = this.records.get(messageKey(identity));
    return record && structuredClone(record);
  }

  admit(event: WhatsAppInboundMessage): 'accepted' | 'duplicate' | 'collision' {
    const key = messageKey(event);
    const digest = fingerprint(event);
    const existing = this.records.get(key);
    if (existing) return existing.fingerprint === digest ? 'duplicate' : 'collision';

    // Sem await entre lookup, received e reserva da fila: admissão indivisível
    // neste processo. Nenhum modelo, abertura de conversa ou rede neste trecho.
    const snapshot = structuredClone(event);
    const record = { event: snapshot, fingerprint: digest, state: 'received' as const };
    const identity = bindingKey(snapshot);
    const previous = this.queues.get(identity);
    // Ceder ao event loop permite enviar o ACK antes de iniciar o trabalho.
    const ready = previous ?? new Promise<void>((resolve) => { setImmediate(resolve); });
    const running = ready.then(() => this.process(key, record));
    const cleanup = () => {
      if (this.queues.get(identity) === tail) this.queues.delete(identity);
    };
    const tail = running.then(cleanup, () => {
      // Captura também rejeições inesperadas da execução gerenciada, sem guardar
      // exceção, cause, stack, headers, corpo ou texto de erro de terceiros.
      this.records.set(key, { ...record, state: 'failed', code: 'CHAT_ERROR' });
      cleanup();
    });
    this.records.set(key, record);
    this.queues.set(identity, tail);
    return 'accepted';
  }

  // Aguarda inclusive trabalho admitido durante a drenagem. Uma identidade
  // específica pode ser drenada sem aguardar conversas independentes.
  async drain(identity?: WhatsAppConversationIdentity): Promise<void> {
    const key = identity && bindingKey(identity);
    for (;;) {
      const tails = key === undefined ? [...this.queues.values()] : [this.queues.get(key)].filter((tail) => tail !== undefined);
      if (tails.length === 0) return;
      await Promise.all(tails);
    }
  }

  private async process(key: string, record: WhatsAppInboxRecord<Response>): Promise<void> {
    this.records.set(key, { ...record, state: 'processing' });
    if (!this.processor) {
      // Conexão de texto/apresentação e resolução de botão são tasks posteriores.
      this.records.set(key, { ...record, state: 'ignored', code: 'PROCESSOR_UNAVAILABLE' });
      return;
    }
    const result = await this.processor(structuredClone(record.event));
    const outcome: ProcessingState<Response> = result.ok
      ? { state: 'processed', response: structuredClone(result.response) }
      : { state: 'failed', code: result.code };
    this.records.set(key, { ...record, ...outcome });
  }
}
