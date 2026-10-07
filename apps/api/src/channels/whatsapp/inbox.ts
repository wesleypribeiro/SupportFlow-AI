import { createHash } from 'node:crypto';
import type { ConversationServiceResult } from '../../core/conversation-service.js';
import type { WhatsAppConversationIdentity } from './conversation-bindings.js';
import type { WhatsAppEvent } from './events.js';
import type { WhatsAppDemoSessionPolicy, WhatsAppSessionNotice } from './demo-session.js';
import { InMemoryWhatsAppServiceWindow } from './service-window.js';

export type WhatsAppInboundMessage = Exclude<WhatsAppEvent, { type: 'status' }>;
type MessageIdentity = Pick<WhatsAppInboundMessage, 'provider' | 'phoneNumberId' | 'messageId'>;
export type WhatsAppInboxProcessor<Response> = (event: WhatsAppInboundMessage) => Promise<
  ConversationServiceResult<Response> | { ok: false; code: 'INVALID_TEXT' | 'UNSUPPORTED_MESSAGE' | 'RESEND_REQUESTED' }
>;
type ProcessingState<Response> =
  | { state: 'received' | 'processing' }
  | { state: 'processed'; response: Response }
  | { state: 'failed'; code: 'NOT_FOUND' | 'ACTION_STALE' | 'CHAT_ERROR' }
  | { state: 'ignored'; code: 'PROCESSOR_UNAVAILABLE' | 'SESSION_UNAVAILABLE' | 'INVALID_INITIAL_TEXT' | 'INVALID_TEXT' | 'UNSUPPORTED_MESSAGE' | 'RESEND_REQUESTED' };
export type WhatsAppInboxRecord<Response> = {
  event: WhatsAppInboundMessage;
  fingerprint: string;
  notice?: WhatsAppSessionNotice;
  noticeError?: 'NOTICE_ERROR';
  presentationError?: 'PRESENTATION_ERROR';
} & ProcessingState<Response>;

// Escolhas locais da demonstração, não limites do provedor. A execução mantém
// todos os IDs admitidos, inclusive os que falharam ou foram ignorados.
const DEFAULT_LIMITS = { maxMessages: 10_000, maxWaitingPerSender: 100 };
export type WhatsAppInboxOptions<Response = unknown> = {
  now?: () => Date;
  serviceWindow?: InMemoryWhatsAppServiceWindow;
  limits?: Partial<typeof DEFAULT_LIMITS>;
  sessions?: WhatsAppDemoSessionPolicy;
  onNotice?: (event: WhatsAppInboundMessage, notice: WhatsAppSessionNotice) => Promise<void>;
  onProcessed?: (record: WhatsAppInboxRecord<Response>) => Promise<void>;
};

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
  private readonly presentations = new Map<string, Set<Promise<void>>>();
  private readonly waiting = new Map<string, number>();
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly serviceWindow: InMemoryWhatsAppServiceWindow;
  readonly startedAt: number;

  constructor(private readonly processor?: WhatsAppInboxProcessor<Response>, private readonly options: WhatsAppInboxOptions<Response> = {}) {
    const now = options.now ?? (() => new Date());
    this.serviceWindow = options.serviceWindow ?? new InMemoryWhatsAppServiceWindow(now);
    this.startedAt = Math.ceil(now().getTime() / 1_000) * 1_000;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (!Number.isFinite(this.startedAt) || Object.values(this.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('Configuração inválida da inbox WhatsApp.');
    }
  }

  get activeQueueCount(): number { return this.queues.size; }

  get(identity: MessageIdentity): WhatsAppInboxRecord<Response> | undefined {
    const record = this.records.get(messageKey(identity));
    return record && structuredClone(record);
  }

  admit(event: WhatsAppInboundMessage): 'accepted' | 'duplicate' | 'collision' | 'capacity' | 'before_start' | 'future_timestamp' {
    const key = messageKey(event);
    const digest = fingerprint(event);
    const existing = this.records.get(key);
    if (existing) return existing.fingerprint === digest ? 'duplicate' : 'collision';
    // Não guardar eventos da sessão perdida: o marco imutável permite sempre
    // reconhecê-los, sem consumir dedupe/fila ou reconstruir autoridade antiga.
    if (event.occurredAt < this.startedAt) return 'before_start';
    const identity = bindingKey(event);
    const waiting = this.waiting.get(identity) ?? 0;
    if (this.records.size >= this.limits.maxMessages || waiting >= this.limits.maxWaitingPerSender) return 'capacity';
    if (!this.serviceWindow.admit(event)) return 'future_timestamp';

    // Sem await entre lookup, received e reserva da fila: admissão indivisível
    // neste processo. Nenhum modelo, abertura de conversa ou rede neste trecho.
    const snapshot = structuredClone(event);
    const record = { event: snapshot, fingerprint: digest, state: 'received' as const };
    const previous = this.queues.get(identity);
    // Ceder ao event loop permite enviar o ACK antes de iniciar o trabalho.
    const ready = previous ?? new Promise<void>((resolve) => { setImmediate(resolve); });
    const running = ready.then(() => {
      const remaining = this.waiting.get(identity)! - 1;
      if (remaining === 0) this.waiting.delete(identity);
      else this.waiting.set(identity, remaining);
      return this.process(key, record);
    });
    const cleanup = () => {
      if (this.queues.get(identity) === tail) this.queues.delete(identity);
    };
    const tail = running.then(cleanup, () => {
      // Captura também rejeições inesperadas da execução gerenciada, sem guardar
      // exceção, cause, stack, headers, corpo ou texto de erro de terceiros.
      this.records.set(key, { ...(this.records.get(key) ?? record), state: 'failed', code: 'CHAT_ERROR' });
      cleanup();
    });
    this.records.set(key, record);
    this.waiting.set(identity, waiting + 1);
    this.queues.set(identity, tail);
    return 'accepted';
  }

  // Aguarda inclusive trabalho admitido durante a drenagem. Uma identidade
  // específica pode ser drenada sem aguardar conversas independentes.
  async drain(identity?: WhatsAppConversationIdentity): Promise<void> {
    const key = identity && bindingKey(identity);
    for (;;) {
      const tails = key === undefined
        ? [...this.queues.values(), ...[...this.presentations.values()].flatMap((tasks) => [...tasks])]
        : [this.queues.get(key), ...this.presentations.get(key) ?? []].filter((tail) => tail !== undefined);
      if (tails.length === 0) return;
      await Promise.all(tails);
    }
  }

  private async process(key: string, record: WhatsAppInboxRecord<Response>): Promise<void> {
    this.records.set(key, { ...record, state: 'processing' });
    const session = await this.options.sessions?.prepare(structuredClone(record.event));
    const notice = session && 'notice' in session ? session.notice : undefined;
    const snapshot = notice ? { ...record, notice } : record;
    if (session && session.state !== 'ready') {
      this.records.set(key, { ...snapshot, ...session });
    } else if (!this.processor) {
      // Composição de recepção isolada, sem processador de decisões.
      this.records.set(key, { ...snapshot, state: 'ignored', code: 'PROCESSOR_UNAVAILABLE' });
    } else {
      try {
        const result = await this.processor(structuredClone(record.event));
        const outcome: ProcessingState<Response> = result.ok
          ? { state: 'processed', response: structuredClone(result.response) }
          : result.code === 'INVALID_TEXT' || result.code === 'UNSUPPORTED_MESSAGE' || result.code === 'RESEND_REQUESTED'
            ? { state: 'ignored', code: result.code }
            : { state: 'failed', code: result.code };
        this.records.set(key, { ...snapshot, ...outcome });
      } catch {
        this.records.set(key, { ...snapshot, state: 'failed', code: 'CHAT_ERROR' });
      }
    }
    // Aviso de sessão separado do envelope comercial, salvo antes de publicar.
    // O callback interno permitirá compor o transporte; não há cliente Meta ou
    // retry aqui. Sua falha nunca apaga a resposta nem repete decisões do motor.
    if (notice && this.options.onNotice) {
      if (this.serviceWindow.isOpen(record.event)) {
        this.trackPresentation(key, record.event, 'noticeError', async () => {
          await this.options.onNotice!(structuredClone(record.event), structuredClone(notice));
        });
      }
    }
    // O envelope/erro já está salvo antes de qualquer formatação/envio. Uma
    // falha nesta etapa não transforma processamento concluído em CHAT_ERROR.
    if (this.options.onProcessed) {
      this.trackPresentation(key, record.event, 'presentationError', async () => {
        await this.options.onProcessed!(structuredClone(this.records.get(key)!));
      });
    }
  }

  private trackPresentation(key: string, event: WhatsAppInboundMessage,
    field: 'noticeError' | 'presentationError', work: () => Promise<void>): void {
    const identity = bindingKey(event);
    const tasks = this.presentations.get(identity) ?? new Set<Promise<void>>();
    this.presentations.set(identity, tasks);
    // Iniciar callbacks na ordem de processamento, mas aguardar rede somente
    // em drain. A outbox serializa envios; correções/cliques liberam esta fila.
    const pending = work().catch(() => {
      this.records.set(key, { ...this.records.get(key)!,
        [field]: field === 'noticeError' ? 'NOTICE_ERROR' : 'PRESENTATION_ERROR' });
    }).finally(() => {
      tasks.delete(pending);
      if (tasks.size === 0) this.presentations.delete(identity);
    });
    tasks.add(pending);
  }
}
