import { z } from 'zod';
import { identifierSchema, nonEmptyStringSchema } from '../shared.js';
import {
  activeCourseSchema,
  activeCourseSummarySchema,
  handoffSchema,
  leadSchema,
  schoolSchema,
  slotSchema,
  trialClassSchema,
} from './entities.js';

export const getSchoolInfoInputSchema = z.strictObject({});
export const getCoursesInputSchema = z.strictObject({});
export const getCourseDetailsInputSchema = z.strictObject({ courseId: identifierSchema });
export const getAvailableSlotsInputSchema = z.strictObject({ courseId: identifierSchema });
export const createLeadInputSchema = leadSchema.omit({ id: true });
export const scheduleTrialClassInputSchema = z.strictObject({
  leadId: identifierSchema,
  slotId: identifierSchema,
});
export const transferToHumanInputSchema = z.strictObject({ reason: nonEmptyStringSchema });

export const toolErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'NOT_FOUND',
  'CONFIRMATION_REQUIRED',
  'ACTION_STALE',
  'SLOT_UNAVAILABLE',
  'OPERATION_FAILED',
]);

export const toolErrorSchema = z.strictObject({
  code: toolErrorCodeSchema,
  message: nonEmptyStringSchema,
});

export const toolFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: toolErrorSchema,
});

export const getSchoolInfoResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), data: z.strictObject({ school: schoolSchema }) }),
  toolFailureSchema,
]);

export const getCoursesResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({ courses: z.array(activeCourseSummarySchema) }),
  }),
  toolFailureSchema,
]);

export const getCourseDetailsResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), data: z.strictObject({ course: activeCourseSchema }) }),
  toolFailureSchema,
]);

export const getAvailableSlotsResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({ courseId: identifierSchema, slots: z.array(slotSchema) }),
  }),
  toolFailureSchema,
]);

export const createLeadResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({ outcome: z.enum(['created', 'updated', 'existing']), lead: leadSchema }),
  }),
  toolFailureSchema,
]);

export const scheduleTrialClassResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({ outcome: z.enum(['created', 'existing']), booking: trialClassSchema }),
  }),
  toolFailureSchema,
]);

export const transferToHumanResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), data: z.strictObject({ request: handoffSchema }) }),
  toolFailureSchema,
]);

export const languageSchoolToolResultSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('get_school_info'), result: getSchoolInfoResultSchema }),
  z.strictObject({ tool: z.literal('get_courses'), result: getCoursesResultSchema }),
  z.strictObject({ tool: z.literal('get_course_details'), result: getCourseDetailsResultSchema }),
  z.strictObject({ tool: z.literal('get_available_slots'), result: getAvailableSlotsResultSchema }),
  z.strictObject({ tool: z.literal('create_lead'), result: createLeadResultSchema }),
  z.strictObject({ tool: z.literal('schedule_trial_class'), result: scheduleTrialClassResultSchema }),
  z.strictObject({ tool: z.literal('transfer_to_human'), result: transferToHumanResultSchema }),
]);

export type GetSchoolInfoInput = z.infer<typeof getSchoolInfoInputSchema>;
export type GetCoursesInput = z.infer<typeof getCoursesInputSchema>;
export type GetCourseDetailsInput = z.infer<typeof getCourseDetailsInputSchema>;
export type GetAvailableSlotsInput = z.infer<typeof getAvailableSlotsInputSchema>;
export type CreateLeadInput = z.infer<typeof createLeadInputSchema>;
export type ScheduleTrialClassInput = z.infer<typeof scheduleTrialClassInputSchema>;
export type TransferToHumanInput = z.infer<typeof transferToHumanInputSchema>;
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;
export type ToolError = z.infer<typeof toolErrorSchema>;
export type ToolFailure = z.infer<typeof toolFailureSchema>;
export type GetSchoolInfoResult = z.infer<typeof getSchoolInfoResultSchema>;
export type GetCoursesResult = z.infer<typeof getCoursesResultSchema>;
export type GetCourseDetailsResult = z.infer<typeof getCourseDetailsResultSchema>;
export type GetAvailableSlotsResult = z.infer<typeof getAvailableSlotsResultSchema>;
export type CreateLeadResult = z.infer<typeof createLeadResultSchema>;
export type ScheduleTrialClassResult = z.infer<typeof scheduleTrialClassResultSchema>;
export type TransferToHumanResult = z.infer<typeof transferToHumanResultSchema>;
export type LanguageSchoolToolResult = z.infer<typeof languageSchoolToolResultSchema>;
