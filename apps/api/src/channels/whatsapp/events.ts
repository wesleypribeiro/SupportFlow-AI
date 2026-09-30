import { z } from 'zod';

// Limites locais de recepção; IDs são opacos e nunca aparados/coagidos.
export const whatsappIdSchema = z.string().min(1).max(1_024);
export const whatsappTextSchema = z.string().max(4_096);
export const whatsappButtonReferenceSchema = z.string().min(1).max(256);
export const whatsappTimestampSchema = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const whatsappDeliveryStatusSchema = z.enum(['sent', 'delivered', 'read', 'failed']);

const origin = {
  provider: z.literal('meta'),
  accountId: whatsappIdSchema,
  phoneNumberId: whatsappIdSchema,
  messageId: whatsappIdSchema,
  // Milissegundos Unix, derivados dos segundos do provedor, não da reentrega.
  occurredAt: whatsappTimestampSchema,
};

export const whatsappEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...origin, type: z.literal('text'), senderId: whatsappIdSchema,
    text: whatsappTextSchema, replyToMessageId: whatsappIdSchema.optional(),
  }),
  z.strictObject({
    ...origin, type: z.literal('button_reply'), senderId: whatsappIdSchema,
    reference: whatsappButtonReferenceSchema, replyToMessageId: whatsappIdSchema,
  }),
  z.strictObject({
    ...origin, type: z.literal('status'), recipientId: whatsappIdSchema.optional(),
    status: whatsappDeliveryStatusSchema,
  }),
]);

// Validação de transporte não comprova vínculo de botão, entrega ou consentimento.
export type WhatsAppEvent = z.infer<typeof whatsappEventSchema>;
