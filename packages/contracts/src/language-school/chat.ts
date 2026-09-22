import { z } from 'zod';
import { createChatResponseSchema } from '../chat/index.js';
import { identifierSchema } from '../shared.js';
import { activeCourseSummarySchema, leadSchema, slotSchema } from './entities.js';
import { createLeadInputSchema, languageSchoolToolResultSchema } from './tools.js';

export const leadPendingActionSchema = z.strictObject({
  actionId: identifierSchema,
  kind: z.literal('create_lead'),
  preview: createLeadInputSchema,
});

export const trialClassPendingActionSchema = z.strictObject({
  actionId: identifierSchema,
  kind: z.literal('schedule_trial_class'),
  preview: z.strictObject({
    lead: leadSchema,
    course: activeCourseSummarySchema,
    slot: slotSchema,
  }),
});

export const languageSchoolPendingActionSchema = z.discriminatedUnion('kind', [
  leadPendingActionSchema,
  trialClassPendingActionSchema,
]);

export const languageSchoolChatResponseSchema = createChatResponseSchema(
  languageSchoolToolResultSchema,
  languageSchoolPendingActionSchema,
);

export type LeadPendingAction = z.infer<typeof leadPendingActionSchema>;
export type TrialClassPendingAction = z.infer<typeof trialClassPendingActionSchema>;
export type LanguageSchoolPendingAction = z.infer<typeof languageSchoolPendingActionSchema>;
export type LanguageSchoolChatResponse = z.infer<typeof languageSchoolChatResponseSchema>;
