import { z } from 'zod';
import { identifierSchema, nonEmptyStringSchema } from '../shared.js';

export const chatRequestSchema = z.strictObject({
  message: z.string().trim().min(1).max(2000),
  conversationId: identifierSchema.optional(),
});

export const chatConfirmationRequestSchema = z.strictObject({
  conversationId: identifierSchema,
  actionId: identifierSchema,
});

// Único ponto de composição do envelope: o chat não importa contratos do segmento.
export function createChatResponseSchema<Result extends z.ZodType, PendingAction extends z.ZodType>(
  resultSchema: Result,
  pendingActionSchema: PendingAction,
) {
  return z.strictObject({
    conversationId: identifierSchema,
    reply: nonEmptyStringSchema,
    results: z.array(resultSchema),
    pendingAction: pendingActionSchema.nullable(),
  });
}

export const chatErrorCodeSchema = z.enum([
  'INVALID_REQUEST', 'NOT_FOUND', 'ACTION_STALE', 'SLOT_UNAVAILABLE', 'CHAT_ERROR',
]);

export const chatErrorResponseSchema = z.strictObject({
  error: z.strictObject({ code: chatErrorCodeSchema, message: nonEmptyStringSchema }),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatConfirmationRequest = z.infer<typeof chatConfirmationRequestSchema>;
export type ChatErrorCode = z.infer<typeof chatErrorCodeSchema>;
export type ChatErrorResponse = z.infer<typeof chatErrorResponseSchema>;
