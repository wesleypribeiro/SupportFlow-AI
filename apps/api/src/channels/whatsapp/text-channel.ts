import { chatConfirmationRequestSchema, chatRequestSchema } from '@supportflow/contracts/chat';
import type { ConversationService } from '../../core/conversation-service.js';
import type { InMemoryWhatsAppConfirmationReferences } from './confirmation-references.js';
import type { InMemoryWhatsAppConversationBindings } from './conversation-bindings.js';
import type { WhatsAppInboxProcessor, WhatsAppInboxRecord } from './inbox.js';
import { InMemoryWhatsAppOutbox, reviewCurrentPreview } from './outbox.js';
import type { WhatsAppTextPresentation } from './outbox.js';
import type { WhatsAppMessage, WhatsAppTransport } from './transport.js';

type TextMessage = Extract<WhatsAppMessage, { type: 'text' }>;
type ActionIdentity = { actionId: string; kind: string };

export function createWhatsAppTextChannel<Response extends { conversationId: string }>(options: {
  service: Pick<ConversationService<Response, ActionIdentity | null>, 'sendMessage' | 'confirmAction' | 'getCurrentPendingAction'>;
  bindings: InMemoryWhatsAppConversationBindings;
  references: InMemoryWhatsAppConfirmationReferences;
  present: (response: Response) => WhatsAppTextPresentation;
  transport: WhatsAppTransport;
}) {
  const outbox = new InMemoryWhatsAppOutbox<Response>(options);
  const process: WhatsAppInboxProcessor<Response> = async (event) => {
    if (event.type === 'text' && event.text === '/reenviar') return { ok: false, code: 'RESEND_REQUESTED' };
    if (event.type === 'button_reply') {
      const resolved = options.references.resolve(event);
      if (!resolved.ok) return { ok: false, code: 'NOT_FOUND' };
      const request = chatConfirmationRequestSchema.parse({
        conversationId: resolved.target.conversationId,
        actionId: resolved.target.actionId,
      });
      // O lifecycle recupera completed antes de avaliar a revisão. A pending
      // atual governa somente publicação, nunca a recuperação deste recibo.
      return options.service.confirmAction(request);
    }
    const binding = options.bindings.get(event);
    const parsed = chatRequestSchema.safeParse({ message: event.text, conversationId: binding?.conversationId });
    if (!parsed.success) return { ok: false, code: 'INVALID_TEXT' };
    if (!binding) return { ok: false, code: 'NOT_FOUND' };
    // Até a correlação de apresentação da task 6.2, nenhum aceite/status solto
    // comprova oferta anterior. Pedido explícito continua sendo válido.
    return options.service.sendMessage(parsed.data, { previousPresentation: null });
  };

  async function present(record: WhatsAppInboxRecord<Response>) {
    if (record.state === 'ignored' && record.code === 'RESEND_REQUESTED') return outbox.recover(record.event);
    let messages: TextMessage[] = [];
    let confirmation: WhatsAppTextPresentation['confirmation'] = null;
    if (record.state === 'processed') {
      const presentation = options.present(record.response);
      messages = [...presentation.messages];
      confirmation = presentation.confirmation;
    } else if (record.state === 'ignored' && (record.code === 'INVALID_TEXT' || record.code === 'INVALID_INITIAL_TEXT')) {
      messages = [{ type: 'text', body: 'Envie uma mensagem de texto com 1 a 2.000 caracteres após remover os espaços das bordas. O texto recebido não foi processado nem truncado.' }];
    } else if (record.state === 'failed') {
      messages = [{ type: 'text', body: record.code === 'ACTION_STALE'
        || (record.code === 'NOT_FOUND' && record.event.type === 'button_reply') ? reviewCurrentPreview
        : 'Não foi possível concluir esta mensagem. Envie uma nova mensagem para continuar.' }];
    }
    return outbox.publish(record, { messages, confirmation });
  }

  return { process, present, outbox };
}
