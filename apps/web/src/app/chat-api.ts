import { chatConfirmationRequestSchema, chatErrorResponseSchema, chatRequestSchema } from '@supportflow/contracts/chat';
import { languageSchoolChatResponseSchema } from '@supportflow/contracts/language-school';
import type { LanguageSchoolChatResponse } from '@supportflow/contracts/language-school';

type ChatOutcome =
  | { ok: true; response: LanguageSchoolChatResponse }
  | { ok: false; kind: 'retry' | 'missing'; message: string };

export async function sendChatMessage(message: string, conversationId?: string): Promise<ChatOutcome> {
  const request = chatRequestSchema.safeParse({
    message,
    ...(conversationId === undefined ? {} : { conversationId }),
  });
  if (!request.success) {
    return { ok: false, kind: 'retry', message: 'Escreva uma mensagem de até 2.000 caracteres.' };
  }
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.data),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = chatErrorResponseSchema.safeParse(body);
      if (response.status === 404 && error.success && error.data.error.code === 'NOT_FOUND') {
        return {
          ok: false, kind: 'missing',
          message: 'Esta conversa não está mais disponível. Inicie uma nova conversa para continuar.',
        };
      }
      return { ok: false, kind: 'retry', message: 'Não foi possível receber uma resposta. Tente novamente.' };
    }
    const parsed = languageSchoolChatResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, kind: 'retry', message: 'Não foi possível ler a resposta. Tente novamente.' };
    }
    return { ok: true, response: parsed.data };
  } catch {
    return { ok: false, kind: 'retry', message: 'Não foi possível conectar. Verifique sua conexão e tente novamente.' };
  }
}

export async function confirmChatAction(conversationId: string, actionId: string): Promise<
  ChatOutcome | { ok: false; kind: 'stale'; message: string }
> {
  // Construção explícita: a prévia e os argumentos nunca voltam ao servidor.
  const request = chatConfirmationRequestSchema.parse({ conversationId, actionId });
  try {
    const response = await fetch('/api/chat/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = chatErrorResponseSchema.safeParse(body);
      if (error.success && response.status === 409 && error.data.error.code === 'ACTION_STALE') {
        return { ok: false, kind: 'stale', message: 'Os dados foram alterados. Continue a conversa para revisar uma nova prévia.' };
      }
      if (error.success && response.status === 404 && error.data.error.code === 'NOT_FOUND') {
        return { ok: false, kind: 'missing', message: error.data.error.message };
      }
    } else {
      const parsed = languageSchoolChatResponseSchema.safeParse(body);
      if (parsed.success) return { ok: true, response: parsed.data };
    }
  } catch {
    // A escrita pode ter ocorrido. A UI mantém os IDs para recuperar o recibo.
  }
  return { ok: false, kind: 'retry', message: 'Não foi possível receber a confirmação. Tente confirmar novamente para recuperar o resultado da mesma ação.' };
}
