import { z } from 'zod';
import { identifierSchema, nonEmptyStringSchema } from '../shared.js';

export const timezoneSchema = nonEmptyStringSchema.refine((value) => {
  if (value !== 'UTC' && !value.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Informe um fuso IANA válido ou UTC.');

export const startsAtSchema = z.iso.datetime({ offset: true });

const phoneSchema = z.string().regex(/^\+?[0-9 ()-]+$/).refine((value) => {
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}, 'Informe um telefone com 7 a 15 dígitos.');

export const contactSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('email'), value: z.email() }),
  z.strictObject({ type: z.literal('phone'), value: phoneSchema }),
]);

export const schoolSchema = z.strictObject({
  id: identifierSchema,
  name: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  address: nonEmptyStringSchema,
  contact: nonEmptyStringSchema,
  openingHours: nonEmptyStringSchema,
  timezone: timezoneSchema,
});

export const priceSchema = z.strictObject({
  amountCents: z.number().int().nonnegative(),
  currency: z.literal('BRL'),
  billingPeriod: z.enum(['month', 'course']),
});

export const courseSummarySchema = z.strictObject({
  id: identifierSchema,
  name: nonEmptyStringSchema,
  language: nonEmptyStringSchema,
  modality: z.enum(['online', 'in_person']),
  active: z.boolean(),
});

export const courseSchema = courseSummarySchema.extend({
  description: nonEmptyStringSchema,
  price: priceSchema.nullable(),
});

// Representações de oferta pública; não filtram registros nem consultam estado.
export const activeCourseSummarySchema = courseSummarySchema.extend({ active: z.literal(true) });
export const activeCourseSchema = courseSchema.extend({ active: z.literal(true) });

export const leadSchema = z.strictObject({
  id: identifierSchema,
  name: nonEmptyStringSchema,
  contact: contactSchema,
  courseId: identifierSchema,
  goal: nonEmptyStringSchema.nullable(),
});

export const slotSchema = z.strictObject({
  slotId: identifierSchema,
  courseId: identifierSchema,
  startsAt: startsAtSchema,
  timezone: timezoneSchema,
});

export const trialClassSchema = z.strictObject({
  id: identifierSchema,
  leadId: identifierSchema,
  courseId: identifierSchema,
  slotId: identifierSchema,
  startsAt: startsAtSchema,
  timezone: timezoneSchema,
  status: z.literal('confirmed'),
});

export const handoffSchema = z.strictObject({
  id: identifierSchema,
  reason: nonEmptyStringSchema,
  status: z.literal('requested'),
});

export type Contact = z.infer<typeof contactSchema>;
export type School = z.infer<typeof schoolSchema>;
export type Price = z.infer<typeof priceSchema>;
export type CourseSummary = z.infer<typeof courseSummarySchema>;
export type Course = z.infer<typeof courseSchema>;
export type ActiveCourseSummary = z.infer<typeof activeCourseSummarySchema>;
export type ActiveCourse = z.infer<typeof activeCourseSchema>;
export type Lead = z.infer<typeof leadSchema>;
export type Slot = z.infer<typeof slotSchema>;
export type TrialClass = z.infer<typeof trialClassSchema>;
export type Handoff = z.infer<typeof handoffSchema>;
