import { z } from 'zod';
import type { WhatsAppConfig } from '../config.js';
import { WHATSAPP_INTERACTIVE_BODY_LIMIT, WHATSAPP_TEXT_LIMIT } from '../presentation.js';
import type { WhatsAppSendResult, WhatsAppTransport } from '../transport.js';

type MetaSendConfig = Pick<Extract<WhatsAppConfig, { enabled: true }>,
  'accessToken' | 'phoneNumberId' | 'graphApiVersion'>;

const nonblank = (value: string) => value.trim().length > 0;
// Contagem conservadora em UTF-16, igual à apresentação; .max() do Zod
// instalado conta pontos de código, que podem ocupar duas unidades.
const boundedText = (maximum: number) => z.string().min(1).refine(nonblank)
  .refine((value) => value.length <= maximum);
const opaqueIdSchema = boundedText(1_024);
const configSchema = z.object({
  accessToken: z.string().min(1).refine((value) => !/[^\x21-\x7e]/.test(value)),
  phoneNumberId: opaqueIdSchema.refine((value) => value !== '.' && value !== '..' && !/[\uD800-\uDFFF]/u.test(value)),
  graphApiVersion: z.literal('v26.0'),
});
const timeoutSchema = z.number().int().min(1).max(2_147_483_647);
const buttonSchema = z.strictObject({
  id: boundedText(256),
  title: boundedText(20),
});
const requestSchema = z.strictObject({
  recipientId: opaqueIdSchema,
  message: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('text'),
      body: boundedText(WHATSAPP_TEXT_LIMIT),
    }),
    z.strictObject({
      type: z.literal('reply_buttons'),
      body: boundedText(WHATSAPP_INTERACTIVE_BODY_LIMIT),
      buttons: z.array(buttonSchema).min(1).max(3)
        .refine((buttons) => new Set(buttons.map(({ id }) => id)).size === buttons.length)
        .refine((buttons) => new Set(buttons.map(({ title }) => title)).size === buttons.length),
    }),
  ]),
});

// Consumir somente evidência de aceite/rejeição; extensões externas não viram
// estado de entrega, credenciais, destinatário ou mensagens de erro públicas.
const acceptedSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  messages: z.array(z.object({ id: opaqueIdSchema })).length(1),
  error: z.never().optional(),
});
const rejectedSchema = z.object({
  error: z.object({ code: z.number().int().nonnegative(), type: z.string().min(1), message: z.string().min(1) }),
  messages: z.never().optional(),
});

async function readResult(response: Response): Promise<WhatsAppSendResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'unknown', reason: 'invalid_response' };
  }
  if (response.ok) {
    const accepted = acceptedSchema.safeParse(body);
    const messageId = accepted.success ? accepted.data.messages[0]?.id : undefined;
    return messageId
      ? { status: 'accepted', messageId }
      : { status: 'unknown', reason: 'invalid_response' };
  }
  // HTTP isolado (por exemplo, HTML de um proxy) não comprova rejeição Meta.
  if (response.status >= 400 && response.status <= 599 && rejectedSchema.safeParse(body).success) {
    const reason = response.status === 401 || response.status === 403 ? 'unauthorized'
      : response.status === 429 ? 'rate_limited' : 'provider_rejection';
    return { status: 'rejected', reason };
  }
  return { status: 'unknown', reason: 'invalid_response' };
}

// Uma tentativa por chamada, sem I/O no construtor. A composição backend fornece
// config e fetch; não há leitura de env, SDK, descoberta de versão ou retry.
export function createMetaCloudApiClient(
  config: MetaSendConfig,
  { fetch: providerFetch, timeoutMs = 10_000 }: { fetch: typeof fetch; timeoutMs?: number },
): WhatsAppTransport {
  const settings = configSchema.safeParse(config);
  if (!settings.success || !timeoutSchema.safeParse(timeoutMs).success || typeof providerFetch !== 'function') {
    throw new Error('Configuração do cliente Meta inválida.');
  }
  const { accessToken, graphApiVersion, phoneNumberId } = settings.data;
  const url = `https://graph.facebook.com/${graphApiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;

  return {
    async send(request) {
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) return { status: 'rejected', reason: 'invalid_request' };
      const { recipientId, message } = parsed.data;
      const payload = {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: recipientId,
        ...(message.type === 'text'
          ? { type: 'text', text: { body: message.body, preview_url: false } }
          : {
            type: 'interactive',
            interactive: {
              type: 'button', body: { text: message.body },
              action: { buttons: message.buttons.map(({ id, title }) => ({ type: 'reply', reply: { id, title } })) },
            },
          }),
      };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<WhatsAppSendResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ status: 'unknown', reason: 'timeout' });
          controller.abort();
        }, timeoutMs);
      });
      const attempt = async (): Promise<WhatsAppSendResult> => {
        try {
          const response = await providerFetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
          });
          return await readResult(response);
        } catch {
          // Nunca propagar mensagem/stack/cause, URL, headers ou corpo da exceção.
          return { status: 'unknown', reason: 'network_error' };
        }
      };
      try {
        // Inclui leitura do corpo e termina mesmo se o fetch injetado ignorar abort.
        return await Promise.race([timeout, attempt()]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
