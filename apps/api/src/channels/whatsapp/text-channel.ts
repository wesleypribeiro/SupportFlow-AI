import { chatRequestSchema } from '@supportflow/contracts/chat';
import type { ConversationService } from '../../core/conversation-service.js';
import type { InMemoryWhatsAppConversationBindings } from './conversation-bindings.js';
import type { WhatsAppInboxProcessor, WhatsAppInboxRecord } from './inbox.js';
import { splitWhatsAppText } from './presentation.js';
import type { WhatsAppMessage, WhatsAppTransport } from './transport.js';

type TextMessage = Extract<WhatsAppMessage, { type: 'text' }>;
type TextPresentation = { messages: TextMessage[]; confirmation: { body: string } | null };

export function createWhatsAppTextChannel<Response>(options: {
  service: Pick<ConversationService<Response>, 'sendMessage'>;
  bindings: InMemoryWhatsAppConversationBindings;
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
    if (record.state === 'processed') {
      const presentation = options.present(record.response);
      messages = [...presentation.messages];
      // Nesta task, a prévia é somente texto. Publicar/resolver botões exige a
      // referência privada e a correlação das tasks 5.x.
      if (presentation.confirmation) {
        messages.push(...splitWhatsAppText(presentation.confirmation.body).map((body): TextMessage => ({ type: 'text', body })));
      }
    } else if (record.state === 'ignored' && (record.code === 'INVALID_TEXT' || record.code === 'INVALID_INITIAL_TEXT')) {
      messages = [{ type: 'text', body: 'Envie uma mensagem de texto com 1 a 2.000 caracteres após remover os espaços das bordas. O texto recebido não foi processado nem truncado.' }];
    } else if (record.state === 'failed') {
      messages = [{ type: 'text', body: 'Não foi possível concluir esta mensagem. Envie uma nova mensagem para continuar.' }];
    }
    // Uma tentativa por parte; falha interrompe o lote, sem repetir o motor.
    for (const message of messages) await sendText(record.event.senderId, message.body);
  }

  return { process, present, sendText };
}
