import { z } from 'zod';
import { activeCourseSummarySchema } from '@supportflow/contracts/language-school';
import {
  applyContextPatch,
  contextPatchSchema,
  type ConversationContext,
} from '../domain/conversation-context.js';
import type { SchoolRepository } from '../domain/school-repository.js';
import type { TrialClassRepository } from '../domain/trial-class-repository.js';
import { getAvailableSlots } from './get-available-slots.js';

export async function updateConversationContext(
  repository: SchoolRepository,
  current: ConversationContext,
  input: unknown,
  message: string,
  agenda?: { trialClassRepository: TrialClassRepository; now: () => Date },
): Promise<ConversationContext> {
  const patch = contextPatchSchema.parse(input);
  const courses = patch.courseReference === null
    ? []
    : z.array(activeCourseSummarySchema).parse(await repository.listActiveCourses());

  const candidate = applyContextPatch(current, patch, message, courses);
  if (!patch.slotReference || !candidate.courseId || !agenda) return candidate;
  const available = await getAvailableSlots({ schoolRepository: repository, ...agenda }, candidate.courseId);
  if (!available.ok && available.error.code === 'OPERATION_FAILED') throw new Error('Falha ao validar horários.');
  // Reaplica sobre o contexto original: curso + horário mudam a revisão uma vez.
  return applyContextPatch(current, patch, message, courses, available.ok ? available.data.slots : []);
}
