import { z } from 'zod';
import type { WhatsAppConfig } from '../config.js';
import {
  whatsappButtonReferenceSchema, whatsappDeliveryStatusSchema, whatsappEventSchema,
  whatsappIdSchema, whatsappTextSchema, whatsappTimestampSchema,
} from '../events.js';
import type { WhatsAppEvent } from '../events.js';

type MetaOrigin = Pick<Extract<WhatsAppConfig, { enabled: true }>, 'wabaId' | 'phoneNumberId'>;
const externalTypeSchema = z.string().min(1).max(128);

// z.object descarta extensões externas. Arrays de itens são validados separadamente
// para que um item malformado não invalide os irmãos de um envelope autorizado.
const envelopeSchema = z.object({
  object: externalTypeSchema,
  entry: z.array(z.object({
    id: whatsappIdSchema,
    changes: z.array(z.object({
      field: externalTypeSchema,
      value: z.object({
        messaging_product: z.literal('whatsapp'),
        metadata: z.object({ phone_number_id: whatsappIdSchema }),
        messages: z.array(z.unknown()).optional(),
        statuses: z.array(z.unknown()).optional(),
      }),
    })),
  })),
});

const timestampSchema = z.string().min(1).max(16)
  .refine((value) => !/[^0-9]/.test(value))
  .transform((seconds) => Number(seconds) * 1_000)
  .pipe(whatsappTimestampSchema);
const messageFields = {
  id: whatsappIdSchema, from: whatsappIdSchema, timestamp: timestampSchema,
  type: externalTypeSchema,
};
const messageSchema = z.object(messageFields);
const contextSchema = z.object({ id: whatsappIdSchema });
const textSchema = z.object({
  ...messageFields, type: z.literal('text'),
  text: z.object({ body: whatsappTextSchema }), context: contextSchema.optional(),
});
const interactiveSchema = z.object({ interactive: z.object({ type: externalTypeSchema }) });
const buttonSchema = z.object({
  ...messageFields, type: z.literal('interactive'), context: contextSchema,
  interactive: z.object({
    type: z.literal('button_reply'),
    button_reply: z.object({ id: whatsappButtonReferenceSchema }),
  }),
});
const statusSchema = z.object({
  id: whatsappIdSchema, timestamp: timestampSchema,
  recipient_id: whatsappIdSchema.optional(), status: externalTypeSchema,
});

type ObservationCode = 'INVALID_MESSAGE' | 'UNSUPPORTED_MESSAGE' | 'INVALID_STATUS' | 'UNSUPPORTED_STATUS' | 'UNSUPPORTED_CHANGE';
export type MetaProjectionResult =
  | { status: 400 | 403 }
  | { status: 200; events: WhatsAppEvent[]; observations: Record<ObservationCode, number> };

// Deve receber apenas JSON cuja assinatura já foi verificada. Sem I/O ou estado.
export function projectMetaWebhook(input: unknown, origin: MetaOrigin): MetaProjectionResult {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) return { status: 400 };
  const envelope = parsed.data;
  // Preflight do lote inteiro: nenhuma projeção parcial de origem divergente.
  if (envelope.object !== 'whatsapp_business_account' || envelope.entry.some((entry) =>
    entry.id !== origin.wabaId || entry.changes.some((change) => change.value.metadata.phone_number_id !== origin.phoneNumberId))) {
    return { status: 403 };
  }

  const events: WhatsAppEvent[] = [];
  const observations: Record<ObservationCode, number> = {
    INVALID_MESSAGE: 0, UNSUPPORTED_MESSAGE: 0, INVALID_STATUS: 0, UNSUPPORTED_STATUS: 0, UNSUPPORTED_CHANGE: 0,
  };
  const source = { provider: 'meta' as const, accountId: origin.wabaId, phoneNumberId: origin.phoneNumberId };
  for (const entry of envelope.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        observations.UNSUPPORTED_CHANGE++;
        continue;
      }
      for (const raw of change.value.messages ?? []) {
        const message = messageSchema.safeParse(raw);
        if (!message.success) { observations.INVALID_MESSAGE++; continue; }
        if (message.data.type === 'text') {
          const text = textSchema.safeParse(raw);
          if (!text.success) { observations.INVALID_MESSAGE++; continue; }
          const data = text.data;
          events.push(whatsappEventSchema.parse({
            ...source, type: 'text', messageId: data.id, senderId: data.from,
            occurredAt: data.timestamp, text: data.text.body,
            ...(data.context ? { replyToMessageId: data.context.id } : {}),
          }));
        } else if (message.data.type === 'interactive') {
          const interactive = interactiveSchema.safeParse(raw);
          if (!interactive.success) { observations.INVALID_MESSAGE++; continue; }
          if (interactive.data.interactive.type !== 'button_reply') { observations.UNSUPPORTED_MESSAGE++; continue; }
          const button = buttonSchema.safeParse(raw);
          if (!button.success) { observations.INVALID_MESSAGE++; continue; }
          const data = button.data;
          events.push(whatsappEventSchema.parse({
            ...source, type: 'button_reply', messageId: data.id, senderId: data.from,
            occurredAt: data.timestamp, reference: data.interactive.button_reply.id,
            replyToMessageId: data.context.id,
          }));
        } else {
          observations.UNSUPPORTED_MESSAGE++;
        }
      }
      for (const raw of change.value.statuses ?? []) {
        const status = statusSchema.safeParse(raw);
        if (!status.success) { observations.INVALID_STATUS++; continue; }
        const supported = whatsappDeliveryStatusSchema.safeParse(status.data.status);
        if (!supported.success) { observations.UNSUPPORTED_STATUS++; continue; }
        const data = status.data;
        events.push(whatsappEventSchema.parse({
          ...source, type: 'status', messageId: data.id, occurredAt: data.timestamp,
          status: supported.data,
          ...(data.recipient_id === undefined ? {} : { recipientId: data.recipient_id }),
        }));
      }
    }
  }
  return { status: 200, events, observations };
}
