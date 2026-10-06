import { chatRequestSchema } from '@supportflow/contracts/chat';
import type { ConversationService } from '../../core/conversation-service.js';
import type { InMemoryWhatsAppConfirmationReferences } from './confirmation-references.js';
import type { InMemoryWhatsAppConversationBindings } from './conversation-bindings.js';
import type { WhatsAppInboxProcessor, WhatsAppInboxRecord } from './inbox.js';
import type { WhatsAppMessage, WhatsAppSendRequest, WhatsAppTransport } from './transport.js';

type TextMessage = Extract<WhatsAppMessage, { type: 'text' }>;
type ActionIdentity = { actionId: string; kind: string };
type TextPresentation = {
  messages: TextMessage[];
  confirmation: (ActionIdentity & { body: string; buttonTitle: string }) | null;
};
const reviewCurrentPreview = 'Esta prévia não está mais disponível para confirmação. Envie uma mensagem para revisar a prévia atual.';

export function createWhatsAppTextChannel<Response extends { conversationId: string }>(options: {
  service: Pick<ConversationService<Response, ActionIdentity | null>, 'sendMessage' | 'getCurrentPendingAction'>;
  bindings: InMemoryWhatsAppConversationBindings;
  references: InMemoryWhatsAppConfirmationReferences;
  present: (response: Response) => TextPresentation;
  transport: WhatsAppTransport;
}) {
  const process: WhatsAppInboxProcessor<Response> = async (event) => {
    if (event.type !== 'text') return { ok: false, code: 'UNSUPPORTED_MESSAGE' };
    const binding = options.bindings.get(event);
    const parsed = chatRequestSchema.safeParse({ message: event.text, conversationId: binding?.conversationId });
    if (!parsed.success) return { ok: false, code: 'INVALID_TEXT' };
    if (!binding) return { ok: false, code: 'NOT_FOUND' };
    // Até a correlação de apresentação da task 6.2, nenhum aceite/status solto
    // comprova oferta anterior. Pedido explícito continua sendo válido.
    return options.service.sendMessage(parsed.data, { previousPresentation: null });
  };

  async function sendText(recipientId: string, body: string) {
    const result = await options.transport.send({ recipientId, message: { type: 'text', body } });
    if (result.status !== 'accepted') throw new Error('Apresentação WhatsApp não aceita.');
  }

  async function present(record: WhatsAppInboxRecord<Response>) {
    let messages: TextMessage[] = [];
    let confirmation: TextPresentation['confirmation'] = null;
    if (record.state === 'processed') {
      const presentation = options.present(record.response);
      messages = [...presentation.messages];
      confirmation = presentation.confirmation;
    } else if (record.state === 'ignored' && (record.code === 'INVALID_TEXT' || record.code === 'INVALID_INITIAL_TEXT')) {
      messages = [{ type: 'text', body: 'Envie uma mensagem de texto com 1 a 2.000 caracteres após remover os espaços das bordas. O texto recebido não foi processado nem truncado.' }];
    } else if (record.state === 'failed') {
      messages = [{ type: 'text', body: record.code === 'ACTION_STALE' ? reviewCurrentPreview
        : 'Não foi possível concluir esta mensagem. Envie uma nova mensagem para continuar.' }];
    }
    // Uma tentativa por parte; falha interrompe o lote, sem repetir o motor.
    for (const message of messages) await sendText(record.event.senderId, message.body);
    if (record.state !== 'processed' || !confirmation) return;

    const binding = options.bindings.get(record.event);
    if (!binding || binding.conversationId !== record.response.conversationId) {
      throw new Error('Vínculo de confirmação indisponível.');
    }
    // A inbox já salvou o envelope após commit. Reler na fila do serviço, depois
    // das partes textuais, evita publicar uma prévia substituída durante o envio.
    // Esta verificação só governa publicação; o lifecycle decide cliques/recibos.
    const current = await options.service.getCurrentPendingAction({ conversationId: binding.conversationId });
    if (!current.ok) throw new Error('Prévia de confirmação indisponível.');
    const action = current.response.pendingAction;
    if (!action || action.actionId !== confirmation.actionId || action.kind !== confirmation.kind) {
      await sendText(record.event.senderId, reviewCurrentPreview);
      return;
    }
    const { reference } = options.references.getOrCreate(binding, action);
    const request: WhatsAppSendRequest = { recipientId: binding.identity.senderId, message: {
      type: 'reply_buttons', body: confirmation.body, buttons: [{ id: reference, title: confirmation.buttonTitle }],
    } };
    const result = await options.transport.send(request);
    if (!options.references.recordSendResult(reference, request, result)) {
      throw new Error('Apresentação WhatsApp não aceita.');
    }
  }

  return { process, present, sendText };
}
